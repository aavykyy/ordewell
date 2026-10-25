import type { ToolOutcome } from './IFileSystem';
import type { DecisionRecord, WebRead, WebReadDecision } from '../services/webReadPolicy';

/** What a caller that can go away hands a read: once `signal` aborts, nothing more leaves for it. */
export interface WebReadOptions {
  signal?: AbortSignal;
  /** Where the read's decisions go instead of the session's record; see `DecideOptions.record`. */
  record?: DecisionRecord;
}

export interface IWebFetcher {
  /**
   * The web-read policy's decision (ADR-0027), for a read this fetcher will
   * carry or one a runner carries natively, such as Claude's `WebFetch`.
   * `fetch` and `search` decide for themselves; never call both.
   */
  decide(read: WebRead): Promise<WebReadDecision>;
  /** Whether a runner's own search through `provider` would run unasked; see `WebReadPolicy.searchesUnasked`. */
  searchesUnasked?(provider: string): boolean;
  fetch(url: string, opts?: WebReadOptions): Promise<ToolOutcome>;
  /**
   * Optional web search. A fetcher without it makes the `web_search` tool
   * report itself unavailable rather than failing the turn — the same
   * degradation `fetch` already uses when no fetcher is wired at all.
   */
  search?(query: string, opts?: WebReadOptions): Promise<ToolOutcome>;
  /**
   * A variant of this fetcher for a research subagent: same policy, cache,
   * transport and budget, but a read that would ask a person is refused
   * instead (ADR-0027, ADR-0008 T6). Absent means subagents get no web tools
   * and the `fetch`/`web_search` tools report themselves unavailable.
   */
  forSubagent?(): IWebFetcher;
  /**
   * A variant for one read-only task attempt, `task` naming it (ADR-0046):
   * a subagent's in never prompting, with a web-read budget of its own that
   * no planner turn and no other attempt spends or resets. Absent, or
   * undefined, means read-only tasks get no web reads, and their `fetch` and
   * `web_search` report themselves unavailable.
   */
  forTask?(task: string): IWebFetcher | undefined;
  /** Reads the current budget still allows, where this fetcher's policy counts them. */
  remaining?(): number | undefined;
}
