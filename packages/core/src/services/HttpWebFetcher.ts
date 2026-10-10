import * as http from 'node:http';
import * as https from 'node:https';
import type { IncomingMessage } from 'node:http';
import type { LookupFunction } from 'node:net';
import { pipeline, type Readable } from 'node:stream';
import * as zlib from 'node:zlib';
import type { IWebFetcher } from '../interfaces/IWebFetcher';
import type { IApproval } from '../interfaces/IApproval';
import type { ToolOutcome } from '../interfaces/IFileSystem';
import { guardedLookup, resolveAll, vetEgress, type ResolveAll } from './egressGuard';

/**
 * The concrete `fetch`/`web_search` implementation, in core so the web server
 * and the VS Code extension share one behavior. Until now `IWebFetcher` had no
 * implementation anywhere, which meant the `fetch` tool was declared to every
 * planner and always answered "not available in this environment" — a tool the
 * model could see, choose, and never use.
 *
 * Approval is per origin, not per URL: reading three pages of one library's
 * docs is one decision, not three.
 */

/** The slice of a `fetch` Response the fetcher reads; the platform `fetch` satisfies it. */
export interface WebResponse {
  ok: boolean;
  status: number;
  headers: { get(name: string): string | null };
  body: unknown;
  text(): Promise<string>;
}

export type WebTransport = (
  url: string,
  init: { signal: AbortSignal; headers: Record<string, string>; redirect: 'manual' },
) => Promise<WebResponse>;

export interface HttpWebFetcherOptions {
  approval: IApproval;
  /**
   * Injected in tests; defaults to a node:http(s) transport whose sockets
   * connect only to addresses `resolveHost` answered and the guard vetted.
   */
  fetchImpl?: WebTransport;
  maxChars?: number;
  timeoutMs?: number;
  /** Override DNS resolution (every answer for a name) in tests. */
  resolveHost?: ResolveAll;
}

const DEFAULT_MAX_CHARS = 40_000;
const DEFAULT_TIMEOUT_MS = 20_000;
const MAX_BODY_BYTES = 2_000_000;
const MAX_REDIRECTS = 5;
/** A default UA gets refused by enough sites that it is not worth the confusing failures. */
const USER_AGENT = 'Mozilla/5.0 (compatible; Ordewell-Planner/1.0; +https://github.com/ordewell)';

/**
 * DuckDuckGo's lite endpoint: no API key, no account, and stable enough for
 * "find me the docs URL". It is HTML scraping, so it is the most brittle thing
 * here by construction — every failure path degrades to a tool result that
 * tells the planner to fall back to `fetch` with a known URL.
 */
const SEARCH_ENDPOINT = 'https://lite.duckduckgo.com/lite/?q=';

function decodeEntities(text: string): string {
  return text
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/g, "'");
}

function htmlToText(html: string): string {
  return decodeEntities(
    html
      .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
      .replace(/<noscript\b[^>]*>[\s\S]*?<\/noscript>/gi, ' ')
      .replace(/<\/(p|div|li|h[1-6]|tr|section|article)>/gi, '\n')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<[^>]+>/g, ' '),
  )
    .replace(/[ \t\f\v]+/g, ' ')
    .replace(/\n\s*\n\s*\n+/g, '\n\n')
    .split('\n')
    .map((line) => line.trim())
    .join('\n')
    .trim();
}

interface SearchHit { title: string; url: string; snippet?: string }

/** Pull result links out of the lite endpoint's markup. */
function parseSearchHits(html: string): SearchHit[] {
  const hits: SearchHit[] = [];
  const linkPattern = /<a\b[^>]*class="[^"]*result(?:-link|__a)[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
  const snippetPattern = /class="[^"]*result(?:-snippet|__snippet)[^"]*"[^>]*>([\s\S]*?)</gi;

  const snippets: string[] = [];
  for (let m = snippetPattern.exec(html); m; m = snippetPattern.exec(html)) {
    snippets.push(decodeEntities(m[1].replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim());
  }

  for (let m = linkPattern.exec(html); m; m = linkPattern.exec(html)) {
    const title = decodeEntities(m[2].replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
    if (!title) continue;
    hits.push({ title, url: decodeEntities(m[1]), snippet: snippets[hits.length] });
  }
  return hits;
}

function sanitizeError(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  if (/abort/i.test(msg)) return 'timed out';
  if (/ECONNREFUSED|ECONNRESET|EHOSTUNREACH|ENETUNREACH/i.test(msg)) return 'host not reachable';
  if (/ENOTFOUND|getaddrinfo/i.test(msg)) return 'host not found';
  return msg.replace(/https?:\/\/\S+/g, '<url>');
}

export class HttpWebFetcher implements IWebFetcher {
  private readonly approval: IApproval;
  private readonly fetchImpl: WebTransport;
  private readonly maxChars: number;
  private readonly timeoutMs: number;
  private readonly resolveHost: ResolveAll;

  constructor(opts: HttpWebFetcherOptions) {
    this.approval = opts.approval;
    this.maxChars = opts.maxChars ?? DEFAULT_MAX_CHARS;
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.resolveHost = opts.resolveHost ?? resolveAll;
    this.fetchImpl = opts.fetchImpl ?? pinnedTransport(guardedLookup(this.resolveHost));
  }

  private async isBlockedHost(host: string, port: string): Promise<boolean> {
    return !(await vetEgress(host, port, this.resolveHost)).ok;
  }

  async confirm(url: string): Promise<boolean> {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return false;
    }
    // Only the two network schemes. `file:` would turn this into a second,
    // unconfined path reader that bypasses the filesystem's confinement.
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return false;

    if (await this.isBlockedHost(parsed.hostname, parsed.port)) return false;

    return this.approval.request({
      kind: 'url_fetch',
      subject: url,
      scope: `${parsed.origin}/*`,
      detail: `Planner research wants to fetch ${parsed.origin}`,
    });
  }

  async fetch(url: string): Promise<ToolOutcome> {
    // Gate on the same confirm search uses, so the SSRF guard and the
    // per-origin approval both run even when a caller invokes fetch directly
    // rather than through executeTool.
    if (!await this.confirm(url)) {
      return { success: false, output: `Fetch denied (blocked host or not approved): ${url}. Continue without it, or ask the user to approve this origin or add it to the planner allowlist.`, truncated: false };
    }
    return this.get(url, 'Fetch');
  }

  async search(query: string): Promise<ToolOutcome> {
    const url = SEARCH_ENDPOINT + encodeURIComponent(query);
    if (!await this.confirm(url)) {
      return { success: false, output: `Web search denied by user for query: ${query}`, truncated: false };
    }

    const page = await this.request(url);
    if (!page.ok) return { success: false, output: `Web search failed: ${page.error}`, truncated: false };

    const hits = parseSearchHits(page.body).slice(0, 10);
    if (hits.length === 0) {
      return {
        success: false,
        output: `No results could be parsed for "${query}". Search is best-effort; if you already know a documentation URL, use the fetch tool directly.`,
        truncated: false,
      };
    }

    const output = hits
      .map((hit, i) => `${i + 1}. ${hit.title}\n   ${hit.url}${hit.snippet ? `\n   ${hit.snippet}` : ''}`)
      .join('\n\n');
    return { success: true, output, truncated: false };
  }

  private async get(url: string, label: string): Promise<ToolOutcome> {
    const page = await this.request(url);
    if (!page.ok) return { success: false, output: `${label} failed: ${page.error}`, truncated: false };

    const text = page.isHtml ? htmlToText(page.body) : page.body;
    if (page.truncated || text.length > this.maxChars) {
      const sliced = text.slice(0, this.maxChars);
      return {
        success: true,
        output: `${sliced}\n\n[... truncated to ${this.maxChars} chars, total ${text.length}${page.truncated ? '+, body was byte-capped at the source' : ''}]`,
        truncated: true,
      };
    }
    return { success: true, output: text, truncated: false };
  }

  private async request(url: string): Promise<{ ok: true; body: string; isHtml: boolean; truncated: boolean } | { ok: false; error: string }> {
    let current = url;
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.timeoutMs);
      try {
        const res = await this.fetchImpl(current, {
          signal: controller.signal,
          headers: { 'user-agent': USER_AGENT, accept: 'text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8' },
          redirect: 'manual',
        });
        if (res.status >= 300 && res.status < 400) {
          const location = res.headers.get('location');
          if (!location) return { ok: false, error: `redirect (${res.status}) with no Location` };
          const next = new URL(location, current).href;
          // Re-check the destination the same way `confirm` checked the origin:
          // a redirect to a private IP, or to a non-http(s) scheme like
          // `file:`, would otherwise bypass both guards `confirm` applies to
          // the initial URL.
          const nextParsed = new URL(next);
          if (nextParsed.protocol !== 'https:' && nextParsed.protocol !== 'http:') {
            return { ok: false, error: 'redirect to a non-HTTP scheme' };
          }
          if (await this.isBlockedHost(nextParsed.hostname, nextParsed.port)) {
            return { ok: false, error: 'redirect to a blocked host' };
          }
          current = next;
          continue;
        }
        if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };

        const contentType = res.headers.get('content-type') ?? '';
        const { body, truncated } = await readBounded(res, MAX_BODY_BYTES);
        return { ok: true, body, isHtml: /html|xml/i.test(contentType), truncated };
      } catch (err) {
        return { ok: false, error: sanitizeError(err) };
      } finally {
        clearTimeout(timer);
        // Releases the socket of a redirect or error response whose body was
        // never read; a no-op once the body has been consumed.
        controller.abort();
      }
    }
    return { ok: false, error: `too many redirects (>${MAX_REDIRECTS})` };
  }
}

function isAsyncIterable(value: unknown): value is AsyncIterable<Uint8Array> {
  return typeof value === 'object' && value !== null && Symbol.asyncIterator in value;
}

async function readBounded(res: WebResponse, maxBytes: number): Promise<{ body: string; truncated: boolean }> {
  return isAsyncIterable(res.body) ? readFromIterable(res.body, maxBytes) : readFromText(res, maxBytes);
}

async function readFromIterable(source: AsyncIterable<Uint8Array>, maxBytes: number): Promise<{ body: string; truncated: boolean }> {
  const chunks: Buffer[] = [];
  let total = 0;
  let truncated = false;
  for await (const chunk of source) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    if (total + buf.length > maxBytes) {
      chunks.push(buf.subarray(0, maxBytes - total));
      total = maxBytes;
      truncated = true;
      break;
    }
    chunks.push(buf);
    total += buf.length;
  }
  return { body: Buffer.concat(chunks).toString('utf8'), truncated };
}

async function readFromText(res: WebResponse, maxBytes: number): Promise<{ body: string; truncated: boolean }> {
  const text = await res.text();
  if (Buffer.byteLength(text, 'utf8') <= maxBytes) return { body: text, truncated: false };
  return { body: Buffer.from(text, 'utf8').subarray(0, maxBytes).toString('utf8'), truncated: true };
}

function headerGetter(res: IncomingMessage): WebResponse['headers'] {
  return {
    get: (name) => {
      const value = res.headers[name.toLowerCase()];
      if (value === undefined) return null;
      return Array.isArray(value) ? value.join(', ') : value;
    },
  };
}

function decodedBody(res: IncomingMessage): Readable {
  const encoding = String(res.headers['content-encoding'] ?? '').trim().toLowerCase();
  const decoder = encoding === 'gzip' || encoding === 'x-gzip' ? zlib.createGunzip()
    : encoding === 'deflate' ? zlib.createInflate()
      : encoding === 'br' ? zlib.createBrotliDecompress()
        : undefined;
  if (!decoder) return res;
  // pipeline forwards a source or decode error to the decoder, where the
  // bounded reader's iteration surfaces it.
  pipeline(res, decoder, () => undefined);
  return decoder;
}

/**
 * GET over node:http(s) with the vetted `lookup`, replacing the platform
 * `fetch`, which resolves names itself and so cannot be pinned. Redirects are
 * left to the caller (each hop gets its own vetted connection), and nothing
 * from the URL's userinfo is sent.
 */
export function pinnedTransport(lookup: LookupFunction): WebTransport {
  return (url, init) => new Promise<WebResponse>((resolve, reject) => {
    const target = new URL(url);
    const client = target.protocol === 'https:' ? https : http;
    const req = client.request(
      {
        protocol: target.protocol,
        hostname: target.hostname.replace(/^\[|\]$/g, ''),
        port: target.port || undefined,
        path: `${target.pathname}${target.search}`,
        method: 'GET',
        // Sent, and decoded below, because the platform fetch did the same and
        // some hosts challenge clients that don't.
        headers: { ...init.headers, 'accept-encoding': 'gzip, deflate, br' },
        signal: init.signal,
        lookup,
        // A pooled keep-alive socket would be reused without a fresh lookup.
        agent: false,
      },
      (res) => {
        // The fetcher aborts once it is done with a response; without a
        // listener that teardown error on an unread body would be uncaught.
        res.on('error', () => undefined);
        const body = decodedBody(res);
        resolve({
          ok: res.statusCode !== undefined && res.statusCode >= 200 && res.statusCode < 300,
          status: res.statusCode ?? 0,
          headers: headerGetter(res),
          body,
          text: async () => (await readFromIterable(body, Infinity)).body,
        });
      },
    );
    req.on('error', reject);
    req.end();
  });
}
