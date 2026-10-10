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
 * ever reaches the cache, a response under the byte cap is not (its tail is
 * missing), and a `no-store`/`private` `Cache-Control` or a `Set-Cookie`
 * header keeps a session-specific body out of it.
 */

const DEFAULT_TTL_MS = 5 * 60_000;
const DEFAULT_MAX_ENTRIES = 100;

export interface CachedPage {
  body: string;
  isHtml: boolean;
}

export interface WebResponseCacheOptions {
  ttlMs?: number;
  maxEntries?: number;
  now?: () => number;
}

export class WebResponseCache {
  private readonly entries = new Map<string, { value: unknown; expiresAt: number }>();
  private readonly ttlMs: number;
  private readonly maxEntries: number;
  private readonly now: () => number;

  constructor(opts: WebResponseCacheOptions = {}) {
    this.ttlMs = opts.ttlMs ?? DEFAULT_TTL_MS;
    this.maxEntries = opts.maxEntries ?? DEFAULT_MAX_ENTRIES;
    this.now = opts.now ?? Date.now;
  }

  getFetch(url: string): CachedPage | undefined {
    return this.get<CachedPage>(`get\u0000${url}`);
  }

  setFetch(url: string, page: CachedPage): void {
    this.set(`get\u0000${url}`, page);
  }

  getSearch(providerAndQuery: string): SearchHit[] | undefined {
    return this.get<SearchHit[]>(`search\u0000${providerAndQuery}`);
  }

  setSearch(providerAndQuery: string, hits: SearchHit[]): void {
    this.set(`search\u0000${providerAndQuery}`, hits);
  }

  private get<T>(key: string): T | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt <= this.now()) {
      this.entries.delete(key);
      return undefined;
    }
    // Re-insert so the least-recently-used entry is the one evicted.
    this.entries.delete(key);
    this.entries.set(key, entry);
    return entry.value as T;
  }

  private set(key: string, value: unknown): void {
    this.entries.delete(key);
    this.entries.set(key, { value, expiresAt: this.now() + this.ttlMs });
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
  }
}

/** The one cache every session's fetcher shares, so a page fetched once is reused across planners. */
export const sharedWebResponseCache = new WebResponseCache();
