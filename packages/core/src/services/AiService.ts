import { Task, ConversationMessage, DiscoveredModel, ReplyRun, ResearchLogEntry, ResearchProgress, RunnerId } from '../models/Task';
import { IConfig } from '../interfaces/IConfig';
import { IFileSystem } from '../interfaces/IFileSystem';
import { IWebFetcher } from '../interfaces/IWebFetcher';
import type { IApproval } from '../interfaces/IApproval';
import type { RunnerModeInfo } from './ModeResolver';
import { GeminiService } from './GeminiService';
import { OpenAiService } from './OpenAiService';
import { isCliProvider } from './ProviderRegistry';
import { CliAgentAiService, type CliAgentAiServiceDeps } from './harness/CliAgentAiService';
import type { IsolatedExecution, PlannerModes } from './plannerModes';
import type { PlannerToolHandler } from './mcp';
import type { SkillInfo } from './SkillsService';
import type { UsageLimitSignal } from './harness/AgentAdapter';

/**
 * The planner tools a session offers its conversation (ADR-0022). A backend
 * that can inject the Ordewell MCP server into its planner issues a planner
 * token bound to `sessionId` and these handlers; API planners use the same task read handlers directly in their tool loop.
 */
export interface PlannerToolsOffer {
  sessionId: string;
  handler: PlannerToolHandler;
}

/**
 * Everything the conversation loop needs to start planning (ADR-0002).
 * The AI service keeps the tool-use message history internally across turns;
 * the surfaces only exchange user/assistant messages with it.
 */
export interface ConversationRequest {
  goal: string;
  runners: RunnerId[];
  modelsByRunner: Partial<Record<RunnerId, DiscoveredModel[]>>;
  fs: IFileSystem;
  onProgress: (progress: ResearchProgress) => void;
  fetcher?: IWebFetcher;
  runnerModes?: Record<RunnerId, RunnerModeInfo[]>;
  autonomousDefault?: boolean;
  /** Where tasks will run (ADR-0013, ADR-0014): in worktrees, the prompt drops file-overlap ordering and describes a repo group. */
  isolatedExecution?: IsolatedExecution;
  /** A plan the planner submits starts at once (ADR-0030), so the opening prompt has no outline gate. */
  autorun?: boolean;
  signal?: AbortSignal;
  /**
   * Persisted dialogue to seed a resumed conversation (session reload). The
   * turns are injected into the message history verbatim — no LLM call happens
   * for them; the first call is the turn opened by `initialMessage`.
   */
  priorHistory?: ConversationMessage[];
  /**
   * The user message that opens this turn. Defaults to `goal` — set it when
   * resuming so the system prompt keeps the original goal while the turn
   * carries the user's new message.
   */
  initialMessage?: string;
  plannerTools?: PlannerToolsOffer;
  /**
   * The session's approval policy, which a harness planner's own tool
   * requests are decided against as the API planner's are (ADR-0026). Absent:
   * nobody can be asked, so they are denied.
   */
  approval?: IApproval;
  /**
   * The workspace's skill catalog. Every planner is shown the task skills it
   * may attach; only one with tools is shown the planner skills, which load
   * through `load_skill` alone (ADR-0024).
   */
  skills?: readonly SkillInfo[];
}

/**
 * A run of a turn's reply text, as a backend reports it. `narration`: it began
 * before its call's last tool call, so it stays when a corrective retry
 * discards what the call replied.
 */
export interface TurnRun extends ReplyRun {
  narration?: true;
}

/**
 * One planner turn's outcome. The planner talks to the user (`message`),
 * commits a full plan (`plan`, a `{tasks:[...]}` JSON object), emits targeted
 * task edits (`task_ops`, a `{taskOps:[...]}` JSON object), or asks to read
 * task bodies and the full catalog before editing (`task_query`, a
 * `{taskQuery:{...}}` JSON object). The Session validates and applies task ops
 * atomically and answers queries out of its own state; the AI service only
 * parses them.
 */
export type ConversationTurn =
  /**
   * `aborted`: the call was stopped, and `text` is only what it had by then.
   * `failed`: the call ended without a reply (a dead agent, a usage limit),
   * and `text` says why; `usageLimit`, where the runner also said in a field
   * whether that was its usage limit (see {@link TurnFailure}).
   * `runs`, on every kind: the reply's runs the turn's surviving calls
   * streamed, in order, and last a note written in the planner's place when
   * `text` is one. An envelope's own run is not among them. Absent from a
   * backend that does not report runs.
   */
  | { kind: 'message'; text: string; researchLog: ResearchLogEntry[]; aborted?: boolean; failed?: boolean; usageLimit?: UsageLimitSignal | false; runs?: TurnRun[] }
  | { kind: 'plan'; tasks: Task[]; text: string; researchLog: ResearchLogEntry[]; runs?: TurnRun[] }
  | { kind: 'task_ops'; ops: import('./TaskOps').TaskOp[]; text: string; researchLog: ResearchLogEntry[]; runs?: TurnRun[] }
  | { kind: 'task_query'; query: import('./TaskQuery').TaskQuery; text: string; researchLog: ResearchLogEntry[]; runs?: TurnRun[] };

export interface IAiService {
  /** Credential values from the harness planner's effective environment, for the outbound secret check. */
  heldSecrets?(): readonly string[];
  /**
   * Begin the planner conversation: collect workspace context, run the
   * research/tool loop, and return the first planner turn. The service
   * retains the full API message history for subsequent
   * {@link continueConversation} calls.
   */
  startConversation(req: ConversationRequest): Promise<ConversationTurn>;

  /**
   * Feed the user's reply into the active conversation and return the next
   * planner turn. Throws if no conversation is active.
   */
  continueConversation(
    userMessage: string,
    onProgress: (progress: ResearchProgress) => void,
    signal?: AbortSignal,
  ): Promise<ConversationTurn>;

  /**
   * Whether a planner conversation is currently held in memory. A branching
   * predicate only — never a test for whether there is anything to release.
   * The harness backend holds an OS process that outlives its conversation, so
   * guarding {@link reset} with this leaks an agent process; call `reset`
   * unconditionally instead.
   */
  hasActiveConversation(): boolean;

  /**
   * Optional: end the planner's live process but keep its own session id, so
   * the next turn starts a fresh one resumed from it (ADR-0009). What a
   * supervisor does to a planner that crashed or hung (ADR-0029). Absent where
   * there is no process to end: the next call is a fresh request anyway.
   */
  restart?(): void;

  /**
   * Whether the active conversation (if any) still matches the planner
   * model/effort currently configured. Optional, and true when absent: a
   * vendor backend re-reads its model from config on every turn, so there is
   * nothing to drift. A harness planner (ADR-0009) is the exception — its
   * model is baked into the agent process at spawn — so only
   * {@link CliAgentAiService} answers this for real. False tells the caller
   * the same thing an absent conversation would: don't call
   * `continueConversation`, restart instead so the new model takes effect.
   */
  conversationMatchesConfig?(): boolean;

  /**
   * Whether the planner reads the catalog and submits plans through Ordewell's
   * MCP tools (ADR-0022). Optional, and false when absent: only a harness
   * planner the server attached to has them, and every other planner keeps
   * the per-turn catalog and the envelopes.
   */
  plannerToolsAttached?(): boolean;

  /**
   * Optional: prune bulky raw tool output out of the live conversation, in
   * place, keeping subagent digests. Returns the characters removed. Absent
   * where the backend holds no tool transcript to prune (a harness planner's
   * agent owns its own context).
   */
  pruneContext?(): number;

  /**
   * One-shot research + plan for non-conversational surfaces (CLI `plan --goal`,
   * web REST). Never asks questions — it plans with what it can find.
   */
  researchAndPlan(
    userDescription: string,
    runners: RunnerId[],
    modelsByRunner: Partial<Record<RunnerId, DiscoveredModel[]>>,
    fs: IFileSystem,
    onProgress: (progress: ResearchProgress) => void,
    fetcher?: IWebFetcher,
    runnerModes?: Record<RunnerId, RunnerModeInfo[]>,
    modes?: PlannerModes,
    signal?: AbortSignal,
  ): Promise<{ tasks: Task[]; researchLog: ResearchLogEntry[]; researchResults: string }>;

  generatePlanDirect(
    userDescription: string,
    runners: RunnerId[],
    modelsByRunner: Partial<Record<RunnerId, DiscoveredModel[]>>,
    onToken?: (token: string) => void,
    fs?: IFileSystem,
    fetcher?: IWebFetcher,
    runnerModes?: Record<RunnerId, RunnerModeInfo[]>,
    modes?: PlannerModes,
    signal?: AbortSignal,
  ): Promise<Task[]>;

  /**
   * Release everything this service holds: the conversation, any in-flight
   * turn, and — on the harness backend — the agent process itself. Idempotent
   * and cheap in every implementation, so callers never gate it.
   */
  reset(): void;
}

/**
 * The single branch point between planner transports. Two of them talk HTTP to
 * an LLM vendor; the third (ADR-0009) drives a coding agent already installed
 * on the machine. Everything downstream — the plan contract, the research-step
 * stream, the four surfaces — is shared.
 */
export function createAiService(config: IConfig, deps?: CliAgentAiServiceDeps): IAiService {
  if (isCliProvider(config.aiProvider)) {
    return new CliAgentAiService(config, deps);
  }
  if (config.aiProvider === 'google') {
    return new GeminiService(config, deps?.turnBudgets);
  }
  return new OpenAiService(config, deps?.turnBudgets);
}
