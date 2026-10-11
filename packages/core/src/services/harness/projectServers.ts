import { createHash } from 'crypto';
import * as path from 'path';
import type { ApprovalRequest, IApproval } from '../../interfaces/IApproval';
import { globalDataDir } from '../../utils/globalDataDir';
import { writePrivateFile } from '../../utils/privateFile';
import { scopeExcluded } from '../plannerAllowlist';
import { isRecord, readText, type ProjectMcpServer } from './repoConfig';

/**
 * A person's approvals of project MCP servers, kept across sessions
 * (ADR-0028). Keyed by repository root and scope, which names the server
 * and hashes its definition: a changed definition is a new question.
 */
export interface ProjectServerApprovals {
  approved(repoRoot: string, scope: string): boolean;
  remember(repoRoot: string, scope: string): void;
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (!isRecord(value)) return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
}

/** `mcp-server:<name>@<hash>`: what a server's approval and allowlist entry name. */
export function projectServerScope(server: ProjectMcpServer): string {
  const hash = createHash('sha256').update(JSON.stringify(canonical(server.definition))).digest('hex').slice(0, 12);
  return `mcp-server:${server.name}@${hash}`;
}

const scopeName = (scope: string) => scope.slice(0, scope.lastIndexOf('@'));

/**
 * Approvals in Ordewell's own data directory, never the repository's, so a
 * repository cannot ship one. Remembering a server's new definition drops
 * its old one.
 */
export function fileProjectServerApprovals(file = path.join(globalDataDir(), 'project-mcp-servers.json')): ProjectServerApprovals {
  const load = (): Record<string, string[]> => {
    const text = readText(file);
    if (text === undefined) return {};
    try {
      const parsed: unknown = JSON.parse(text);
      const repositories = isRecord(parsed) && isRecord(parsed.repositories) ? parsed.repositories : {};
      return Object.fromEntries(Object.entries(repositories).map(([repo, scopes]) => [repo, Array.isArray(scopes) ? scopes.filter((s): s is string => typeof s === 'string') : []]));
    } catch {
      return {};
    }
  };
  return {
    approved: (repoRoot, scope) => load()[repoRoot]?.includes(scope) ?? false,
    remember(repoRoot, scope) {
      const repositories = load();
      repositories[repoRoot] = [...(repositories[repoRoot] ?? []).filter((s) => scopeName(s) !== scopeName(scope)), scope];
      writePrivateFile(file, `${JSON.stringify({ repositories }, null, 2)}\n`);
    },
  };
}

function describe(server: ProjectMcpServer, scope: string): string {
  const what = server.transport === 'stdio'
    ? `Starting it runs this command as you${server.names.length ? `, setting ${server.names.join(', ')}` : ''}.`
    : `Starting it connects to this URL${server.names.length ? `, sending ${server.names.join(', ')}` : ''}.`;
  return [
    `The repository declares this MCP server for the planner in ${server.source}. ${what}`,
    'Any ${VAR} in it is filled in from your environment.',
    `Approving is remembered for this repository until the definition changes; the planner allowlist entry ${scope} starts it without asking.`,
  ].join(' ');
}

export interface ProjectServerDecision {
  started: ProjectMcpServer[];
  held: ProjectMcpServer[];
}

/**
 * Which of a repository's servers a planner may start (ADR-0028): none past
 * an exclusion, any a person approved before, and otherwise what the
 * session's approval policy answers now — a person, the allowlist, or the
 * mode. Only a person's answer is remembered; with no policy, only what was
 * remembered starts.
 */
export async function decideProjectServers(
  servers: ProjectMcpServer[],
  opts: { repoRoot: string; approval?: IApproval; approvals: ProjectServerApprovals },
): Promise<ProjectServerDecision> {
  const decision: ProjectServerDecision = { started: [], held: [] };
  for (const server of servers) {
    const scope = projectServerScope(server);
    const req: ApprovalRequest = { kind: 'mcp_server', subject: `${server.name}: ${server.target}`, scope, detail: describe(server, scope) };
    const list = opts.approval?.allowlist?.();
    let started = false;
    if (list && scopeExcluded(list, scope)) {
      opts.approval?.record?.(req, false, 'excluded');
    } else if (opts.approvals.approved(opts.repoRoot, scope)) {
      opts.approval?.record?.(req, true, 'remembered');
      started = true;
    } else if (opts.approval) {
      const unasked = opts.approval.peek?.(req).decision === 'allow';
      started = await opts.approval.request(req).catch(() => false);
      if (started && !unasked) opts.approvals.remember(opts.repoRoot, scope);
    }
    (started ? decision.started : decision.held).push(server);
  }
  return decision;
}
