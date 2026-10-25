import type { IWebFetcher, WebReadOptions } from '../interfaces/IWebFetcher';
import type { ToolOutcome } from '../interfaces/IFileSystem';
import type { ApprovalSource } from './ApprovalPolicy';
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

/** What let a read through, as an allowed read's result names it; a non-prompting read is allowed only by what already stands. */
const ALLOWED_BY: Partial<Record<ApprovalSource, string>> = {
  mode: 'the approval mode',
  'pre-approved': 'the planner allowlist',
  remembered: 'a grant given in this session',
};

/**
 * One read-only attempt's web reads, over the session's fetcher for that
 * attempt (`IWebFetcher.forTask`): decided by the session's web-read policy
 * without asking anyone, within the attempt's own budget, and carried by the
 * host, apart from the task's shell, so a sealed shell neither stops them nor
 * gains the network from them. Ended with its attempt: a read in flight is
 * aborted, and none starts after.
 *
 * Its decisions are its own, not the planner's: they reach the attempt's log
 * in the call's result, a refusal as its reason and an allowed read naming
 * what allowed it, and never the planner's conversation.
 */
export class TaskWebReader implements TaskWebReads {
  private readonly ended = new AbortController();

  constructor(private readonly fetcher: IWebFetcher) {}

  fetch(url: string, signal: AbortSignal): Promise<McpToolReply> {
    return this.read(signal, (opts) => this.fetcher.fetch(url, opts));
  }

  search(query: string, signal: AbortSignal): Promise<McpToolReply> {
    const { fetcher } = this;
    if (!fetcher.search) return Promise.resolve({ text: 'Web search is not available in this session. If you already know a documentation URL, fetch it instead.', isError: true });
    return this.read(signal, (opts) => fetcher.search!(query, opts));
  }

  end(): void {
    this.ended.abort();
  }

  private async read(signal: AbortSignal, run: (opts: WebReadOptions) => Promise<ToolOutcome>): Promise<McpToolReply> {
    if (this.ended.signal.aborted) return { text: ENDED, isError: true };
    // This read's own, a redirect hop's included: reads run in parallel, so no shared list could say whose a decision was.
    const allowed: string[] = [];
    const outcome = await run({
      signal: AbortSignal.any([signal, this.ended.signal]),
      record: (req, granted, source) => {
        if (granted) allowed.push(`${req.scope} by ${ALLOWED_BY[source] ?? source}`);
      },
    });
    // A transport that answers after the attempt ended still hands nothing to a runner that is gone.
    if (this.ended.signal.aborted) return { text: ENDED, isError: true };
    if (!outcome.success) return { text: outcome.output, isError: true };
    const left = this.fetcher.remaining?.();
    const why = allowed.length ? ` (${allowed.join('; ')})` : '';
    return { text: `${outcome.output}\n\n[Allowed by the session's web-read policy without asking anyone${why}${left === undefined ? '' : `; ${left} web read${left === 1 ? '' : 's'} left in this attempt`}.]` };
  }
}
