import * as http from 'node:http';
import * as https from 'node:https';
import type { IncomingMessage } from 'node:http';
import type { LookupFunction } from 'node:net';
import { pipeline, type Readable } from 'node:stream';
import * as zlib from 'node:zlib';
import type { IWebFetcher } from '../interfaces/IWebFetcher';
import type { SearchHit, SearchPage } from '../interfaces/ISearchProvider';
import type { ISearchProvider } from '../interfaces/ISearchProvider';
import type { ToolOutcome } from '../interfaces/IFileSystem';
import { guardedLookup, resolveAll, vetEgress, type ResolveAll } from './egressGuard';
import { DuckDuckGoSearchProvider } from './DuckDuckGoSearchProvider';
import { WebResponseCache } from './WebResponseCache';
import type { WebRead, WebReadDecision, WebReadPolicy } from './webReadPolicy';

/**
 * The concrete `fetch`/`web_search` implementation, in core so the web server
 * and the VS Code extension share one behavior. Until now `IWebFetcher` had no
 * implementation anywhere, which meant the `fetch` tool was declared to every
 * planner and always answered "not available in this environment" — a tool the
 * model could see, choose, and never use.
 *
 * Whether a read happens is the web-read policy's to decide (ADR-0027); this
 * carries it. Redirect hops are vetted here, since the policy saw only the
 * first URL. Search goes through a pluggable provider behind the same
 * transport; results and pages are cached in an injected, process-wide cache
 * that saves the network but never the decision.
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
  policy: WebReadDecider;
  /**
   * Injected in tests; defaults to a node:http(s) transport whose sockets
   * connect only to addresses `resolveHost` answered and the guard vetted.
   */
  fetchImpl?: WebTransport;
  maxChars?: number;
  timeoutMs?: number;
  /** Override DNS resolution (every answer for a name) in tests. */
  resolveHost?: ResolveAll;
  /** Shared across sessions in production; a fresh one per instance is the test default. */
  cache?: WebResponseCache;
  /** Shared across sessions so the search cooldown is process-wide. */
  searchProvider?: ISearchProvider;
  /** False for a research subagent, which must never prompt (see {@link forSubagent}). */
  prompting?: boolean;
}

const DEFAULT_MAX_CHARS = 40_000;
const DEFAULT_TIMEOUT_MS = 20_000;
const MAX_BODY_BYTES = 2_000_000;
const MAX_REDIRECTS = 5;
/** A default UA gets refused by enough sites that it is not worth the confusing failures. */
const USER_AGENT = 'Mozilla/5.0 (compatible; Ordewell-Planner/1.0; +https://github.com/ordewell)';

const SEARCH_COOLDOWN_OUTPUT =
  'Web search is temporarily unavailable: the search provider backed off after pushing back on automated queries. Do not retry now; fetch a documentation URL you already know instead.';

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

function formatHits(hits: SearchHit[]): ToolOutcome {
  const output = hits
    .map((hit, i) => `${i + 1}. ${hit.title}\n   ${hit.url}${hit.snippet ? `\n   ${hit.snippet}` : ''}`)
    .join('\n\n');
  return { success: true, output, truncated: false };
}

function sanitizeError(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  if (/abort/i.test(msg)) return 'timed out';
  if (/ECONNREFUSED|ECONNRESET|EHOSTUNREACH|ENETUNREACH/i.test(msg)) return 'host not reachable';
  if (/ENOTFOUND|getaddrinfo/i.test(msg)) return 'host not found';
  return msg.replace(/https?:\/\/\S+/g, '<url>');
}

/** A complete, non-private GET response; a response under the byte cap or marked private is not cacheable. */
type FetchedPage =
  | { ok: true; status: number; body: string; isHtml: boolean; truncated: boolean; cacheable: boolean }
  | { ok: false; status?: number; error: string };

/** `no-store`/`private` or a `Set-Cookie` marks a response as session-specific, so it never enters a shared cache. */
function isPrivateResponse(cacheControl: string, setCookie: string | null): boolean {
  if (setCookie) return true;
  return /(?:^|,)\s*(?:no-store|private)\b/i.test(cacheControl);
}

type WebReadDecider = Pick<WebReadPolicy, 'decide'> & Partial<Pick<WebReadPolicy, 'searchesUnasked'>>;

export class HttpWebFetcher implements IWebFetcher {
  private readonly policy: WebReadDecider;
  private readonly fetchImpl: WebTransport;
  private readonly maxChars: number;
  private readonly timeoutMs: number;
  private readonly resolveHost: ResolveAll;
  private readonly cache: WebResponseCache;
  private readonly searchProvider: ISearchProvider;
  private readonly prompting: boolean;

  constructor(opts: HttpWebFetcherOptions) {
    this.policy = opts.policy;
    this.maxChars = opts.maxChars ?? DEFAULT_MAX_CHARS;
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.resolveHost = opts.resolveHost ?? resolveAll;
    this.fetchImpl = opts.fetchImpl ?? pinnedTransport(guardedLookup(this.resolveHost));
    this.cache = opts.cache ?? new WebResponseCache();
    this.searchProvider = opts.searchProvider ?? new DuckDuckGoSearchProvider();
    this.prompting = opts.prompting ?? true;
  }

  private async isBlockedHost(host: string, port: string): Promise<boolean> {
    return !(await vetEgress(host, port, this.resolveHost)).ok;
  }

  decide(read: WebRead): Promise<WebReadDecision> {
    return this.policy.decide(read, this.decideOptions);
  }

  private get decideOptions(): { prompting: boolean } {
    return { prompting: this.prompting };
  }

  forSubagent(): IWebFetcher {
    return new HttpWebFetcher({
      policy: this.policy,
      fetchImpl: this.fetchImpl,
      maxChars: this.maxChars,
      timeoutMs: this.timeoutMs,
      resolveHost: this.resolveHost,
      cache: this.cache,
      searchProvider: this.searchProvider,
      prompting: false,
    });
  }

  searchesUnasked(provider: string): boolean {
    return this.policy.searchesUnasked?.(provider) ?? false;
  }

  async fetch(url: string): Promise<ToolOutcome> {
    const decision = await this.policy.decide({ kind: 'fetch', url }, this.decideOptions);
    if (!decision.allowed) return { success: false, output: decision.reason, truncated: false };
    return this.get(url, 'Fetch');
  }

  async search(query: string): Promise<ToolOutcome> {
    const provider = this.searchProvider;

    // Before the policy: a search that would only answer "temporarily
    // unavailable" must not prompt a Guarded user or spend a budgeted read. No
    // request goes out, and the planner is pointed at `fetch` for URLs it
    // already knows.
    if (provider.coolingDown()) return { success: false, output: SEARCH_COOLDOWN_OUTPUT, truncated: false };

    const decision = await this.policy.decide({ kind: 'search', query, provider: provider.id }, this.decideOptions);
    if (!decision.allowed) return { success: false, output: decision.reason, truncated: false };

    // The cache saves the network, never the decision: the policy ran first, so
    // a hit is refused by an exclusion, the secret check, a Guarded approval or
    // the budget exactly as a live search would be.
    const cacheKey = `${provider.id}\u0000${query}`;
    const cached = this.cache.getSearch(cacheKey);
    if (cached) return formatHits(cached);

    const outcome = await provider.search(query, (url) => this.getSearchPage(url));
    switch (outcome.kind) {
      case 'hits':
        this.cache.setSearch(cacheKey, outcome.hits);
        return formatHits(outcome.hits);
      case 'none':
        return {
          success: false,
          output: `No results could be parsed for "${query}". Search is best-effort; if you already know a documentation URL, use the fetch tool directly.`,
          truncated: false,
        };
      case 'blocked':
        return { success: false, output: SEARCH_COOLDOWN_OUTPUT, truncated: false };
      case 'error':
        return { success: false, output: `Web search failed: ${outcome.error}`, truncated: false };
    }
  }

  private async get(url: string, label: string): Promise<ToolOutcome> {
    const cached = this.cache.getFetch(url);
    if (cached) return this.render(label, cached.body, cached.isHtml, false);

    const page = await this.request(url);
    if (!page.ok) return { success: false, output: `${label} failed: ${page.error}`, truncated: false };
    if (page.cacheable && !page.truncated) this.cache.setFetch(url, { body: page.body, isHtml: page.isHtml });
    return this.render(label, page.body, page.isHtml, page.truncated);
  }

  private render(label: string, body: string, isHtml: boolean, byteTruncated: boolean): ToolOutcome {
    const text = isHtml ? htmlToText(body) : body;
    if (byteTruncated || text.length > this.maxChars) {
      const sliced = text.slice(0, this.maxChars);
      return {
        success: true,
        output: `${sliced}\n\n[... truncated to ${this.maxChars} chars, total ${text.length}${byteTruncated ? '+, body was byte-capped at the source' : ''}]`,
        truncated: true,
      };
    }
    return { success: true, output: text, truncated: false };
  }

  private async getSearchPage(url: string): Promise<SearchPage> {
    const page = await this.request(url);
    return page.ok
      ? { ok: true, status: page.status, body: page.body }
      : { ok: false, status: page.status, error: page.error };
  }

  private async request(url: string): Promise<FetchedPage> {
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
          if (!location) return { ok: false, status: res.status, error: `redirect (${res.status}) with no Location` };
          const next = new URL(location, current).href;
          // Re-check the destination the same way `confirm` checked the origin:
          // a redirect to a private IP, or to a non-http(s) scheme like
          // `file:`, would otherwise bypass both guards `confirm` applies to
          // the initial URL.
          const nextParsed = new URL(next);
          if (nextParsed.protocol !== 'https:' && nextParsed.protocol !== 'http:') {
            return { ok: false, status: res.status, error: 'redirect to a non-HTTP scheme' };
          }
          if (await this.isBlockedHost(nextParsed.hostname, nextParsed.port)) {
            return { ok: false, status: res.status, error: 'redirect to a blocked host' };
          }
          current = next;
          continue;
        }
        if (!res.ok) return { ok: false, status: res.status, error: `HTTP ${res.status}` };

        const contentType = res.headers.get('content-type') ?? '';
        const cacheable = !isPrivateResponse(res.headers.get('cache-control') ?? '', res.headers.get('set-cookie'));
        const { body, truncated } = await readBounded(res, MAX_BODY_BYTES);
        return { ok: true, status: res.status, body, isHtml: /html|xml/i.test(contentType), truncated, cacheable };
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
