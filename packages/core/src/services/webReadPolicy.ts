import type { IApproval, ApprovalRequest } from '../interfaces/IApproval';
import { resolveAll, vetEgress, vetEgressUnresolved, type ResolveAll } from './egressGuard';
import { scopeExcluded } from './plannerAllowlist';
import type { ApprovalSource } from './ApprovalPolicy';
import { carriesSecret, sensitiveEnvValues } from './outboundSecrets';

/**
 * The one decision every planner web read goes through, whichever runner
 * plans and whichever path carries the bytes (ADR-0027). A fetch names the
 * URL it reads; a search names its query and the provider that receives it.
 */
export type WebRead =
  | { kind: 'fetch'; url: string }
  /** `provider` keys the grant; `providerLabel`, when given, names it to the person asked. */
  | { kind: 'search'; query: string; provider: string; providerLabel?: string; note?: string };

/** A refusal's `reason` is written for the planner: it says what to do next. */
export type WebReadDecision = { allowed: true } | { allowed: false; reason: string };

export interface DecideOptions {
  /**
   * Research subagents run in the background where nothing can prompt
   * (ADR-0008, T6). When false, a read that would ask is refused with the gap
   * to report, rather than raising a prompt nobody can answer.
   */
  prompting?: boolean;
  /**
   * Where this read's decisions go, the first URL's and any redirect hop's,
   * in place of the session's approval record. A read-only task's are its
   * attempt's, never the planner's (ADR-0046), so its policy records nothing
   * without one.
   */
  record?: DecisionRecord;
}

export type DecisionRecord = (req: ApprovalRequest, granted: boolean, source: ApprovalSource) => void;

export interface WebReadPolicyOptions {
  approval: IApproval;
  /** The secrets Ordewell holds — provider keys, MCP tokens — read per request. */
  secrets?: () => Iterable<string>;
  /** Defaults to `process.env`; its credential-named values are secrets too. */
  env?: () => Record<string, string | undefined>;
  /** How many web reads one planner turn may make; read per request, so a settings change applies at once. */
  budget?: () => number;
  /** The planner turn in progress; a new one starts a new budget. */
  turn?: () => string | undefined;
  /** Override DNS resolution (every answer for a name) in tests. */
  resolveHost?: ResolveAll;
  /**
   * The read-only task whose attempt reads (ADR-0046), by title, set by
   * {@link WebReadPolicy.forTask}: named in approvals and refusals, and its
   * budget is the policy's own for its whole life, whatever `turn` says.
   */
  task?: string;
}

export const DEFAULT_WEB_READ_BUDGET = 40;

const ALLOWED: WebReadDecision = { allowed: true };

/** Who reads, as an approval and a refusal name it. */
interface Reader {
  who: string;
  /** Whose budget a read over it spent, and where to say so. */
  budget: { spent: string; tell: string };
  /** What a reader that may not prompt is told to do with a read it was refused. */
  gap: string;
  /** Where it runs, as a refusal for want of a channel says. */
  background: string;
}

const PLANNER_READER: Reader = {
  who: 'Planner research',
  budget: { spent: 'this planner turn has used its web-read budget', tell: 'tell the user' },
  gap: 'Note the gap in your digest',
  background: 'research agents run in the background',
};

function taskReader(task: string): Reader {
  return {
    who: `Read-only task "${task}"`,
    budget: { spent: 'this task attempt has used its web-read budget', tell: 'say in your handoff' },
    gap: 'Report the gap in your task_complete handoff',
    background: 'a read-only task runs in the background',
  };
}

export class WebReadPolicy {
  private readonly options: WebReadPolicyOptions;
  private readonly reader: Reader;
  private readonly approval: IApproval;
  private readonly resolveHost: ResolveAll;
  private readonly secrets: () => Iterable<string>;
  private readonly env: () => Record<string, string | undefined>;
  private readonly budget: () => number;
  private readonly turn: () => string | undefined;
  private spent: { turn: string | undefined; reads: number } = { turn: undefined, reads: 0 };

  constructor(opts: WebReadPolicyOptions) {
    this.options = opts;
    this.reader = opts.task === undefined ? PLANNER_READER : taskReader(opts.task);
    this.approval = opts.approval;
    this.secrets = opts.secrets ?? (() => []);
    this.env = opts.env ?? (() => process.env);
    this.budget = opts.budget ?? (() => DEFAULT_WEB_READ_BUDGET);
    this.turn = opts.task === undefined ? opts.turn ?? (() => undefined) : () => undefined;
    this.resolveHost = opts.resolveHost ?? resolveAll;
  }

  /**
   * The same policy for one read-only task attempt (ADR-0046): the same
   * approval, allowlist, live secrets and budget setting, with a count of its
   * own that no planner turn resets and no other attempt spends. One per
   * attempt, so a retry or a continue starts a fresh count.
   */
  forTask(task: string): WebReadPolicy {
    return new WebReadPolicy({ ...this.options, task });
  }

  /**
   * Every check that needs no network runs first, then the budget and the
   * approval, and only then is a fetch's host resolved: a lookup is itself a
   * request, so `<data>.attacker.example` would leave through DNS even for a
   * read that is then excluded, over budget or declined.
   */
  async decide(read: WebRead, opts: DecideOptions = {}): Promise<WebReadDecision> {
    const target = read.kind === 'fetch' ? this.vetFetch(read.url) : this.vetSearch(read);
    const { request, label } = target;
    const record = this.recordFor(opts);
    if (target.refused) return this.refuse(record, request, target.refused.source, target.refused.reason);

    // Before the mode, since the mode may be `allow`: an exclusion holds in every mode.
    const list = this.approval.allowlist?.();
    if (list && scopeExcluded(list, request.scope)) {
      return this.refuse(record, request, 'excluded', `${label} refused: ${request.scope} is excluded by the planner allowlist. Continue without it.`);
    }

    // Spent before the approval resolves, so reads raised in parallel cannot
    // all pass the check at once; given back if the read is refused (a cancelled
    // one keeps it: its host may already have been looked up).
    const spent = this.spend();
    if (!spent) {
      return this.refuse(record, request, 'budget', `${label} refused: ${this.reader.budget.spent} (${this.budget()}). Continue with what you have, and ${this.reader.budget.tell} that more reading would need a higher budget.`);
    }
    if (opts.prompting === false) {
      // A subagent may never prompt: only what is already standing — a grant,
      // the allowlist, or Full's mode — lets the read through.
      const standing = this.approval.peek?.(request);
      if (standing?.decision === 'allow') {
        record?.(request, true, standing.source);
        return this.resolved(record, target, spent.turn);
      }
      this.refund(spent.turn);
      return this.subagentRefusal(record, read, request, standing?.source ?? 'no-channel');
    }
    if (await this.approval.request(request)) return this.resolved(record, target, spent.turn);
    this.refund(spent.turn);
    return { allowed: false, reason: read.kind === 'fetch'
      ? `Fetch not approved: ${request.scope}. Continue without it, or ask the user to approve this origin or add it to the planner allowlist.`
      : 'Web search not approved. Continue without it, or fetch a documentation URL you already know.' };
  }

  private subagentRefusal(record: DecisionRecord | undefined, read: WebRead, request: ApprovalRequest, source: ApprovalSource): WebReadDecision {
    const label = read.kind === 'fetch' ? 'Fetch' : 'Web search';
    const { gap, background } = this.reader;
    if (source === 'mode') {
      return this.refuse(record, request, source, `${label} refused: ${request.scope} is not covered by the planner allowlist in allowlist mode. ${gap}; the user must add a standing approval or change the approval mode.`);
    }
    if (source === 'remembered') {
      return this.refuse(record, request, source, `${label} refused: ${request.scope} was previously refused in this session. ${gap}; the user must add a standing approval or start a new session.`);
    }
    record?.(request, false, source);
    return { allowed: false, reason: read.kind === 'fetch'
      ? `Fetch refused: ${request.scope} is not approved in this session, and ${background} where nothing can be approved. ${gap}; the planner can fetch it directly.`
      : `Web search refused: ${background} where nothing can be approved. ${gap}; the planner can search directly.` };
  }

  /**
   * Whether a search through `provider` would run without asking anyone, for
   * a runner whose own search raises no request and is set on or off when
   * its session starts (ADR-0027). A zero budget disables it; no query is
   * known yet, so secrets and individual reads cannot be checked or counted.
   */
  searchesUnasked(provider: string): boolean {
    if (this.budget() === 0) return false;
    const scope = searchScope(provider);
    const list = this.approval.allowlist?.();
    if (list && scopeExcluded(list, scope)) return false;
    return this.approval.grantsUnasked?.({ kind: 'web_search', scope }) ?? false;
  }

  /** The last check, the one that leaves the machine: every DNS answer for the host must be public. */
  private async resolved(record: DecisionRecord | undefined, target: Target, turn: string | undefined): Promise<WebReadDecision> {
    if (!target.resolve) return ALLOWED;
    const egress = await vetEgress(target.resolve.hostname, target.resolve.port, this.resolveHost);
    if (egress.ok) return ALLOWED;
    this.refund(turn);
    return this.refuse(record, target.request, 'guard', guardRefusal(egress.reason));
  }

  private refuse(record: DecisionRecord | undefined, request: ApprovalRequest, source: ApprovalSource, reason: string): WebReadDecision {
    record?.(request, false, source);
    return { allowed: false, reason };
  }

  /**
   * A planner's decisions reach the session's record, the conversation's
   * approval cards; a task attempt's go only where its read says, since they
   * are not the planner's (ADR-0046).
   */
  private recordFor(opts: DecideOptions): DecisionRecord | undefined {
    if (opts.record) return opts.record;
    if (this.options.task !== undefined || !this.approval.record) return undefined;
    return (req, granted, source) => this.approval.record?.(req, granted, source);
  }

  private vetFetch(raw: string): Target {
    const label = 'Fetch';
    const request = (subject: string, scope: string, origin = scope): ApprovalRequest =>
      ({ kind: 'url_fetch', subject, scope, detail: `${this.reader.who} wants to fetch ${origin}` });
    // First, on the text as given: resolving a host is itself a request, and
    // a secret in a subdomain would leave through DNS. Recorded without the
    // URL, the origin included, for the same reason.
    if (this.carriesSecret([raw])) {
      return { label, request: request(WITHHELD, WITHHELD), refused: { source: 'secret', reason: secretRefusal(label, 'URL') } };
    }
    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      return { label, request: request(raw, raw), refused: { source: 'guard', reason: 'Fetch refused: not a valid URL.' } };
    }
    // `file:` would turn a fetch into a second, unconfined path reader.
    if (url.protocol !== 'https:' && url.protocol !== 'http:') {
      return { label, request: request(raw, raw), refused: { source: 'guard', reason: 'Fetch refused: only http and https URLs can be fetched.' } };
    }
    const fetchRequest = request(raw, `${url.origin}/*`, url.origin);
    const egress = vetEgressUnresolved(url.hostname, url.port);
    if (egress && !egress.ok) {
      return { label, request: fetchRequest, refused: { source: 'guard', reason: guardRefusal(egress.reason) } };
    }
    return { label, request: fetchRequest, ...(egress ? {} : { resolve: { hostname: url.hostname, port: url.port } }) };
  }

  private vetSearch({ query, provider, providerLabel, note }: Extract<WebRead, { kind: 'search' }>): Target {
    const label = 'Web search';
    // A bare id is one of Ordewell's own backends, so the prompt says plainly
    // that the query leaves for a third party; a labelled runner-native search
    // points at the provider's own request instead, where `note` explains it.
    const detail = `${this.reader.who} wants to search the web with ${providerLabel ?? provider}${providerLabel ? '' : ', a third party that receives the query'}${note ? `. ${note}` : ''}`;
    const request = (subject: string): ApprovalRequest =>
      ({ kind: 'web_search', subject, scope: searchScope(provider), detail });
    if (this.carriesSecret([query])) {
      return { label, request: request(WITHHELD), refused: { source: 'secret', reason: secretRefusal(label, 'query') } };
    }
    return { label, request: request(query) };
  }

  /** Reads the current planner turn, or the task attempt, may still make, for the reader to see. */
  remaining(): number {
    const used = this.spent.turn === this.turn() ? this.spent.reads : 0;
    return Math.max(0, this.budget() - used);
  }

  private spend(): { turn: string | undefined } | undefined {
    const turn = this.turn();
    if (this.spent.turn !== turn) this.spent = { turn, reads: 0 };
    if (this.spent.reads >= this.budget()) return undefined;
    this.spent.reads += 1;
    return { turn };
  }

  private refund(turn: string | undefined): void {
    if (this.spent.turn === turn && this.spent.reads > 0) this.spent.reads -= 1;
  }

  private carriesSecret(texts: string[]): boolean {
    return carriesSecret(texts, [...this.secrets(), ...sensitiveEnvValues(this.env())]);
  }
}

interface Target {
  label: string;
  /** What is asked, or recorded when refused before asking. */
  request: ApprovalRequest;
  refused?: { source: ApprovalSource; reason: string };
  /** A host name still to be resolved and vetted, once the read is otherwise allowed. */
  resolve?: { hostname: string; port: string };
}

const WITHHELD = '(withheld: it contains a secret)';

function searchScope(provider: string): string {
  return `web_search:${provider}`;
}

function guardRefusal(reason: string): string {
  return `Fetch refused: ${reason}. Private, local and non-web addresses are never fetched.`;
}

/** Names no part of what was refused: the reason reaches the model and the session's record. */
function secretRefusal(label: string, what: string): string {
  return `${label} refused: the ${what} contains what looks like a secret (an API key, token or credential). Never put credentials in a ${what}; continue without it.`;
}
