import { taggedReadOnlyMode, unavailableTaskModeMessage } from './ModeResolver';
import { McpAttachError, McpAttachTimeout, RunnerStartupExit } from './harness/ordewellBinding';
import * as path from 'path';
import { Task, TaskSkillSnapshot, TaskSnapshot, Verdict, RunnerId, DEFAULT_RUNNERS, flattenTasksWithParents, pausedOnLimit, waitsForReset, type RunSettings } from '../models/Task';
import { IConfig } from '../interfaces/IConfig';
import { INotification } from '../interfaces/INotification';
import type { IRunner, IRunnerSession, QueuedTaskMessage, StructuredTurnEnd } from '../interfaces/IRunner';
import type { TaskShell, TaskShellSite } from '../interfaces/IFileSystem';
import type { RunnerModelRef } from '../models/RunnerCommand';
import { countedSessionCost, resumedSessionWindow } from '../models/Usage';
import { summarizeOutput } from './promptAugment';
import { endedByExit, VerdictEngine } from './VerdictEngine';
import { BufferedTaskOutputSource } from './BufferedTaskOutputSource';
import type { LiveTail, LiveTailOptions, TaskOutputSource } from '../interfaces/TaskOutputSource';
import { PlanStore } from './PlanStore';
import type { RunnerRegistry } from '../plugins/RunnerRegistry';
import type {
  IsolationHandoff,
  IsolationMergeResult,
  IsolationRun,
  IWorktreeIsolation,
  PreviousWork,
  TreeSnapshot,
} from '../interfaces/IWorktreeIsolation';
import { createWorktreeIsolation } from './GitWorktreeIsolation';
import { SELF_REPO } from './isolationRecord';
import { taskRefOf } from './TaskRefs';
import { IsolationRunController } from './IsolationRunController';
import { completesTask, Landing, type LandingMessage, type LandingOutcome, type UnlandedOutcome } from './Landing';
import { classifyRunnerStop, readUsageLimitReset, stopsRunner, type AttemptEnd, type TurnFailure } from './runnerExit';
import { RELAPSE_MS, RESUME_MARGIN_MS, UsageLimitWaits } from './UsageLimitWaits';
import { landed, selectReadyTasks, startWaits, waitOf, type ForcedStart, type Readiness, type StartRuleInput, type StartWait, type StartWaitKind } from './readiness';
import type { ResearchSchedule, ResearchWait } from './ResearchTasks';
import { blockingFailures, planBlocks, repeatingChecks } from './blocking';
import { betweenRounds, loopRoundOf, outOfRounds } from '../models/Loop';
import {
  attemptCwd, attemptPrompt, checksTree, classifyAttempt, decidesIsolation, landsNothing, mergeExcludes, takesSkills,
  type AttemptKind, type Continuation, type TaskWork,
} from './attemptKind';
import { resolveTaskSkills, TaskSkillsError, type SkillLookup } from './taskSkills';
import { SkillsService, workspaceSkillRoots } from './SkillsService';
import { capConflictFiles } from './conflictFiles';
import { resolveWorkspaceEnv, type WorkspaceEnv } from './workspaceEnv';
import { supportsTaskMode } from './harness/connectors';
import { continuability, sessionOwner } from './continuation';
import { quotedList } from '../utils/quotedList';
import type { RunMergeView } from './SessionMessage';
import { resumeTime } from '../taskRow/status';
import { scriptBodyOf } from '../models/ScriptTask';
import { SCRIPT_RUNNER, ScriptRunner } from './ScriptRunner';

/** What ran an automatic Merge all: a task reaching its merge gate, or the run settling with landed work unmerged. */
export type AutoMergeTrigger = { kind: 'gate'; taskId: string } | { kind: 'run_end' };

/**
 * Who opened a run (ADR-0029): a call the user made, or one made for them; a
 * call of the supervisor's own; or a usage-limit reset resuming what it paused.
 * Only the user's starts a run's supervision afresh.
 */
export type RunOrigin = 'user' | 'supervisor' | 'limit-reset';

/** What the scheduler reads of the open run's settings, at each decision it makes from them. */
export type SchedulerRunSettings = Pick<RunSettings, 'mergeAtGatesAutomatically'>;

/**
 * A start someone asked for, from the moment it was admitted until it has
 * taken its claim or been let go (ADR-0029): a start waiting on the user's
 * answer, on a held edit, or on the run to open. Stop counts it as live work,
 * and a Stop since it was admitted refuses its claim.
 */
export interface StartAdmission {
  /** No Stop came since it was admitted. */
  current(): boolean;
  /** It claimed, or will not: Stop no longer counts it. Idempotent. */
  release(): void;
}

/** Where a start stands against the user's Stop (ADR-0029): no longer current once one comes. */
type Admitted = Pick<StartAdmission, 'current'>;

/** What a start the user's Stop withdrew answers, wherever it was waiting. */
export const STOPPED_BEFORE_START = 'Not done: stopped before it could start. The run was stopped meanwhile; start it again if it is still wanted.';

/** A claim taken — its spawn under way — or why the start may not take one. */
type Claim = { spawned: Promise<void> } | { refused: string };

/**
 * The one notification channel out of the orchestrator. Everything that used
 * to travel over a separate callback (onRefresh) is an observer event; the
 * Session subscribes once and turns these into SessionMessages.
 */
export interface OrchestratorObserver {
  /** Any task-shaped state changed (store mutation, checkpoint, retry, …). */
  onTaskChanged?(): void;
  /**
   * A run reached an outcome that stands until the user acts — completed,
   * failed, or awaiting the user — on its own, not as the answer to a call.
   * Emitted before the `onTaskChanged` that announces it, so a listener can
   * save the outcome before any surface is told.
   */
  onTaskSettled?(data: { taskId: string }): void;
  onRunStarted?(data: { origin: RunOrigin }): void;
  /** An automatic Merge all settled, at a gate or at the run's end; failures are attention events for a supervisor. */
  onAutoMerge?(data: { trigger: AutoMergeTrigger; result: IsolationMergeResult }): void;
  onTick?(): void;
  onUsageChanged?(): void;
  onExecutionComplete?(): void;
  /**
   * A task paused on its runner's usage limit, or its resume changed:
   * `resumeAt` is when it resumes on its own (ISO time), null when it waits
   * for a manual retry — the reset could not be read, the resume was
   * cancelled, or the resumed attempt hit the limit again at once.
   * `cancelled` marks the resume being cancelled, which is no new pause.
   */
  onUsageLimitWait?(data: { taskId: string; runner: string; resumeAt: string | null; cancelled?: true }): void;
  /**
   * A task's runner now answers on another model (#106). `asked` when a model
   * command sent through its chat chose it: the user's own choice, which the
   * plan is to follow. `attemptEnded` when the attempt that runs `sessionId`
   * is no longer the task's, so the switch says nothing of what runs next.
   * `effort` only where the runner reported one.
   */
  onModelSwitched?(data: { taskId: string; sessionId: string; from: RunnerModelRef; model: RunnerModelRef; effort?: string; asked: boolean; attemptEnded: boolean }): void;
  /** A live task's runner went silent (ADR-0018's idle timer); paused while it waits on input, a checkpoint or an approval. */
  onTaskIdle?(data: { taskId: string; idleSince: string }): void;
  onReviewNeeded?(data: { tasks: Task[]; planRunners: RunnerId[] }): void;
  onReviewApproved?(data: { tasks: Task[] }): void;
  onCheckpoint?(data: { taskId: string; taskTitle: string; summary: string }): void;
  /**
   * The isolation run record changed and should be persisted with the plan.
   * `detached` is the record of a run another plan has replaced since — a
   * release that outlived a plan load — for the session it belongs to.
   */
  onIsolationChanged?(detached?: IsolationRun): void;
  /** A run did not start: the tree is dirty, and the user picks stash or no isolation. `repos` names the dirty repos of a group. */
  onIsolationBlocked?(data: { reason: 'dirty'; repos: string[] }): void;
  /** An isolated run settled; emitted before `onExecutionComplete`, which surfaces treat as terminal. */
  onIsolationHandoff?(handoff: IsolationHandoff): void;
  /** The isolated run was cleared up and forgotten, by a Merge all that left nothing to hand over or by a discard. */
  onRunClosed?(): void;
  /**
   * What a run says about how it isolates — the fallback to the workspace root,
   * shared paths, copies, a stash. Beside the notification channel, which a
   * daemon may leave unwired, so a surface without toasts can still show it.
   */
  onIsolationNotice?(data: { level: 'info' | 'warn' | 'error'; message: string }): void;
}

/**
 * A message or interrupt a task cannot take: it is not running, or it is
 * waiting on something a message does not answer.
 * The request is wrong, not the orchestrator, so a surface says why.
 */
export class TaskControlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TaskControlError';
  }
}

/** How a refused {@link TaskControlError} names what was asked: "no turn to …". */
const CONTROL_WORDS = {
  message: 'send a message to',
  interrupt: 'interrupt',
  force: 'send a message to',
  command: 'run a command in',
} as const;

/** What Ordewell tells a runner whose turn ended without a `task_complete` call (ADR-0018, W1). */
const COMPLETION_REMINDER = 'Your turn ended without calling `task_complete`. If the task is done, call `task_complete` with status `done` and your full report as the summary. If you are blocked, call it with status `blocked` and the reason. If you need something from the user, say exactly what and end your turn.';

/**
 * One run of one task, from the moment the scheduler claims it until its
 * verdict, cancel, stop or plan load. Everything that has to die with the run
 * lives on this record, so {@link TaskOrchestrator.endAttempt} releases all of
 * it at once and nothing can be left behind for one exit path to forget.
 */
interface TaskAttempt {
  readonly taskId: string;
  /** 1-based count of spawns, continued from the persisted attempt ledgers. */
  readonly attempt: number;
  /**
   * `starting` while the async spawn is in flight; `session` is null until
   * `running`. `integrating` once its verdict is with {@link Landing} — still
   * live, so the task neither completes nor frees its dependents until the
   * landing says so.
   */
  phase: AttemptPhase;
  session: IRunnerSession | null;
  readonly runner: string;
  /** Null until {@link attemptCwd} settles. */
  cwd: string | null;
  /** Whether `cwd` is a worktree prepared for this attempt rather than the workspace root. */
  worktree: boolean;
  /** The landing in flight, so a cancel waits for it before tearing the worktree down. */
  integration: Promise<LandingOutcome> | null;
  /** What this attempt is, which decides where it runs, what it is told and what is checked; see {@link AttemptKind}. */
  readonly kind: AttemptKind;
  /** The workspace's tracked state as the attempt started, when its tree is checked; what that check compares with. */
  snapshot: TreeSnapshot | null;
  readonly startedAt: string;
  /**
   * Set as its verdict arrives, before the verdict is applied: the turn that
   * called `task_complete` ends while the verdict is still settling, and must
   * not read as waiting for input.
   */
  decided: boolean;
  /** The task skills put in this attempt's prompt, as read from where it runs. */
  skills: readonly TaskSkillSnapshot[];
  /**
   * The start it was claimed for, as the user's Stop stands to it. The repair
   * its conflict is owed claims under it too, so a Stop since withdraws that
   * repair as it withdrew the attempt.
   */
  readonly admission: Admitted;
  /** Resumed after a usage limit, at its reset or by {@link TaskOrchestrator.resumeNow}, rather than started; see {@link RELAPSE_MS}. */
  readonly autoResumed: boolean;
  /** Why the running turn failed, as the runner reported it, if it did. */
  turnError: TurnFailure | null;
  /** Where the running turn's output starts in the session's. */
  turnOutputFrom: number;
  /** The completion reminder went out: once per attempt, so a second turn without `task_complete` waits for input. */
  reminded: boolean;
  /**
   * Its runner was told to stop (ADR-0018, L1). What it reports as it winds
   * down is still this attempt's, though the attempt has ended.
   */
  runnerStopped: boolean;
  /**
   * The plan scope it was claimed in. A plan loaded after it ends the scope:
   * what the runner still reports belongs to the old plan's task, never to a
   * task of the new one that happens to reuse its id.
   */
  readonly planScope: number;
  /** A script task's attempt (ADR-0035): the script runner runs its body, with no model. */
  readonly script: boolean;
  /** A read-only attempt's `run_command` (ADR-0046), ended with the attempt. */
  shell: TaskShell | null;
}

type AttemptPhase = 'starting' | 'running' | 'integrating';

/** A force start queued behind its dependencies (see {@link TaskOrchestrator.forceStartTask}). */
interface QueuedStart {
  /** The merge gate as it stood when the user forced the start: every surface confirms that one first (ADR-0020). */
  pastGate: readonly string[];
  /** What it last said of a gate it was not confirmed past, so it says so once. */
  gateNotice?: string;
}

/** What keeps a queued force start waiting, with nothing to say: it starts once these clear. */
const QUEUED_WAITS: ReadonlySet<StartWaitKind> = new Set<StartWaitKind>(['queued', 'completing', 'merging', 'start-hold', 'unapproved', 'research-parallel', 'research-message']);

/** A force start the user made now: their own act, past the whole merge gate they confirmed. */
const FORCED_NOW: ForcedStart = { queued: false };

/**
 * A resume the user, planner or supervisor asked for before the reset; see
 * {@link TaskOrchestrator.resumeNow}. It sweeps along every other task
 * waiting on the same runner's reset.
 */
interface ResumeNow {
  taskId: string;
  origin: RunOrigin;
  message?: string;
}

/**
 * Where the full-plan run stands, as one value; every getter that reports on
 * the run derives from it (ADR-0034; ADR-0018 U1).
 * - `idle`: no full-plan run since the plan loaded or the user stopped one. A
 *   task started on its own may still be at work.
 * - `scheduling`: the scheduler drives the plan, starting ready tasks as slots
 *   free. A run that waits on the user, a hold or a merge gate stays here.
 * - `held`: a usage-limit pause holds the run. It stays open and starts
 *   nothing new until the reset, a Resume now, a retry, a skip or a move to
 *   another runner continues it.
 * - `endedOnFailure`: the run ended with failed tasks and the tasks they
 *   block; a retry or a skip continues it.
 * - `finished`: every task completed or was skipped.
 */
type RunState = 'idle' | 'scheduling' | 'held' | 'endedOnFailure' | 'finished';

/** Read-only view of a task's live attempt. */
export interface TaskAttemptSnapshot {
  taskId: string;
  attempt: number;
  phase: AttemptPhase;
  sessionId: string | null;
  runner: string;
  cwd: string | null;
  startedAt: string;
  skills: readonly TaskSkillSnapshot[];
}

/**
 * The wiring a {@link TaskOrchestrator} runs on, every collaborator resolved.
 * {@link TaskOrchestrator.compose} is the only production caller; tests build
 * one through it too. The constructor makes nothing itself, so there is exactly
 * one place defaults live.
 */
export interface TaskOrchestratorDeps {
  research?: ResearchSchedule;
  config: IConfig;
  notifications: INotification;
  runner: IRunner;
  /** Runs script tasks' bodies (ADR-0035), in place of a registered runner. */
  scriptRunner: IRunner;
  store: PlanStore;
  output: TaskOutputSource;
  /** The plan's isolation run and the open run's lifecycle (ADR-0013). */
  runs: IsolationRunController;
  /** A passed attempt's work onto the integration branch, and any conflict repair. */
  landing: Landing;
  registry: RunnerRegistry | null;
  /** The workspace root, read at call time — VS Code can change it. */
  workspaceRoot: () => string;
  /** The workspace's own variables for a task's cwd (ADR-0016). */
  workspaceEnv: (cwd: string) => Promise<WorkspaceEnv>;
  /** The skill catalog over workspace roots, as {@link workspaceSkillRoots} orders them — read at each spawn. */
  skillsAt: (roots: readonly string[]) => SkillLookup;
  /** What the task's last saved attempt did, or null when it left no log (ADR-0020). */
  previousAttemptFromLog: (taskId: string) => string | null;
  /**
   * The newest attempt the task has a saved log for, 0 for none. An attempt's
   * log is saved under its number, so a new one is numbered past a log kept
   * from before the task had ledgers.
   */
  lastLoggedAttempt: (taskId: string) => number;
  /**
   * The open run's settings, read as each automatic merge is decided rather
   * than copied when the run opens, so a change to the run under way applies
   * at once (ADR-0030); absent before any run.
   */
  runSettings: () => SchedulerRunSettings | undefined;
  /**
   * The user's approval record, read at each start (ADR-0035): the Session
   * owns it, and the scheduler starts nothing outside it.
   */
  isApproved: (taskId: string) => boolean;
  /** A read-only attempt's shell (ADR-0046); absent, its runner is given no `run_command`. */
  taskShell?: (site: TaskShellSite) => TaskShell | undefined;
}

/**
 * What a caller supplies to {@link TaskOrchestrator.compose}; every optional
 * one gets its default there. This is what a host or test chooses, not the
 * resolved wiring the orchestrator itself runs on.
 */
export interface TaskOrchestratorOptions {
  research?: ResearchSchedule;
  config: IConfig;
  notifications: INotification;
  runner: IRunner;
  scriptRunner?: IRunner;
  store?: PlanStore;
  output?: TaskOutputSource;
  isolation?: IWorktreeIsolation;
  registry?: RunnerRegistry | null;
  workspaceRoot?: () => string;
  workspaceEnv?: (cwd: string) => Promise<WorkspaceEnv>;
  skillsAt?: (roots: readonly string[]) => SkillLookup;
  previousAttemptFromLog?: (taskId: string) => string | null;
  lastLoggedAttempt?: (taskId: string) => number;
  runSettings?: () => SchedulerRunSettings | undefined;
  /** Every task is approved unless a Session supplies its record: an orchestrator on its own has no user to ask. */
  isApproved?: (taskId: string) => boolean;
  taskShell?: (site: TaskShellSite) => TaskShell | undefined;
}

/**
 * The pure scheduler. Owns execution state (the {@link RunState},
 * `reviewApproved`, the live task attempts, the start hold) and the verifier.
 * All task-shaped state — the plan tree, the flat index, the completed set
 * — lives in {@link PlanStore}, injected at construction. The orchestrator
 * calls `store.markCompleted(id)` / `store.markFailed(id)` instead of mutating
 * task state directly. A task completes only after the runner reports it done
 * through `task_complete` on its attempt's token; process exit without that
 * evidence is a visible failure and does not unblock dependent work.
 */
export class TaskOrchestrator {
  private config: IConfig;
  private notifications: INotification;
  private runner: IRunner;
  private scriptRunner: IRunner;
  private store: PlanStore;
  private output: TaskOutputSource;
  private attempts = new Map<string, TaskAttempt>();
  /** Bumped by every plan load: an ended attempt's wind-down belongs to the scope before it. */
  private planScope = 0;
  /** Each task's runners still winding down once stopped: a continue waits for them (ADR-0018, L1). */
  private windDowns = new Map<string, Promise<void>>();
  private verifier = new VerdictEngine();
  /** Changed only by start, stop, a plan load, a usage-limit pause, a move off the limit, and {@link settleRun}. */
  private runState: RunState = 'idle';
  /** Planner turns in flight that new starts wait for (ADR-0029); running attempts carry on. */
  private startHolds = 0;
  /** Bumped by the user's Stop: a start admitted under an older generation never takes its claim. */
  private stopGeneration = 0;
  /** Starts admitted and not yet claimed or let go; see {@link StartAdmission}. */
  private admissions = 0;
  private reviewApproved = false;
  private autoMergeBlocked = false;
  private mergesInFlight = 0;
  /*
   * Retry counts, spawn counts and holds describe a task across attempts, so
   * they deliberately live outside the attempt record: ending an attempt must
   * not forget that the user held the task or how often it has run.
   */
  private retryCounts = new Map<string, number>();
  private spawnCounts = new Map<string, number>();
  /** A Merge all is under way: no ops task starts until it ends (ADR-0020). */
  private merging = false;
  /** The last "waiting for Merge all" notice, so a run paused at a gate says it once, not on every tick. */
  private gateNotice = '';
  /** The workspace's own variables for a task's cwd (ADR-0016); swapped out in tests. */
  private workspaceEnv: (cwd: string) => Promise<WorkspaceEnv>;
  /** What the workspace env has already warned about, so a run says it once, not per task. */
  private envWarnings = new Set<string>();
  /**
   * Tasks pulled out of auto-scheduling (user-cancelled, marked not done, or a
   * start that could not reach its runner), each with the reason the surfaces
   * show. They stay 'pending' — "not executed" — but the scheduler skips them
   * until the user retries or force-starts, which would otherwise loop forever
   * on a task whose spawn always throws.
   */
  private onHold = new Map<string, string>();
  /**
   * Force starts queued behind dependencies the scheduler will not start them
   * after: outside a run it drives, or past a failed dependency, which it
   * never forces. Each starts once those still under way have finished.
   */
  private queuedStarts = new Map<string, QueuedStart>();
  /**
   * Tasks Mark complete is landing after it ended their attempt: in progress
   * with no attempt for as long as that takes, and not orphans for it.
   */
  private completing = new Set<string>();
  /** One wait per runner for its usage limit to reset; the tasks it resumes, and when, are on the plan (#84). */
  private limitWaits = new UsageLimitWaits((runner) => this.unawaited(this.resumeAfterLimit(runner), `Could not resume the tasks paused on the usage limit of ${runner}`));

  /**
   * The plan's isolation run and the open run's lifecycle (ADR-0013); see
   * {@link IsolationRunController}. Read and acted on there directly, except
   * Merge all: that goes through {@link mergeRun}, which keeps it apart from
   * ops tasks and starts the tasks its merge lets through.
   */
  readonly runs: IsolationRunController;
  /** A passed attempt's work onto the integration branch, and the conflict repair a landing may need. */
  private landing: Landing;

  private registry: RunnerRegistry | null;
  private workspaceRootFn: () => string;
  private observers: OrchestratorObserver[] = [];
  private skillsAt: (roots: readonly string[]) => SkillLookup;
  private previousAttemptFromLog: (taskId: string) => string | null;
  private lastLoggedAttempt: (taskId: string) => number;
  private runSettings: () => SchedulerRunSettings | undefined;
  private isApproved: (taskId: string) => boolean;
  private taskShell: (site: TaskShellSite) => TaskShell | undefined;
  private readonly research: ResearchSchedule | undefined;

  constructor(deps: TaskOrchestratorDeps) {
    this.research = deps.research;
    this.config = deps.config;
    this.notifications = deps.notifications;
    this.runner = deps.runner;
    this.scriptRunner = deps.scriptRunner;
    this.store = deps.store;
    this.output = deps.output;
    this.runs = deps.runs;
    this.landing = deps.landing;
    this.registry = deps.registry;
    this.workspaceRootFn = deps.workspaceRoot;
    this.workspaceEnv = deps.workspaceEnv;
    this.skillsAt = deps.skillsAt;
    this.previousAttemptFromLog = deps.previousAttemptFromLog;
    this.lastLoggedAttempt = deps.lastLoggedAttempt;
    this.runSettings = deps.runSettings;
    this.isApproved = deps.isApproved;
    this.taskShell = deps.taskShell ?? (() => undefined);

    this.store.onMutate = () => this.emit('onTaskChanged');
    this.verifier.onVerdict((taskId, verdict) => { void this.deliverVerdict(taskId, verdict); });
    this.verifier.onCheckpoint((taskId, summary) => {
      const task = this.store.get(taskId);
      if (!task) return;
      this.store.markAwaitingUser(taskId, 'checkpoint');
      this.verifier.pauseIdle(taskId);
      this.emit('onTaskSettled', { taskId });
      this.emit('onTaskChanged');
      this.emit('onCheckpoint', { taskId, taskTitle: task.title, summary });
    });
    this.verifier.onCheckpointWithdrawn((taskId) => {
      if (!this.awaitsCheckpoint(taskId)) return;
      this.store.markInProgress(taskId);
      this.emit('onTaskChanged');
    });
    // idleSince is advisory UI state, not a store mutation — broadcast it
    // through the same onTaskChanged seam without touching PlanStore. Only
    // going silent is news to a supervisor: null also comes on teardown.
    this.verifier.onIdleChange((taskId, idleSince) => {
      if (idleSince) this.emit('onTaskIdle', { taskId, idleSince });
      this.emit('onTaskChanged');
    });
  }

  /**
   * The composition root: resolves every optional collaborator and wires the
   * isolation listener that the constructor cannot, because it needs the
   * instance's own (private) emit seam. Nothing else in the
   * codebase constructs an orchestrator, so this is the one place defaults
   * live — a host or test supplies what it cares about and gets the rest.
   */
  static compose(options: TaskOrchestratorOptions): TaskOrchestrator {
    const store = options.store ?? new PlanStore();
    const output = options.output ?? new BufferedTaskOutputSource();
    const isolation = options.isolation ?? createWorktreeIsolation({ config: options.config });
    const workspaceRoot = options.workspaceRoot ?? (() => process.cwd());
    // The listener callbacks fire only after construction, so the reference
    // below is settled by the time any of them runs.
    const runs = new IsolationRunController({
      isolation,
      config: options.config,
      notifications: options.notifications,
      workspaceRoot,
      listener: {
        changed: (detached) => orchestrator.emit('onIsolationChanged', detached),
        blocked: (repos) => orchestrator.emit('onIsolationBlocked', { reason: 'dirty', repos }),
        handoff: (handoff) => orchestrator.emit('onIsolationHandoff', handoff),
        closed: () => orchestrator.emit('onRunClosed'),
        notice: (level, message) => orchestrator.emit('onIsolationNotice', { level, message }),
      },
      liveTasks: (): ReadonlySet<string> => orchestrator.liveTaskIds(),
    });
    const landing = new Landing({ runs, config: options.config, tasks: store });
    const orchestrator = new TaskOrchestrator({
      config: options.config,
      notifications: options.notifications,
      runner: options.runner,
      scriptRunner: options.scriptRunner ?? new ScriptRunner(),
      store,
      output,
      runs,
      landing,
      registry: options.registry ?? null,
      workspaceRoot,
      workspaceEnv: options.workspaceEnv ?? ((cwd) => resolveWorkspaceEnv(cwd)),
      skillsAt: options.skillsAt ?? ((roots) => new SkillsService(roots)),
      previousAttemptFromLog: options.previousAttemptFromLog ?? (() => null),
      lastLoggedAttempt: options.lastLoggedAttempt ?? (() => 0),
      runSettings: options.runSettings ?? (() => undefined),
      isApproved: options.isApproved ?? (() => true),
      research: options.research,
      ...(options.taskShell ? { taskShell: options.taskShell } : {}),
    });
    return orchestrator;
  }

  /** Advisory silence timestamp for a task's live runner, or null if not idle. */
  getIdleSince(taskId: string): string | null {
    return this.verifier.getIdleSince(taskId);
  }

  /**
   * What an ops retry is told about the attempt before. The saved log is read
   * whether or not the session was reloaded, so both behave alike; the output
   * buffer is the fallback for a runner that has no log. A reload clears the
   * attempt count along with the buffer, so a retry made since is what says
   * there was an attempt to report on.
   */
  private opsPreviousAttempt(taskId: string): string | undefined {
    const saved = this.previousAttemptFromLog(taskId) ?? this.output.liveTail(taskId, { maxLines: OPS_RETRY_TAIL_LINES })?.text;
    if (saved !== undefined) return saved;
    return (this.retryCounts.get(taskId) ?? 0) > 0 ? 'Its output is not available: this session was reloaded since it ran.' : undefined;
  }

  /** Recent clean output of a task's latest attempt, running or ended; null if it never ran. */
  getLiveOutput(taskId: string, opts: LiveTailOptions): LiveTail | null {
    return this.output.liveTail(taskId, opts);
  }

  get storeInstance(): PlanStore { return this.store; }

  /**
   * The variables a task's agent gets from its workspace. What cannot be
   * applied is said once — silently starting without them is how agents ran
   * under the wrong account when an edited `.envrc` was left unallowed.
   */
  private async envForTask(cwd: string): Promise<Record<string, string>> {
    const resolved = await this.workspaceEnv(cwd);
    const warn = (key: string, message: string) => {
      if (this.envWarnings.has(key)) return;
      this.envWarnings.add(key);
      this.notifications.warn(message);
    };
    if (resolved.blockedEnvrc) {
      warn(`blocked:${resolved.blockedEnvrc}`, `direnv has blocked ${resolved.blockedEnvrc}, so tasks start without its variables. Run \`direnv allow\` in ${path.dirname(resolved.blockedEnvrc)} to use them.`);
    }
    if (resolved.trackedEnvFile) {
      warn(`tracked:${resolved.trackedEnvFile}`, `Ignored ${resolved.trackedEnvFile}: git tracks it, and a committed file must not choose the environment agents run in. Untrack it to use it.`);
    }
    if (resolved.refused.length > 0) {
      warn(`refused:${resolved.refused.join(',')}`, `Ignored ${resolved.refused.join(', ')} from the workspace environment: Ordewell never passes these to agents.`);
    }
    return resolved.env;
  }

  approveCheckpoint(taskId: string): void {
    if (!this.awaitsCheckpoint(taskId)) return;
    this.verifier.approveCheckpoint(taskId);
    this.store.markInProgress(taskId);
    this.emit('onTaskChanged');
  }

  rejectCheckpoint(taskId: string, reason?: string): void {
    if (!this.awaitsCheckpoint(taskId)) return;
    this.verifier.rejectCheckpoint(taskId, reason ?? 'Checkpoint rejected by user');
    this.store.markInProgress(taskId);
    this.emit('onTaskChanged');
  }

  /** What the task's waiting checkpoint asks, whole; undefined once it settles or when none waits. */
  getCheckpointQuestion(taskId: string): string | undefined {
    return this.verifier.getCheckpointQuestion(taskId);
  }

  /*
   * The saved reason says what the task waits on. The live attempt stays a
   * guard: a checkpoint reloaded from disk has no runner left to answer it,
   * and putting it back to in_progress would strand it with nothing behind it.
   */
  awaitsCheckpoint(taskId: string): boolean {
    return this.store.get(taskId)?.awaitingReason === 'checkpoint' && this.attempts.has(taskId);
  }

  /**
   * Send a structured task a user message (ADR-0018, M1). Mid-turn it queues
   * behind the turn; a task waiting for input takes it at once and is back in
   * progress. Returns the message's id, for {@link removeQueuedTaskMessage}.
   */
  sendTaskMessage(taskId: string, text: string): string {
    return this.messageTask(taskId, text, 'message', (session, message) => session.sendMessage(message));
  }

  /**
   * Force send (ADR-0023, F1–F3): interrupt the running turn and deliver the
   * message as the next one, ahead of anything queued, without the task
   * waiting for input in between. A task already waiting for input just takes it.
   */
  forceSendTaskMessage(taskId: string, text: string): string {
    return this.messageTask(taskId, text, 'force', (session, message) => session.forceSend(message));
  }

  /**
   * Run the task runner's own command `/name args` (#66) as a turn of its
   * own, waiting behind a running turn as a message would. Ordewell carries
   * it; what it does is the runner's business (#24).
   */
  invokeTaskCommand(taskId: string, name: string, args = ''): string {
    const command = args.trim() ? `/${name} ${args.trim()}` : `/${name}`;
    return this.messageTask(taskId, command, 'command', (session) => session.invokeCommand(name, args));
  }

  private messageTask(
    taskId: string,
    text: string,
    action: 'message' | 'force' | 'command',
    send: (session: IRunnerSession, message: string) => string,
  ): string {
    const message = text.trim();
    if (!message) throw new TaskControlError('A message to a task cannot be empty.');
    const task = this.store.get(taskId);
    const session = this.runnerSession(taskId, action);
    if (task?.status === 'awaiting_user' && task.awaitingReason !== 'input') {
      throw new TaskControlError(`Task "${task.title}" is at a checkpoint: approve or reject it instead.`);
    }
    const id = send(session, message);
    if (task?.status === 'awaiting_user') this.store.markInProgress(taskId);
    this.emit('onTaskChanged');
    return id;
  }

  /** Force send a message not yet delivered, queued or handed over; false once it was delivered. */
  forceSendQueuedTaskMessage(taskId: string, id: string): boolean {
    const sent = this.runnerSession(taskId, 'force').forceSendQueued(id);
    if (sent) this.emit('onTaskChanged');
    return sent;
  }

  /** Take back a message still queued behind a turn; false once it was delivered. */
  removeQueuedTaskMessage(taskId: string, id: string): boolean {
    const removed = this.runnerSession(taskId, 'message').removeQueued(id);
    if (removed) this.emit('onTaskChanged');
    return removed;
  }

  /** Stop a structured task's running turn; it then waits for input like any turn that ends without a `task_complete` call. */
  async interruptTask(taskId: string): Promise<void> {
    await this.runnerSession(taskId, 'interrupt').interrupt();
  }

  /** What is waiting for a structured task's turn to end; empty for any other task. */
  getQueuedTaskMessages(taskId: string): QueuedTaskMessage[] {
    const session = this.attempts.get(taskId)?.session;
    return session?.queued() ?? [];
  }

  private runnerSession(taskId: string, action: keyof typeof CONTROL_WORDS): IRunnerSession {
    const task = this.store.get(taskId);
    if (!task) throw new TaskControlError(`No task ${taskId} in this plan.`);
    if (task.type === 'script') throw new TaskControlError(`Task "${task.title}" is a script task: it runs no model, so there is no turn to ${CONTROL_WORDS[action]}. Stop it, or edit its body and retry it.`);
    const attempt = this.attempts.get(taskId);
    const session = attempt?.session;
    if (!attempt || !session || attempt.phase !== 'running' || attempt.decided) {
      throw new TaskControlError(`Task "${task.title}" is not running, so there is no turn to ${CONTROL_WORDS[action]}.`);
    }
    return session;
  }

  /**
   * A structured turn that ended without a `task_complete` call (ADR-0018, W1). No
   * verdict is guessed: the task waits for input, unless a checkpoint in the
   * same turn already has it waiting, or a queued message went straight out —
   * the session never passes through idle then, so nothing flickers. The first
   * turn of an attempt to end that way, cleanly, gets the completion reminder
   * instead: weaker models often finish the work and report in prose.
   */
  private onTurnEnd(taskId: string, attempt: TaskAttempt, session: IRunnerSession, reason: StructuredTurnEnd): void {
    if (this.attempts.get(taskId) !== attempt || attempt.phase !== 'running' || attempt.decided) return;
    if (session.turnState() === 'working') {
      this.emit('onTaskChanged');
      return;
    }
    if (this.store.get(taskId)?.status !== 'in_progress') return;
    if (this.unresumed(attempt)) {
      // There is no session to wait in. Ending the runner hands the attempt to
      // its verdict, which fails it for want of a `task_complete` call.
      session.kill();
      return;
    }
    if (reason === 'failed' && attempt.turnError !== null && classifyRunnerStop(attempt.turnError) === 'usage-limit') {
      // The runner is still up, but no turn can run until the limit resets.
      this.unawaited(this.stopOnLimit(taskId, attempt), `Could not pause task "${this.store.get(taskId)?.title ?? taskId}" on its usage limit`);
      return;
    }
    if (reason === 'completed' && !attempt.reminded) {
      attempt.reminded = true;
      this.messageTask(taskId, COMPLETION_REMINDER, 'message', (live, message) => live.sendMessage(message, 'ordewell'));
      return;
    }
    this.store.markAwaitingUser(taskId, 'input');
    this.verifier.pauseIdle(taskId);
    this.emit('onTaskSettled', { taskId });
    this.emit('onTaskChanged');
  }

  subscribe(observer: OrchestratorObserver): () => void {
    this.observers.push(observer);
    return () => {
      this.observers = this.observers.filter(o => o !== observer);
    };
  }

  /**
   * Isolated per observer: one that throws must not take down the scheduler
   * or stop the remaining observers from hearing the event.
   */
  private emit(event: keyof OrchestratorObserver, ...args: unknown[]): void {
    for (const o of this.observers) {
      const fn = o[event] as (...args: unknown[]) => void;
      if (!fn) continue;
      try {
        fn(...args);
      } catch (err) {
        console.error(`[TaskOrchestrator] observer threw from ${event}:`, err);
      }
    }
  }

  get isRunning(): boolean {
    return this.isScheduling || this.attempts.size > 0;
  }
  /**
   * A runner is executing *right now*. Narrower than {@link isRunning}, which
   * also covers the armed-but-idle scheduler `tick()` deliberately leaves
   * behind when a plan is paused on a user task, a checkpoint or a hold —
   * nothing is executing then, so nothing is reading the plan mid-mutation.
   */
  get hasLiveWork(): boolean {
    return this.attempts.size > 0;
  }
  get isReviewApproved(): boolean { return this.reviewApproved; }
  /** The scheduler is driving the plan: ready tasks start on their own as slots free. Narrower than {@link isRunning}. */
  get isScheduling(): boolean { return this.runState === 'scheduling'; }
  /**
   * A full-plan run with nothing starting that something still resumes: a
   * usage limit's reset, or a retry of a failed task its blocked tasks wait on.
   */
  get awaitsResume(): boolean { return this.runState === 'held' || this.runState === 'endedOnFailure'; }
  get status(): 'approved' | 'running' | 'completed' {
    if (this.runState === 'scheduling') return 'running';
    return this.runState === 'finished' ? 'completed' : 'approved';
  }
  get activeTaskIds(): string[] { return [...this.activeSessionMap.keys()]; }
  /** Task id → session id of every attempt whose runner is up; a spawn in flight has no session yet. */
  get activeSessionMap(): Map<string, string> {
    const map = new Map<string, string>();
    for (const [taskId, attempt] of this.attempts) {
      if (attempt.session) map.set(taskId, attempt.session.id);
    }
    return map;
  }

  getAttempt(taskId: string): TaskAttemptSnapshot | undefined {
    const attempt = this.attempts.get(taskId);
    if (!attempt) return undefined;
    const { taskId: id, attempt: n, phase, session, runner, cwd, startedAt, skills } = attempt;
    return { taskId: id, attempt: n, phase, sessionId: session?.id ?? null, runner, cwd, startedAt, skills };
  }

  /** A planner turn holds new starts: what is ready starts when it releases them. */
  get startsHeld(): boolean { return this.startHolds > 0; }

  /**
   * Hold the scheduler's new starts while a planner turn decides what runs
   * next, so its edits do not race a task that would otherwise start under
   * it. Running attempts are untouched. The release is idempotent and starts
   * nothing itself: whoever releases ticks, which starts what became ready.
   */
  holdStarts(): () => void {
    this.startHolds++;
    let held = true;
    return () => {
      if (!held) return;
      held = false;
      this.startHolds--;
    };
  }

  /**
   * Admit a start that will wait before it claims — on the user's answer, a
   * held edit, the run opening. Until it is released, Stop counts it as live
   * work; once a Stop comes it is no longer current, and its claim is refused.
   */
  admitStart(): StartAdmission {
    const { current } = this.admittedNow();
    let held = true;
    this.admissions++;
    return {
      current,
      release: () => {
        if (!held) return;
        held = false;
        this.admissions--;
      },
    };
  }

  /**
   * Something can still start that nobody has to ask for again: a start
   * admitted and not yet claimed, a force start queued behind its
   * dependencies, or a task that resumes on its own at its usage limit's
   * reset. A Stop is owed to it, whether or not anything runs.
   */
  get startsPending(): boolean {
    return this.admissions > 0 || this.queuedStarts.size > 0 || this.store.allTasks.some(waitsForReset);
  }

  /** A start admitted now that nothing has to count as live work: one that claims before it awaits, or follows on from one that did. */
  private admittedNow(): Admitted {
    const generation = this.stopGeneration;
    return { current: () => generation === this.stopGeneration };
  }

  /** Run `work`, which awaits before it claims, under an admission it holds throughout and claims under. */
  private async whileAdmitted<T>(work: (admission: StartAdmission) => Promise<T>): Promise<T> {
    const admission = this.admitStart();
    try {
      return await work(admission);
    } finally {
      admission.release();
    }
  }

  /**
   * "Merge all"; a settled run that merged everything is cleared up and
   * forgotten. During a run it merges what has landed and the run goes on:
   * the tasks waiting at a merge gate for that work then start (ADR-0020).
   * Never alongside ops work, either way round ({@link mergeExcludes}).
   */
  async mergeRun(): Promise<IsolationMergeResult> {
    return this.mergeLanded();
  }

  private async mergeLanded(trigger?: AutoMergeTrigger): Promise<IsolationMergeResult> {
    const excluded = [...this.attempts.values()].find((a) => mergeExcludes(a.kind));
    if (excluded) {
      const title = this.store.get(excluded.taskId)?.title ?? excluded.taskId;
      throw new TaskControlError(`Ops task "${title}" is running in your checkout: Merge all once it has finished.`);
    }
    this.mergesInFlight++;
    this.merging = true;
    let result: IsolationMergeResult;
    try {
      result = await this.runs.merge();
    } catch (err) {
      if (!trigger) throw err;
      result = { outcome: 'failed', repo: SELF_REPO };
      this.tell('error', `Automatic Merge all could not finish: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      this.merging = --this.mergesInFlight > 0;
    }
    if (!trigger && result.outcome === 'merged') this.autoMergeBlocked = false;
    if (trigger) {
      this.autoMergeBlocked = result.outcome !== 'merged';
      this.emit('onAutoMerge', { trigger, result });
      if (this.autoMergeBlocked) {
        this.tell('warn', trigger.kind === 'gate'
          ? `Automatic Merge all for task ${this.store.get(trigger.taskId)?.order ?? trigger.taskId} stopped. The merge gate is waiting for you.`
          : 'Automatic Merge all at the end of the run stopped. The run is handed over to you to merge.');
      }
    }
    // The run's end closes the run itself, straight after.
    if (trigger?.kind !== 'run_end') await this.tick();
    return result;
  }

  /**
   * Close the settled run. With merge at gates automatically on, landed work
   * not merged yet is merged first, through the gate's path, so no surface
   * hears of a handoff for a run about to merge; one that stopped is handed
   * over as before.
   */
  private async closeRun(): Promise<void> {
    if (this.mergesAutomatically() && !this.autoMergeBlocked && !this.merging && this.runs.isolating && this.runMergeView()
      && ![...this.attempts.values()].some((a) => mergeExcludes(a.kind))) {
      await this.mergeLanded({ kind: 'run_end' });
    }
    await this.runs.close();
  }

  /**
   * The run as a surface offers Merge all mid-run (ADR-0020): what has landed
   * and is not merged, and whether the run is paused at its gates with nothing
   * else running. Null once everything landed is merged.
   */
  runMergeView(): RunMergeView | null {
    const handoff = this.runs.view()?.handoff;
    if (!handoff?.landed.length) return null;
    const waitingAtGate = this.store.allTasks.some((t) => this.getMergeGate(t.id).length > 0);
    return { waitingAtGate, paused: waitingAtGate && this.isScheduling && this.attempts.size === 0, repos: handoff.repos, landed: handoff.landed };
  }

  /**
   * The ancestors an ops or user task waits on at its merge gate: those whose
   * landed work is not in the user's branch yet (ADR-0020). Empty for every
   * other task. Judged whatever the task's status but `completed` — a retry of
   * a failed ops task acts on the checkout as a first start does — so a start
   * the user is about to confirm is told what it would act without.
   */
  getMergeGate(taskId: string): string[] {
    const task = this.store.get(taskId);
    if (!task || task.status === 'completed') return [];
    return waitOf(this.startWaits(task), 'merge-gate')?.unmerged ?? [];
  }

  /** Why a task is held out of auto-scheduling, as the surfaces show it; null when it is not held. */
  holdReason(taskId: string): string | null {
    return this.onHold.get(taskId) ?? null;
  }

  /** The research limit holding a research task back, when it is the first thing that does (ADR-0037 R4). */
  researchWait(taskId: string): ResearchWait | undefined {
    const task = this.store.get(taskId);
    if (!task?.research) return;
    const [first] = this.startWaits(task);
    return first?.kind === 'research-parallel' || first?.kind === 'research-message' ? first : undefined;
  }

  /**
   * Every reason a task cannot start now, from the one start rule
   * (ADR-0034); none when it can. `forced` judges a start the user forced.
   * Takes the task, not its id: the command seam judges one as a held edit
   * leaves it.
   */
  startWaits(task: Readonly<Task>, forced?: ForcedStart): StartWait[] {
    return startWaits(task, this.startRule(), forced);
  }

  private startRule(): StartRuleInput {
    return {
      store: this.store,
      onHold: this.onHold,
      approved: this.isApproved,
      research: this.research,
      runs: this.runs,
      merging: this.merging,
      startsHeld: this.startHolds > 0,
      completing: this.completing,
      queued: this.queuedStarts,
    };
  }

  /** The failed tasks a task not started yet waits on, through its dependencies (ADR-0034); empty when it is not blocked. */
  getBlockedBy(taskId: string): string[] {
    return blockingFailures(this.store.planTasks).get(taskId) ?? [];
  }

  /**
   * `edited`: the plan is the last one edited, not a new one. Only a Stop
   * withdraws a queued start (ADR-0035), so one of a task the edit keeps
   * stays queued: a script task waiting at its merge gate still starts at
   * Merge all.
   */
  loadPlan(tasks: readonly Task[], planRunners: RunnerId[] = [...DEFAULT_RUNNERS], edited = false): void {
    const queued = edited ? [...this.queuedStarts] : [];
    // End what belongs to the plan being replaced before it is swapped: its
    // ledgers are its tasks', and a task of the next plan that reuses an id
    // must not inherit them. The bump then closes the scope, so a runner still
    // winding down reports into nothing rather than into the next plan.
    const repairs = this.endAllAttempts('load').filter((a) => a.kind.kind === 'repair' && a.worktree);
    this.planScope += 1;
    this.store.load(tasks, planRunners);
    for (const a of repairs) this.unawaited(this.runs.release(a.taskId, { keep: true }, a.integration), `Could not keep the worktree of task "${this.store.get(a.taskId)?.title ?? a.taskId}"`);
    // A plan committed while the scheduler runs keeps that run, and its mode
    // with it; otherwise the next start decides afresh.
    this.runs.interrupt({ keepOpen: this.isScheduling });
    // A held or ended run belongs to the plan it was in, whose failed tasks this
    // load gives a fresh chance: kept, the next retry would restart a run
    // nobody started, and a usage-limit move would arm the scheduler. A plan
    // loaded from disk holds no run either, so at a reset only its paused
    // tasks resume, as after any restart.
    if (this.runState !== 'scheduling') this.runState = 'idle';
    this.reviewApproved = false;
    this.retryCounts.clear();
    this.spawnCounts.clear();
    this.onHold.clear();
    this.queuedStarts = new Map(queued.filter(([id]) => this.store.get(id)));
    this.recoverOrphans();
    this.rearmLimitWaits();
  }

  /**
   * Adopt an edited plan without letting go of the run in progress. Everything
   * the scheduler owns — live sessions, holds, retry counts, the verifier and
   * the review approval — survives, because `loadPlan` clears all of it and a
   * mid-run edit is not a new run. Only the tasks change.
   *
   * The ids with live sessions are defended: one dropped from the edited plan is
   * carried over (its verdict still has to land somewhere), and one whose status
   * the snapshot predates is put back to `in_progress` — adopting the snapshot's
   * "pending" would offer the scheduler work a runner is already doing.
   *
   * A failed task stays failed, unlike a plan load's fresh chance: an edit is
   * not a retry, and the tasks it blocks wait for that retry (ADR-0034).
   */
  reconcilePlan(newTasks: readonly Task[], planRunners: RunnerId[] = [...DEFAULT_RUNNERS]): void {
    const before = this.store.planTasks;
    const adopted = [...newTasks];
    for (const taskId of this.attempts.keys()) {
      const task = this.store.get(taskId);
      if (!task) continue;

      const at = adopted.findIndex((t) => t.id === taskId);
      if (at < 0) {
        adopted.push({ ...task });
      } else if (adopted[at].status !== 'in_progress') {
        console.warn(`[TaskOrchestrator] Running task "${task.title}" status changed to "${adopted[at].status}" in modified plan, using orchestrator truth`);
        adopted[at] = { ...adopted[at], status: 'in_progress' };
      }
    }

    const waitingRunners = new Set(this.store.allTasks.filter(waitsForReset).map((t) => this.store.resolveTaskRunner(t)));
    this.store.load(adopted, planRunners, { keepFailed: true });
    this.planEdited(before);
    // An edit that took the last task waiting on a runner's reset out of the
    // plan — or ended its pause by re-arming it — releases the hold and
    // disarms the wait, so the run goes on and no timer resumes a wait
    // nothing owes (ADR-0018, U1).
    for (const runner of waitingRunners) if (this.waitingOn(runner).length === 0) this.limitWaits.disarm(runner);
    this.releaseHold();
  }

  /**
   * An edit landed on the plan — a planner's task ops through
   * {@link reconcilePlan}, or the user's direct edit through the PlanEditor.
   * One that leaves a loop's check out of rounds ends the loop (ADR-0045 L6):
   * what of its body has not run will not run, and, while the run is under
   * way, the check settles once more so the supervisor hears the end. Nothing
   * else notices such an edit: the check settled when it failed a round, and
   * no round will run it again.
   */
  planEdited(before: readonly Task[]): void {
    const was = new Map(before.map((task) => [task.id, task]));
    for (const check of this.store.allTasks) {
      if (!outOfRounds(check)) continue;
      const prior = was.get(check.id);
      if (prior && outOfRounds(prior)) continue;
      this.closeLoop(check, LOOP_OUT_OF_ROUNDS);
      // Outside a run there is no supervisor to settle it for, and the next
      // run starts a failed check's rounds over; the close still stands.
      if (this.isRunning) this.emit('onTaskSettled', { taskId: check.id });
    }
  }

  /** Start the full-plan run, or continue one that is held or ended on a failure. */
  async start(origin: RunOrigin = 'user'): Promise<void> {
    if (this.runs.blocked) return;
    if (this.isScheduling) {
      console.error('[TaskOrchestrator] start() called but already running: no-op');
      return;
    }
    if (!this.reviewApproved) {
      console.log('[TaskOrchestrator] start() blocked: plan review not yet approved. Emitting onReviewNeeded.');
      this.emit('onReviewNeeded', { tasks: this.store.planTasks, planRunners: this.store.planRunners });
      return;
    }
    this.openRun(origin);
    console.log(`[TaskOrchestrator] Starting with ${this.store.allTasks.length} tasks (${this.store.allTasks.filter(t => t.type === 'ai' && t.prompt).length} AI ready)`);
    this.runState = 'scheduling';
    this.emit('onTaskChanged');
    await this.tick();
  }

  /**
   * A usage-limit pause with a reset to wait for holds the run (ADR-0018,
   * U1): spawning more would spend the same exhausted limit, and the run
   * stays open — neither handed over nor merged at its end — however it was
   * started, so a task started alone keeps its run for the reset too. A pause
   * no reset will resume holds nothing: it keeps only its own runner's tasks
   * from starting (`readiness.usage-limit`).
   */
  private holdOnLimit(): void {
    if (this.runState === 'scheduling' || this.runState === 'idle') this.runState = 'held';
  }

  /**
   * Stop the run. The user's Stop also withdraws every start admitted before
   * it and not yet claimed (ADR-0029); a `restart` only disarms an idle
   * scheduler for the run about to start, which must not undo starts asked
   * for meanwhile.
   */
  stop(reason: 'user' | 'restart' = 'user'): void {
    if (reason === 'user') this.stopGeneration++;
    this.runState = 'idle';
    // Let the verifier go before the runners: a killed session fires its exit
    // synchronously, and under a still-valid generation that exit is a verdict
    // — for a conflict repair, one that lands work the stop just cancelled.
    this.verifier.reset();
    // Each attempt's runner winds down as any ended attempt's does, so what it
    // reports meanwhile is still counted; whatever is still starting goes too.
    for (const attempt of this.attempts.values()) this.stopRunner(attempt);
    this.runner.stopAll();
    this.scriptRunner.stopAll();
    // Interrupted work is kept like a failed attempt's: inspectable, and off
    // `active` so a crash-recovery prune does not sweep it away. A stopped
    // repair did not land, so its task waits on the user as its conflict did;
    // every other stopped task is back to not started, as a cancel leaves it.
    // Left in progress, it would read as running with nothing behind it — and
    // its kept worktree as work a finished run could clear up.
    const stopped: TaskAttempt[] = [];
    for (const a of this.endAllAttempts('stop')) {
      if (a.kind.kind === 'repair') this.store.markAwaitingUser(a.taskId, 'conflict');
      else if (this.store.get(a.taskId)) {
        this.store.markPending(a.taskId);
        stopped.push(a);
      }
      if (a.worktree) this.unawaited(this.runs.release(a.taskId, { keep: true }, a.integration), `Could not keep the worktree of task "${this.store.get(a.taskId)?.title ?? a.taskId}"`);
    }
    this.runs.interrupt();
    this.onHold.clear();
    if (reason === 'user') this.queuedStarts.clear();
    // A stopped run does not start itself again: what waited on a reset waits for the user now.
    for (const t of this.store.allTasks.filter(waitsForReset)) this.dropResume(t.id);
    this.sayStopped(stopped);
    this.recoverOrphans();
    this.emit('onTaskChanged');
  }

  /** Name the tasks a stop took down, so none is mistaken for one still at work. */
  private sayStopped(stopped: readonly TaskAttempt[]): void {
    if (stopped.length === 0) return;
    const one = stopped.length === 1;
    const named = quotedList(stopped.map((a) => this.store.get(a.taskId)?.title ?? a.taskId));
    const kept = stopped.some((a) => a.worktree)
      ? ` What ${one ? 'it' : 'they'} did is kept in ${one ? 'its worktree' : 'their worktrees'}: Mark complete lands it; Retry starts over and keeps it on a branch.`
      : '';
    this.tell('info', `Stopped ${named}: back to not started.${kept}`);
  }

  /**
   * A task in progress with no attempt has nothing running it: a stop, a plan
   * load or anything else that ended its attempt left its status behind. It
   * is put back to not started, and said, so it can be retried rather than
   * read as running — or, in an isolated run, count as live work forever.
   */
  private recoverOrphans(): void {
    const orphans = this.store.allTasks.filter((t) => t.type !== 'user' && t.status === 'in_progress' && !this.attempts.has(t.id) && !this.completing.has(t.id));
    if (orphans.length === 0) return;
    for (const t of orphans) this.store.markPending(t.id);
    const one = orphans.length === 1;
    const titles = quotedList(orphans.map((t) => t.title));
    this.tell('warn', `${one ? 'Task' : 'Tasks'} ${titles} ${one ? 'was' : 'were'} shown as running, but nothing was running ${one ? 'it' : 'them'}: back to not started. Retry or force-start ${one ? 'it' : 'them'}; a worktree ${one ? 'it' : 'they'} had is kept.`);
    this.emit('onTaskChanged');
  }

  /**
   * Task ids still live, whose worktrees no clean-up of the whole run may
   * take: an attempt is running them, or the plan has them in progress or
   * waiting on the user mid-attempt — at a checkpoint, or for input. One
   * waiting on the user's decision instead (a conflict, a usage limit, files
   * an ops task changed) is not: no runner is at work on it, and a clean-up
   * keeps what it holds on a branch before its worktree goes.
   */
  private liveTaskIds(): Set<string> {
    const live = new Set(this.attempts.keys());
    for (const t of this.store.allTasks) {
      const midAttempt = t.status === 'awaiting_user' && (t.awaitingReason === 'checkpoint' || t.awaitingReason === 'input');
      if (t.status === 'in_progress' || midAttempt) live.add(t.id);
    }
    return live;
  }

  /**
   * Whether the run may close with its handoff: no task is live. A handoff
   * tells the user the run has finished, and a Merge all after it clears the
   * run up, so neither may happen under a task the plan still shows at work.
   */
  private get settled(): boolean {
    return this.liveTaskIds().size === 0;
  }

  /**
   * The boundary a verdict crosses: nothing awaits the verifier's listener, so
   * a throw from reading the output, landing, releasing a worktree or the tick
   * after would be an unhandled rejection — and an attempt left integrating is
   * live work forever. One that never settled fails (a repair waits on the
   * user, as its conflict did) and blocks only its dependents; either way the
   * run says why and goes on.
   */
  private async deliverVerdict(taskId: string, verdict: Verdict): Promise<void> {
    const attempt = this.attempts.get(taskId);
    try {
      await this.onVerdict(taskId, verdict);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      try {
        const title = this.store.get(taskId)?.title ?? taskId;
        const unsettled = attempt !== undefined && this.attempts.get(taskId) === attempt;
        if (unsettled) {
          this.endAttempt(taskId, 'verdict');
          if (attempt.kind.kind === 'repair') this.store.markAwaitingUser(taskId, 'conflict');
          else this.store.markFailed(taskId);
          this.store.setTaskOutputSummary(taskId, summarizeOutput(reason, ''));
          // Its landing may be what threw, so the release does not wait on it.
          if (attempt.worktree) this.unawaited(this.runs.release(taskId, { keep: true }), `Could not keep the worktree of task "${title}"`);
        }
        this.tell('error', unsettled ? `Task "${title}" could not be settled: ${reason}` : `Task "${title}" settled, but what follows it could not be scheduled: ${reason}`);
        this.unawaited(this.afterVerdict(taskId), 'The run could not be closed');
      } catch (cleanupErr) {
        // Nothing awaits a verdict, so this is the last place its failure can surface.
        console.error(`[TaskOrchestrator] verdict for ${taskId} failed (${reason}) and so did handling it:`, cleanupErr);
      }
    }
  }

  /** Work nothing awaits: a rejection is said, not left unhandled. */
  private unawaited(work: Promise<unknown>, failure: string): void {
    work.catch((err: unknown) => {
      const message = `${failure}: ${err instanceof Error ? err.message : String(err)}`;
      try {
        this.tell('error', message);
      } catch (tellErr) {
        console.error(`[TaskOrchestrator] ${message}; saying so failed:`, tellErr);
      }
    });
  }

  private async onVerdict(taskId: string, verdict: Verdict): Promise<void> {
    const task = this.store.get(taskId);
    const attempt = this.attempts.get(taskId);
    if (!task || !attempt) return;
    attempt.decided = true;
    // Read before anything is awaited: the turn an exit cut short ends a moment later.
    const stoppedMidTurn = endedByExit(verdict) ? saidInFlight(attempt) : null;
    // Not after the landing: whatever the runner did meanwhile would go unverified (ADR-0018, L1).
    this.stopRunner(attempt);

    console.error(`[TaskOrchestrator] Task ${taskRefOf(this.store.planTasks, task.id) ?? `#${task.order}`} "${task.title}" verdict=${verdict.outcome}`);
    if (attempt.script) {
      console.error(`[TaskOrchestrator] Script body: ${JSON.stringify(scriptBodyOf(task)).slice(0, 200)}`);
    } else {
      console.error(`[TaskOrchestrator] Runner: ${task.assignedRunner}, Model: ${task.assignedModel?.modelId ?? 'default'}`);
      console.error(`[TaskOrchestrator] Prompt preview: ${(task.prompt ?? '').slice(0, 200)}`);
    }
    if (attempt.kind.kind === 'repair') return this.settleRepair(task, attempt, verdict);

    // A verdict can arrive inside whatever ended the runner: a stop kills every
    // session before it ends their attempts. Applied a tick later, it finds
    // such an attempt ended and leaves the task as that left it.
    await Promise.resolve();
    if (this.attempts.get(taskId) !== attempt) return;
    const summary = this.output.finalText(taskId);
    const report = this.output.report(taskId);
    const landing = verdict.outcome === 'pass' ? await this.land(attempt, () => this.landing.landPassed(task, attempt)) : null;
    const changedFiles = landing && checksTree(attempt.kind) ? await this.runs.filesChangedSince(attempt.snapshot) : [];
    const unresumedReason = this.unresumed(attempt) ? unresumedMessage(task, `${attempt.runner} could not find its saved session`) : null;
    if (this.attempts.get(taskId) !== attempt) return;
    this.endAttempt(taskId, 'verdict');
    this.store.setTaskVerdict(taskId, verdict);
    console.error(`[TaskOrchestrator] Output summary:\n${summary || '(empty: no output captured)'}`);
    if (changedFiles.length > 0) {
      // The evidence the ops rule rests on: a runner cannot be kept from
      // writing, only caught. Nothing is committed, and nothing fails.
      this.store.markAwaitingUser(taskId, 'files-changed');
      this.tell('warn', `Ops task "${task.title}" finished, but changed tracked files in your checkout: ${capConflictFiles(changedFiles)}. An ops task must not change repository files, so nothing was committed: look at the changes, then mark it complete or retry it.`);
    } else if (landing) {
      await this.applyLanding(task, landing, attempt.admission, () => this.notifications.info(`Task "${task.title}" completed.`));
    } else if (stoppedMidTurn !== null && classifyRunnerStop(stoppedMidTurn) === 'usage-limit') {
      this.pauseOnLimit(task, attempt, stoppedMidTurn);
      if (attempt.worktree) await this.runs.release(taskId, { keep: true });
    } else {
      // Missing completion evidence is a hard boundary for what depends on
      // this task: its dependents are blocked until a retry passes
      // (ADR-0034). Independent work keeps starting. A loop's check that
      // starts a round instead is no failure yet (ADR-0045 L3).
      this.store.markFailed(taskId);
      if (!this.startRound(taskId)) this.notifications.error(unresumedReason ?? failureText(this.store.get(taskId) ?? task, verdict));
      if (attempt.worktree) await this.runs.release(taskId, { keep: true });
    }

    this.store.setTaskOutputSummary(taskId, summarizeOutput(unresumedReason ?? verdict.reason, summary, report));

    this.logAndArchive(task, verdict);
    await this.afterVerdict(taskId);
  }

  private async afterVerdict(taskId: string): Promise<void> {
    // A conflict owed a repair is back in progress: nothing has settled yet.
    const status = this.store.get(taskId)?.status;
    if (status === 'completed' || status === 'failed' || status === 'awaiting_user') this.emit('onTaskSettled', { taskId });
    this.emit('onTaskChanged');
    if (this.isScheduling) {
      await this.tick();
      return;
    }
    // A run the scheduler is not driving settles here rather than in a tick,
    // so what was queued behind this task starts here too.
    await this.startQueued();
    await this.settleRun('verdict');
  }

  /**
   * A repair's verdict never replaces the verdict the task's own work earned,
   * and a repair that does not land leaves the task waiting on the user —
   * never a failed task, so never one that blocks its dependents.
   */
  private async settleRepair(task: Task, attempt: TaskAttempt, verdict: Verdict): Promise<void> {
    const outcome = await this.land(attempt, () => this.landing.settleRepair(task, verdict, () => this.attempts.get(task.id) === attempt));
    if (this.attempts.get(task.id) !== attempt) return;
    this.endAttempt(task.id, 'verdict');
    await this.applyLanding(task, outcome, attempt.admission, () => {
      this.logAndArchive(task, task.verdict ?? verdict);
    });
    await this.afterVerdict(task.id);
  }

  /**
   * Hand an attempt's verdict to Landing. The attempt stays live while that
   * settles — it may wait on the module's merge queue — so a cancel, retry or
   * stop in that window still wins, and waits for the merge before tearing the
   * worktree down; nothing counts the task as done before its work is on the
   * integration branch.
   */
  private land(attempt: TaskAttempt, settle: () => Promise<LandingOutcome>): Promise<LandingOutcome> {
    attempt.phase = 'integrating';
    attempt.integration = settle();
    return attempt.integration;
  }

  /**
   * Settle a task by how its landing went; `onLanded` is what the path that
   * landed it adds to completing it. `admission` is the start the landed work
   * came from, which a repair follows on from.
   */
  private async applyLanding(task: Task, outcome: LandingOutcome, admission: Admitted, onLanded: () => void): Promise<void> {
    if (!completesTask(outcome)) return this.settleUnlanded(task, outcome, admission);
    this.store.markCompleted(task.id);
    this.closeLoop(task, LOOP_PASSED);
    onLanded();
    this.say(outcome.messages);
    await this.landResolved(task.id, admission);
  }

  /**
   * Work that did not land waits on the user — it never fails the task or
   * blocks its dependents — unless its conflict is owed a repair, which takes
   * the slot the ending attempt freed and never one more than the run allows.
   * The repair follows on from the start whose work it repairs: a Stop since
   * that was admitted withdraws it.
   */
  private settleUnlanded(task: Task, outcome: UnlandedOutcome, admission: Admitted): void {
    this.store.markAwaitingUser(task.id, 'conflict');
    this.say(outcome.messages);
    if (outcome.kind !== 'repair-needed') return;
    if (this.attempts.size < this.config.maxParallelSessions) {
      const claimed = this.claim(task.id, admission);
      if ('refused' in claimed) this.tell('warn', `The conflict of task "${task.title}" is not repaired: ${claimed.refused}`);
      else this.unawaited(claimed.spawned, `Could not start the repair of task "${task.title}"`);
    } else {
      this.store.markPending(task.id);
      this.tell('info', `Task "${task.title}" is repaired once a slot is free.`);
    }
  }

  private async landResolved(resolverId: string, admission: Admitted): Promise<void> {
    const resolved = await this.landing.landResolved(resolverId);
    if (!resolved) return;
    const { task, outcome } = resolved;
    await this.applyLanding(task, outcome, admission, () => {
      if (task.verdict) this.logAndArchive(task, task.verdict);
    });
  }

  getReadyTasks(): Task[] {
    return this.readiness().ready;
  }

  private readiness(): Readiness {
    if (!this.isScheduling) return { ready: [], candidateCount: 0, excluded: [], gated: [] };
    const maxParallel = this.config.maxParallelSessions;
    const active = this.attempts.size;
    const readiness = selectReadyTasks({ ...this.startRule(), active, maxParallel });

    for (const { task, waits } of readiness.excluded) {
      console.log(`[TaskOrchestrator] excluded: ${taskRefOf(this.store.planTasks, task.id) ?? `#${task.order}`} "${task.title}": ${waits.map((w) => w.kind).join(', ')}`);
    }
    console.log(`[TaskOrchestrator] getReadyTasks: ${readiness.candidateCount} candidates, ${Math.max(0, maxParallel - active)} slots, maxParallel=${maxParallel}`);
    return readiness;
  }

  private mergesAutomatically(): boolean {
    return this.runSettings()?.mergeAtGatesAutomatically ?? false;
  }

  /**
   * The user changed the run settings under an open run (ADR-0030). The
   * scheduler reads them at each decision it makes from them, so a merge gate
   * already reached is merged now rather than at the next event. Fire-and-forget
   * — no caller waits on the change — and its failure is said through
   * {@link unawaited}, never left unhandled.
   */
  runSettingsChanged(): void {
    if (!this.runs.isOpen || !this.isScheduling) return;
    this.unawaited(this.tick(), 'Could not act on the changed run settings');
  }

  private openRun(origin: RunOrigin): void {
    const opening = !this.runs.isOpen;
    this.runs.open();
    if (!opening) return;
    this.autoMergeBlocked = false;
    this.emit('onRunStarted', { origin });
  }

  /**
   * Open the run a task starts in, and decide whether it isolates if the
   * task's next attempt needs that ({@link decidesIsolation}). False while a
   * dirty tree waits on the user; `resume` is what their choice replays.
   */
  private async openFor(taskId: string, origin: RunOrigin, resume: () => Promise<void>): Promise<boolean> {
    this.openRun(origin);
    return !decidesIsolation(this.nextAttemptKind(taskId)) || this.runs.decide(resume);
  }

  /**
   * {@link openFor} for an explicit start under `admission`. A Stop while the
   * run opened interrupts that opening too, which then opens nothing; the
   * start says it was stopped rather than going quiet as if a dirty tree were
   * waiting on the user.
   */
  private async openForAdmitted(taskId: string, origin: RunOrigin, resume: () => Promise<void>, admission: Admitted): Promise<boolean> {
    const opened = await this.openFor(taskId, origin, resume);
    if (!admission.current()) throw new TaskControlError(STOPPED_BEFORE_START);
    return opened;
  }

  /** The kind a task's next attempt starts as, short of a repair or a continue: what is weighed before one exists. */
  private nextAttemptKind(taskId: string): AttemptKind {
    const task = this.store.get(taskId);
    return classifyAttempt(task ? this.workOf(task) : 'change', { carriedFrom: task?.carriedFrom });
  }

  /**
   * What a task's work is. A read-only task is one on the mode its runner's
   * manifest tags read-only (ADR-0001), which is what lands nothing (ADR-0046).
   */
  private workOf(task: Task): TaskWork {
    if (this.store.isOps(task.id)) return 'ops';
    const modes = this.registry?.get(this.store.resolveTaskRunner(task))?.manifest.modes;
    return task.type === 'ai' && task.taskMode !== undefined && task.taskMode === taggedReadOnlyMode(modes) ? 'readOnly' : 'change';
  }

  /**
   * Cancel a running (or scheduled) task: kill its session and return it to
   * 'pending' — "not executed". The task is put on hold so the scheduler
   * doesn't immediately restart it; Retry / Force Start release the hold.
   *
   * The attempt's worktree is kept, as a stopped or failed one is: a runner is
   * often cancelled because it looked stuck after doing the work, and Mark
   * complete can still land that work. The next attempt replaces it.
   */
  async cancelTask(taskId: string): Promise<void> {
    await this.cancelAttempt(taskId, { keep: true });
  }

  private async cancelAttempt(taskId: string, worktree: { keep: boolean }): Promise<void> {
    const task = this.store.get(taskId);
    if (!task) return;
    // A cancel that arrives after the task already settled (its verdict
    // landed and the attempt was torn down) has nothing left to cancel. Without
    // this guard it would still revert a completed/failed task to 'pending',
    // silently discarding a verdict that already landed.
    if (!this.attempts.has(taskId) && task.status !== 'in_progress') return;
    const ended = this.endAttempt(taskId, 'cancel');
    this.store.markPending(taskId);
    this.onHold.set(taskId, 'cancelled; retry or force start to run it again');
    this.emit('onTaskChanged');
    await this.runs.release(taskId, worktree, ended?.integration);
    await this.tick();
  }

  /**
   * Let go of a task that is leaving the plan. A live runner is cancelled
   * as {@link cancelTask} does, but its worktree goes: no task is left to land
   * it into. A spawn still in flight just loses its attempt,
   * which is what makes {@link runClaimed} kill the session it is about to
   * receive. The id's cross-attempt bookkeeping goes too — a hold or retry
   * count kept for a task that no longer exists would be inherited by nothing.
   */
  async releaseTask(taskId: string): Promise<void> {
    this.dropResume(taskId);
    const phase = this.attempts.get(taskId)?.phase;
    if (phase === 'running' || phase === 'integrating') await this.cancelAttempt(taskId, { keep: false });
    else {
      this.endAttempt(taskId, 'release');
      // Not left in progress while its worktree goes: it is leaving the plan, not running.
      if (this.store.get(taskId)?.status === 'in_progress') this.store.markPending(taskId);
      await this.runs.release(taskId, { keep: false });
    }
    this.onHold.delete(taskId);
    this.retryCounts.delete(taskId);
    this.spawnCounts.delete(taskId);
  }

  async markTaskComplete(taskId: string): Promise<void> {
    const task = this.store.get(taskId);
    if (!task || task.status === 'completed') return;
    // A second call made while the first awaits its landing finds no attempt —
    // it was ended by the first — and would land, archive and announce again.
    if (this.completing.has(taskId)) return;
    // A repair its landing may be owed follows on from this, the user's act.
    const admission = this.admittedNow();

    const ended = this.endAttempt(taskId, 'complete');
    const verdict = this.verifier.markComplete(task);
    // The user vouches for the work, so it lands the way a passed verdict's
    // would — including a landing a passed verdict already has in flight.
    this.completing.add(taskId);
    let landing: LandingOutcome;
    try {
      landing = await (ended?.integration ?? this.landing.landVouched(task));
    } finally {
      this.completing.delete(taskId);
    }

    if (completesTask(landing)) {
      this.store.markCompleted(taskId);
      this.closeLoop(task, LOOP_CHECK_MARKED_COMPLETE);
    } else this.settleUnlanded(task, landing, admission);
    this.store.setTaskVerdict(taskId, verdict);
    this.store.setTaskOutputSummary(taskId, summarizeOutput(verdict.reason, ''));
    this.logAndArchive(task, verdict);
    if (completesTask(landing)) {
      this.onHold.delete(taskId);
      this.notifications.info(`Task "${task.title}" marked complete.`);
      this.say(landing.messages);
      await this.landResolved(taskId, admission);
    }

    // A task paused on a usage limit no longer waits on its reset.
    this.releaseHold();
    this.emit('onTaskChanged');
    await this.tick();
  }

  /**
   * Undo a completion: return the task to "not executed" — pending, verdict and
   * summary dropped, archive entry removed. It is put on hold like a cancel, so
   * a running plan does not immediately re-spawn the work the user just
   * un-marked; Retry / Force Start / Run release the hold. Dependents fall back
   * to waiting on their own, because the scheduler gates on `isCompleted`.
   */
  async markTaskIncomplete(taskId: string): Promise<void> {
    const task = this.store.get(taskId);
    if (!task || task.status !== 'completed') return;

    this.verifier.clear(task);
    this.store.retry(taskId);
    this.store.removeFromLog(taskId);
    this.onHold.set(taskId, 'marked not done; retry or force start to run it again');

    this.notifications.info(`Task "${task.title}" marked not done.`);
    this.emit('onTaskChanged');
    await this.tick();
  }

  /**
   * Skip: end a task as `skipped`, with no verdict and nothing of its work
   * landed. Its worktree is kept, as a failed attempt's is, so the user can
   * still look at it or Mark complete it later. Its dependents go ahead
   * without it once the work it waited on is done, and a run that ended on a
   * failure continues for them, as a retry would continue it. A running task is stopped before it is skipped.
   */
  async skipTask(taskId: string, reason?: string, origin: RunOrigin = 'user'): Promise<void> {
    const task = this.store.get(taskId);
    if (!task || task.status === 'completed' || task.status === 'skipped' || this.completing.has(taskId)) return;
    if (task.status === 'in_progress') throw new TaskControlError(`Task "${task.title}" is running: stop it before skipping it.`);
    await this.whileAdmitted(async (admission) => {
      // Dropping its resume may release a held run, which the tick below then schedules.
      this.dropResume(taskId);
      const ended = this.endAttempt(taskId, 'skip');
      this.verifier.clear(task);
      this.store.markSkipped(taskId, reason?.trim() || undefined);
      this.closeLoop(task, LOOP_CHECK_SKIPPED);
      this.onHold.delete(taskId);
      this.notifications.info(`Task "${task.title}" skipped: none of its work lands, and the tasks that depend on it go ahead without it once the work it waited on is done.`);
      this.emit('onTaskChanged');
      await this.runs.release(taskId, { keep: true }, ended?.integration);
      // A Stop while the worktree was kept leaves the run stopped: the skip
      // stands, and nothing it released starts. A run another task's reset
      // still holds stays held; only one that ended on a failure starts
      // afresh, as a retry continues it (ADR-0034).
      if (this.runState === 'endedOnFailure' && admission.current()) await this.start(origin);
      else await this.tick();
    });
  }

  private logAndArchive(task: Task, verdict: Verdict): void {
    const snapshot: TaskSnapshot = {
      ...task,
      completedAt: Date.now(),
      verdict,
      retryCount: this.retryCounts.get(task.id) ?? 0,
      finalized: true,
    };
    this.store.appendToLog(snapshot);
    // Completed tasks remain in the active plan tree so the UI can keep
    // showing them alongside pending and running work.
  }

  async retryTask(taskId: string, origin: RunOrigin = 'user'): Promise<void> {
    const task = this.store.get(taskId);
    if (!task) return;
    await this.whileAdmitted(async (admission) => {
      // A retried task's own pause ends with it; that may release a held run,
      // which the tick below then schedules (ADR-0018, U1).
      this.dropResume(taskId);
      this.retryCounts.set(taskId, (this.retryCounts.get(taskId) ?? 0) + 1);
      const ended = this.endAttempt(taskId, 'retry');
      const movedFrom = this.movedFrom(task);
      this.store.retry(taskId);
      if (movedFrom) this.store.setCarriedFrom(taskId, movedFrom);
      this.onHold.delete(taskId);
      this.emit('onTaskChanged');
      if (movedFrom) {
        // The earlier runner's work is the new attempt's to restore, so its worktree stays until that prepare replaces it.
        await ended?.integration;
      } else {
        // A retry starts over from the integration tip, which by now holds what its
        // predecessors landed; the old attempt's worktree has nothing to offer it.
        await this.runs.release(taskId, { keep: false }, ended?.integration);
      }
      // A Stop while the worktree went leaves the run stopped, the task back to not started.
      if (!admission.current()) return;
      // A retry continues a run that ended on a failure (ADR-0034); a held
      // run another task still owes a reset stays held.
      if (this.runState === 'endedOnFailure') await this.start(origin);
      else await this.tick();
    });
  }

  /**
   * Continue a finished structured task in its saved runner session (ADR-0018,
   * K1): a retry whose first turn is the user's message, sent to the session
   * the task ended in rather than a fresh one given its prompt again. The
   * worktree keeps the same path, where the runner keeps its sessions, and
   * restores the previous work so that session's memory matches its files.
   */
  async continueTask(taskId: string, message: string, origin: RunOrigin = 'user'): Promise<void> {
    const text = message.trim();
    if (!text) throw new TaskControlError('A message to continue a task with cannot be empty.');
    const task = this.store.get(taskId);
    if (!task) throw new TaskControlError(`No task ${taskId} in this plan.`);
    const eligible = continuability(task);
    if (!eligible.ok) throw new TaskControlError(eligible.reason);
    if (pausedOnLimit(task)) return this.resumeNow(taskId, origin, text);
    await this.whileAdmitted(async (admission) => {
      if (!(await this.openForAdmitted(taskId, origin, () => this.continueTask(taskId, message, origin), admission))) return;
      // The run may have started it while opening, or the task changed: the
      // claim below must be the only one, and continues the task as it is now.
      const now = this.store.get(taskId);
      const resumable = now && continuability(now);
      if (this.attempts.has(taskId) || !resumable?.ok) return;
      this.refuseClaim(taskId, admission);

      this.retryCounts.set(taskId, (this.retryCounts.get(taskId) ?? 0) + 1);
      this.endAttempt(taskId, 'retry');
      this.store.retry(taskId);
      this.onHold.delete(taskId);
      // Claimed before anything is awaited, so a running scheduler never sees the
      // pending task and starts it afresh. Its prepare replaces the old worktree.
      const started = this.claimed(taskId, admission, { message: text, resumeSessionId: resumable.sessionId });
      // A continuation continues a run that ended on a failure; a run another
      // task's reset still holds stays held.
      const resumed = this.runState === 'endedOnFailure' ? this.start(origin) : Promise.resolve();
      // Both are awaited even if one fails: the claimed attempt's start must not
      // be left unhandled because restarting the run threw.
      await Promise.all([resumed, started]);
    });
  }

  /**
   * Keep a task paused on its runner's usage limit from resuming on its own:
   * it waits for a manual retry, as one whose reset time could not be read
   * does. What a surface's cancel calls. A run the pause held goes on once
   * nothing else waits on a reset. False when no resume was scheduled for it.
   */
  async cancelScheduledResume(taskId: string): Promise<boolean> {
    if (!this.dropResume(taskId)) return false;
    await this.tick();
    return true;
  }

  /** {@link cancelScheduledResume} without its tick, for a caller that ticks or starts once it is done. */
  private dropResume(taskId: string): boolean {
    const task = this.store.get(taskId);
    if (!task || !waitsForReset(task)) return false;
    const runner = this.store.resolveTaskRunner(task);
    this.store.setTaskResumeAt(taskId, undefined);
    if (this.waitingOn(runner).length === 0) this.limitWaits.disarm(runner);
    this.releaseHold();
    this.emit('onUsageLimitWait', { taskId, runner, resumeAt: null, cancelled: true });
    this.emit('onTaskChanged');
    return true;
  }

  /**
   * The hold a usage-limit pause put on the run is released once nothing
   * waits on a reset (ADR-0018, U1) — however the last wait went: the reset,
   * a cancel, Mark complete or the task leaving the plan. The run is still
   * open, so the next tick schedules it.
   */
  private releaseHold(): void {
    if (this.runState === 'held' && !this.store.allTasks.some(waitsForReset)) this.runState = 'scheduling';
  }

  /**
   * The runner whose attempt left the task's work, when the task has been
   * moved off it since: a session cannot cross runners, so whatever starts
   * the task next is a carry-over of that work, the rule a paused task's move
   * follows (ADR-0018, U1).
   */
  private movedFrom(task: Task): RunnerId | undefined {
    const owner = sessionOwner(task);
    return owner && owner !== this.store.resolveTaskRunner(task) ? owner : undefined;
  }

  /**
   * Run before writing assignments so cancellation sees the old runner's
   * shared wait. A session cannot cross runners, so the next attempt is a
   * carry-over of the paused attempt's files (ADR-0018, U1).
   *
   * The move routes the task around the limit, so a run the pause held goes
   * on, as a retry would continue it. That run is still open — a hold never
   * closes one — and every edit that calls this ticks once it is written,
   * which starts the task.
   */
  releaseMovedResume(taskId: string, changes: Partial<Task>): Partial<Task> {
    const task = this.store.get(taskId);
    if (!task || task.status !== 'awaiting_user' || task.awaitingReason !== 'usage-limit') return changes;
    const next = { ...task, ...changes };
    // The limit belongs to the runner's account, so a model change on that
    // same runner must keep waiting for its reset.
    if ((next.assignedRunner ?? this.store.planRunners[0]) === this.store.resolveTaskRunner(task)) return changes;
    this.dropResume(taskId);
    this.onHold.delete(taskId);
    if (this.runState === 'held') this.runState = 'scheduling';
    return { ...changes, status: 'pending', awaitingReason: undefined, resumeAt: undefined, carriedFrom: this.store.resolveTaskRunner(task) };
  }

  /**
   * A task's attempt stopped on its runner's usage limit, without a
   * completion call. Failing would paint a red X on a task that only has to
   * wait, and spawning more tasks would spend the same exhausted limit, so the
   * task pauses and the run holds. When the runner said when its limit
   * resets, the task joins its runner's wait and resumes on its own then
   * (#84); otherwise, or when it was resumed a moment ago and hit the limit
   * again, it waits for the user to retry it.
   */
  private pauseOnLimit(task: Readonly<Task>, attempt: TaskAttempt, said: string | TurnFailure): void {
    this.store.markAwaitingUser(task.id, 'usage-limit');
    const kept = attempt.worktree ? ': its worktree is kept' : '';
    const reset = readUsageLimitReset(attempt.runner, said);
    const relapsed = attempt.autoResumed && Date.now() - Date.parse(attempt.startedAt) < RELAPSE_MS;
    if (!reset || relapsed) {
      const why = relapsed
        ? 'hit its usage limit again right after it was resumed, so it is not resumed on its own again'
        : 'hit its usage limit';
      this.tell('warn', `Task "${task.title}" stopped before it reported completion: ${attempt.runner} ${why}. Retry it once the limit resets${kept}.`);
      this.emit('onUsageLimitWait', { taskId: task.id, runner: attempt.runner, resumeAt: null });
      return;
    }
    this.store.setTaskResumeAt(task.id, new Date(reset.getTime() + RESUME_MARGIN_MS).toISOString());
    this.holdOnLimit();
    const resumeAt = this.armLimitWait(attempt.runner);
    this.tell('info', `Task "${task.title}" paused: ${attempt.runner} hit its usage limit. It resumes on its own at ${resumeTime(resumeAt)}${kept}.`);
    this.emit('onUsageLimitWait', { taskId: task.id, runner: attempt.runner, resumeAt: resumeAt.toISOString() });
  }

  /**
   * The limit arrived as the turn's error with the runner still up: the
   * attempt ends here, as its verdict would have ended it, so a resume is a
   * continue in a fresh process (ADR-0018, L1/K1).
   */
  private async stopOnLimit(taskId: string, attempt: TaskAttempt): Promise<void> {
    const task = this.store.get(taskId);
    if (!task) return;
    attempt.decided = true;
    const summary = this.output.finalText(taskId);
    this.endAttempt(taskId, 'usage-limit');
    this.pauseOnLimit(task, attempt, attempt.turnError ?? '');
    this.store.setTaskOutputSummary(taskId, summarizeOutput(attempt.turnError?.message ?? `${attempt.runner} hit its usage limit`, summary));
    if (attempt.worktree) await this.runs.release(taskId, { keep: true });
    await this.afterVerdict(taskId);
  }

  /** The tasks waiting on `runner`'s reset to resume on their own. */
  private waitingOn(runner: string): Readonly<Task>[] {
    return this.store.allTasks.filter((t) => waitsForReset(t) && this.store.resolveTaskRunner(t) === runner);
  }

  /**
   * Arm `runner`'s one wait for the latest resume time among its tasks, and
   * put that time on each of them, so they resume together.
   */
  private armLimitWait(runner: string): Date {
    const latest = Math.max(...this.waitingOn(runner).map((t) => Date.parse(t.resumeAt ?? '')));
    const at = this.limitWaits.arm(runner, new Date(latest));
    for (const t of this.waitingOn(runner)) this.store.setTaskResumeAt(t.id, at.toISOString());
    return at;
  }

  /**
   * The waits a loaded plan still owes. A resume time that passed while
   * nothing was running — the daemon was down, say — resumes at once.
   */
  private rearmLimitWaits(): void {
    this.limitWaits.clear();
    for (const t of this.store.allTasks.filter(waitsForReset)) {
      if (Number.isNaN(Date.parse(t.resumeAt ?? ''))) this.store.setTaskResumeAt(t.id, undefined);
    }
    const runners = new Set(this.store.allTasks.filter(waitsForReset).map((t) => this.store.resolveTaskRunner(t)));
    for (const runner of runners) this.armLimitWait(runner);
  }

  /**
   * Resume a task paused on its runner's usage limit now, in its saved
   * session, once the user says the limit has reset early. The limit is the
   * runner's account's, so every task waiting on that runner's reset resumes
   * with it, as at the reset itself. `message` follows the reset notice in the
   * same continuation. A resumed attempt that hits the limit again at once
   * waits for the user, as an automatic resume's does: that is what keeps a
   * caller from resuming it round and round.
   */
  async resumeNow(taskId: string, origin: RunOrigin = 'user', message?: string): Promise<void> {
    const task = this.store.get(taskId);
    if (!task) throw new TaskControlError(`No task ${taskId} in this plan.`);
    if (!pausedOnLimit(task)) throw new TaskControlError(`Task "${task.title}" is not paused on a usage limit.`);
    const eligible = continuability(task);
    if (!eligible.ok) throw new TaskControlError(eligible.reason);
    // Refused before the runner's wait is disarmed, so a refusal leaves every
    // resume at the reset as it was.
    this.refuseClaim(taskId, this.admittedNow());
    const runner = this.store.resolveTaskRunner(task);
    this.limitWaits.disarm(runner);
    try {
      await this.resumeAfterLimit(runner, { taskId, origin, message: message?.trim() || undefined });
    } finally {
      // What did not resume — refused once its run opened, or swept along
      // with no slot left — still resumes at its reset.
      if (this.waitingOn(runner).length > 0) this.armLimitWait(runner);
    }
  }

  private async resumeAfterLimit(runner: string, now?: ResumeNow): Promise<void> {
    const asked = now ? this.store.get(now.taskId) : undefined;
    const due = [...(asked ? [asked] : []), ...this.waitingOn(runner).filter((t) => t.id !== asked?.id)];
    if (due.length === 0) return;
    this.tell('info', `The usage limit of ${runner} has reset: resuming ${quotedList(due.map((t) => t.title))}.`);
    await Promise.all(due.map((t) => this.resumeTask(t.id, now)));
  }

  /**
   * Retry a task paused on a usage limit, continuing its saved session where
   * it left one (ADR-0018, K1), then release the hold the pause put on the
   * run once nothing else waits on a reset. `now` is the Resume now that
   * asked for it, or for another task on its runner, which sweeps it along.
   */
  private async resumeTask(taskId: string, now?: ResumeNow): Promise<void> {
    const origin = now?.origin ?? 'limit-reset';
    const asked = now?.taskId === taskId;
    await this.whileAdmitted(async (admission) => {
      const opened = await this.openFor(taskId, origin, () => this.resumeTask(taskId, now));
      // One asked for now answers its caller as stopped; any other was stopped with its run, which said so.
      if (asked && !admission.current()) throw new TaskControlError(STOPPED_BEFORE_START);
      if (!opened) return;
      const task = this.store.get(taskId);
      // One asked for now resumes without a resume time; any other cancelled meanwhile stays put.
      if (!task || !(asked ? pausedOnLimit(task) : waitsForReset(task)) || this.attempts.has(taskId)) return;
      // A task a direct edit turned manual never runs, so the reset ends its
      // pause rather than spawning a runner for it (CONTEXT.md, "Start rule").
      if (task.type !== 'ai') {
        this.dropResume(taskId);
        return;
      }
      if (asked) this.refuseClaim(taskId, admission);
      else if (!this.mayResume(task, admission, now !== undefined)) return;
      const resumeSessionId = task.runnerSessionId;
      this.retryCounts.set(taskId, (this.retryCounts.get(taskId) ?? 0) + 1);
      // The attempt the limit cut short goes on, in the round it was in.
      this.store.retry(taskId, { sameRound: true });
      this.onHold.delete(taskId);
      const message = asked && now?.message ? `${LIMIT_RESET_MESSAGE}\n\n${now.message}` : LIMIT_RESET_MESSAGE;
      const continuation = resumeSessionId ? { message, resumeSessionId } : null;
      const started = this.claimed(taskId, admission, continuation, { autoResumed: true });
      const resumed = this.runState === 'held' && !this.store.allTasks.some(waitsForReset) ? this.start(origin) : Promise.resolve();
      // Both are awaited even if one fails: the claimed attempt's start must not
      // be left unhandled because restarting the run threw.
      await Promise.all([resumed, started]);
    });
  }

  /**
   * A resume nobody asked for cannot be refused to anyone. At the limit's
   * reset, one that may not claim waits for the user instead — its resume
   * time dropped, and said. One swept along by a Resume now keeps its resume
   * time, which its caller arms again: the reset has not come. A Stop says
   * so itself.
   */
  private mayResume(task: Readonly<Task>, admission: Admitted, swept: boolean): boolean {
    const refused = this.claimRefusal(task.id, admission);
    if (!refused) return true;
    if (!admission.current()) return false;
    if (swept) {
      this.tell('info', `Task "${task.title}" did not resume now: ${refused} It still resumes on its own at its usage limit's reset.`);
    } else {
      this.dropResume(task.id);
      this.tell('warn', `Task "${task.title}" did not resume at its usage limit's reset: ${refused} Resume it once it can start.`);
    }
    return false;
  }

  /**
   * Manually start a single AI task right now (the "force start" affordance on
   * a task card), past a failed dependency (ADR-0034) or a merge gate
   * (ADR-0020), but never past the claim: it still needs the user's approval,
   * a free slot, and no Stop since it was asked for, and throws
   * {@link TaskControlError} saying which it lacks. A dependency still under
   * way or yet to run is not forced past: the task is released to the
   * scheduler instead, which starts it once they finish, and the line saying
   * so is the answer.
   * Reuses the scheduler's own claim so a force-started task gets the same
   * augmented prompt, session tracking, and exit handling — callers must not
   * re-spawn the runner themselves. No-op if the task is unknown, a user
   * task, or already running.
   */
  async forceStartTask(taskId: string, origin: RunOrigin = 'user'): Promise<string | undefined> {
    const task = this.store.get(taskId);
    if (!task || task.type === 'user') return;
    if (this.attempts.has(taskId)) return;
    const research = this.research?.wait(task);
    if (research) {
      this.startAtGate(taskId);
      return research.kind === 'research-message'
        ? `Task "${task.title}" waits for your next message: the research limit of ${research.limit} for this message has been reached.`
        : `Task "${task.title}" waits for a research slot: ${research.limit} research tasks may run at once.`;
    }
    this.refuseOpsDuringMerge(taskId, FORCED_NOW);
    const queued = this.queueBehindDependencies(task);
    if (queued) return queued;
    this.queuedStarts.delete(taskId);
    return this.startForced(taskId, origin, FORCED_NOW);
  }

  /**
   * Start an approved task once its merge gate opens, never past it: a script
   * task `run_script` added behind work not merged into the user's branch yet
   * (ADR-0035). A scheduler driving the run starts it as it would any task;
   * otherwise it waits with the queued force starts, confirmed past nothing,
   * so it starts once Merge all has merged that work, and a Stop withdraws it.
   */
  startAtGate(taskId: string): void {
    if (!this.store.get(taskId) || this.attempts.has(taskId)) return;
    if (!this.isScheduling) this.queuedStarts.set(taskId, { pastGate: [] });
    this.emit('onTaskChanged');
  }

  /**
   * A forced start, from its run opening to its claim. It is judged again once
   * the run has opened, against the task as it stands then, which is what
   * the claim reads and runs. A queued one that something holds back again
   * meanwhile goes back in the queue; one made now that an edit gave
   * dependencies still under way waits for them as if forced after the edit,
   * and says so.
   */
  private async startForced(taskId: string, origin: RunOrigin, forced: ForcedStart): Promise<string | undefined> {
    // A dirty tree's replay of a start made now asks again, from its dependencies on.
    const resume = async () => { await (forced.queued ? this.startForced(taskId, origin, forced) : this.forceStartTask(taskId, origin)); };
    return this.whileAdmitted(async (admission) => {
      if (!(await this.openForAdmitted(taskId, origin, resume, admission))) return;
      // The run may have started it while opening.
      if (this.attempts.has(taskId)) return;
      // A Merge all may have begun while it opened.
      this.refuseOpsDuringMerge(taskId, forced);
      if (forced.queued && this.holdsQueued(taskId, forced)) {
        this.queuedStarts.set(taskId, { pastGate: forced.pastGate });
        return;
      }
      const task = this.store.get(taskId);
      const requeued = !forced.queued && task ? this.queueBehindDependencies(task) : null;
      if (requeued) return requeued;
      this.refuseClaim(taskId, admission);
      // Forced again after a failure, a loop's check starts its rounds over, as a retry does (ADR-0045 L7).
      if (this.store.isFailed(taskId)) this.store.startRoundsOver(taskId);
      // A force start is the user's own act, so it ends the task's pause: its
      // resume goes, and the hold with it once nothing else waits (U1).
      this.dropResume(taskId);
      this.onHold.delete(taskId);
      this.notePastGate(taskId);
      await this.claimed(taskId, admission);
    });
  }

  /**
   * A force start of a task whose dependencies are still under way or yet to
   * run: started now, it would build on work that is not there, so it waits
   * for them in the run, off any hold, and says so. Dependencies are never
   * bypassed silently. A blocked task is forced past its failure as asked.
   * What it goes past at the merge gate is the gate the user confirmed now.
   */
  private queueBehindDependencies(task: Readonly<Task>): string | null {
    const waits = this.startWaits(task, FORCED_NOW);
    const waiting = (waitOf(waits, 'dependencies') ?? waitOf(waits, 'queued'))?.waiting ?? [];
    if (waiting.length === 0) return null;
    this.onHold.delete(task.id);
    if (!this.leftToScheduler(task)) this.queuedStarts.set(task.id, { pastGate: this.getMergeGate(task.id) });
    const names = waiting.map((id) => `task "${this.store.get(id)?.title ?? id}"`);
    const listed = names.length === 1 ? names[0] : `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`;
    const idle = this.isScheduling || waiting.some((id) => this.attempts.has(id)) ? '' : ' Nothing is running now: run the plan to start them.';
    const queued = `Task "${task.title}" is approved and starts once ${listed} ${names.length === 1 ? 'finishes' : 'finish'}.${idle}`;
    this.tell('info', queued);
    this.emit('onTaskChanged');
    return queued;
  }

  /**
   * A force start the scheduler driving the run makes for itself once its
   * dependencies finish: a task not started yet that nothing blocks. A failed
   * one, such as a loop's check forced mid-round, it would never start again,
   * so the force start stays queued.
   */
  private leftToScheduler(task: Readonly<Task>): boolean {
    return this.isScheduling && (task.status === 'pending' || task.status === 'approved') && this.getBlockedBy(task.id).length === 0;
  }

  /**
   * Starts the queued force starts nothing holds back any more. One the
   * scheduler now drives the run for, that nothing blocks and that was not
   * confirmed past a gate, is left to it. One at a gate the user did not
   * confirm — work that landed after they forced the start — waits for Merge
   * all, or for another force start, and says so once.
   */
  private async startQueued(): Promise<void> {
    for (const [id, queued] of [...this.queuedStarts]) {
      const task = this.store.get(id);
      if (!task || this.attempts.has(id) || task.status === 'completed' || task.status === 'skipped') {
        this.queuedStarts.delete(id);
        continue;
      }
      const waits = this.startWaits(task, task.research ? undefined : { queued: true, pastGate: queued.pastGate });
      if (task.research && (waits.length > 0 || this.attempts.size >= this.config.maxParallelSessions)) continue;
      if (waits.some((w) => QUEUED_WAITS.has(w.kind))) continue;
      if (this.leftToScheduler(task) && queued.pastGate.length === 0) {
        this.queuedStarts.delete(id);
        continue;
      }
      const gate = waitOf(waits, 'merge-gate');
      if (gate) {
        this.sayQueuedAtGate(task, queued, gate.unmerged);
        continue;
      }
      this.queuedStarts.delete(id);
      try {
        const origin = task.research && (task.reportTo ?? task.researchOrigin)?.actor === 'supervisor' ? 'supervisor' : 'user';
        await this.startForced(id, origin, { queued: true, pastGate: queued.pastGate });
      } catch (err) {
        this.tell('warn', `Task "${task.title}" did not start once its dependencies finished: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  /**
   * A queued start the start rule holds back, at a gate it was not confirmed
   * past or otherwise. Taken out of the queue by now, so its dependencies
   * still under way read as `dependencies` rather than `queued`.
   */
  private holdsQueued(taskId: string, forced: Extract<ForcedStart, { queued: true }>): boolean {
    const task = this.store.get(taskId);
    return !!task && this.startWaits(task, forced).some((w) => QUEUED_WAITS.has(w.kind) || w.kind === 'dependencies' || w.kind === 'merge-gate');
  }

  private sayQueuedAtGate(task: Readonly<Task>, queued: QueuedStart, unmerged: readonly string[]): void {
    const titles = unmerged.map((id) => `"${this.store.get(id)?.title ?? id}"`).join(', ');
    const notice = `Task "${task.title}" waits for Merge all: the work of ${titles} is not merged into your branch yet. Merge all to start it, or force start it again to start it without that work.`;
    if (queued.gateNotice === notice) return;
    queued.gateNotice = notice;
    this.tell('info', notice);
  }

  private refuseOpsDuringMerge(taskId: string, forced: ForcedStart): void {
    const task = this.store.get(taskId);
    if (task && waitOf(this.startWaits(task, forced), 'merging')) {
      throw new TaskControlError(`A Merge all is under way: ops task "${task.title}" can start once it has finished.`);
    }
  }

  /**
   * A force start passes a merge gate (ADR-0020), and the surface confirmed it
   * first; the choice is kept on the task and said, because the work it acts
   * on is not in the user's branch.
   */
  private notePastGate(taskId: string): void {
    const task = this.store.get(taskId);
    // Whatever its status: a failed ops task started again acts on the checkout as its first start did.
    const unmerged = (task && waitOf(this.startWaits(task), 'merge-gate')?.unmerged) ?? [];
    if (!task || unmerged.length === 0) return;
    const titles = unmerged.map((id) => `"${this.store.get(id)?.title ?? id}"`);
    this.store.setForcedPastGate(taskId, titles);
    this.tell('warn', `Task "${task.title}" was force-started before the work of ${titles.join(', ')} was merged into your branch.`);
  }

  getCompletedCount(): number { return this.store.completedCount; }
  getTotalCount(): number { return this.store.allTasks.length; }
  isAllComplete(): boolean { return this.store.isAllComplete(); }
  isAnyFailed(): boolean { return this.store.isAnyFailed(); }

  async approveReview(origin: RunOrigin = 'user'): Promise<void> {
    if (this.reviewApproved) {
      console.log('[TaskOrchestrator] approveReview() called but already approved: no-op');
      return;
    }
    this.reviewApproved = true;
    this.emit('onTaskChanged');
    this.emit('onReviewApproved', { tasks: this.store.planTasks });
    await this.start(origin);
  }

  async tick(): Promise<void> {
    // What this tick starts was admitted as it began: a Stop during one of its awaits withdraws it.
    const admission = this.admittedNow();
    this.recoverOrphans();
    // Every way a dependency finishes ticks — a verdict, Mark complete, a skip,
    // a failed spawn — so a queued force start waiting on it is started here.
    await this.startQueued();
    if (!this.isScheduling) return this.settleRun('tick');

    // Ahead of the run-complete check too: the turn may add work to a run
    // that would otherwise end under it. Its release ticks again.
    if (this.startHolds > 0) return;

    this.repeatChecks();
    let readiness = this.readiness();
    // Work merged by hand opens a gate as Merge all does; only git can tell.
    // A user task's gate counts too, though the scheduler never starts one.
    if (readiness.gated.length > 0 && (await this.runs.refreshInHead())) {
      this.autoMergeBlocked = false;
      readiness = this.readiness();
    }
    if (!this.isScheduling) return;
    if (this.mergesAutomatically() && !this.autoMergeBlocked && !this.merging
      && ![...this.attempts.values()].some((a) => mergeExcludes(a.kind))) {
      // Only for a task the merge lets start, or lets the user do: nothing else holds it back.
      const gate = readiness.gated[0];
      if (gate) {
        // Another landing must not repeatedly attempt a merge the user now
        // needs to resolve. A user merge or a new run releases this hold.
        this.autoMergeBlocked = true;
        await this.mergeLanded({ kind: 'gate', taskId: gate.id });
        readiness = this.readiness();
      }
    }
    if (!this.isScheduling) return;
    const { ready } = readiness;
    console.log(`[TaskOrchestrator] tick(): ${ready.length} ready, ${this.attempts.size} active, held=${this.startHolds}`);

    if (ready.length === 0 && this.attempts.size === 0) return this.settleRun('tick');

    for (const { id } of ready) {
      // Readiness was read before this loop awaited any start: a stop, a plan
      // load, a Merge all, a user control or a concurrent tick may have come
      // since, so each id is judged again — and last with nothing awaited
      // between that and the claim.
      if (!this.isScheduling) return;
      if (!this.stillReady(id)) continue;
      if (decidesIsolation(this.nextAttemptKind(id)) && !(await this.runs.decide(() => this.tick()))) continue;
      if (!this.isScheduling) return;
      if (!this.stillReady(id)) continue;
      const claimed = this.claim(id, admission);
      if ('refused' in claimed) {
        if (!admission.current()) return;
        continue;
      }
      await claimed.spawned;
    }
    this.emit('onTick');
  }

  /**
   * The one step that decides, with nothing at work and nothing the scheduler
   * can start, whether the run goes on, is held, waits on the user or is over
   * (ADR-0034). Every surface takes `onExecutionComplete` as the run's end, so
   * only an end emits it. A run the scheduler is not driving — tasks started
   * on their own — ends on a verdict; a cancel, Mark complete or failed spawn
   * just closes it, so the next run decides its own mode rather than inherit
   * this one's.
   */
  private async settleRun(after: 'tick' | 'verdict'): Promise<void> {
    // A retry, Mark not done or an added task since leaves the plan unfinished:
    // still finished, it would tell every surface the run is over while a task waits.
    if (this.runState === 'finished' && !this.store.isFinished()) this.runState = 'idle';
    if (this.attempts.size > 0) return;
    if (this.runState === 'held') {
      // A task on a usage limit keeps the run open: closed, it would be handed
      // over or merged before the work the reset resumes.
      return;
    }
    if (this.runState !== 'scheduling') {
      if (after === 'tick') {
        if (this.runs.isOpen && this.settled) await this.closeRun();
        return;
      }
      if (this.store.isFinished()) this.runState = 'finished';
      this.emit('onTick');
      if (this.settled) await this.closeRun();
      this.emit('onExecutionComplete');
      return;
    }

    const remaining = this.store.allTasks.filter(t => t.status !== 'completed' && t.status !== 'skipped');
    console.log(`[TaskOrchestrator] tick(): no work. remaining=${remaining.length}, completed=${this.store.isAllComplete()}`);
    const remainingById = new Map(remaining.map((t) => [t.id, t]));
    for (const { task, label } of flattenTasksWithParents(this.store.planTasks)) {
      if (!remainingById.has(task.id)) continue;
      console.log(`  - ${label}. ${task.title} [${task.type}/${task.status}] prompt=${!!task.prompt}`);
    }
    const { blocked, repeating } = planBlocks(this.store.planTasks);
    if (remaining.length === 0) {
      this.runState = 'finished';
      this.sayFinished();
    } else if (remaining.every((t) => (t.status === 'failed' && !repeating.has(t.id)) || blocked.has(t.id))) {
      // Nothing left can start until a failed task is retried (ADR-0034):
      // the run ends, and a retry continues it.
      this.runState = 'endedOnFailure';
      this.sayEndedOnFailure(blocked);
    } else {
      // Waiting on the user: a user task, a checkpoint, a held task or a merge
      // gate. The scheduler stays armed, because the control that answers it
      // ticks, and a tick schedules only while it is.
      this.notifications.info('Remaining tasks require user action or are on hold.');
      this.sayGate();
      this.emit('onTaskChanged');
      this.emit('onTick');
      return;
    }
    this.emit('onTaskChanged');
    this.emit('onTick');
    await this.closeRun();
    this.emit('onExecutionComplete');
  }

  /**
   * A loop's check failed (ADR-0045). With `failed` evidence and rounds left,
   * a round starts: its body runs again as new attempts, each from the
   * integration tip, so it builds on what earlier rounds landed, and true says
   * the failure is the round's, not the task's. Approval is not spent by a
   * run, so the plan's approval of the body covers every round. Out of
   * rounds, the body still to run will not run. A body task the user skipped
   * has stopped the loop (L7): no round starts, and the skip stands.
   */
  private startRound(checkId: string): boolean {
    const check = this.store.get(checkId);
    if (!check?.loop) return false;
    if (outOfRounds(check)) {
      this.closeLoop(check, LOOP_OUT_OF_ROUNDS);
      return false;
    }
    if (!betweenRounds(check)) return false;
    const body = check.loop.body.flatMap((id) => this.store.get(id) ?? []);
    if (body.some((t) => t.status === 'skipped' && !LOOP_SKIPS.has(t.skipReason ?? ''))) return false;
    for (const task of body.filter((t) => !this.attempts.has(t.id) && REPEATABLE.has(t.status))) {
      this.store.retry(task.id);
      this.onHold.delete(task.id);
      this.queuedStarts.delete(task.id);
    }
    const named = quotedList(body.map((t) => t.title));
    this.tell('info', `Task "${check.title}" failed round ${loopRoundOf(check)} of ${check.loop.maxRounds}: ${named} ${body.length === 1 ? 'runs' : 'run'} to fix what it found, then it checks again.`);
    return true;
  }

  /**
   * The loop is over (ADR-0045 L6): its check passed, or will run no more.
   * What of its body has not run, or did not pass, is not waited for: it ends
   * skipped, with why. A body task at work is left to finish.
   */
  private closeLoop(check: Readonly<Task>, reason: string): void {
    for (const id of check.loop?.body ?? []) {
      const task = this.store.get(id);
      if (!task || this.attempts.has(id) || !LEFT_UNDONE.has(task.status)) continue;
      this.store.markSkipped(id, reason);
      this.onHold.delete(id);
      this.queuedStarts.delete(id);
    }
  }

  /**
   * A check whose round's body has all passed and landed runs again, as the
   * next round (ADR-0045 L5). Read off the plan at each tick rather than at a
   * body's verdict, so whatever finishes the body — a verdict, a retry, a Mark
   * complete, a reload in between — resumes the loop alike.
   */
  private repeatChecks(): void {
    let repeated = false;
    for (const id of repeatingChecks(this.store.planTasks)) {
      const check = this.store.get(id);
      if (!check?.loop || this.attempts.has(id) || !check.loop.body.every((b) => landed(b, this.store, this.runs))) continue;
      this.store.repeat(id);
      this.onHold.delete(id);
      repeated = true;
      this.notifications.info(`The fix for task "${check.title}" has landed: it checks again, round ${loopRoundOf(check)} of ${check.loop.maxRounds}.`);
    }
    if (repeated) this.emit('onTaskChanged');
  }

  /** Skipped work is not completed work, so a run with any says so rather than that everything completed. */
  private sayFinished(): void {
    const skipped = this.store.allTasks.filter((t) => t.status === 'skipped').length;
    if (skipped === 0) this.notifications.info('All tasks completed!');
    else this.notifications.info(`Run finished: ${this.store.completedCount} completed, ${skipped} skipped.`);
  }

  /** How a run that ended on failures ends: what it finished, what failed, and what that blocks. */
  private sayEndedOnFailure(blocked: ReadonlyMap<string, string[]>): void {
    const tasks = this.store.allTasks;
    const failed = tasks.filter((t) => t.status === 'failed');
    const stuck = tasks.filter((t) => blocked.has(t.id));
    const skipped = tasks.filter((t) => t.status === 'skipped').length;
    const counts = `${tasks.filter((t) => t.status === 'completed').length} completed, ${failed.length} failed, ${stuck.length} blocked${skipped > 0 ? `, ${skipped} skipped` : ''}`;
    const retry = stuck.length > 0 ? ' A blocked task starts once the failed task it waits on is retried and passes.' : '';
    this.tell('warn', `Run finished: ${counts}.${retry}`);
  }

  /** Whether the scheduler may start `id` now: nothing in the start rule holds it back, and a slot is free. */
  private stillReady(id: string): boolean {
    const task = this.store.get(id);
    if (!task || this.attempts.has(id) || this.attempts.size >= this.config.maxParallelSessions) return false;
    return this.startWaits(task).length === 0;
  }

  /**
   * A run paused at merge gates says so, as plainly as a task that waits on
   * the user: which tasks wait, and that Merge all lets them go on (ADR-0020).
   */
  private sayGate(): void {
    const waiting = this.store.allTasks.filter((t) => this.getMergeGate(t.id).length > 0);
    const notice = waiting.length === 0
      ? ''
      : `Waiting for Merge all: ${waiting.map((t) => `"${t.title}"`).join(', ')} ${waiting.length === 1 ? 'needs' : 'need'} work that is not merged into your branch yet.`;
    if (notice === this.gateNotice) return;
    this.gateNotice = notice;
    if (notice) this.tell('info', notice);
  }

  /**
   * Why a start may not take its claim now, or null when it may: a Stop came
   * since it was admitted (ADR-0029), the task left the plan or is being
   * marked complete, it is outside the user's approval record (ADR-0035), or
   * every slot is taken. Read in the same synchronous step as the claim it
   * guards, so nothing can change in between.
   */
  private claimRefusal(taskId: string, admission: Admitted): string | null {
    if (!admission.current()) return STOPPED_BEFORE_START;
    const task = this.store.get(taskId);
    if (!task) return `There is no task "${taskId}" in this plan any more.`;
    if (this.completing.has(taskId)) return `Task "${task.title}" is being marked complete: its work is landing.`;
    if (!this.isApproved(taskId)) return `Task "${task.title}" waits for the user's approval: they approve it by starting it, or by executing the plan.`;
    const research = this.research?.wait(task);
    if (research) return research.kind === 'research-message'
      ? `Task "${task.title}" waits for your next message: the research limit of ${research.limit} for this message has been reached.`
      : `Task "${task.title}" waits for a research slot: ${research.limit} research tasks may run at once.`;
    const live = this.attempts.size;
    if (live >= this.config.maxParallelSessions) {
      return `${live} ${live === 1 ? 'task is' : 'tasks are'} already running, the most this session runs at once. Wait for one to finish, or stop one first.`;
    }
    return null;
  }

  /** An explicit start's refusal, before it changes anything: its caller's answer, as a {@link TaskControlError}. */
  private refuseClaim(taskId: string, admission: Admitted): void {
    const refused = this.claimRefusal(taskId, admission);
    if (refused) throw new TaskControlError(refused);
  }

  /** An explicit start's claim, once {@link refuseClaim} let it through: its spawn, or the refusal as a rejection. */
  private claimed(taskId: string, admission: Admitted, continuation: Continuation | null = null, opts: { autoResumed?: boolean } = {}): Promise<void> {
    const claimed = this.claim(taskId, admission, continuation, opts);
    return 'spawned' in claimed ? claimed.spawned : Promise.reject(new TaskControlError(claimed.refused));
  }

  /**
   * The one claim every attempt start passes — the scheduler's, a run or force
   * start, a retry's, a continue, a resume, a repair. Checked and taken in one
   * synchronous step ({@link claimRefusal}), then marked claimed before
   * anything is awaited, so no other start can take the same task or slot.
   * The task is read here, as it stands: a start that awaited first — its run
   * opening, the user's answer — runs what the plan holds now, not what it
   * held when it was asked for. A task already claimed is not claimed again:
   * there is nothing to start.
   */
  private claim(taskId: string, admission: Admitted, continuation: Continuation | null = null, opts: { autoResumed?: boolean } = {}): Claim {
    if (this.attempts.has(taskId)) return { spawned: Promise.resolve() };
    const refused = this.claimRefusal(taskId, admission);
    if (refused) return { refused };
    const task = this.store.get(taskId)!;
    const script = task.type === 'script';
    const attempt: TaskAttempt = {
      taskId: task.id,
      attempt: Math.max(this.spawnCounts.get(task.id) ?? 0, this.lastLoggedAttempt(task.id), ...task.attemptUsage?.map((u) => u.attempt) ?? []) + 1,
      phase: 'starting',
      session: null,
      runner: script ? SCRIPT_RUNNER : this.store.resolveTaskRunner(task),
      cwd: null,
      worktree: false,
      integration: null,
      kind: classifyAttempt(this.workOf(task), { repair: this.landing.nextRepair(task.id), continuation, carriedFrom: task.carriedFrom }),
      snapshot: null,
      startedAt: new Date().toISOString(),
      decided: false,
      skills: [],
      admission,
      autoResumed: opts.autoResumed === true,
      turnError: null,
      turnOutputFrom: 0,
      reminded: false,
      runnerStopped: false,
      planScope: this.planScope,
      script,
      shell: null,
    };
    this.spawnCounts.set(task.id, attempt.attempt);
    this.attempts.set(task.id, attempt);
    this.research?.started(task);
    // A script spends nothing a ledger counts: no model, no tokens (ADR-0035).
    if (!script) this.store.startAttemptUsage(task.id, attempt.attempt, attempt.runner, attempt.startedAt);
    this.store.markInProgress(task.id);
    this.emit('onTaskChanged');
    return { spawned: this.runClaimed(task, attempt, continuation) };
  }

  private async runClaimed(task: Task, attempt: TaskAttempt, continuation: Continuation | null): Promise<void> {
    if (!(await this.spawnAttempt(task, attempt))) return;

    // Committed as running: notify observers only now, outside the fallible
    // spawn path above, so an observer throwing here is never mistaken for a
    // failed spawn (which would tear down the attempt it just announced).
    if (attempt.worktree) this.emit('onIsolationChanged');
    this.emit('onTaskChanged');
    if (attempt.kind.kind === 'repair') {
      const group = this.runs.current?.repos.some((r) => r.path !== SELF_REPO);
      const { n, limit } = attempt.kind.repair;
      this.tell('info', `Repairing the conflict of task "${task.title}" in its own ${group ? 'worktrees' : 'worktree'} (repair ${n} of ${limit}).`);
    } else {
      this.notifications.info(`Task "${task.title}" ${continuation ? 'continued' : 'started'} (${attempt.runner})`);
    }
  }

  /**
   * The fallible half of starting a task: resolving its cwd/worktree and
   * spawning the runner. Resolves false when the attempt never committed —
   * abandoned because it was ended from under it, or a failed spawn already
   * unwound (both leave `runClaimed` with nothing further to announce).
   */
  private async spawnAttempt(task: Task, attempt: TaskAttempt): Promise<boolean> {
    try {
      const { kind } = attempt;
      if (!attempt.script) {
        // Nothing can drive a runner without a structured connector, so it is
        // refused before a worktree is made for it.
        if (!supportsTaskMode(attempt.runner)) {
          const name = this.registry?.get(attempt.runner)?.manifest.displayName ?? attempt.runner;
          throw new Error(`${name} has no structured connector, so Ordewell cannot run its tasks. Assign the task to another runner.`);
        }
        // The plan fixed this mode when it was made and ADR-0001 forbids
        // swapping it here, so a host that cannot run it ends the attempt
        // before a worktree is made for it.
        const manifest = this.registry?.get(attempt.runner)?.manifest;
        const unavailable = manifest && unavailableTaskModeMessage(manifest, task.taskMode);
        if (unavailable) throw new Error(unavailable);
      }
      // Resumed beside a runner still winding it down, a session would run in
      // two processes, and count from before what the first one still reports.
      if (kind.kind === 'continuation') await this.windDowns.get(task.id);
      const { cwd, worktree, previousWork, workspace } = await attemptCwd(kind, task, this.runs);
      attempt.cwd = cwd;
      attempt.worktree = worktree;
      if (checksTree(kind)) attempt.snapshot = await this.runs.snapshotWorkspace();
      if (this.attempts.get(task.id) !== attempt) {
        // Ended while its worktree was being made, so whatever ended it could
        // not release it. A newer attempt's own prepare replaces it instead,
        // and a Mark complete lands what is in it. A repair's worktree holds
        // work that passed, so it is only handed back.
        if (attempt.worktree && !this.attempts.has(task.id) && !this.completing.has(task.id)) await this.runs.release(task.id, { keep: kind.kind === 'repair' });
        this.abandonSpawn(task, attempt);
        return false;
      }
      const session = attempt.script
        ? await this.spawnScript(task, attempt, cwd)
        : await this.spawnRunner(task, attempt, cwd, worktree ? workspace : undefined, previousWork);

      // Stop/load/cancel can end the attempt while the async adapter is
      // starting. Do not resurrect that execution after the surface already
      // went idle — and compare identity, not presence, because a newer
      // attempt of the same task may have been claimed in the meantime.
      if (this.attempts.get(task.id) !== attempt) {
        this.abandonSpawn(task, attempt, session);
        return false;
      }
      attempt.phase = 'running';
      attempt.session = session;
      this.store.setTaskRunnerSessionId(task.id, undefined);
      this.store.clearCarriedFrom(task.id);
      if (kind.kind === 'carryOver' && previousWork?.outcome === 'fallback') {
        this.tell('warn', `Task "${task.title}" starts fresh on ${attempt.runner}: the work its paused attempt on ${kind.from} left conflicts with the integration tip, so it was not carried over. It is kept on branch ${quotedList([...new Set(previousWork.preserved.map((kept) => kept.branch))])}.`);
      }
      if (takesSkills(kind)) this.store.setTaskAttemptSkills(task.id, [...attempt.skills]);

      // Attached before the verifier, so the summary of the call that settles
      // the attempt is captured before its verdict asks for the final text.
      session.onEvent((event) => {
        if (event.type !== 'usage' || attempt.planScope !== this.planScope || (this.attempts.get(task.id) !== attempt && !attempt.runnerStopped)) return;
        this.store.recordAttemptUsage(task.id, attempt.attempt, event.record, new Date().toISOString());
        this.emit('onUsageChanged');
      });
      session.onExit(() => this.woundDown(attempt, session));
      this.output.attach(task.id, session);
      this.verifier.watch(task, session);
      session.onEvent((event) => {
        if (event.type === 'turn_start') {
          attempt.turnError = null;
          attempt.turnOutputFrom = session.getOutput().length;
        } else if (event.type === 'error') attempt.turnError = event;
        else if (event.type === 'model_switched' || event.type === 'model_drifted') {
          this.emit('onModelSwitched', {
            taskId: task.id, sessionId: session.id, from: event.from, model: event.to,
            ...(event.type === 'model_switched' && event.effort ? { effort: event.effort } : {}),
            asked: event.type === 'model_switched', attemptEnded: this.attempts.get(task.id) !== attempt,
          });
        }
      });
      session.onTurnEnd((reason) => this.onTurnEnd(task.id, attempt, session, reason));
      return true;
    } catch (err) {
      if (this.attempts.get(task.id) !== attempt) {
        this.abandonSpawn(task, attempt);
        return false;
      }
      this.endAttempt(task.id, 'spawn-failed');
      // Each way out settles the task's status before it awaits anything, so
      // no tick in between finds it in progress with no attempt.
      const refusal = err instanceof Error ? err.message : String(err);
      // A missed attach is a hold for a start or a continue: nothing ran, so
      // the task is not failed and its saved session stays for a retry.
      const attachTimeout = err instanceof McpAttachTimeout;
      // A script has no runner whose account a limit could stop (ADR-0035).
      if (attempt.kind.kind !== 'repair' && !attempt.script && classifyRunnerStop(refusal) === 'usage-limit') {
        // The limit refused the turn Ordewell was starting: a pause, as one
        // mid-turn is, and the saved session stays for the resume to continue.
        this.pauseOnLimit(task, attempt, refusal);
        this.store.setTaskOutputSummary(task.id, summarizeOutput(refusal, ''));
        await this.runs.release(task.id, { keep: true });
        this.emit('onTaskSettled', { taskId: task.id });
        this.emit('onTaskChanged');
        await this.tick();
        return false;
      }
      if (attempt.kind.kind === 'continuation' && !attachTimeout) {
        // A runner that exits while starting on a saved session has refused it.
        const refused = err instanceof RunnerStartupExit;
        const reason = refused
          ? unresumedMessage(task, `${attempt.runner} could not find its saved session`)
          : unresumedMessage(task, `could not start: ${err instanceof Error ? err.message : String(err)}`);
        this.store.markFailed(task.id);
        if (refused) this.store.setTaskRunnerSessionId(task.id, undefined);
        this.store.setTaskOutputSummary(task.id, summarizeOutput(reason, refused ? err.message : ''));
        await this.runs.release(task.id, { keep: false });
        this.notifications.error(reason);
        this.emit('onTaskSettled', { taskId: task.id });
        this.emit('onTaskChanged');
        await this.tick();
        return false;
      }
      if (attempt.kind.kind === 'repair') {
        this.store.markAwaitingUser(task.id, 'conflict');
        this.settleUnlanded(task, await this.landing.unrepaired(task, `could not start: ${err instanceof Error ? err.message : String(err)}`), attempt.admission);
        this.emit('onTaskSettled', { taskId: task.id });
        this.emit('onTaskChanged');
        await this.tick();
        return false;
      }
      if (attachTimeout) {
        // The runner stayed up but never connected. Nothing was sent to it
        // and no verdict exists, so the task is held with a reason rather
        // than failed: its dependents stay on the plan, and a later start
        // can still run it (ADR-0022, S2).
        this.store.markPending(task.id);
        this.onHold.set(task.id, 'could not connect to Ordewell\'s tools; start it again');
        await this.runs.release(task.id, { keep: false });
        this.tell('warn', `Task "${task.title}" is on hold: could not connect to Ordewell's tools. Start it again.`);
        this.emit('onTaskSettled', { taskId: task.id });
        this.emit('onTaskChanged');
        await this.tick();
        return false;
      }
      if (err instanceof TaskSkillsError) {
        // Running without a skill the plan attached would be a silent rewrite
        // of the plan (ADR-0001): the task fails, saying what was missing.
        // An earlier attempt's snapshot would read as what this one was given.
        this.store.setTaskAttemptSkills(task.id, undefined);
        this.store.markFailed(task.id);
        this.store.setTaskOutputSummary(task.id, summarizeOutput(err.message, ''));
        await this.runs.release(task.id, { keep: false });
        this.tell('error', err.message);
        this.emit('onTaskSettled', { taskId: task.id });
        this.emit('onTaskChanged');
        await this.tick();
        return false;
      }
      if (err instanceof McpAttachError || err instanceof RunnerStartupExit) {
        this.store.markFailed(task.id);
        this.store.setTaskOutputSummary(task.id, summarizeOutput(err.message, err.message));
        await this.runs.release(task.id, { keep: true });
        this.tell('error', err.message);
        this.emit('onTaskSettled', { taskId: task.id });
        this.emit('onTaskChanged');
        await this.tick();
        return false;
      }
      // Couldn't spawn — the task was never executed, so it stays "to do".
      // Held out of auto-scheduling to avoid a spawn-throw retry loop.
      this.store.markPending(task.id);
      this.onHold.set(task.id, `could not start: ${err instanceof Error ? err.message : String(err)}; start it again`);
      await this.runs.release(task.id, { keep: false });
      this.tell('error', `Failed to start task "${task.title}": ${err}`);
      this.emit('onTaskChanged');
      await this.tick();
      return false;
    }
  }

  /**
   * The runner's half of a start: the skills read where the attempt runs, the
   * prompt its kind is told, and the runner spawned on its model and mode. A
   * read-only attempt is given its shell, which may write its task workspace,
   * `writable`, and nothing of the user's (ADR-0046).
   */
  private async spawnRunner(task: Task, attempt: TaskAttempt, cwd: string, writable: string | undefined, previousWork: PreviousWork | undefined): Promise<IRunnerSession> {
    const worktree = attempt.worktree;
    const { kind } = attempt;
    // Read where the attempt runs: a skill an earlier task committed is in
    // this worktree only once that task's work has landed.
    if (takesSkills(kind) && task.skills?.length) {
      attempt.skills = resolveTaskSkills(task, this.skillsAt(this.skillRoots(cwd)), worktree ? (name) => this.uncommittedSkillFolder(name) : undefined);
    }
    const finalPrompt = attemptPrompt(kind, {
      task,
      plan: this.store.planTasks,
      planMapEnabled: this.config.planMapEnabled,
      previousWork,
      skills: attempt.skills,
      repairPrompt: (t) => this.landing.repairPrompt(t),
      previousAttempt: (taskId) => this.opsPreviousAttempt(taskId),
    });
    const env = await this.envForTask(cwd);
    if (landsNothing(kind)) {
      // Each repo worktree's `.git` must stay the repository's, so a sealed run
      // cannot plant one for the runner's own git to load (ADR-0046).
      const worktrees = writable ? Object.values(this.runs.openRecord(task.id)?.repos ?? {}).map((r) => r.worktree) : [];
      attempt.shell = this.taskShell({ cwd, ...(writable ? { writable } : {}), ...(worktrees.length ? { worktrees } : {}) }) ?? null;
    }
    const shell = attempt.shell;
    return this.runner.spawn({
      taskId: task.id,
      runner: attempt.runner,
      prompt: finalPrompt,
      modelId: task.assignedModel?.modelId,
      thinkingEffort: task.assignedModel?.thinkingEffort,
      modelVariants: task.assignedModel?.availableVariants,
      mode: task.taskMode ?? 'build',
      cwd,
      registry: this.registry ?? undefined,
      order: task.order,
      title: task.title,
      env,
      resumeSessionId: kind.kind === 'continuation' ? kind.resumeSessionId : undefined,
      resumeCost: kind.kind === 'continuation' ? countedSessionCost(task.attemptUsage, kind.resumeSessionId) : undefined,
      resumeWindow: kind.kind === 'continuation' ? resumedSessionWindow(task.attemptUsage, attempt.runner, attempt.attempt, kind.resumeSessionId) : undefined,
      attempt: attempt.attempt,
      ...(attempt.skills.length > 0 ? { skills: attempt.skills } : {}),
      ...(shell ? { shell } : {}),
      workspaceRoot: this.workspaceRootFn(),
      onNotice: (message) => this.tell('warn', `Task "${task.title}": ${message}`),
    });
  }

  /**
   * A script task's start (ADR-0035): its body as the plan holds it now, run
   * by the script runner at the workspace root with the workspace's own
   * variables, as a task's runner gets them (ADR-0016). There is no prompt,
   * so no skills and no account of an earlier attempt: a retry runs the body
   * again as written.
   */
  private async spawnScript(task: Task, attempt: TaskAttempt, cwd: string): Promise<IRunnerSession> {
    const body = scriptBodyOf(task);
    if (!body) throw new Error(`Task "${task.title}" has no script to run: give it "commands" or a "script".`);
    const env = await this.envForTask(cwd);
    return this.scriptRunner.spawn({
      taskId: task.id,
      runner: attempt.runner,
      prompt: '',
      cwd,
      order: task.order,
      title: task.title,
      env,
      attempt: attempt.attempt,
      script: body,
    });
  }

  /** For a skill the main checkout has, the folder a worktree only gets once it is committed. */
  private uncommittedSkillFolder(name: string): string | undefined {
    const root = this.workspaceRootFn();
    const skill = this.skillsAt(this.skillRoots(root)).findSkill(name);
    return skill?.source === 'workspace' ? path.relative(root, path.dirname(skill.path)).split(path.sep).join('/') : undefined;
  }

  /**
   * The roots whose `.ordewell/skills/` an attempt at `cwd` reads: in a repo
   * group, `cwd` holds each repo — a worktree of it when isolated, the
   * workspace's own checkout when not — and no folder of its own (ADR-0014).
   */
  private skillRoots(cwd: string): string[] {
    return workspaceSkillRoots(this.workspaceRootFn(), this.runs.skillLayout().repos, cwd);
  }

  /**
   * A continue whose runner never announced the session it was told to
   * resume. Nothing was continued, and nothing fresh was started in its place.
   */
  private unresumed(attempt: TaskAttempt): boolean {
    const session = attempt.session;
    return attempt.kind.kind === 'continuation' && session !== null && !session.nativeSessionId();
  }

  /**
   * A spawn whose attempt ended while it was in flight: kill what it produced
   * and take back the claim it made. Only the claim — whatever ended the
   * attempt may have decided the task since (mark complete, cancel, retry).
   * A task Mark complete is landing stays in progress until that lands:
   * back to not started, the scheduler would start it again under the landing.
   */
  private abandonSpawn(task: Task, attempt: TaskAttempt, session?: IRunnerSession): void {
    session?.kill();
    attempt.shell?.end();
    if (this.attempts.has(task.id) || this.completing.has(task.id) || this.store.get(task.id)?.status !== 'in_progress') return;
    if (attempt.kind.kind === 'repair') this.store.markAwaitingUser(task.id, 'conflict');
    else this.store.markPending(task.id);
    this.emit('onTaskChanged');
  }

  private tell(level: 'info' | 'warn' | 'error', message: string): void {
    this.notifications[level](message);
    this.emit('onIsolationNotice', { level, message });
  }

  private say(messages: readonly LandingMessage[]): void {
    for (const { level, text, repairLog } of messages) {
      if (repairLog) this.tell(level, text);
      else this.notifications[level](text);
    }
  }

  /**
   * Replay the start a dirty tree turned away. `stash` puts the user's tracked
   * changes on the git stash first, so the run isolates; `shared` runs this one
   * run in the workspace root, knowingly.
   */
  async continueBlockedRun(how: 'stash' | 'shared'): Promise<void> {
    const resume = await this.runs.continueBlocked(how);
    if (resume) await resume();
  }

  /**
   * The one way an attempt ends. Dropping the record is itself what
   * invalidates a spawn still in flight ({@link runClaimed} kills the session
   * it receives for an attempt that is no longer current).
   *
   * A user interruption also bumps the verifier's generation *before* stopping
   * the runner: a runner may fire onExit synchronously from
   * stop(), and if that exit reaches VerdictEngine under the still-valid
   * generation it delivers a verdict that marks the task 'completed' for one
   * tick — long enough for the scheduler to start a dependent task. Stop and
   * load reset the whole verifier themselves.
   */
  private endAttempt(taskId: string, reason: AttemptEnd): TaskAttempt | undefined {
    const attempt = this.attempts.get(taskId);
    this.attempts.delete(taskId);
    const session = attempt?.session ?? null;
    const nativeSessionId = session?.nativeSessionId() ?? null;
    if (attempt) {
      this.store.endAttemptUsage(taskId, attempt.attempt, new Date().toISOString(), session?.sessionCost?.() ?? undefined, nativeSessionId ?? undefined);
      this.output.detach(taskId);
      attempt.shell?.end();
    }
    if (attempt && session) this.saveNativeSession(taskId, nativeSessionId, attempt.runner);
    if (stopsRunner(reason)) {
      const task = this.store.get(taskId);
      if (task) this.verifier.clear(task);
      if (attempt) this.stopRunner(attempt);
    }
    return attempt;
  }

  /**
   * Let the attempt's runner go the way it ends a turn (ADR-0018, L1): it
   * winds down on its own time, bounded by its interrupt grace, and nothing
   * here waits on it but a continue of the same task.
   */
  private stopRunner(attempt: TaskAttempt): void {
    const session = attempt.session;
    if (!session || attempt.runnerStopped) return;
    attempt.runnerStopped = true;
    const { taskId } = attempt;
    // A stop that failed leaves nothing to wait for, and nothing awaits this but a continue.
    const runner = attempt.script ? this.scriptRunner : this.runner;
    const windDown = Promise.all([this.windDowns.get(taskId), runner.stop(session.id)]).catch(() => undefined).then(() => {
      if (this.windDowns.get(taskId) === windDown) this.windDowns.delete(taskId);
    });
    this.windDowns.set(taskId, windDown);
  }

  /**
   * An ended attempt's runner is gone: the count its session ended on is the
   * one a continue of that session counts from. One still current is ended
   * with that count instead.
   */
  private woundDown(attempt: TaskAttempt, session: IRunnerSession): void {
    if (attempt.planScope !== this.planScope || !attempt.runnerStopped || this.attempts.get(attempt.taskId) === attempt) return;
    this.store.endAttemptUsage(attempt.taskId, attempt.attempt, new Date().toISOString(), session.sessionCost?.() ?? undefined, session.nativeSessionId() ?? undefined);
    this.emit('onUsageChanged');
  }

  /** Kept on the task once the attempt ends, so a continue can resume it after a reload (ADR-0018, K1). */
  private saveNativeSession(taskId: string, nativeSessionId: string | null, runner: RunnerId): void {
    if (nativeSessionId) this.store.setTaskRunnerSessionId(taskId, nativeSessionId, runner);
  }

  private endAllAttempts(reason: 'stop' | 'load'): TaskAttempt[] {
    const ended = [...this.attempts.values()];
    for (const { taskId } of ended) this.endAttempt(taskId, reason);
    this.verifier.reset();
    if (reason === 'load') this.output.reset();
    return ended;
  }
}

const LIMIT_RESET_MESSAGE = 'Your usage limit has reset. Carry on with the task from where you stopped.';

/** Why a loop's body that did not run ends skipped once its loop is over (ADR-0045 L6). */
const LOOP_PASSED = 'not needed: its check passed';
const LOOP_OUT_OF_ROUNDS = 'not run: the loop ran out of rounds';
const LOOP_CHECK_MARKED_COMPLETE = 'not needed: its check was marked complete';
const LOOP_CHECK_SKIPPED = 'not needed: its check was skipped';

/** The skips a loop made itself, which a new set of rounds undoes; any other is the user's, and stops the loop (L7). */
const LOOP_SKIPS: ReadonlySet<string> = new Set([LOOP_PASSED, LOOP_OUT_OF_ROUNDS, LOOP_CHECK_MARKED_COMPLETE, LOOP_CHECK_SKIPPED]);

/** A body task a round runs again: not at work, and not waiting on the user. */
const REPEATABLE: ReadonlySet<Task['status']> = new Set<Task['status']>(['pending', 'approved', 'completed', 'failed', 'skipped']);

/** A body task a closed loop leaves undone: it has not run, or it did not pass. */
const LEFT_UNDONE: ReadonlySet<Task['status']> = new Set<Task['status']>(['pending', 'approved', 'failed']);

/** What a failed task's notice says; a loop's check out of rounds says how many it ran. */
function failureText(task: Readonly<Task>, verdict: Verdict): string {
  if (outOfRounds(task)) return `Task "${task.title}" failed in all ${loopRoundOf(task)} rounds of its loop: ${verdict.reason}`;
  return `Task "${task.title}" failed verification: ${verdict.reason}`;
}

/** How much of an ops task's last attempt the next one is shown. */
const OPS_RETRY_TAIL_LINES = 60;

function unresumedMessage(task: Task, why: string): string {
  return `Could not continue task "${task.title}": ${why}. Retry starts it afresh.`;
}

/**
 * What the runner said in the turn its exit cut short, or null when no turn
 * was in flight. A limit is acted on only when it ended a turn Ordewell
 * started (ADR-0018, U1): limit words in a turn that had already ended did
 * not stop the runner. The turn's error, where the runner said in a field
 * whether it is the limit, outranks the words (ADR-0044).
 */
function saidInFlight(attempt: TaskAttempt): string | TurnFailure | null {
  const session = attempt.session;
  if (!session || session.turnState() !== 'working') return null;
  if (attempt.turnError?.usageLimit !== undefined) return attempt.turnError;
  return session.getOutput().slice(attempt.turnOutputFrom);
}
