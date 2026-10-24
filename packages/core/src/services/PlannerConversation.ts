import { v4 as uuidv4 } from 'uuid';
import type { ConversationRequest, ConversationTurn, IAiService, TurnRun } from './AiService';
import { reEmitPlanPrompt, repairLoop, resubmitEditPrompt, resubmitPlanPrompt, taskOpsRejectedPrompt } from './PlanRepair';
import { renderTaskQueryAnswer, taskQuerySignature, TASK_QUERY_ANSWER_OR_OPS, TASK_QUERY_REMINDER, TASK_READ_TOOLS_REMINDER, type LiveOutputLookup, type TaskQuery, type TaskQueryCatalog } from './TaskQuery';
import { taskOpsProtocol, type TaskOp } from './TaskOps';
import { readOnlyMode, readOnlyRunners } from './ModeResolver';
import type { PlannerTurnOutcome, SessionBroadcaster, SessionNotice } from './SessionMessage';
import { TurnStream } from './replyStream';
import type { ForkedDialogue } from './conversationFork';
import { condensedNotice, extractSummary, keptTail, summaryRequest } from './conversationSummary';
import type { ConversationMessage, LegacyPlanState, ReplyRun, ResearchLogEntry, ResearchProgress, RunnerId, SkillLoad, Task } from '../models/Task';
import { flattenTasksWithParents, isUserMessage } from '../models/Task';
import type { ExecutionActor, ExecutionRecord } from '../models/Execution';
import { plannerMessage, plannerTranscript, skillLoadLabel, type SkillInvocation } from './skillInvocation';
import { skillLoadNotice, surfaceStep } from '../conversation/records';
import { planChangeErrorText, type PassedChange, type PlanChangeCheck } from './PlanChangeCheck';
import { heldEditTasks } from './heldEdit';
import { classifyRunnerStop, type TurnFailure } from './runnerExit';
import type { PlannerLimit } from './PlannerResend';
import type { AssignmentScope } from './AssignmentScope';
import { PlannerBriefing, type TurnBriefing } from './PlannerBriefing';
import { PromptBlocks, type PlanRow, type PlanView, type TurnBlocks } from './PromptBlocks';
import { joinRuns, noteRun, writtenOver as writtenOverRuns } from './settleReply';
import type { StartWait, StartWaitKind } from './readiness';
import { SubagentRuns } from './SubagentRuns';

/**
 * Per-runner model cap for the always-on catalog block. Generous enough that
 * a typical single-agent catalog (dozens of models) is never truncated —
 * only runners that aggregate hundreds of models (e.g. OpenRouter) hit it.
 */
const CATALOG_MODEL_CAP = 100;

/** Stands in for the catalog block where the planner pulls the catalog itself (ADR-0022, L3). */
const PLANNER_TOOLS_REMINDER =
  'Runners, models and modes may have changed since you last read them: call list_runners and list_models just before submit_plan.';

/**
 * A planner message must never open with the user's text. Claude Code reads a
 * leading `/name` as its own slash command, and before the plan has tasks a
 * later turn carries neither the catalog nor a plan block to lead with
 * (ADR-0012 T10), so an unknown `/clear` would run instead of being answered.
 * The marker keeps the text intact and the command from being read as one.
 */
function plannerInput(parts: readonly (string | undefined)[]): string {
  const message = parts.filter((part): part is string => Boolean(part)).join('\n\n');
  return message.startsWith('/') ? `The user's message follows:\n\n${message}` : message;
}

/**
 * Reads a planner gets per user turn before every answer also carries an
 * instruction to land the turn. Three covers the realistic shape of a read —
 * look at a task, look at the catalog, look at a neighbour it now suspects —
 * without letting a confused planner explore on the user's tokens forever.
 */
const MAX_TASK_QUERIES = 3;

/**
 * Reads answered per user turn, full stop. The soft limit above still answers,
 * so without a hard stop a planner that ignores the instruction loops until
 * something else breaks.
 */
const MAX_TASK_QUERIES_HARD = 6;

/** Per-turn read state. Shared across the repair loop so retries don't reset it. */
interface ReadBudget {
  answered: number;
  /** Query signatures already answered this turn — a repeat is a loop, not a read. */
  seen: Set<string>;
  /** Reads answered before every answer also says to land the turn. */
  soft: number;
  /** Reads answered at all. */
  hard: number;
}

/**
 * A user turn's caps, or a wake-up turn's budget (ADR-0029): with no user
 * message to bound it, a supervisor gets the plan's budget whole, and only
 * its last read is told to land.
 */
function freshReadBudget(wakeUp?: WakeUpTurn): ReadBudget {
  const limits = wakeUp
    ? { soft: Math.max(0, wakeUp.readBudget - 1), hard: wakeUp.readBudget }
    : { soft: MAX_TASK_QUERIES, hard: MAX_TASK_QUERIES_HARD };
  return { answered: 0, seen: new Set(), ...limits };
}

/**
 * Spend one read from the turn's budget, whichever channel it came over.
 * Refused at the hard limit; otherwise answered, and told to land the turn
 * once the soft limit is spent or the planner asks the identical question
 * again — a loop, not a read.
 */
function spendRead(reads: ReadBudget, signature: string): 'refused' | 'answer' | 'land' {
  if (reads.answered >= reads.hard) return 'refused';
  const land = reads.seen.has(signature) || reads.answered >= reads.soft;
  reads.seen.add(signature);
  reads.answered++;
  return land ? 'land' : 'answer';
}

/**
 * The planner turn (see CONTEXT.md): the one piece of planner work that holds
 * the conversation, from its claim to its settled outcome. Its signal is what a
 * stop aborts.
 */
export class PlannerTurn {
  private readonly controller = new AbortController();
  private dropped = false;
  private forced = false;

  get signal(): AbortSignal { return this.controller.signal; }

  /** The plan it was answering was dropped under it, so nothing it settles may land. */
  get abandoned(): boolean { return this.dropped; }

  /** A force send stopped it, not the user: the forced turn follows. A turn already stopped stays the user's stop. */
  get forceSent(): boolean { return this.forced; }

  stop(by?: 'force_send'): void {
    if (by === 'force_send' && !this.controller.signal.aborted) this.forced = true;
    this.controller.abort();
  }

  abandon(): void {
    this.dropped = true;
    this.controller.abort();
  }
}

/**
 * How a turn takes the conversation: a turn that continues the dialogue is
 * refused while another is live, and one that starts a fresh plan supersedes
 * it — the plan the live one was answering is being dropped anyway.
 */
type TurnAdmission = { refuseAs: string } | 'supersede';

/**
 * A backend's turn, or the turn a submission made of it. `said` is then the
 * reply's prose, which the user reads beside the plan or edit it carried; an
 * envelope reply's text is the envelope itself, and is never shown — what it
 * said is the narration before its tool calls.
 */
type ClaimedTurn = ConversationTurn & { said?: string };
/** A turn with every read already drained — what the settle path actually commits. */
type SettleableTurn = Exclude<ClaimedTurn, { kind: 'task_query' }>;
/** A turn that changes nothing in the plan: what it said is all that lands. */
type CommitTurn = Exclude<SettleableTurn, { kind: 'task_ops' | 'plan' }>;

/** {@link writtenOverRuns} for a turn that reported runs; one that reported none carries none. */
function writtenOver(runs: readonly TurnRun[] | undefined, text: string): Pick<ConversationTurn, 'runs'> {
  return runs ? { runs: writtenOverRuns(runs, text) } : {};
}

/** A message or entry carries runs only where the backend reported them. */
const withRuns = (runs: ReplyRun[] | undefined): { runs?: ReplyRun[] } => (runs ? { runs } : {});

/** What a planner turn may change: the whole plan, or tasks through edits. */
export type PlanChange = 'plan' | 'edit';

/**
 * A wake-up turn (ADR-0029): a supervisor's turn on wake-up digests alone, no
 * user message in it. What it may do is its level's, decided by the host.
 */
export interface WakeUpTurn {
  /** Reads the turn may make, in place of a user message's caps. */
  readBudget: number;
  /**
   * Why a whole plan, or a task edit, is refused in this turn, worded for the
   * model; undefined when its level allows it. Asked when the change is made
   * and again as it lands, so a level lowered during the turn applies at once.
   */
  refused(change: PlanChange): string | undefined;
  /** Told to the model after the digests and never saved, like the plan block: who it is in this turn, and what it may do. */
  brief?: string;
  /**
   * Who the turn acts for at the command seam, read at each call; absent, the
   * supervisor at the run's level. A turn on a report owed to the user's turn
   * acts as that turn did, and speaks as the planner (ADR-0037, R3).
   */
  actor?: () => Extract<ExecutionActor, { kind: 'planner-turn' | 'supervisor' }>;
}

/** The planner speaks as the supervisor in a wake-up turn, but for one acting as the user's turn. */
function bySupervisor(wakeUp: WakeUpTurn | undefined): boolean {
  return wakeUp !== undefined && wakeUp.actor?.().kind !== 'planner-turn';
}

/** One user turn, from the message to its settled outcome: every backend call it makes streams through `stream`. */
interface UserTurn {
  stream: TurnStream;
  planner: PlannerTurn;
  signal: AbortSignal;
  /** The plan the turn is answering; a settle that finds another one current lands nothing. */
  plan: LegacyPlanState | null;
  reads: ReadBudget;
  /** Set when no user message opened the turn: the supervisor answers it. */
  wakeUp?: WakeUpTurn;
  /** What the turn tells the planner besides its inputs; told only if the turn lands an answer the planner gave. */
  briefing?: TurnBriefing;
  /** The catalog and plan blocks it sends, held by the live context once it lands normally. */
  blocks?: TurnBlocks;
  /** A corrective retry was sent in it: the planner misread something, so its next turn is sent the whole plan again (ADR-0012 T10). */
  repaired?: boolean;
  /** Its message was force sent. */
  forced?: boolean;
  /** Handed in since the backend last answered; see {@link PlannerConversation.submit}. */
  submitted?: PlannerSubmission;
  writes: TurnWrites;
  /** See {@link ReplyOptions.onCommit}. */
  onCommit?: () => void;
  /** Surfaces were last told the turn holds an edit, so they are told when it no longer does. */
  heldShown?: boolean;
  /** Its end was announced when it was abandoned; it says nothing more. */
  ended?: boolean;
  /**
   * Narration of the calls whose reply the turn did not settle on — a read it
   * answered, an attempt a corrective retry discarded. It stays where it
   * streamed, and the reply is saved with it (ADR-0017 A1).
   */
  narration: TurnRun[];
}

/**
 * What a turn writes to the dialogue, held until the one mutation that lands
 * its outcome writes it all (see {@link PlannerConversation.land}): its inputs —
 * the opening's goal, or the user's message and the wake-up digests, each with
 * the skills its `/name` tokens loaded and its user-prompt research entry — the
 * skills the planner loads as it runs, and the research subagents it starts.
 * Nothing of it is written while the turn is in flight, so no other save can
 * persist it, a turn that never lands has nothing to take back, and a reload
 * cannot replay an input the transcript also holds (ADR-0029).
 */
interface TurnWrites {
  /**
   * Each entry with where it belongs: the transcript's length when it was
   * held, so it lands ahead of what was written after it — a command at the
   * seam, a settings note — not at the end.
   */
  entries: { at: number; entry: ConversationMessage }[];
  research: ResearchLogEntry[];
  subagents: SubagentRuns;
}

/**
 * A message a landing turn writes: in the turn's voice — the supervisor's in a
 * wake-up turn — unless it is the plan marker, which keeps its own kind and is
 * told to surfaces by the plan broadcast rather than as a planner message.
 */
interface Landed {
  content: string;
  kind?: 'plan_generated';
  runs?: ReplyRun[];
}

/** A read made through a planner tool: refused once the turn's budget is gone, else answered, told to land when the budget asks it to. */
export type ToolRead<T> = { status: 'refused' } | { status: 'answered'; value: T; landNow: boolean };

/** A plan or task edit handed to the open turn over a channel other than its reply (ADR-0022). */
export type PlannerSubmission =
  | { kind: 'plan'; tasks: Task[] }
  | { kind: 'task_ops'; ops: TaskOp[] };

interface SettledTurn {
  plan: LegacyPlanState;
  outcome: Exclude<PlannerTurnOutcome, 'stopped' | 'error'>;
}

/** Everything (re)opening a conversation needs besides the dialogue itself. */
export type ConversationOpening = Omit<ConversationRequest, 'goal' | 'onProgress' | 'signal' | 'priorHistory' | 'initialMessage'>;

/**
 * What the conversation needs from the session that hosts it. The session keeps
 * plan state, persistence and scheduling; the conversation reaches them only
 * through here, so a fake host is enough to drive it.
 */
export interface PlannerConversationHost {
  /** The plan the transcript lives on (`conversationHistory`, `researchLog`). */
  plan(): LegacyPlanState | null;
  goal(): string;
  aiService(): IAiService;
  onProgress(progress: ResearchProgress): void;
  /** Fresh discovery, allowlist-filtered the way the system prompt shows it. */
  opening(runners: RunnerId[]): Promise<ConversationOpening>;
  /** What the per-turn catalog block and every read draw from, as of now. */
  catalog(): TaskQueryCatalog;
  /** Whether autorun is on now (ADR-0030); the planner is told in the turn after it changes. */
  autorun(): boolean;
  /** The enabled runners and allowlist as of now; the planner is told in the turn after either changes. */
  assignmentScope(): AssignmentScope;
  tasks(): readonly Task[];
  /**
   * Why a task cannot start now, from the scheduler's start rule (ADR-0034);
   * none once nothing holds it back, or while the plan is not yet approved.
   */
  startWaits(task: Readonly<Task>): readonly StartWait[];
  /**
   * The orchestrator's live capture for a task's latest attempt, backing the
   * `output` field of a read. Injected the same way as the catalog so the
   * conversation never reaches into execution state directly.
   */
  liveOutput: LiveOutputLookup;
  isExecuting(): boolean;
  /** The session's single mutation ritual: op → persist → notify (default: the plan). */
  mutate(op: () => boolean, notify?: () => void): LegacyPlanState | null;
  broadcast: SessionBroadcaster;
  /** `turnId`: the planner turn whose commit this is, when one is. */
  broadcastPlan(turnId?: string): void;
  /**
   * The one check a plan change meets, over live state: a whole plan or a
   * batch as its turn lands it, and the held edit as it is shown. A
   * supervisor's batch that trips the oscillation guard is refused, and the
   * user is told of the trip once, in the supervisor's voice (ADR-0029): a note
   * saved as it is written, like any of Ordewell's own, which a turn in flight
   * holds nothing in.
   */
  planChanges: Pick<PlanChangeCheck, 'check' | 'checkNow'>;
  /** Tell the user something the transcript does not carry. */
  notice(level: SessionNotice['level'], message: string): void;
  /** Load planner-produced tasks: an edit keeps run state, a commit starts over. Returns how many landed. */
  adoptTasks(tasks: readonly Task[], how: 'edit' | 'commit'): number;
  capturePrd(text: string): void;
  /** The planner turn was stopped or abandoned: whatever it is waiting on (a parked approval) will never be answered. */
  turnAborted(): void;
  /** A planner turn is about to take the conversation, which nothing holds now. */
  turnClaiming?(): void;
  /** A planner turn let the conversation go, so the next one may take it. */
  turnReleased?(): void;
  /** A turn ended on the planner's usage limit, which it reported as `said`: what is sent again, and when. */
  usageLimit(said: TurnFailure): PlannerLimit;
}

/**
 * A conversation edit (rewind, fork) the conversation refused because the
 * request itself is wrong — no such message, nothing to fork. Transport-agnostic
 * like `PlanEditError`: a route maps it to a status, core carries none.
 */
export class ConversationEditError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConversationEditError';
  }
}

/**
 * Refused because a planner turn is in flight. Distinct from a bad request:
 * the same call succeeds once the turn settles, and the turn would otherwise
 * append its reply to a transcript that no longer holds the message it
 * answers.
 */
export class ConversationBusyError extends ConversationEditError {
  constructor(operation: string) {
    super(`Cannot ${operation} while the planner is answering: wait for the reply, or stop it first.`);
    this.name = 'ConversationBusyError';
  }
}

/**
 * A planner turn that settled after the plan it was answering was dropped (a
 * new plan, another session adopted, the session closed). Nothing it produced
 * was committed: landing it would write one session's reply into another's
 * transcript.
 */
export class PlannerTurnDiscardedError extends Error {
  constructor(options?: ErrorOptions) {
    super('The planner turn was discarded: the plan it was answering is no longer the current one.', options);
    this.name = 'PlannerTurnDiscardedError';
  }
}

/**
 * A wake-up turn's backend ended without a reply — a dead agent, a usage
 * limit — and said why. A user's turn shows that in the chat instead; a
 * wake-up has nobody waiting on it, so its supervisor is told (ADR-0029).
 */
export class PlannerTurnFailedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PlannerTurnFailedError';
  }
}

/**
 * A planner turn ended on the planner's usage limit (#84). Nothing of it
 * lands: the transcript keeps the failure instead, out of the planner's own
 * dialogue, and the turn's inputs wait to be sent again — at `resendAt`, or
 * with the next input when it is null.
 */
export class PlannerUsageLimitError extends PlannerTurnFailedError {
  readonly resendAt: Date | null;
  /** Why nothing is sent again on its own, when nothing is. */
  readonly held?: string;

  constructor(limit: PlannerLimit) {
    super(limit.text);
    this.name = 'PlannerUsageLimitError';
    this.resendAt = limit.resendAt;
    if (limit.held) this.held = limit.held;
  }
}

/**
 * The user stopped the turn and the backend reported that as a thrown error
 * rather than a settled reply. Typed so a surface can stay quiet for it without
 * reading the message: some SDKs' abort errors are plain `Error`s by name, and
 * a real failure can mention "aborted" too.
 */
export class PlannerTurnStoppedError extends Error {
  constructor(options?: ErrorOptions) {
    super('The planner turn was stopped.', options);
    this.name = 'PlannerTurnStoppedError';
  }
}

/**
 * What a turn that threw should surface. Its own stop or abandonment is why it
 * ended, whatever the backend called the error it threw on the way out; the
 * original is kept as the cause, since the turn may also have failed for real.
 */
function interrupted(planner: PlannerTurn, err: unknown): unknown {
  if (err instanceof PlannerTurnDiscardedError || err instanceof PlannerTurnStoppedError) return err;
  if (planner.abandoned) return new PlannerTurnDiscardedError({ cause: err });
  if (planner.signal.aborted) return new PlannerTurnStoppedError({ cause: err });
  return err;
}

/** What a call cut off by something other than its turn's own stop is saved as. */
const CUT_OFF = "The planner's call was cut off before it answered.";

/** Width of a rewind target's preview — one picker row, not the whole message. */
const REWIND_PREVIEW_WIDTH = 80;

/** A user message a rewind can fork the conversation from just before. */
export interface RewindTarget {
  /** Position in the transcript — what {@link PlannerConversation.cloneBefore} takes. */
  index: number;
  preview: string;
  /** The whole message — the preview cuts it to one line, and a surface confirming the rewind quotes it. */
  content: string;
  timestamp: string;
}

/** What a rewind forks from, and the message it lands just before. */
export interface RewoundDialogue {
  dialogue: ForkedDialogue;
  rewoundMessage: string;
}

/** What a compaction left behind. */
export interface ConversationCompaction {
  summary: string;
  /** Transcript entries kept verbatim after the summary entry. */
  keptMessages: number;
}

export interface ReplyOptions {
  signal?: AbortSignal;
  /**
   * Run inside the mutation that lands the turn's outcome — the edit, the
   * plan or the reply — so what the caller drops with it (the inputs the turn
   * answered) leaves disk in the same save.
   */
  onCommit?: () => void;
  /** Wake-up digests delivered with this turn (ADR-0029), oldest first, ahead of the user's message if there is one. */
  wakeUps?: readonly string[];
  /** Set when the turn is a wake-up's alone. */
  wakeUp?: WakeUpTurn;
  /** The user's message was force sent: the turn replaces the one it stopped (ADR-0023). */
  forced?: boolean;
}

/** Refused while tasks run: a whole plan replaces the run's, and only an edit can leave running work as it is. */
const WHOLE_PLAN_WHILE_RUNNING =
  'Tasks are running, so a whole new plan cannot replace this one now. Change the tasks that have not started with task edits instead, or ask the user to stop the run first.';

/**
 * The planner conversation (ADR-0002), end to end: the persisted dialogue
 * record, the live model context behind it, and every turn from the user's
 * message to a settled, persisted outcome.
 *
 * It is the only writer of `conversationHistory` and of the planner's
 * `researchLog`. The writes land on the host's plan object — which is what the
 * session persists and broadcasts — and only ever inside the host's mutation
 * ritual, so each reaches disk in the save made for it. A planner turn writes
 * nothing until the mutation that lands it ({@link land}): any other save made
 * while it runs finds nothing of it to persist.
 *
 * The live model context (a vendor service's message list, a harness planner's
 * process and native session id) is disposable: {@link reset} drops it and the
 * next turn is replayed from the transcript. That is what lets the transcript
 * be replaced by a summary, or copied into a fork, without the model's memory
 * drifting from it.
 */
export class PlannerConversation {
  private readonly briefing: PlannerBriefing;
  private readonly blocks: PromptBlocks;
  private live: PlannerTurn | null = null;
  private openTurn: UserTurn | null = null;

  constructor(private readonly host: PlannerConversationHost) {
    this.briefing = new PlannerBriefing({
      autorun: () => host.autorun(),
      scope: () => host.assignmentScope(),
      tasks: () => host.tasks(),
      plannerTools: () => host.aiService().plannerToolsAttached?.() ?? false,
    });
    this.blocks = new PromptBlocks({
      catalog: () => this.catalogBlock(),
      plan: () => this.planView(),
      compactions: () => host.aiService().compactions?.() ?? 0,
    });
  }

  get transcript(): readonly ConversationMessage[] {
    return this.host.plan()?.conversationHistory ?? [];
  }

  /** Whether a planner turn holds the conversation. */
  get isTurnInFlight(): boolean {
    return this.live !== null;
  }

  /** Stop the planner turn in flight; it settles as stopped. False when none is. */
  stopTurn(by?: 'force_send'): boolean {
    if (!this.live) return false;
    this.live.stop(by);
    return true;
  }

  /**
   * Drop the planner turn in flight together with the plan it was answering:
   * it is stopped, whatever it settles is discarded, and the conversation is
   * free at once rather than when the abandoned turn finishes unwinding.
   */
  abandonTurn(): void {
    this.drop('stopped');
  }

  /**
   * Free the conversation from a turn that did not end when stopped — a hung
   * wake-up (ADR-0029). Unlike {@link abandonTurn} the plan stays, so the turn
   * is forgotten as its failure would have been: nothing it held lands, and
   * what it would have told the planner is told to the next turn.
   */
  abandonHungTurn(): void {
    this.drop('error');
  }

  /**
   * Let the live turn go. A user turn's end is announced now, and it says
   * nothing after — not its stream, not its held edit, not its end again —
   * since it may settle at any time later: the API services restart nothing,
   * and a hung call settles whenever it settles, while the next turn runs.
   */
  private drop(outcome: 'stopped' | 'error'): void {
    const turn = this.live;
    if (!turn) return;
    this.live = null;
    turn.abandon();
    const open = this.openTurn;
    if (open?.planner !== turn) return;
    this.openTurn = null;
    this.clearHeld(open);
    open.stream.mute();
    open.ended = true;
    this.host.broadcast({ type: 'planner_turn_ended', turnId: open.stream.turnId, outcome });
  }

  /**
   * Run planner work that is not a conversation turn — one-shot plan
   * generation — as the planner turn, so it is stopped, refused and superseded
   * like one. It starts a fresh plan, so it supersedes the turn in flight.
   */
  async hold<T>(signal: AbortSignal | undefined, body: (turn: PlannerTurn) => Promise<T>): Promise<T> {
    const { turn, release } = this.claim('supersede', signal);
    try {
      return await body(turn);
    } catch (err) {
      throw interrupted(turn, err);
    } finally {
      release();
    }
  }

  /**
   * Take the conversation for a new planner turn. A caller's own signal stops
   * the turn too; the relay is detached on release because a caller may reuse
   * that signal, and a stale listener would stop the next turn with it.
   */
  private claim(admission: TurnAdmission, callerSignal?: AbortSignal): { turn: PlannerTurn; release: () => void } {
    if (admission === 'supersede') this.abandonTurn();
    else if (this.live) throw new ConversationBusyError(admission.refuseAs);
    this.host.turnClaiming?.();
    const turn = new PlannerTurn();
    this.live = turn;
    turn.signal.addEventListener('abort', () => this.host.turnAborted(), { once: true });
    const relay = () => turn.stop();
    if (callerSignal?.aborted) turn.stop();
    else callerSignal?.addEventListener('abort', relay, { once: true });
    return {
      turn,
      release: () => {
        callerSignal?.removeEventListener('abort', relay);
        // An abandoned turn gave the slot up already, maybe to its successor.
        if (this.live !== turn) return;
        this.live = null;
        this.host.turnReleased?.();
      },
    };
  }

  /** The user turn being answered, for what the host raises during it — an approval the turn's research asks for. */
  get currentTurnId(): string | undefined {
    return this.openTurn?.stream.turnId;
  }

  /** The open turn's wake-up rules, when the supervisor is answering it rather than the user's message. */
  get currentWakeUp(): WakeUpTurn | undefined {
    return this.openTurn?.wakeUp;
  }

  /**
   * What the open turn's task reads have left, for the planner to see. A user
   * turn counts down to the instruction to land and names the hard stop; a
   * wake-up turn has its one budget, whole.
   */
  get readsLeft(): { left: number; hardStop?: number } | undefined {
    const turn = this.openTurn;
    if (!turn) return undefined;
    const { reads, wakeUp } = turn;
    return wakeUp ? { left: reads.hard - reads.answered } : { left: reads.soft - reads.answered, hardStop: reads.hard };
  }

  /** A skill the planner loaded in the open turn, held with the turn; false when none is open to take it. */
  recordPlannerSkill(skill: SkillLoad): boolean {
    const turn = this.openTurn;
    if (!turn || turn.signal.aborted || turn.plan !== this.host.plan()) return false;
    this.holdWrites(turn, [{ role: 'assistant', content: skillLoadLabel(skill), timestamp: new Date().toISOString(), kind: 'skill_load', skill }]);
    this.host.broadcast({ type: 'planner_skill_loaded', turnId: turn.stream.turnId, skill: skillLoadNotice(skill) });
    return true;
  }

  /**
   * Hand the open turn a plan (already validated) or a task edit. The turn
   * settles with it exactly as with the same plan or ops parsed out of its
   * reply, and it wins over any envelope that reply carries. A later
   * submission replaces an earlier one. False when no user turn is open.
   */
  submit(submission: PlannerSubmission): boolean {
    const turn = this.openTurn;
    if (!turn) return false;
    turn.submitted = submission;
    this.showHeld(turn, submission);
    return true;
  }

  /**
   * Tell surfaces what the turn's edit would leave, from the same applier that
   * lands it, so an edit that would not apply shows nothing. It stays shown
   * from the moment it is handed in until it lands, is refused, or the turn
   * ends: the backend's reply claims it, but it has not landed by then.
   */
  private showHeld(turn: UserTurn, held: PlannerSubmission | null): void {
    const result = held?.kind === 'task_ops' ? this.host.planChanges.checkNow({ kind: 'ops', ops: held.ops }, 'land') : undefined;
    if (!result?.ok) {
      this.clearHeld(turn);
      return;
    }
    turn.heldShown = true;
    this.host.broadcast({ type: 'plan_edit_held', held: { turnId: turn.stream.turnId, tasks: heldEditTasks(this.host.tasks(), result.tasks) } });
  }

  private clearHeld(turn: UserTurn): void {
    if (!turn.heldShown) return;
    turn.heldShown = false;
    this.host.broadcast({ type: 'plan_edit_held', held: null });
  }

  /**
   * The edit the open turn already holds, for a further edit in the same reply
   * to join rather than replace. Empty when it holds nothing; null when it holds
   * a whole plan, which an edit cannot be layered on.
   */
  pendingOps(): TaskOp[] | null {
    const held = this.openTurn?.submitted;
    if (!held) return [];
    return held.kind === 'task_ops' ? held.ops : null;
  }

  /**
   * A read the planner makes through a tool. It spends the same per-turn budget
   * as an envelope read, so a planner cannot read more by switching channels:
   * past the soft limit, or on a repeated question, the answer still comes but
   * is told to land the turn; at the hard limit it is refused. `signature`
   * names the question, for the repeat check.
   */
  async read<T>(signature: string, answer: () => Promise<T>): Promise<ToolRead<T>> {
    const reads = this.openTurn?.reads;
    if (!reads) return { status: 'answered', value: await answer(), landNow: false };
    const spent = spendRead(reads, signature);
    if (spent === 'refused') return { status: 'refused' };
    return { status: 'answered', value: await answer(), landNow: spent === 'land' };
  }

  /** Whether the model still holds this conversation in memory. */
  get isActive(): boolean {
    return this.host.aiService().hasActiveConversation();
  }

  /** Call inside the host's mutation ritual. */
  append(role: ConversationMessage['role'], content: string, opts: { timestamp?: string; kind?: ConversationMessage['kind']; runs?: ReplyRun[]; actor?: ConversationMessage['actor'] } = {}): void {
    this.appendEntries([{
      role, content, timestamp: opts.timestamp ?? new Date().toISOString(),
      ...(opts.kind ? { kind: opts.kind } : {}), ...(opts.actor ? { actor: opts.actor } : {}), ...(opts.runs ? { runs: opts.runs } : {}),
    }]);
  }

  private appendEntries(entries: ConversationMessage[]): void {
    const plan = this.host.plan();
    if (plan) plan.conversationHistory = [...(plan.conversationHistory ?? []), ...entries];
  }

  /** Swap the whole transcript. The live context no longer matches it, so pair with {@link reset}. */
  replace(messages: readonly ConversationMessage[]): void {
    const plan = this.host.plan();
    if (plan) plan.conversationHistory = [...messages];
  }

  /**
   * The plan scope this conversation served is gone: drop the live model
   * context, and what the planner was told outside the transcript in it (see
   * {@link PlannerBriefing}). Idempotent; the harness backend holds an OS
   * process here, so callers never gate it on {@link isActive}.
   */
  reset(): void {
    this.dropContext();
    this.blocks.restart();
    this.briefing.clear();
  }

  /** A run update for the planner's next turn, whoever opens it (ADR-0029). */
  tellRunUpdate(text: string): void {
    this.briefing.runUpdate(text);
  }

  /** Drop the live model context alone: the next turn replays from the transcript. */
  private dropContext(): void {
    this.host.aiService().reset();
    this.blocks.forget();
  }

  /**
   * The user messages a rewind may land before. The opening message is the
   * goal: cutting it leaves a conversation about nothing, which is a new
   * session, not a rewind. After a compaction the summary entry, always
   * first, plays the goal's part: what it replaced is gone, so a rewind stops
   * at it.
   */
  rewindTargets(): RewindTarget[] {
    // An opening that hit the planner's usage limit left its failure ahead of the goal.
    const opener = this.transcript.findIndex((m) => m.kind !== 'error');
    return this.transcript.flatMap((m, index) => {
      if (!isUserMessage(m) || index === opener) return [];
      const line = m.content.split('\n')[0];
      const preview = line.length > REWIND_PREVIEW_WIDTH ? `${line.slice(0, REWIND_PREVIEW_WIDTH - 1)}…` : line;
      return [{ index, preview, content: m.content, timestamp: m.timestamp }];
    });
  }

  /**
   * Replace the transcript with a summary of it, keeping the last two
   * exchanges as they were, and drop the live context so the next message
   * replays from the shorter record.
   *
   * The summary is one hidden turn through whichever planner is configured —
   * on the live context when it still matches, replayed from the transcript
   * when not — so the compaction is the same for a vendor API and a harness
   * agent. Whatever the turn emits besides the summary is discarded, ops
   * included: it condenses the conversation, never the plan. Nothing is
   * written until the summary is in hand, so a failed or stopped turn leaves
   * the transcript exactly as it was.
   */
  async compact(signal?: AbortSignal): Promise<ConversationCompaction> {
    this.assertIdle('condense the conversation');
    const plan = this.host.plan();
    if (!plan) throw new ConversationEditError('No planning conversation to condense');
    if (!keptTail(this.transcript)) {
      throw new ConversationEditError('The conversation is too short to condense: it takes more than two exchanges before a summary saves anything.');
    }
    // A planner turn, so a message sent while it runs is refused: the reply
    // would share the summary turn's live context, which the compaction resets
    // as it lands, and its message would be condensed away or left dangling.
    const { turn, release } = this.claim({ refuseAs: 'condense the conversation' }, signal);
    try {
      const summary = await this.summarize(turn.signal);
      const tail = keptTail(this.transcript);
      if (this.host.plan() !== plan || !tail) throw new ConversationEditError('The conversation changed while it was being condensed: nothing was replaced.');
      const now = new Date().toISOString();
      const content = condensedNotice(summary);
      this.host.mutate(() => {
        plan.conversationHistory = [{ role: 'assistant', content, timestamp: now, kind: 'compaction' }, ...tail];
        return true;
      }, () => {
        this.host.broadcast({ type: 'planner_message', content, timestamp: now });
        this.host.broadcastPlan();
      });
      return { summary, keptMessages: tail.length };
    } catch (err) {
      throw interrupted(turn, err);
    } finally {
      // Success and failure alike: the live context either holds the
      // conversation this replaced or a summary exchange nobody kept. An
      // abandoned compaction's context was dropped by whatever abandoned it,
      // and a reset now would cut off the turn that has the backend since.
      if (!turn.abandoned) this.dropContext();
      release();
    }
  }

  private async summarize(signal: AbortSignal): Promise<string> {
    const ai = this.host.aiService();
    const request = summaryRequest(this.planRows()?.map(({ line }) => line) ?? null);
    // Only liveness and spend get through: streamed prose or research steps
    // from this turn would land in the chat as if the planner had said them.
    // Its calls are counted like any turn's, but the context they measure is
    // dropped as the turn ends, condensed or not, so they move no meter.
    const onProgress = (p: ResearchProgress) => {
      if (p.type === 'liveness') this.host.onProgress(p);
      else if (p.type === 'usage' && p.record) this.host.onProgress({ ...p, record: { ...p.record, aggregate: true } });
    };
    let turn: ConversationTurn;
    if (this.canContinueLive()) {
      ai.pruneContext?.();
      turn = await ai.continueConversation(request, onProgress, signal);
    } else {
      turn = await this.resume(await this.reopen(), request, [...this.transcript], signal, onProgress);
    }
    // Not a ConversationEditError: the caller's catch turns an aborted turn into
    // the stop or discard it was, which a surface answers differently from a refusal.
    if (signal.aborted) throw new Error('Condensing was stopped: the conversation is unchanged.');
    const summary = extractSummary(turn.text);
    if (!summary) throw new ConversationEditError('The planner returned no summary, so the conversation is unchanged. Try again.');
    return summary;
  }

  /**
   * A copy of the dialogue record for a forked session to carry. Refused
   * mid-turn: the copy would hold the user's message without the reply to it.
   * The live context is not part of it — the fork replays from this record on
   * its first turn, like any adopted session.
   */
  clone(): ForkedDialogue {
    this.assertIdle('fork the conversation');
    const plan = this.host.plan();
    return structuredClone({
      conversationHistory: plan?.conversationHistory ?? [],
      researchLog: plan?.researchLog ?? [],
    });
  }

  /**
   * A copy of the dialogue as it stood just before the user message at
   * `index` (a position from {@link rewindTargets}) — what a rewind forks
   * from — plus that message's full text, for a surface to offer back. This
   * conversation is not touched. The research trace is cut at the same point
   * by time: its entries carry no link to the message that caused them.
   */
  cloneBefore(index: number): RewoundDialogue {
    this.assertIdle('rewind the conversation');
    if (!this.rewindTargets().some((t) => t.index === index)) {
      if (index > 0) throw new ConversationEditError(`No user message at position ${index} to rewind to.`);
      throw new ConversationEditError(this.transcript[0]?.kind === 'compaction'
        ? 'The conversation was condensed there: a rewind cannot reach back past the summary.'
        : 'The first message is the goal: start a new session to change it.');
    }
    const { content: rewoundMessage, timestamp: cutoff } = this.transcript[index];
    return {
      dialogue: structuredClone({
        conversationHistory: this.transcript.slice(0, index),
        researchLog: (this.host.plan()?.researchLog ?? []).filter((e) => e.timestamp < cutoff),
      }),
      rewoundMessage,
    };
  }

  /**
   * What the skill check of a landed plan or edit warned about, kept in the
   * transcript so every surface shows it, on reload too, and not only the
   * planner that may have read it in a tool result. Call inside the host's
   * mutation ritual, so the broadcast plan carries it.
   */
  recordSkillWarnings(warnings: readonly string[], timestamp?: string): void {
    if (warnings.length === 0) return;
    this.append('assistant', ['Skill check:', ...warnings.map((w) => `- ${w}`)].join('\n'), { kind: 'system', timestamp });
  }

  /**
   * A call at the command seam (ADR-0029), kept where it happened in the
   * dialogue: a reload shows it, and a planner replayed from the transcript
   * knows what was started or stopped, and by whom. Call inside the host's
   * mutation ritual.
   */
  recordExecution(record: ExecutionRecord, text: string): void {
    this.appendEntries([{ role: 'assistant', content: text, timestamp: record.at, kind: 'execution', execution: record }]);
  }

  /**
   * Open the conversation on the host's fresh plan: the goal is its first
   * message. `prepare` (discovery) runs inside the turn, so a stop reaches it.
   */
  async start(goal: SkillInvocation, prepare: () => Promise<ConversationOpening>, signal?: AbortSignal): Promise<LegacyPlanState> {
    return this.userTurn('supersede', goal, signal, async (userTurn) => {
      const opening = await prepare();
      this.assertCurrent(userTurn);
      // Held like any turn's input: an opening that never lands — a usage
      // limit, then its goal waits to be sent again — leaves no goal behind.
      const now = new Date().toISOString();
      this.holdWrites(userTurn, this.userEntries(goal, now), [this.userPrompt(goal.text, now)]);
      this.briefing.opened(opening.autorun ?? false);
      this.blocks.restart();
      const turn = await this.host.aiService().startConversation({
        ...opening,
        // The system prompt's goal is the text as typed; skill bodies ride the
        // first message alone, so the planner holds each one once.
        goal: goal.text,
        initialMessage: plannerInput([plannerMessage(goal.text, goal.skills)]),
        onProgress: userTurn.stream.sink(),
        signal: userTurn.signal,
      });
      const settleable = await this.drainTaskQueries(turn, userTurn);
      this.assertNotLimited(settleable, userTurn);
      return this.settle(settleable, userTurn);
    });
  }

  /**
   * Every later user message, to a persisted outcome. A turn that throws lands
   * nothing: what it held is dropped with it, so session memory never drifts
   * from disk and the UI.
   */
  async reply(message: string | SkillInvocation, options: ReplyOptions = {}): Promise<LegacyPlanState> {
    const sent = typeof message === 'string' ? { text: message, skills: [] } : message;
    const wakeUps = options.wakeUps ?? [];
    // Refused while any turn is live: two would interleave their transcript
    // appends, and each would settle on the other's open turn.
    return this.userTurn({ refuseAs: 'send a message' }, sent, options.signal, (userTurn) => {
      userTurn.onCommit = options.onCommit;
      return this.replyTurn(sent, wakeUps, userTurn);
    }, { wakeUps, wakeUp: options.wakeUp, forced: options.forced });
  }

  private async replyTurn(message: SkillInvocation, wakeUps: readonly string[], userTurn: UserTurn): Promise<SettledTurn> {
    const { signal } = userTurn;
    const plan = this.requirePlan();
    const priorHistory = plan.conversationHistory ?? [];
    const now = new Date().toISOString();
    const fromUser = wakeUps.length === 0 || message.text !== '' || message.skills.length > 0;
    // Held, not written: a save mid-turn must never land these in the
    // transcript while their pending turns still hold them (ADR-0029).
    // Deferring the write — rather than tagging the entries and skipping them
    // on replay — is what keeps the transcript and `pendingTurns` from ever
    // holding the same input after a save; the two leave together in the save
    // that lands the outcome.
    const entries: ConversationMessage[] = wakeUps.map((content): ConversationMessage => ({ role: 'user', content, timestamp: now, kind: 'wake_up' }));
    if (fromUser) entries.push(...this.userEntries(message, now, userTurn.forced));
    this.holdWrites(userTurn, entries, fromUser ? [this.userPrompt(message.text, now)] : []);

    // Decided before the briefing is built: a replay's opening states autorun
    // and the runners itself, so the briefing says neither again.
    const reopened = this.canContinueLive() ? null : await this.reopen(userTurn);
    userTurn.briefing = this.briefing.brief();
    // The persisted transcript keeps the raw user message; the model gets the
    // catalog and the current plan (tasks, statuses, edit protocol — once
    // tasks exist) alongside it, whole where its live context holds no copy
    // and as what changed where it does (ADR-0012 T10).
    userTurn.blocks = this.blocks.next();
    const contextBlock = [...userTurn.blocks.blocks, ...userTurn.briefing.blocks].join('\n\n');
    const said = fromUser ? plannerMessage(message.text, message.skills) : '';
    const outgoing = plannerInput([contextBlock, ...wakeUps, userTurn.wakeUp?.brief, said]);

    const turn = reopened
      ? await this.resume(reopened, outgoing, priorHistory, signal, userTurn.stream.sink())
      : await this.host.aiService().continueConversation(outgoing, userTurn.stream.sink(), signal);

    const settleable = await this.drainTaskQueries(turn, userTurn);
    this.assertNotLimited(settleable, userTurn);
    if (userTurn.wakeUp) this.assertWakeUpAnswered(settleable, userTurn);
    this.assertCurrent(userTurn);
    return this.settle(settleable, userTurn);
  }

  /**
   * A wake-up turn lands only a real answer. Stopped — by the user, or by its
   * timeout — it lands nothing, not the fragment a backend hands back; a
   * failure is thrown rather than shown, for the supervisor to retry
   * (ADR-0029).
   */
  private assertWakeUpAnswered(turn: SettleableTurn, userTurn: UserTurn): void {
    if (userTurn.signal.aborted) throw new PlannerTurnStoppedError();
    if (turn.kind === 'message' && turn.failed) throw new PlannerTurnFailedError(turn.text);
  }

  /**
   * A turn that ended on the planner's usage limit lands nothing: what it held
   * is dropped, its failure is kept in its place, and the limit's wait is armed
   * in the same save. Only a turn Ordewell started gets here, so a limit is
   * never acted on for a planner nobody asked anything of.
   */
  private assertNotLimited(turn: SettleableTurn, userTurn: UserTurn): void {
    if (turn.kind !== 'message' || !turn.failed || userTurn.signal.aborted) return;
    const said: TurnFailure = { message: turn.text, usageLimit: turn.usageLimit };
    if (classifyRunnerStop(said) !== 'usage-limit') return;
    this.assertCurrent(userTurn);
    const limit = this.host.usageLimit(said);
    this.host.mutate(() => {
      this.recordFailure(limit.text);
      return true;
    }, () => this.host.broadcastPlan());
    throw new PlannerUsageLimitError(limit);
  }

  /**
   * A failure kept in the transcript, drawn as one on reload too, and never
   * replayed to the planner. Stamped after the newest entry: surfaces take
   * only entries newer than the last they synced.
   */
  private recordFailure(text: string): void {
    const newest = this.transcript.reduce((latest, e) => Math.max(latest, Date.parse(e.timestamp) || 0), 0);
    this.append('assistant', text, { kind: 'error', timestamp: new Date(Math.max(Date.now(), newest + 1)).toISOString() });
  }

  private assertIdle(operation: string): void {
    if (this.isTurnInFlight) throw new ConversationBusyError(operation);
  }

  /** Refuse to land a turn that no longer belongs here: it was abandoned, or its plan is no longer the host's. */
  private assertCurrent(userTurn: UserTurn): void {
    if (userTurn.planner.abandoned || this.host.plan() !== userTurn.plan) throw new PlannerTurnDiscardedError();
  }

  /**
   * {@link assertCurrent} on the far side of an await that precedes a plan
   * mutation: the skill check waits on git, and a stop, rewind or session
   * switch in that window drops the edit instead of landing it on whatever
   * plan is current by then. A stop counts here because nothing has landed
   * yet — the user asked for the turn to end before it changed the plan.
   */
  private assertStillCurrent(userTurn: UserTurn): void {
    this.assertCurrent(userTurn);
    if (userTurn.signal.aborted) throw new PlannerTurnStoppedError();
  }

  /**
   * A live conversation is only safe to continue in-place when it also
   * matches the model/effort configured right now — a harness planner's
   * running process was spawned with the old one baked in and cannot pick up
   * a switch (ADR-0009). Otherwise the turn resumes from the transcript.
   */
  private canContinueLive(): boolean {
    const ai = this.host.aiService();
    return ai.hasActiveConversation() && (ai.conversationMatchesConfig?.() ?? true);
  }

  /**
   * Bracket one user turn with its start and end, under an id minted here:
   * the turn is where the stream a surface draws begins and ends, and only the
   * conversation sees all of it — every backend call, read and retry.
   */
  private async userTurn(
    admission: TurnAdmission,
    prompt: SkillInvocation,
    signal: AbortSignal | undefined,
    run: (turn: UserTurn) => Promise<SettledTurn>,
    delivered: { wakeUps?: readonly string[]; wakeUp?: WakeUpTurn; forced?: boolean } = {},
  ): Promise<LegacyPlanState> {
    const { turn: planner, release } = this.claim(admission, signal);
    const turnId = uuidv4();
    const subagents = new SubagentRuns();
    // The turn's own stream: a subagent it started that reports after the turn
    // is gone reaches only the turn's own record, which nothing will write.
    const stream = new TurnStream(turnId, (p) => {
      subagents.observe(p);
      this.host.onProgress(p);
    });
    const { wakeUp, forced } = delivered;
    const turn: UserTurn = {
      stream, planner, signal: planner.signal, plan: this.host.plan(), reads: freshReadBudget(wakeUp), narration: [],
      writes: { entries: [], research: [], subagents },
      ...(wakeUp ? { wakeUp } : {}), ...(forced ? { forced } : {}),
    };
    this.openTurn = turn;
    const skills = prompt.skills.map(skillLoadNotice);
    const wakeUps = delivered.wakeUps ?? [];
    this.host.broadcast({
      type: 'planner_turn_started', turnId, prompt: prompt.text,
      ...(skills.length > 0 ? { skills } : {}),
      ...(wakeUps.length > 0 ? { wakeUps: [...wakeUps] } : {}),
      ...(bySupervisor(wakeUp) ? { supervisor: true } : {}),
      ...(forced ? { forced: true } : {}),
    });
    let outcome: PlannerTurnOutcome = 'error';
    try {
      const settled = await run(turn);
      outcome = settled.outcome;
      return settled.plan;
    } catch (err) {
      if (err instanceof PlannerTurnDiscardedError) {
        outcome = 'stopped';
        throw err;
      }
      throw interrupted(planner, err);
    } finally {
      if (this.openTurn === turn) this.openTurn = null;
      this.clearHeld(turn);
      // Released before the end is announced, so a surface that sends its
      // next message on hearing it is not refused by the turn it heard end.
      release();
      // A stop can still settle — a backend hands back what it had as a
      // message — but the user asked for it to end, and that is what it did.
      if (!turn.ended) this.host.broadcast({
        type: 'planner_turn_ended', turnId, outcome: planner.signal.aborted ? 'stopped' : outcome,
        ...(planner.forceSent ? { forceSent: true } : {}),
      });
    }
  }

  private requirePlan(): LegacyPlanState {
    const plan = this.host.plan();
    if (!plan) throw new Error('No active plan state');
    return plan;
  }

  /** The message as typed, then one entry per skill it loaded, sharing its timestamp so a reload keeps them together. */
  private userEntries({ text, skills }: SkillInvocation, timestamp: string, forced?: boolean): ConversationMessage[] {
    return [
      { role: 'user', content: text, timestamp, ...(forced ? { forced: true } : {}) },
      ...skills.map((skill): ConversationMessage => ({ role: 'user', content: skillLoadLabel(skill), timestamp, kind: 'skill_load', skill })),
    ];
  }

  private userPrompt(content: string, timestamp: string): ResearchLogEntry {
    return { id: `up-${Date.now()}`, type: 'user_prompt', content, timestamp };
  }

  /** Hold what the turn writes until it lands, each entry where the transcript stands now; see {@link TurnWrites}. */
  private holdWrites(userTurn: UserTurn, entries: readonly ConversationMessage[], research: readonly ResearchLogEntry[] = []): void {
    const at = this.transcript.length;
    userTurn.writes.entries.push(...entries.map((entry) => ({ at, entry })));
    userTurn.writes.research.push(...research);
  }

  /**
   * The one mutation that lands a turn's outcome (ADR-0029). What the turn held
   * goes in first — each entry where it belongs, ahead of what was written
   * after it, then the research and the subagents — so the transcript reads in
   * the order it happened and the inputs leave the plan's pending turns in the
   * save that carried their answer. `outcome` makes the turn's change to the
   * plan and returns what the turn said, which is written, then sent in that
   * order; `announce` follows it on every surface. The turn's briefing is told
   * unless the planner gave no answer (`unheard`): a failure, or a stop.
   */
  private land(
    userTurn: UserTurn,
    researchLog: ResearchLogEntry[],
    outcome: () => Landed[],
    { skillWarnings = [], announce, unheard = false }: { skillWarnings?: readonly string[]; announce?: () => void; unheard?: boolean } = {},
  ): LegacyPlanState {
    const { turnId } = userTurn.stream;
    const now = new Date().toISOString();
    // A supervisor's words and edits are drawn as the supervisor's, so the user can tell what changed on its own.
    const supervisor = bySupervisor(userTurn.wakeUp);
    let said: Landed[] = [];
    const plan = this.host.mutate(() => {
      this.writeHeld(userTurn, researchLog);
      said = outcome();
      for (const { content, kind, runs } of said) this.append('assistant', content, { timestamp: now, kind: kind ?? (supervisor ? 'supervisor' : undefined), runs });
      this.recordSkillWarnings(skillWarnings, now);
      userTurn.onCommit?.();
      return true;
    }, () => {
      for (const { content, kind, runs } of said) {
        if (kind !== 'plan_generated') this.host.broadcast({ type: 'planner_message', content, timestamp: now, turnId, ...(supervisor ? { supervisor: true } : {}), ...withRuns(runs) });
      }
      announce?.();
    });
    if (!unheard) {
      userTurn.briefing?.heard();
      if (!userTurn.repaired) userTurn.blocks?.heard();
    }
    this.warnSkills(skillWarnings);
    return plan!;
  }

  private writeHeld(userTurn: UserTurn, researchLog: ResearchLogEntry[]): void {
    const plan = this.requirePlan();
    const { entries, research, subagents } = userTurn.writes;
    const history = [...(plan.conversationHistory ?? [])];
    // Past the held entries already placed, which all belong at or before it.
    entries.forEach(({ at, entry }, placed) => history.splice(Math.min(at + placed, history.length), 0, entry));
    plan.conversationHistory = history;
    this.recordResearch([...research, ...researchLog]);
    // After the turn's own research, which a harness planner logs a subagent's steps in too: they are regrouped under it.
    plan.researchLog = subagents.foldInto(plan.researchLog ?? []);
  }

  private recordResearch(entries: ResearchLogEntry[]): void {
    const plan = this.host.plan();
    // A `load_skill` body is kept by its skill-load entry, never by the trace.
    if (plan) plan.researchLog = [...(plan.researchLog ?? []), ...entries.map((e) => ('type' in e ? e : surfaceStep(e)))];
  }

  /**
   * The opening a replay starts under, read fresh, the live context dropped
   * first; what it states of autorun and the runners is what the planner is
   * told by it. A turn abandoned while the opening was read stops here: the
   * backend may be its successor's by now.
   */
  private async reopen(userTurn?: UserTurn): Promise<ConversationOpening> {
    const opening = await this.host.opening(this.requirePlan().runners);
    if (userTurn) this.assertCurrent(userTurn);
    // Explicit rather than left to each backend's start: a replay begins from
    // the transcript alone, which for a harness planner means its native
    // session id goes too — otherwise the agent's own memory of the old
    // dialogue could ride along under the replayed one.
    this.dropContext();
    this.briefing.opened(opening.autorun ?? false);
    return opening;
  }

  /**
   * Reopen the model context from the transcript — because the in-memory one
   * is gone (session reload, extension restart), or because it is stale
   * against the planner config now in effect. No LLM call happens for the
   * replayed turns; the first call is the one the user's message opens.
   */
  private resume(
    opening: ConversationOpening,
    message: string,
    priorHistory: ConversationMessage[],
    signal: AbortSignal,
    onProgress: (progress: ResearchProgress) => void,
  ): Promise<ConversationTurn> {
    const replayed = plannerTranscript(priorHistory);
    // The opening message as typed, unless a compaction has since condensed it
    // away. Its skill bodies replay with it in the transcript, not in the goal.
    const opener = priorHistory[0] && isUserMessage(priorHistory[0]) ? priorHistory[0].content : undefined;
    const goal = opener || this.host.goal() || message;
    return this.host.aiService().startConversation({
      ...opening,
      runners: this.requirePlan().runners,
      goal,
      onProgress,
      signal,
      priorHistory: replayed,
      initialMessage: message,
    });
  }

  /**
   * Answer every read the planner emits until it says something else.
   *
   * The channel is a text envelope rather than a registered tool because the
   * protocol has to be identical on both planner backends (ADR-0009): Ordewell
   * owns a tool loop only in the API case, and a harness planner running as a
   * coding-agent subprocess can only be reached this way.
   *
   * Draining here — outside {@link repairLoop} — is what keeps reads free of
   * the repair budget. A planner that looks a task up and *then* fumbles its
   * ops JSON still gets its two corrective retries; charging it for the read
   * would cost it the chance to fix the edit.
   */
  private async drainTaskQueries(turn: ConversationTurn, userTurn: UserTurn): Promise<SettleableTurn> {
    const { reads, signal, stream } = userTurn;
    const ai = this.host.aiService();
    const carried: ConversationTurn['researchLog'] = [];
    let current = this.claimSubmission(turn, userTurn);
    while (current.kind === 'task_query') {
      carried.push(...current.researchLog);
      userTurn.narration.push(...current.runs ?? []);
      const spent = ai.hasActiveConversation() && !signal.aborted ? spendRead(reads, taskQuerySignature(current.query)) : 'refused';
      if (spent === 'refused') {
        const text = 'The planner kept asking to read tasks instead of answering. Nothing was changed: ask again, or be more specific about the edit you want.';
        // The reads' narration is the turn's already.
        return { kind: 'message', text, researchLog: carried, ...(current.runs ? { runs: [noteRun(text)] } : {}) };
      }
      const answer = this.taskQueryAnswer(current.query);
      current = this.claimSubmission(await ai.continueConversation(
        spent === 'land' ? `${answer}\n\n${TASK_QUERY_ANSWER_OR_OPS}` : answer,
        stream.sink(),
        signal,
      ), userTurn);
    }
    return this.failedIfCutOff(carried.length > 0
      ? { ...current, researchLog: [...carried, ...current.researchLog] }
      : current, userTurn);
  }

  /**
   * A call cut off by something other than the turn's own stop failed: what it
   * hands back is a fragment of an answer, and the turn keeps what it was sent,
   * as any failure does. Nothing of Ordewell's resets a backend under a turn on
   * the same plan (see `PlannerBackend`); one that changes the plan abandons the turn.
   */
  private failedIfCutOff(turn: SettleableTurn, userTurn: UserTurn): SettleableTurn {
    if (turn.kind !== 'message' || !turn.aborted || userTurn.signal.aborted) return turn;
    return { kind: 'message', text: CUT_OFF, researchLog: turn.researchLog, failed: true, ...writtenOver(turn.runs, CUT_OFF) };
  }

  /**
   * The backend's answer, with what was handed in while it ran standing in
   * for whatever its reply carried. Taken once: a corrective re-send after a
   * rejected edit must not settle on the same submission again. A stopped
   * turn commits nothing, the same as a stopped reply with a plan in it.
   */
  private claimSubmission(turn: ConversationTurn, userTurn: UserTurn): ClaimedTurn {
    const submitted = userTurn.submitted;
    userTurn.submitted = undefined;
    if (!submitted || userTurn.signal.aborted) return turn;
    const { text, researchLog, runs } = turn;
    // The backend settled its reply as a message, so the reply is shown from
    // here, settled where its runs streamed, or not at all.
    const said = text.trim() ? { said: text } : {};
    const shown = runs ? { runs } : {};
    return submitted.kind === 'plan'
      ? { kind: 'plan', tasks: submitted.tasks, text, researchLog, ...shown, ...said }
      : { kind: 'task_ops', ops: submitted.ops, text, researchLog, ...shown, ...said };
  }

  /**
   * Render one read out of live state. Never persisted to the transcript: the
   * detail is context for the planner's next reply, and re-sending it on every
   * later turn is exactly the cost this channel exists to avoid.
   */
  private taskQueryAnswer(query: TaskQuery): string {
    return renderTaskQueryAnswer(query, this.host.tasks(), this.host.catalog(), this.host.liveOutput);
  }

  /**
   * Drive a planner turn, its reads already drained, to a persisted, broadcast
   * outcome. Task edits apply atomically; validation failures are fed back to
   * the model for up to 2 silent retries, then surfaced as a message with the
   * plan untouched. The first turn and every later turn route through here —
   * one path, not two.
   */
  private async settle(turn: SettleableTurn, userTurn: UserTurn): Promise<SettledTurn> {
    type Settled = SettledTurn | { turn: CommitTurn };
    const { signal, stream } = userTurn;
    const ai = this.host.aiService();
    // A planner with tools submits through them alone, so its correctives ask for a tool call, not JSON.
    const tools = ai.plannerToolsAttached?.() ?? false;
    const refusal = (text: string, { researchLog, runs }: SettleableTurn): Settled => ({ turn: { kind: 'message', text, researchLog, ...writtenOver(runs, text) } });
    const invalidOps = (errors: string[], t: SettleableTurn): Settled =>
      refusal(`I tried to modify the tasks, but the changes were invalid:\n- ${errors.join('\n- ')}\n\nThe plan is unchanged. Rephrase the request, or adjust the tasks manually.`, t);
    const invalidPlan = (errors: string[], t: SettleableTurn): Settled =>
      refusal(`I tried to commit a plan, but it was invalid:\n- ${errors.join('\n- ')}\n\nThe plan is unchanged. Rephrase the request, or adjust the tasks manually.`, t);

    let discarding = turn;
    const settled = await repairLoop<SettleableTurn, Settled>({
      first: async () => turn,
      // The retry answers in place of the discarded attempt's reply and the
      // plan display it streamed, never of the narration before its calls,
      // nor of the calls themselves: the turn lands with their research.
      resend: async (corrective) => {
        userTurn.repaired = true;
        userTurn.narration.push(...(discarding.runs ?? []).filter((run) => run.narration));
        stream.retract(new Set(userTurn.narration.map((run) => run.segmentId)));
        const retry = await this.drainTaskQueries(await ai.continueConversation(corrective, stream.sink(), signal), userTurn);
        return { ...retry, researchLog: [...discarding.researchLog, ...retry.researchLog] };
      },
      interpret: async (t) => {
        discarding = t;
        const refused = t.kind === 'plan' || t.kind === 'task_ops' ? userTurn.wakeUp?.refused(t.kind === 'plan' ? 'plan' : 'edit') : undefined;
        if (refused) {
          this.clearHeld(userTurn);
          const errors = [refused];
          if (!ai.hasActiveConversation() || signal.aborted) return { done: (t.kind === 'plan' ? invalidPlan : invalidOps)(errors, t) };
          return { retry: { errors, corrective: refused } };
        }
        if (t.kind === 'plan' && this.host.isExecuting()) {
          const errors = [WHOLE_PLAN_WHILE_RUNNING];
          if (!ai.hasActiveConversation() || signal.aborted) return { done: invalidPlan(errors, t) };
          return { retry: { errors, corrective: (tools ? resubmitEditPrompt : taskOpsRejectedPrompt)(errors) } };
        }
        if (t.kind === 'plan') {
          this.assertCurrent(userTurn);
          const landed = await this.commitPlan(t, userTurn);
          if ('plan' in landed) return { done: { plan: landed.plan, outcome: 'plan' } };
          const { errors } = landed;
          if (!ai.hasActiveConversation() || signal.aborted) return { done: invalidPlan(errors, t) };
          return { retry: { errors, corrective: tools ? resubmitPlanPrompt(errors) : reEmitPlanPrompt(errors.join('; ')) } };
        }
        if (t.kind !== 'task_ops') return { done: { turn: t } };
        this.assertCurrent(userTurn);
        const applied = await this.applyTaskOps(t, userTurn);
        if ('plan' in applied) return { done: { plan: applied.plan, outcome: 'task_ops' } };
        // No live conversation (or an abort) means no corrective re-send is
        // possible — surface the failure instead of retrying into the void.
        if (!ai.hasActiveConversation() || signal.aborted) {
          return { done: invalidOps(applied.errors, t) };
        }
        return { retry: { errors: applied.errors, corrective: (tools ? resubmitEditPrompt : taskOpsRejectedPrompt)(applied.errors) } };
      },
      maxRepairs: 2,
      onExhausted: ({ reply, errors }) => (reply.kind === 'plan' ? invalidPlan : invalidOps)(errors, reply),
    });

    if ('plan' in settled) return settled;
    this.assertCurrent(userTurn);
    return { plan: this.commit(settled.turn, userTurn), outcome: settled.turn.kind };
  }

  /** A name not found at submit only warns: a task the attaching one depends on may create it. */
  private warnSkills(warnings: readonly string[]): void {
    for (const warning of warnings) this.host.notice('warn', warning);
  }

  /**
   * Check a task_ops turn as it lands and commit it atomically: what passed
   * lands in the tick the check's rules ran in. Returns the errors on
   * rejection (plan untouched).
   */
  private async applyTaskOps(turn: Extract<SettleableTurn, { kind: 'task_ops' }>, userTurn: UserTurn): Promise<{ plan: LegacyPlanState } | { errors: string[] }> {
    this.requirePlan();
    const landed: { plan?: LegacyPlanState } = {};
    const checked = await this.host.planChanges.check({ kind: 'ops', ops: turn.ops }, 'land', (passed) => {
      // The skill check waits on git, which a stop, rewind or session switch may outlast.
      this.assertStillCurrent(userTurn);
      const said = this.said(turn, userTurn);
      landed.plan = this.land(userTurn, turn.researchLog, () => {
        this.host.adoptTasks(passed.tasks, 'edit');
        return [...(said ? [said] : []), { content: `Tasks updated:\n- ${passed.summary.join('\n- ')}` }];
      }, {
        skillWarnings: passed.warnings,
        announce: () => {
          this.host.broadcastPlan();
          // After the plan that carries it, so the edit is never missing from both.
          this.clearHeld(userTurn);
        },
      });
    });
    this.assertStillCurrent(userTurn);
    if (landed.plan) return { plan: landed.plan };
    return this.refusedHeld(userTurn, checked.ok ? [] : checked.errors.map(planChangeErrorText));
  }

  /**
   * Check a whole plan as it lands and commit it in the same tick, as an edit
   * is: it waited out the rest of its reply, so the runners it was accepted
   * against may be gone (ADR-0003 V1). Returns the errors on rejection.
   */
  private async commitPlan(turn: Extract<SettleableTurn, { kind: 'plan' }>, userTurn: UserTurn): Promise<{ plan: LegacyPlanState } | { errors: string[] }> {
    const landed: { plan?: LegacyPlanState } = {};
    const checked = await this.host.planChanges.check({ kind: 'plan', tasks: turn.tasks }, 'land', (passed) => {
      this.assertStillCurrent(userTurn);
      landed.plan = this.landPlan(turn, userTurn, passed);
    });
    this.assertStillCurrent(userTurn);
    if (landed.plan) return { plan: landed.plan };
    return { errors: checked.ok ? [] : checked.errors.map(planChangeErrorText) };
  }

  private landPlan(turn: Extract<SettleableTurn, { kind: 'plan' }>, userTurn: UserTurn, passed: PassedChange): LegacyPlanState {
    this.requirePlan();
    const said = this.said(turn, userTurn);
    return this.land(userTurn, turn.researchLog, () => {
      // A cheap model may emit the PRD block and the plan JSON in one turn —
      // capture the PRD here too so it isn't dropped with the plan preamble.
      this.host.capturePrd(turn.text);
      const count = this.host.adoptTasks(passed.tasks, 'commit');
      return [...(said ? [said] : []), { content: `Plan generated with ${count} task${count === 1 ? '' : 's'}.`, kind: 'plan_generated' }];
    }, { skillWarnings: passed.warnings, announce: () => this.host.broadcastPlan(userTurn.stream.turnId) });
  }

  /** The edit was refused as it landed: what it showed is not coming. */
  private refusedHeld(userTurn: UserTurn, errors: string[]): { errors: string[] } {
    this.clearHeld(userTurn);
    return { errors };
  }

  /** Commit a settled turn that changes nothing in the plan: what it said. */
  private commit(turn: CommitTurn, userTurn: UserTurn): LegacyPlanState {
    this.requirePlan();

    // Budget models occasionally return an empty content turn after tool use —
    // surface that visibly instead of rendering a blank bubble. A stopped turn
    // is empty because it was cut short, which is not the model's fault.
    const replied = turn.text.trim() !== '';
    const text = replied
      ? turn.text
      : userTurn.signal.aborted
        ? '(Stopped before replying.)'
        : '(The planner returned an empty response. Reply to continue, or rephrase your goal.)';
    const runs = this.shown(userTurn, replied ? turn.runs : writtenOver(turn.runs, text).runs, text);
    return this.land(userTurn, turn.researchLog, () => {
      this.host.capturePrd(text);
      return [{ content: text, runs }];
    }, { unheard: turn.failed === true || userTurn.signal.aborted });
  }

  /**
   * The runs a reply is saved and sent with (ADR-0017 A1): the narration the
   * turn kept from calls it did not settle on, then the reply's own. None from
   * a backend that reports no runs, whose reply then stands as one message.
   */
  private shown(userTurn: UserTurn, runs: readonly TurnRun[] | undefined, content: string): ReplyRun[] | undefined {
    const kept = userTurn.narration;
    if (!runs && kept.length === 0) return undefined;
    return [...kept, ...(runs ?? [noteRun(content)])].map(({ segmentId, text, startedAt }) => ({ segmentId, text, startedAt }));
  }

  /** What a plan or edit turn said beside what it landed: its reply, or an envelope's narration. */
  private said(turn: SettleableTurn, userTurn: UserTurn): { content: string; runs?: ReplyRun[] } | undefined {
    if (turn.said !== undefined) return { content: turn.said, runs: this.shown(userTurn, turn.runs, turn.said) };
    const narration = this.shown(userTurn, turn.runs ?? [], '') ?? [];
    return narration.length > 0 ? { content: joinRuns(narration), runs: narration } : undefined;
  }

  /**
   * The catalog the planner may actually draw from — model ids and task-mode
   * ids, per runner in the plan — before any plan exists or after. The system
   * prompt shows it in another shape, which the planner starts misquoting once
   * a long conversation has outlived it, so it is stated in a turn's message
   * as well: once per live context, and again when it changes (ADR-0012 T10).
   *
   * The host's catalog is allowlist-filtered, so a restricted allowlist stays a
   * hard bound on every turn, and reads the plan's runners live, so a runner
   * admitted mid-session by a retarget is shown like every other. A planner
   * with Ordewell's tools gets a reminder to read the catalog instead.
   */
  private catalogBlock(): string | null {
    if (!this.host.plan()) return null;
    if (this.host.aiService().plannerToolsAttached?.()) return PLANNER_TOOLS_REMINDER;
    const { runners, models, modes } = this.host.catalog();

    const modelLines = runners.map((runner) => {
      const list = models[runner] ?? [];
      const capped = list.slice(0, CATALOG_MODEL_CAP);
      const remainder = list.length - capped.length;
      const ids = capped.map((m) => m.modelId).join(', ') || '(no models discovered)';
      return `${runner}: ${ids}${remainder > 0 ? ` … +${remainder} more not shown` : ''}`;
    });

    const readOnly = readOnlyRunners(Object.fromEntries(runners.map((r) => [r, modes[r] ?? []])));

    return [
      '<available_models>',
      ...modelLines,
      '</available_models>',
      `<read_only_runners>${readOnly.join(', ') || '(none)'}</read_only_runners>`,
    ].join('\n');
  }

  /**
   * The "you are here" view for post-plan chat: current tasks with stable
   * references, plus the read and edit protocols. Never persisted, and built
   * fresh for every turn so the model sees live statuses — including which
   * tasks are locked by a running execution — whether its turn sends the
   * whole block or what changed (ADR-0012 T10).
   */
  private planView(): PlanView | null {
    if (!this.host.plan()) return null;
    const rows = this.planRows() ?? [];
    const tools = this.host.aiService().plannerToolsAttached?.() ?? false;
    // Gated on live runners, not on an armed scheduler: a paused-but-armed run
    // has nothing running to lock, and takes a whole plan as well as an edit.
    const locked = flattenTasksWithParents(this.host.tasks()).filter(({ task }) => task.status === 'in_progress');
    const running = this.host.isExecuting()
      ? `Execution is RUNNING${locked.length ? ` — these tasks are locked: ${locked.map(({ ref }) => ref).join(', ')}` : ''}. No new task starts until your reply ends; your task edits apply then, to tasks that have not started. An edit aimed at a running task is refused — the user can stop it first, or you can change it after it finishes. Do not submit a whole new plan while tasks run.`
      : '';
    const full = [
      '<current_plan>',
      ...rows.map(({ line }) => line),
      '</current_plan>',
      'The block above is the CURRENT task plan — short fields only. Choose how to respond:',
      '- To answer a question or discuss, reply in plain prose (no JSON).',
      tools ? TASK_READ_TOOLS_REMINDER : TASK_QUERY_REMINDER,
      ...taskOpsProtocol(running && `\n${running}`, tools),
    ].filter(Boolean).join('\n');
    return { rows, full, running, tools };
  }

  /** One line per task, subtasks indented under their parent, with stable references — null until the plan has tasks. */
  private planRows(): PlanRow[] | null {
    const tasks = this.host.tasks();
    if (!this.host.plan() || tasks.length === 0) return null;
    const rows = flattenTasksWithParents(tasks);
    const refOf = new Map(rows.map(({ task, ref }) => [task.id, ref]));
    const { modes } = this.host.catalog();
    const lineOf = ({ task: t, parent }: (typeof rows)[number]): string => {
      const refs = (ids: readonly string[]) => `[${ids.map((d) => refOf.get(d) ?? d).join(', ')}]`;
      // A script task runs on no runner, model or mode (ADR-0035): what it runs is its line.
      if (t.type === 'script') {
        return `${parent ? '  ' : ''}${refOf.get(t.id)} id=${t.id} "${t.title}" [${t.status}] type:SCRIPT ${scriptPlanField(t)} slice:${t.sliceType ?? '-'} deps:${refs(t.dependencies)}${waitNote(this.host.startWaits(t), refs)}`;
      }
      const isMan = t.type === 'user';
      // A MAN task has no model or mode to run under — the field that means
      // something there is how many steps the human still has to do. The
      // planner sees no mode name, only read-only (ADR-0031).
      const readOnly = t.taskMode !== undefined && t.taskMode === readOnlyMode(modes[t.assignedRunner]);
      const runFields = isMan
        ? `steps:${t.userSteps?.length ?? 0}`
        : `${t.assignedModel ? `model:${t.assignedModel.modelId} ` : ''}${readOnly ? 'read-only ' : ''}effort:${t.assignedModel?.thinkingEffort ?? '-'}`;
      return `${parent ? '  ' : ''}${refOf.get(t.id)} id=${t.id} "${t.title}" [${t.status}] type:${isMan ? 'MAN' : t.ops ? 'AI ops' : 'AI'} runner:${t.assignedRunner} ${runFields} autonomy:${t.autonomy ?? '-'} slice:${t.sliceType ?? '-'} deps:${refs(t.dependencies)}${t.skills?.length ? ` skills:[${t.skills.join(', ')}]` : ''}${waitNote(this.host.startWaits(t), refs)}`;
    };
    return rows.map((row) => ({ id: row.task.id, ref: row.ref, title: row.task.title, line: lineOf(row) }));
  }
}

/**
 * A script task's body as its plan line shows it: its commands whole, as the
 * planner would write them, or the first line of its script, which
 * `task_query` reads whole. Its time limit when it set one.
 */
function scriptPlanField(t: Task): string {
  const limit = t.timeoutMs !== undefined ? ` timeoutMs:${t.timeoutMs}` : '';
  if (t.commands) return `commands:${JSON.stringify(t.commands)}${limit}`;
  const lines = (t.script ?? '').trim().split('\n');
  return `script:${JSON.stringify(lines[0])}${lines.length > 1 ? ` (${lines.length} lines; task_query prompt reads it whole)` : ''}${limit}`;
}

/** Said already by a task's line — its status, its type — or by the note that execution is running. */
const SAID_ON_THE_LINE: ReadonlySet<StartWaitKind> = new Set<StartWaitKind>(['started', 'by-hand', 'start-hold']);

/** The first reason the start rule gives that the task's line does not already say, as a short field. */
function waitNote(waits: readonly StartWait[], refs: (ids: readonly string[]) => string): string {
  const wait = waits.find((w) => !SAID_ON_THE_LINE.has(w.kind));
  if (!wait) return '';
  switch (wait.kind) {
    case 'blocked': return ` waits:blocked${refs(wait.failed)}`;
    case 'dependencies':
    case 'queued': return ` waits:${wait.kind}${refs(wait.waiting)}`;
    case 'merge-gate': return ` waits:merge-gate${refs(wait.unmerged)}`;
    case 'repeating': return ` waits:repeating(round ${wait.round} of ${wait.maxRounds})${wait.waiting.length > 0 ? refs(wait.waiting) : ''}`;
    case 'loop-check': return ` waits:loop-check${refs([wait.check])}`;
    case 'usage-limit': return ` waits:usage-limit[${wait.runner}]`;
    case 'on-hold': return ` waits:on-hold${wait.reason ? `(${wait.reason.replace(/\s+/g, ' ')})` : ''}`;
    default: return ` waits:${wait.kind}`;
  }
}
