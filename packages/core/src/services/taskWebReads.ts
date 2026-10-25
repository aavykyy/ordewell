import type { IWebFetcher } from '../interfaces/IWebFetcher';
import type { ToolOutcome } from '../interfaces/IFileSystem';
import type { McpToolReply } from './mcp/tools';

/**
 * What a read-only attempt's `fetch` and `web_search` calls are answered from
 * (ADR-0046). `signal` is the call's: it aborts when the token is revoked or
 * the caller cancels.
 */
export interface TaskWebReads {
  fetch(url: string, signal: AbortSignal): Promise<McpToolReply>;
  search(query: string, signal: AbortSignal): Promise<McpToolReply>;
}

const ENDED = 'This task attempt has ended, so nothing was read.';

/**
 * One read-only attempt's web reads, over the session's fetcher for that
 * attempt (`IWebFetcher.forTask`): decided by the session's web-read policy
 * without asking anyone, within the attempt's own budget, and carried by the
 * host, apart from the task's shell, so a sealed shell neither stops them nor
 * gains the network from them. Ended with its attempt: a read in flight is
 * aborted, and none starts after.
 */
export class TaskWebReader implements TaskWebReads {
  private readonly ended = new AbortController();

  constructor(private readonly fetcher: IWebFetcher) {}

  fetch(url: string, signal: AbortSignal): Promise<McpToolReply> {
    return this.read(signal, (both) => this.fetcher.fetch(url, { signal: both }));
  }

  search(query: string, signal: AbortSignal): Promise<McpToolReply> {
    const { fetcher } = this;
    if (!fetcher.search) return Promise.resolve({ text: 'Web search is not available in this session. If you already know a documentation URL, fetch it instead.', isError: true });
    return this.read(signal, (both) => fetcher.search!(query, { signal: both }));
  }

  end(): void {
    this.ended.abort();
  }

  private async read(signal: AbortSignal, run: (signal: AbortSignal) => Promise<ToolOutcome>): Promise<McpToolReply> {
    if (this.ended.signal.aborted) return { text: ENDED, isError: true };
    const outcome = await run(AbortSignal.any([signal, this.ended.signal]));
    if (!outcome.success) return { text: this.ended.signal.aborted ? ENDED : outcome.output, isError: true };
    // The decision rides with the result into the attempt's log, as a refusal's reason does.
    const left = this.fetcher.remaining?.();
    return { text: `${outcome.output}\n\n[Allowed by the session's web-read policy without asking anyone${left === undefined ? '' : `; ${left} web read${left === 1 ? '' : 's'} left in this attempt`}.]` };
  }
}
