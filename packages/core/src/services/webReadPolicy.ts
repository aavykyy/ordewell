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
}

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
}

export const DEFAULT_WEB_READ_BUDGET = 40;

const ALLOWED: WebReadDecision = { allowed: true };

export class WebReadPolicy {
  private readonly approval: IApproval;
  private readonly resolveHost: ResolveAll;
  private readonly secrets: () => Iterable<string>;
  private readonly env: () => Record<string, string | undefined>;
  private readonly budget: () => number;
  private readonly turn: () => string | undefined;
  private spent: { turn: string | undefined; reads: number } = { turn: undefined, reads: 0 };

  constructor(opts: WebReadPolicyOptions) {
    this.approval = opts.approval;
    this.secrets = opts.secrets ?? (() => []);
    this.env = opts.env ?? (() => process.env);
    this.budget = opts.budget ?? (() => DEFAULT_WEB_READ_BUDGET);
    this.turn = opts.turn ?? (() => undefined);
    this.resolveHost = opts.resolveHost ?? resolveAll;
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
    if (target.refused) return this.refuse(request, target.refused.source, target.refused.reason);

    // Before the mode, since the mode may be `allow`: an exclusion holds in every mode.
    const list = this.approval.allowlist?.();
    if (list && scopeExcluded(list, request.scope)) {
      return this.refuse(request, 'excluded', `${label} refused: ${request.scope} is excluded by the planner allowlist. Continue without it.`);
    }

    // Spent before the approval resolves, so reads raised in parallel cannot
    // all pass the check at once; given back if the read does not happen.
    const spent = this.spend();
    if (!spent) {
      return this.refuse(request, 'budget', `${label} refused: this planner turn has used its web-read budget (${this.budget()}). Continue with what you have, and tell the user that more reading would need a higher budget.`);
    }
    if (opts.prompting === false) {
      // A subagent may never prompt: only what is already standing — a grant,
      // the allowlist, or Full's mode — lets the read through.
      const standing = this.approval.peek?.(request);
      if (standing?.decision === 'allow') {
        this.approval.record?.(request, true, standing.source);
        return this.resolved(target, spent.turn);
      }
      this.refund(spent.turn);
      return this.subagentRefusal(read, request, standing?.source ?? 'no-channel');
    }
    if (await this.approval.request(request)) return this.resolved(target, spent.turn);
    this.refund(spent.turn);
    return { allowed: false, reason: read.kind === 'fetch'
      ? `Fetch not approved: ${request.scope}. Continue without it, or ask the user to approve this origin or add it to the planner allowlist.`
      : 'Web search not approved. Continue without it, or fetch a documentation URL you already know.' };
  }

  private subagentRefusal(read: WebRead, request: ApprovalRequest, source: ApprovalSource): WebReadDecision {
    const label = read.kind === 'fetch' ? 'Fetch' : 'Web search';
    if (source === 'mode') {
      return this.refuse(request, source, `${label} refused: ${request.scope} is not covered by the planner allowlist in allowlist mode. Note the gap in your digest; the user must add a standing approval or change the approval mode.`);
    }
    if (source === 'remembered') {
      return this.refuse(request, source, `${label} refused: ${request.scope} was previously refused in this session. Note the gap in your digest; the user must add a standing approval or start a new session.`);
    }
    this.approval.record?.(request, false, source);
    return { allowed: false, reason: read.kind === 'fetch'
      ? `Fetch refused: ${request.scope} is not approved in this session, and research agents run in the background where nothing can be approved. Note the gap in your digest; the planner can fetch it directly.`
      : 'Web search refused: research agents run in the background where nothing can be approved. Note the gap in your digest; the planner can search directly.' };
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
  private async resolved(target: Target, turn: string | undefined): Promise<WebReadDecision> {
    if (!target.resolve) return ALLOWED;
    const egress = await vetEgress(target.resolve.hostname, target.resolve.port, this.resolveHost);
    if (egress.ok) return ALLOWED;
    this.refund(turn);
    return this.refuse(target.request, 'guard', guardRefusal(egress.reason));
  }

  private refuse(request: ApprovalRequest, source: ApprovalSource, reason: string): WebReadDecision {
    this.approval.record?.(request, false, source);
    return { allowed: false, reason };
  }

  private vetFetch(raw: string): Target {
    const label = 'Fetch';
    const request = (subject: string, scope: string, origin = scope): ApprovalRequest =>
      ({ kind: 'url_fetch', subject, scope, detail: `Planner research wants to fetch ${origin}` });
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
    const detail = `Planner research wants to search the web with ${providerLabel ?? provider}${providerLabel ? '' : ', a third party that receives the query'}${note ? `. ${note}` : ''}`;
    const request = (subject: string): ApprovalRequest =>
      ({ kind: 'web_search', subject, scope: searchScope(provider), detail });
    if (this.carriesSecret([query])) {
      return { label, request: request(WITHHELD), refused: { source: 'secret', reason: secretRefusal(label, 'query') } };
    }
    return { label, request: request(query) };
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
