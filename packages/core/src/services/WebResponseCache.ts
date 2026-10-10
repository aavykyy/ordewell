import type { SearchHit } from '../interfaces/ISearchProvider';

/**
 * A short-lived, bounded, in-process cache of successful public GET responses
 * and search results, shared across sessions so parallel planners and their
 * subagents do not each re-fetch the same page (ADR-0027). It saves the
 * network, never the decision: the fetcher still passes every read through the
 * web-read policy before it looks here, so a hit can be refused by an
 * exclusion, the secret check, a Guarded approval or the budget exactly as a
 * live read can.
 *
 * Only complete, non-private responses are stored: nothing denied or errored
 * ever reaches the cache, a response cut at the byte cap is not (its tail is
 * missing), nor is one another origin answered through a redirect (it is keyed
 * by the URL asked for). A `no-store`/`private` `Cache-Control` or a
 * `Set-Cookie` header keeps a session-specific body out, `no-cache` keeps out
 * one that would need revalidating, and a shorter `max-age` shortens the TTL.
 * Entries are bounded by count and by total bytes.
 */

const DEFAULT_TTL_MS = 5 * 60_000;
const DEFAULT_MAX_ENTRIES = 100;
/** A count alone would let every entry be a byte-capped 2 MB page. */
const DEFAULT_MAX_BYTES = 20_000_000;

export interface CachedPage {
  body: string;
  isHtml: boolean;
}

export interface WebResponseCacheOptions {
  ttlMs?: number;
  maxEntries?: number;
  maxBytes?: number;
  now?: () => number;
}

export class WebResponseCache {
  private readonly entries = new Map<string, { value: unknown; bytes: number; expiresAt: number }>();
  private readonly ttlMs: number;
  private readonly maxEntries: number;
  private readonly maxBytes: number;
  private readonly now: () => number;
  private bytes = 0;

  constructor(opts: WebResponseCacheOptions = {}) {
    this.ttlMs = opts.ttlMs ?? DEFAULT_TTL_MS;
    this.maxEntries = opts.maxEntries ?? DEFAULT_MAX_ENTRIES;
    this.maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;
    this.now = opts.now ?? Date.now;
  }

  getFetch(url: string): CachedPage | undefined {
    return this.get<CachedPage>(`get\u0000${url}`);
  }

  /** `maxAgeMs` is the response's own freshness; it shortens the TTL, never extends it. */
  setFetch(url: string, page: CachedPage, maxAgeMs = Infinity): void {
    this.set(`get\u0000${url}`, page, Buffer.byteLength(page.body), maxAgeMs);
  }

  getSearch(providerAndQuery: string): SearchHit[] | undefined {
    return this.get<SearchHit[]>(`search\u0000${providerAndQuery}`);
  }

  setSearch(providerAndQuery: string, hits: SearchHit[]): void {
    const bytes = hits.reduce((sum, h) => sum + Buffer.byteLength(h.title) + Buffer.byteLength(h.url) + Buffer.byteLength(h.snippet ?? ''), 0);
    this.set(`search\u0000${providerAndQuery}`, hits, bytes, Infinity);
  }

  private get<T>(key: string): T | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt <= this.now()) {
      this.delete(key);
      return undefined;
    }
    // Re-insert so the least-recently-used entry is the one evicted.
    this.entries.delete(key);
    this.entries.set(key, entry);
    return entry.value as T;
  }

  private set(key: string, value: unknown, bytes: number, maxAgeMs: number): void {
    this.delete(key);
    if (bytes > this.maxBytes) return;
    this.entries.set(key, { value, bytes, expiresAt: this.now() + Math.min(this.ttlMs, maxAgeMs) });
    this.bytes += bytes;
    while (this.entries.size > this.maxEntries || this.bytes > this.maxBytes) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.delete(oldest);
    }
  }

  private delete(key: string): void {
    const entry = this.entries.get(key);
    if (!entry) return;
    this.entries.delete(key);
    this.bytes -= entry.bytes;
  }
}

/** The one cache every session's fetcher shares, so a page fetched once is reused across planners. */
export const sharedWebResponseCache = new WebResponseCache();
