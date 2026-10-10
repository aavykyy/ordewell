import type { ToolOutcome } from './IFileSystem';
import type { WebRead, WebReadDecision } from '../services/webReadPolicy';

export interface IWebFetcher {
  /**
   * The web-read policy's decision (ADR-0027), for a read this fetcher will
   * carry or one a runner carries natively, such as Claude's `WebFetch`.
   * `fetch` and `search` decide for themselves; never call both.
   */
  decide(read: WebRead): Promise<WebReadDecision>;
  fetch(url: string): Promise<ToolOutcome>;
  /**
   * Optional web search. A fetcher without it makes the `web_search` tool
   * report itself unavailable rather than failing the turn — the same
   * degradation `fetch` already uses when no fetcher is wired at all.
   */
  search?(query: string): Promise<ToolOutcome>;
  /**
   * A variant of this fetcher for a research subagent: same policy, cache,
   * transport and budget, but a read that would ask a person is refused
   * instead (ADR-0027, ADR-0008 T6). Absent means subagents get no web tools
   * and the `fetch`/`web_search` tools report themselves unavailable.
   */
  forSubagent?(): IWebFetcher;
}
