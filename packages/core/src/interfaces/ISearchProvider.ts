/**
 * A web-search backend behind a narrow seam (ADR-0027). The fetcher carries
 * the bytes through its vetted transport; a provider owns only the endpoint,
 * how to read its results, and how it reacts when it pushes back. `id` flows
 * into the web-read policy's `search` decision, so an approval names the third
 * party that receives the query.
 *
 * One provider exists today (DuckDuckGo's lite endpoint, zero-configuration).
 * The seam exists so adding another is one class, not a refactor.
 */

/** One search result: a title, its URL, and an optional snippet. */
export interface SearchHit {
  title: string;
  url: string;
  snippet?: string;
}

/**
 * The fetcher's vetted page fetch, as a provider sees it. `status` is carried
 * so a provider can tell 429/403 ("pushed back") from a plain error, and the
 * body so it can tell a results page from a challenge.
 */
export type SearchPage =
  | { ok: true; status: number; body: string }
  | { ok: false; status?: number; error: string };

export type SearchTransport = (url: string) => Promise<SearchPage>;

/**
 * What one lookup produced. `blocked` means the provider pushed back and
 * marked itself unavailable; `none` is a plain 200 with nothing parseable,
 * which is not a block; `error` is anything else that went wrong.
 */
export type SearchOutcome =
  | { kind: 'hits'; hits: SearchHit[] }
  | { kind: 'none' }
  | { kind: 'blocked'; reason: string }
  | { kind: 'error'; error: string };

export interface ISearchProvider {
  /** The id that names this backend in the web-read policy's `search` decision. */
  readonly id: string;
  /** The human name shown wherever the query's destination is named. */
  readonly name: string;
  /** Whether a recent push-back has left the provider in cooldown; no request may go out. */
  coolingDown(): boolean;
  /** Run one query through `get`, which fetches through the fetcher's pinned transport. */
  search(query: string, get: SearchTransport): Promise<SearchOutcome>;
}
