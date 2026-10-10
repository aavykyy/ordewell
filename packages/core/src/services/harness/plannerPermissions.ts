import type { ApprovalDecision, IApproval } from '../../interfaces/IApproval';
import type { IWebFetcher } from '../../interfaces/IWebFetcher';
import { grantScopeFor, resolveWithin } from '../pathScope';
import type { PlannerAsk } from './AgentAdapter';

/**
 * What a harness planner's own tool requests are decided against (ADR-0026):
 * the session's approval policy, the API planner's, and the web fetcher, whose
 * web-read policy decides a fetch (ADR-0027). Absent means nobody can be asked.
 */
export interface PlannerPermissionGate {
  approval: IApproval;
  fetcher?: IWebFetcher;
  workspaceRoot: string;
}

// `other` is not always a write: a read the envelope has no rule for lands here
// too, so the message names the envelope rather than claiming an edit was tried.
const UNKNOWN_TOOL_DENIAL = 'The Ordewell planner is read-only and its envelope has no rule for this tool, so it did not run. Read with the read tools, use run_command for commands and fetch or web_search for the web; changes belong to the plan\'s tasks.';
const OPS_HINT = 'Continue without it. If it would change something outside the repository, add it to the plan as an ops task; if it only reads, ask the user to approve it or add it to the planner allowlist.';

const ALLOW: ApprovalDecision = { decision: 'allow' };

const SUBJECT_MAX_CHARS = 400;

function deny(note: string): ApprovalDecision {
  return { decision: 'deny', note };
}

export async function decidePlannerPermission(
  ask: PlannerAsk | undefined,
  input: Record<string, unknown>,
  gate: PlannerPermissionGate | undefined,
): Promise<ApprovalDecision> {
  if (!ask || ask.kind === 'other') return deny(UNKNOWN_TOOL_DENIAL);
  if (!gate) return deny('Nobody can approve this here. Continue without it.');

  switch (ask.kind) {
    case 'mcp': {
      const args = JSON.stringify(input);
      const subject = `${ask.server ?? 'MCP'} · ${ask.tool} ${args.length > SUBJECT_MAX_CHARS ? `${args.slice(0, SUBJECT_MAX_CHARS)}…` : args}`;
      const granted = await gate.approval.request({
        kind: 'mcp_tool',
        subject,
        scope: ask.scope,
        tool: ask.tool,
        detail: `The planner wants to use "${ask.tool}"${ask.server ? ` from ${ask.server}` : ''}. It may change things outside the repository.`,
      });
      return granted ? ALLOW : deny(`Not approved: ${ask.scope}. ${OPS_HINT}`);
    }
    case 'fetch': {
      if (!gate.fetcher) return deny('This fetch cannot be approved here.');
      const decision = await gate.fetcher.decide({ kind: 'fetch', url: ask.url });
      return decision.allowed ? ALLOW : deny(decision.reason);
    }
    case 'search': {
      if (!gate.fetcher) return deny('This search cannot be approved here.');
      const decision = await gate.fetcher.decide({
        kind: 'search',
        query: ask.query,
        provider: ask.provider,
        // It runs at the provider, which already holds the conversation the query came from.
        note: `${ask.provider} runs this search itself and already sees this planner's conversation.`,
      });
      return decision.allowed ? ALLOW : deny(decision.reason);
    }
    case 'path': {
      const { abs, inside } = resolveWithin(gate.workspaceRoot, ask.path);
      if (inside) return ALLOW;
      const granted = await gate.approval.request({
        kind: 'external_path',
        subject: abs,
        scope: grantScopeFor(abs, ask.directory ? 'directory' : 'file'),
        detail: `Planner research wants to read ${abs}, outside the workspace (${gate.workspaceRoot}).`,
      });
      return granted ? ALLOW : deny(`Access denied: "${abs}" is outside the workspace and was not approved.`);
    }
  }
}
