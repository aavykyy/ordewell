import { ORDEWELL_MCP_SERVER_NAME, PLANNER_TOOLS, TASK_TOOLS, type McpCredential } from '../mcp';
import type { PlannerStartOptions } from './AgentAdapter';

export class McpAttachError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'McpAttachError';
  }
}

/** Which token's tools a runner is handed (ADR-0022, A1). */
export type OrdewellToolRole = 'task' | 'planner';

/** A runner's report on the Ordewell server's connection, in one vocabulary for every runner. */
export type AttachState = 'connected' | 'pending' | 'failed';

/**
 * How one runner is handed the Ordewell MCP server (ADR-0022): the names it
 * calls the server's tools by, which of its permission requests are for them,
 * and what its report of the connection means. Each runner's binding adds how
 * the server is written into that runner's launch or configuration, which has
 * no common shape.
 *
 * `Ask` is the runner's own permission request, as far as telling one for an
 * Ordewell tool needs it.
 */
export interface OrdewellToolBinding<Ask = never> {
  /** The name the runner calls an Ordewell tool by, and reports its calls and requests under. */
  toolName(tool: string): string;
  /** Every tool `role` is given, under the runner's names, in the server's order, less those its token hides. */
  toolNames(role: OrdewellToolRole, hidden?: readonly string[]): string[];
  /**
   * The planner tools this runner's planner token hides, by their names on
   * the server: those it carries natively (ADR-0027), which a model offered
   * both tends to take from Ordewell instead.
   */
  plannerHidden(start: PlannerStartOptions): string[];
  /**
   * Who receives the runner's own search when that search raises no
   * permission request and is set on or off for the whole session
   * (ADR-0027), so the web-read policy decides it at session start, as
   * {@link PlannerStartOptions.nativeSearch}. Absent for a runner whose
   * searches are asked one by one.
   */
  sessionSearchProvider?: string;
  /** Whether a permission request is for one of the server's tools, which is never refused or left waiting (ADR-0022, S3). */
  isOrdewellAsk(ask: Ask): boolean;
  /** What the runner's own status word for the server says about its connection. */
  attachState(status: string | null | undefined): AttachState;
}

/** The tools of a role, by their names on the server, less `hidden`. */
export function ordewellToolNames(role: OrdewellToolRole, hidden: readonly string[] = []): string[] {
  return (role === 'task' ? TASK_TOOLS : PLANNER_TOOLS).map((tool) => tool.name).filter((tool) => !hidden.includes(tool));
}

/** The naming half of a binding for a runner that names a server's tool `<prefix><tool>`. */
export function prefixedToolNames(prefix: string): Pick<OrdewellToolBinding, 'toolName' | 'toolNames'> & { hasPrefix(name: string): boolean } {
  return {
    toolName: (tool) => `${prefix}${tool}`,
    toolNames: (role, hidden) => ordewellToolNames(role, hidden).map((tool) => `${prefix}${tool}`),
    hasPrefix: (name) => name.startsWith(prefix),
  };
}

/** `mcp__<server>__<tool>`: how Claude Code names an MCP tool, and the name Codex's `exec` tool lists one under too. */
export const MCP_CLIENT_TOOL_NAMES = prefixedToolNames(`mcp__${ORDEWELL_MCP_SERVER_NAME}__`);

/** `a`, `a and b`, `a, b and c`. */
export function listed(items: string[]): string {
  return items.length < 2 ? items.join('') : `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}

/** An adapter as {@link spawnAttached} handles it. */
interface SpawnedAdapter {
  dispose(): void;
  /** Absent: the runner cannot be handed the server at all. */
  mcpAttached?(): Promise<boolean>;
}

/** A runner spawned with the Ordewell server connected, and the token it was spawned with. */
export interface AttachedSpawn<A> {
  adapter: A;
  token: string;
}

/** What {@link spawnAttached} needs of the runner it spawns and the server it hands it. */
export interface SpawnAttachSteps<A extends SpawnedAdapter> {
  /** The runner as failures name it. */
  runner: string;
  create(): A;
  issueToken(): Promise<McpCredential>;
  revoke(token: string): void;
  /** Start `adapter` on `credential`. A throw means the runner cannot be spawned at all, so it is not respawned. */
  start(adapter: A, credential: McpCredential): Promise<void>;
  /** Defaults to the adapter's own `dispose`. */
  dispose?(adapter: A): void;
  /** True once nobody wants the runner any more: what was spawned is taken back and nothing is returned. */
  cancelled?(): boolean;
  /** The code of a process that exited while starting; its attach report is not believed. */
  startupExit?(): number | null;
  /** Why the first spawn failed, told before the respawn. */
  onRespawn?(failure: string): void;
  /** The {@link McpAttachError}'s message once the respawn failed too. */
  failed(first: string, second: string): string;
}

/**
 * One runner with Ordewell's tools attached (ADR-0025): a spawn that does not
 * report the server connected is killed with its token and respawned once on
 * a fresh one; a second failure throws {@link McpAttachError}. Null once
 * {@link SpawnAttachSteps.cancelled}, with nothing left running.
 */
export async function spawnAttached<A extends SpawnedAdapter>(steps: SpawnAttachSteps<A>): Promise<AttachedSpawn<A> | null> {
  const first = await spawnOnce(steps);
  if (typeof first !== 'string') return first;
  steps.onRespawn?.(first);
  const second = await spawnOnce(steps);
  if (typeof second !== 'string') return second;
  throw new McpAttachError(steps.failed(first, second));
}

async function spawnOnce<A extends SpawnedAdapter>(steps: SpawnAttachSteps<A>): Promise<AttachedSpawn<A> | null | string> {
  let credential: McpCredential;
  try {
    credential = await steps.issueToken();
  } catch (err) {
    return `Ordewell's MCP server could not issue a token (${errorText(err)})`;
  }
  const { token } = credential;
  if (steps.cancelled?.()) {
    steps.revoke(token);
    return null;
  }
  let adapter: A;
  try {
    adapter = steps.create();
  } catch (err) {
    steps.revoke(token);
    throw err;
  }
  const takeBack = () => {
    if (steps.dispose) steps.dispose(adapter);
    else adapter.dispose();
    steps.revoke(token);
  };
  if (!adapter.mcpAttached) {
    takeBack();
    return `${steps.runner} cannot be handed Ordewell's MCP server`;
  }
  try {
    await steps.start(adapter, credential);
  } catch (err) {
    takeBack();
    throw err;
  }
  if (steps.cancelled?.()) {
    takeBack();
    return null;
  }
  let failure = `${steps.runner} did not report Ordewell's MCP server connected`;
  let attached = false;
  try {
    attached = await adapter.mcpAttached();
    const exit = steps.startupExit?.() ?? null;
    if (exit !== null) {
      attached = false;
      failure += ` (process exited with code ${exit})`;
    }
  } catch (err) {
    failure = `${steps.runner} could not check Ordewell's MCP attach state (${errorText(err)})`;
  }
  const cancelled = steps.cancelled?.() ?? false;
  if (attached && !cancelled) return { adapter, token };
  takeBack();
  return cancelled ? null : failure;
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Ask the runner until it reports the server connected or failed, or the
 * deadline passes. `probe` gets the time left and answers with the runner's
 * latest report, waiting for one however it must.
 */
export async function awaitAttach(probe: (msLeft: number) => Promise<AttachState>, timeoutMs: number, pollMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const left = deadline - Date.now();
    if (left <= 0) return false;
    const state = await probe(left);
    if (state !== 'pending') return state === 'connected';
    if (pollMs > 0) {
      await new Promise((resolve) => {
        const timer = setTimeout(resolve, pollMs);
        timer.unref?.();
      });
    }
  }
}
