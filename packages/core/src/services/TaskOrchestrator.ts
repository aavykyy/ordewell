import { McpAttachError } from './harness/ordewellBinding';
import * as path from 'path';
import { Task, TaskSkillSnapshot, TaskSnapshot, Verdict, RunnerId, DEFAULT_RUNNERS, flattenTasks, flattenTasksWithParents, waitsForReset, type RunSettings } from '../models/Task';
import { IConfig } from '../interfaces/IConfig';
import { INotification } from '../interfaces/INotification';
import type { IRunner, IRunnerSession, QueuedTaskMessage, StructuredTurnEnd } from '../interfaces/IRunner';
import { summarizeOutput } from './promptAugment';
import { VerdictEngine } from './VerdictEngine';
import { BufferedTaskOutputSource } from './BufferedTaskOutputSource';
import type { LiveTail, LiveTailOptions, TaskOutputSource } from '../interfaces/TaskOutputSource';
import { PlanStore } from './PlanStore';
import type { RunnerRegistry } from '../plugins/RunnerRegistry';
import type {
  IsolationHandoff,
  IsolationMergeResult,
  IsolationRun,
  IWorktreeIsolation,
  TreeSnapshot,
} from '../interfaces/IWorktreeIsolation';
import { createWorktreeIsolation } from './GitWorktreeIsolation';
import { SELF_REPO } from './isolationRecord';
import { taskRefOf } from './TaskRefs';
import { IsolationRunController } from './IsolationRunController';
import { completesTask, Landing, type LandingMessage, type LandingOutcome, type UnlandedOutcome } from './Landing';
import { classifyRunnerStop, readUsageLimitReset, stopsRunner, type AttemptEnd } from './runnerExit';
import { UsageLimitWaits } from './UsageLimitWaits';
import { mergeGate, selectReadyTasks, type Readiness } from './readiness';
import {
  attemptCwd, attemptPrompt, checksTree, classifyAttempt, decidesIsolation, mergeExcludes, takesSkills,
  type AttemptKind, type Continuation,
} from './attemptKind';
import { resolveTaskSkills, TaskSkillsError, type SkillLookup } from './taskSkills';
import { SkillsService, workspaceSkillRoots } from './SkillsService';
import { capConflictFiles } from './conflictFiles';
import { resolveWorkspaceEnv, type WorkspaceEnv } from './workspaceEnv';
import { supportsTaskMode } from './harness/connectors';
import { continuability } from './continuation';
import { quotedList } from '../utils/quotedList';
import type { RunMergeView } from './SessionMessage';
import { resumeTime } from '../taskRow/status';

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
  /** Started by a usage limit's reset rather than by the user or the scheduler; see {@link RELAPSE_MS}. */
  readonly autoResumed: boolean;
  /** The runner's own words for why the running turn failed, if it did. */
  turnError: string | null;
  /** The completion reminder went out: once per attempt, so a second turn without `task_complete` waits for input. */
  reminded: boolean;
}

type AttemptPhase = 'starting' | 'running' | 'integrating';

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
  config: IConfig;
  notifications: INotification;
  runner: IRunner;
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
   * The open run's settings, read as each automatic merge is decided rather
   * than copied when the run opens, so a change to the run under way applies
   * at once (ADR-0030); absent before any run.
   */
  runSettings: () => SchedulerRunSettings | undefined;
}

/**
 * What a caller supplies to {@link TaskOrchestrator.compose}; every optional
 * one gets its default there. This is what a host or test chooses, not the
 * resolved wiring the orchestrator itself runs on.
 */
export interface TaskOrchestratorOptions {
  config: IConfig;
  notifications: INotification;
  runner: IRunner;
  store?: PlanStore;
  output?: TaskOutputSource;
  isolation?: IWorktreeIsolation;
  registry?: RunnerRegistry | null;
  workspaceRoot?: () => string;
  workspaceEnv?: (cwd: string) => Promise<WorkspaceEnv>;
  skillsAt?: (roots: readonly string[]) => SkillLookup;
  previousAttemptFromLog?: (taskId: string) => string | null;
  runSettings?: () => SchedulerRunSettings | undefined;
}

/**
 * The pure scheduler. Owns execution state (`running`, `planStatus`,
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
  private store: PlanStore;
  private output: TaskOutputSource;
  private attempts = new Map<string, TaskAttempt>();
  private verifier = new VerdictEngine();
  private running = false;
  private planStatus: 'approved' | 'running' | 'completed' = 'approved';
  /** Planner turns in flight that new starts wait for (ADR-0029); running attempts carry on. */
  private startHolds = 0;
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
  /**
   * A full-plan run a failure paused. Retrying the failed task is the explicit
   * resume the pause waits for — without this a retry only reset the task to
   * pending and nothing ran until the user also re-ran the whole plan.
   */
  private haltedByFailure = false;
  /** A Merge all is under way: no ops task starts until it ends (ADR-0020). */
  private merging = false;
  /** The last "waiting for Merge all" notice, so a run paused at a gate says it once, not on every tick. */
  private gateNotice = '';
  /** The workspace's own variables for a task's cwd (ADR-0016); swapped out in tests. */
  private workspaceEnv: (cwd: string) => Promise<WorkspaceEnv>;
  /** What the workspace env has already warned about, so a run says it once, not per task. */
  private envWarnings = new Set<string>();
  /**
   * Tasks pulled out of auto-scheduling (user-cancelled or failed to spawn).
   * They stay 'pending' — "not executed" — but the scheduler skips them until
   * the user retries or force-starts, which would otherwise loop forever on a
   * task whose spawn always throws.
   */
  private onHold = new Set<string>();
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
  private runSettings: () => SchedulerRunSettings | undefined;

  constructor(deps: TaskOrchestratorDeps) {
    this.config = deps.config;
    this.notifications = deps.notifications;
    this.runner = deps.runner;
    this.store = deps.store;
    this.output = deps.output;
    this.runs = deps.runs;
    this.landing = deps.landing;
    this.registry = deps.registry;
    this.workspaceRootFn = deps.workspaceRoot;
    this.workspaceEnv = deps.workspaceEnv;
    this.skillsAt = deps.skillsAt;
    this.previousAttemptFromLog = deps.previousAttemptFromLog;
    this.runSettings = deps.runSettings;

    this.store.onMutate = () => this.emit('onTaskChanged');
    this.verifier.onVerdict((taskId, verdict) => { void this.deliverVerdict(taskId, verdict); });
    this.verifier.onCheckpoint((taskId, summary) => {
      const task = this.store.get(taskId);
      if (!task) return;
      this.store.markAwaitingUser(taskId, 'checkpoint');
      this.verifier.pauseIdle(taskId);
      this.emit('onTaskSettled', { taskId });
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
        notice: (level, message) => orchestrator.emit('onIsolationNotice', { level, message }),
      },
      liveTasks: (): ReadonlySet<string> => orchestrator.liveTaskIds(),
    });
    const landing = new Landing({ runs, config: options.config, tasks: store });
    const orchestrator = new TaskOrchestrator({
      config: options.config,
      notifications: options.notifications,
      runner: options.runner,
      store,
      output,
      runs,
      landing,
      registry: options.registry ?? null,
      workspaceRoot,
      workspaceEnv: options.workspaceEnv ?? ((cwd) => resolveWorkspaceEnv(cwd)),
      skillsAt: options.skillsAt ?? ((roots) => new SkillsService(roots)),
      previousAttemptFromLog: options.previousAttemptFromLog ?? (() => null),
      runSettings: options.runSettings ?? (() => undefined),
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

  private messageTask(
    taskId: string,
    text: string,
    action: 'message' | 'force',
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

  /** Force send a message still queued behind the running turn; false once the runner has it. */
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
    return this.running || this.attempts.size > 0;
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
  get isScheduling(): boolean { return this.running; }
  /** A full-plan run a failure paused, which a retry of the failed task resumes. */
  get isHaltedByFailure(): boolean { return this.haltedByFailure && !this.running; }
  get status(): 'approved' | 'running' | 'completed' { return this.planStatus; }
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
      throw new TaskControlError(`Ops task "${title}" is running in your checkout — Merge all once it has finished.`);
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
    return { waitingAtGate, paused: waitingAtGate && this.running && this.attempts.size === 0, repos: handoff.repos, landed: handoff.landed };
  }

  /**
   * The dependencies an ops or user task waits on at its merge gate: those
   * whose landed work is not in the user's branch yet (ADR-0020). Empty once
   * the task has started, and for every other task.
   */
  getMergeGate(taskId: string): string[] {
    const task = this.store.get(taskId);
    if (!task || (task.status !== 'pending' && task.status !== 'approved')) return [];
    return mergeGate(task, this.store, this.runs);
  }

  loadPlan(tasks: readonly Task[], planRunners: RunnerId[] = [...DEFAULT_RUNNERS]): void {
    this.store.load(tasks, planRunners);
    const repairs = this.endAllAttempts('load').filter((a) => a.kind.kind === 'repair' && a.worktree);
    for (const a of repairs) this.unawaited(this.runs.release(a.taskId, { keep: true }, a.integration), `Could not keep the worktree of task "${this.store.get(a.taskId)?.title ?? a.taskId}"`);
    // A plan committed while the scheduler runs keeps that run, and its mode
    // with it; otherwise the next start decides afresh.
    this.runs.interrupt({ keepOpen: this.running });
    // A failure's halt belongs to the plan it failed in, whose failed tasks this
    // load gives a fresh chance: left set, the next retry would restart a run
    // nobody started, and a usage-limit move would arm the scheduler.
    this.haltedByFailure = false;
    this.planStatus = 'approved';
    this.reviewApproved = false;
    this.retryCounts.clear();
    this.spawnCounts.clear();
    this.onHold.clear();
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
   * not a retry, and a run a failure halted waits for that retry.
   */
  reconcilePlan(newTasks: Task[], planRunners: RunnerId[] = [...DEFAULT_RUNNERS]): void {
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

    this.store.load(adopted, planRunners);
    for (const t of flattenTasks(adopted)) {
      if (t.status === 'failed') this.store.markFailed(t.id);
    }
    if (this.isRunning) this.planStatus = 'running';
  }

  async start(origin: RunOrigin = 'user'): Promise<void> {
    if (this.runs.blocked) return;
    if (this.running) {
      console.error('[TaskOrchestrator] start() called but already running — no-op');
      return;
    }
    if (!this.reviewApproved) {
      console.log('[TaskOrchestrator] start() blocked — plan review not yet approved. Emitting onReviewNeeded.');
      this.emit('onReviewNeeded', { tasks: this.store.planTasks, planRunners: this.store.planRunners });
      return;
    }
    this.openRun(origin);
    console.log(`[TaskOrchestrator] Starting with ${this.store.allTasks.length} tasks (${this.store.allTasks.filter(t => t.type === 'ai' && t.prompt).length} AI ready)`);
    this.running = true;
    this.haltedByFailure = false;
    this.planStatus = 'running';
    this.emit('onTaskChanged');
    await this.tick();
  }

  private haltOnFailure(): void {
    if (this.running) this.haltedByFailure = true;
    this.running = false;
    this.planStatus = 'approved';
  }

  stop(): void {
    this.haltedByFailure = false;
    this.running = false;
    this.planStatus = 'approved';
    // Let the verifier go before the runners: a killed session fires its exit
    // synchronously, and under a still-valid generation that exit is a verdict
    // — for a conflict repair, one that lands work the stop just cancelled.
    this.verifier.reset();
    this.runner.stopAll();
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
    // A stopped run does not start itself again: what waited on a reset waits for the user now.
    for (const t of this.store.allTasks.filter(waitsForReset)) this.cancelScheduledResume(t.id);
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
    this.tell('info', `Stopped ${named} — back to not started.${kept}`);
  }

  /**
   * A task in progress with no attempt has nothing running it: a stop, a plan
   * load or anything else that ended its attempt left its status behind. It
   * is put back to not started, and said, so it can be retried rather than
   * read as running — or, in an isolated run, count as live work forever.
   */
  private recoverOrphans(): void {
    const orphans = this.store.allTasks.filter((t) => t.type === 'ai' && t.status === 'in_progress' && !this.attempts.has(t.id) && !this.completing.has(t.id));
    if (orphans.length === 0) return;
    for (const t of orphans) this.store.markPending(t.id);
    const one = orphans.length === 1;
    const titles = quotedList(orphans.map((t) => t.title));
    this.tell('warn', `${one ? 'Task' : 'Tasks'} ${titles} ${one ? 'was' : 'were'} shown as running, but nothing was running ${one ? 'it' : 'them'} — back to not started. Retry or force-start ${one ? 'it' : 'them'}; a worktree ${one ? 'it' : 'they'} had is kept.`);
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
   * user, as its conflict did); either way the run halts and says why.
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
        this.haltOnFailure();
        this.tell('error', unsettled ? `Task "${title}" could not be settled: ${reason}` : `Task "${title}" settled, but the run could not go on: ${reason}`);
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

    console.error(`[TaskOrchestrator] Task ${taskRefOf(this.store.planTasks, task.id) ?? `#${task.order}`} "${task.title}" verdict=${verdict.outcome}`);
    console.error(`[TaskOrchestrator] Runner: ${task.assignedRunner}, Model: ${task.assignedModel?.modelId ?? 'default'}`);
    console.error(`[TaskOrchestrator] Prompt preview: ${(task.prompt ?? '').slice(0, 200)}`);
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
    console.error(`[TaskOrchestrator] Output summary:\n${summary || '(empty — no output captured)'}`);
    if (changedFiles.length > 0) {
      // The evidence the ops rule rests on: a runner cannot be kept from
      // writing, only caught. Nothing is committed, and nothing fails.
      this.store.markAwaitingUser(taskId, 'files-changed');
      this.tell('warn', `Ops task "${task.title}" finished, but changed tracked files in your checkout: ${capConflictFiles(changedFiles)}. An ops task must not change repository files, so nothing was committed — look at the changes, then mark it complete or retry it.`);
    } else if (landing) {
      await this.applyLanding(task, landing, () => this.notifications.info(`Task "${task.title}" completed.`));
    } else if (classifyRunnerStop(attempt.session?.getOutput() ?? '') === 'usage-limit') {
      this.pauseOnLimit(task, attempt, attempt.session?.getOutput() ?? '');
      if (attempt.worktree) await this.runs.release(taskId, { keep: true });
    } else {
      this.store.markFailed(taskId);
      // Missing completion evidence is a hard boundary: do not launch more
      // work from a full-plan run until the user retries/resumes explicitly.
      // Already-active parallel tasks may finish, but no new task is spawned.
      this.haltOnFailure();
      this.notifications.error(unresumedReason ?? `Task "${task.title}" failed verification: ${verdict.reason}`);
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
    if (!this.running) {
      if (this.attempts.size === 0) {
        if (this.store.isAllComplete()) this.planStatus = 'completed';
        this.emit('onTick');
        if (this.settled) await this.closeRun();
        this.emit('onExecutionComplete');
      }
      return;
    }
    await this.tick();
  }

  /**
   * A repair's verdict never replaces the verdict the task's own work earned,
   * and a repair that does not land leaves the task waiting on the user —
   * never a failed task, so never a halted run.
   */
  private async settleRepair(task: Task, attempt: TaskAttempt, verdict: Verdict): Promise<void> {
    const outcome = await this.land(attempt, () => this.landing.settleRepair(task, verdict, () => this.attempts.get(task.id) === attempt));
    if (this.attempts.get(task.id) !== attempt) return;
    this.endAttempt(task.id, 'verdict');
    await this.applyLanding(task, outcome, () => {
      this.store.unblockDependents(task.id);
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

  /** Settle a task by how its landing went; `onLanded` is what the path that landed it adds to completing it. */
  private async applyLanding(task: Task, outcome: LandingOutcome, onLanded: () => void): Promise<void> {
    if (!completesTask(outcome)) return this.settleUnlanded(task, outcome);
    this.store.markCompleted(task.id);
    onLanded();
    this.say(outcome.messages);
    await this.landResolved(task.id);
  }

  /**
   * Work that did not land waits on the user — it never fails the task or
   * halts the run — unless its conflict is owed a repair, which takes the slot
   * the ending attempt freed and never one more than the run allows.
   */
  private settleUnlanded(task: Task, outcome: UnlandedOutcome): void {
    this.store.markAwaitingUser(task.id, 'conflict');
    this.say(outcome.messages);
    if (outcome.kind !== 'repair-needed') return;
    if (this.attempts.size < this.config.maxParallelSessions) this.unawaited(this.startTask(task), `Could not start the repair of task "${task.title}"`);
    else {
      this.store.markPending(task.id);
      this.tell('info', `Task "${task.title}" is repaired once a slot is free.`);
    }
  }

  private async landResolved(resolverId: string): Promise<void> {
    const resolved = await this.landing.landResolved(resolverId);
    if (!resolved) return;
    const { task, outcome } = resolved;
    await this.applyLanding(task, outcome, () => {
      this.store.unblockDependents(task.id);
      if (task.verdict) this.logAndArchive(task, task.verdict);
    });
  }

  getReadyTasks(): Task[] {
    return this.readiness().ready;
  }

  private readiness(): Readiness {
    if (!this.running) return { ready: [], candidateCount: 0, excluded: [], gated: [] };
    const maxParallel = this.config.maxParallelSessions;
    const active = this.attempts.size;
    const waitingRunners = new Set(this.store.allTasks
      .filter((t) => t.status === 'awaiting_user' && t.awaitingReason === 'usage-limit')
      .map((t) => this.store.resolveTaskRunner(t)));
    const onHold = new Set(this.onHold);
    for (const t of this.store.allTasks) {
      if (waitingRunners.has(this.store.resolveTaskRunner(t))) onHold.add(t.id);
    }
    const readiness = selectReadyTasks({
      store: this.store,
      onHold,
      runs: this.runs,
      active,
      maxParallel,
      merging: this.merging,
    });

    for (const { task, reasons } of readiness.excluded) {
      console.log(`[TaskOrchestrator] excluded: ${taskRefOf(this.store.planTasks, task.id) ?? `#${task.order}`} "${task.title}" — ${reasons.join(', ')}`);
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
    if (!this.runs.isOpen || !this.running) return;
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

  /** The kind a task's next attempt starts as, short of a repair or a continue: what is weighed before one exists. */
  private nextAttemptKind(taskId: string): AttemptKind {
    return classifyAttempt(this.store.isOps(taskId));
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
    this.onHold.add(taskId);
    this.emit('onTaskChanged');
    await this.runs.release(taskId, worktree, ended?.integration);
    await this.tick();
  }

  /**
   * Let go of a task that is leaving the plan. A live runner is cancelled
   * as {@link cancelTask} does, but its worktree goes: no task is left to land
   * it into. A spawn still in flight just loses its attempt,
   * which is what makes {@link startTask} kill the session it is about to
   * receive. The id's cross-attempt bookkeeping goes too — a hold or retry
   * count kept for a task that no longer exists would be inherited by nothing.
   */
  async releaseTask(taskId: string): Promise<void> {
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

    if (completesTask(landing)) this.store.markCompleted(taskId);
    else this.settleUnlanded(task, landing);
    this.store.setTaskVerdict(taskId, verdict);
    this.store.setTaskOutputSummary(taskId, summarizeOutput(verdict.reason, ''));
    this.logAndArchive(task, verdict);
    if (completesTask(landing)) {
      this.store.unblockDependents(taskId);
      this.onHold.delete(taskId);
      this.notifications.info(`Task "${task.title}" marked complete.`);
      this.say(landing.messages);
      await this.landResolved(taskId);
    }

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
    this.onHold.add(taskId);
    // A finished plan is no longer finished — leaving 'completed' would tell
    // every surface the run is over while a task sits pending.
    if (this.planStatus === 'completed') this.planStatus = 'approved';

    this.notifications.info(`Task "${task.title}" marked not done.`);
    this.emit('onTaskChanged');
    await this.tick();
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
    this.retryCounts.set(taskId, (this.retryCounts.get(taskId) ?? 0) + 1);
    const ended = this.endAttempt(taskId, 'retry');
    this.store.retry(taskId);
    this.store.unblockDependents(taskId);
    this.onHold.delete(taskId);
    this.emit('onTaskChanged');
    // A retry starts over from the integration tip, which by now holds what its
    // predecessors landed; the old attempt's worktree has nothing to offer it.
    await this.runs.release(taskId, { keep: false }, ended?.integration);
    if (this.haltedByFailure && !this.running) await this.start(origin);
    else await this.tick();
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
    if (!(await this.openFor(taskId, origin, () => this.continueTask(taskId, message, origin)))) return;
    // The run may have started it while opening; the claim below must be the only one.
    if (this.attempts.has(taskId) || !continuability(task).ok) return;

    this.retryCounts.set(taskId, (this.retryCounts.get(taskId) ?? 0) + 1);
    this.endAttempt(taskId, 'retry');
    this.store.retry(taskId);
    this.store.unblockDependents(taskId);
    this.onHold.delete(taskId);
    // Claimed before anything is awaited, so a running scheduler never sees the
    // pending task and starts it afresh. Its prepare replaces the old worktree.
    const started = this.startTask(task, { message: text, resumeSessionId: eligible.sessionId });
    const resumed = this.haltedByFailure && !this.running ? this.start(origin) : Promise.resolve();
    // Both are awaited even if one fails: the claimed attempt's start must not
    // be left unhandled because restarting the run threw.
    await Promise.all([resumed, started]);
  }

  /**
   * Keep a task paused on its runner's usage limit from resuming on its own:
   * it waits for a manual retry, as one whose reset time could not be read
   * does. What a surface's cancel calls, and what moving the task to another
   * runner has to call first. False when no resume was scheduled for it.
   */
  cancelScheduledResume(taskId: string): boolean {
    const task = this.store.get(taskId);
    if (!task || !waitsForReset(task)) return false;
    const runner = this.store.resolveTaskRunner(task);
    this.store.setTaskResumeAt(taskId, undefined);
    if (this.waitingOn(runner).length === 0) this.limitWaits.disarm(runner);
    this.emit('onUsageLimitWait', { taskId, runner, resumeAt: null, cancelled: true });
    this.emit('onTaskChanged');
    return true;
  }

  /** Run before writing assignments so cancellation sees the old runner's shared wait. */
  releaseMovedResume(taskId: string, changes: Partial<Task>): Partial<Task> {
    const task = this.store.get(taskId);
    if (!task || task.status !== 'awaiting_user' || task.awaitingReason !== 'usage-limit') return changes;
    const next = { ...task, ...changes };
    // The limit belongs to the runner's account, so a model change on that
    // same runner must keep waiting for its reset.
    if ((next.assignedRunner ?? this.store.planRunners[0]) === this.store.resolveTaskRunner(task)) return changes;
    this.cancelScheduledResume(taskId);
    this.onHold.delete(taskId);
    if (this.haltedByFailure && !this.store.isAnyFailed()) {
      this.running = true;
      this.haltedByFailure = false;
      this.planStatus = 'running';
    }
    return { ...changes, status: 'pending', awaitingReason: undefined, resumeAt: undefined };
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
  private pauseOnLimit(task: Readonly<Task>, attempt: TaskAttempt, said: string): void {
    this.store.markAwaitingUser(task.id, 'usage-limit');
    this.haltOnFailure();
    const kept = attempt.worktree ? ' — its worktree is kept' : '';
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
    this.store.setTaskOutputSummary(taskId, summarizeOutput(attempt.turnError ?? `${attempt.runner} hit its usage limit`, summary));
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

  private async resumeAfterLimit(runner: string): Promise<void> {
    const due = this.waitingOn(runner);
    if (due.length === 0) return;
    this.tell('info', `The usage limit of ${runner} has reset: resuming ${quotedList(due.map((t) => t.title))}.`);
    await Promise.all(due.map((t) => this.resumeTask(t.id)));
  }

  /**
   * Retry a task paused on a usage limit, continuing its saved session where
   * it left one (ADR-0018, K1), then release the hold the pause put on the
   * run — once nothing else waits on a reset, and never past a failure, which
   * waits for the user.
   */
  private async resumeTask(taskId: string): Promise<void> {
    if (!(await this.openFor(taskId, 'limit-reset', () => this.resumeTask(taskId)))) return;
    const task = this.store.get(taskId);
    if (!task || !waitsForReset(task) || this.attempts.has(taskId)) return;
    const resumeSessionId = task.runnerSessionId;
    this.retryCounts.set(taskId, (this.retryCounts.get(taskId) ?? 0) + 1);
    this.store.retry(taskId);
    this.onHold.delete(taskId);
    const continuation = resumeSessionId ? { message: LIMIT_RESET_MESSAGE, resumeSessionId } : null;
    const started = this.startTask(task, continuation, { autoResumed: true });
    const resumed = this.haltedByFailure && !this.running && !this.store.isAnyFailed() && !this.store.allTasks.some(waitsForReset) ? this.start('limit-reset') : Promise.resolve();
    // Both are awaited even if one fails: the claimed attempt's start must not
    // be left unhandled because restarting the run threw.
    await Promise.all([resumed, started]);
  }

  /**
   * Manually start a single AI task right now, bypassing dependency/readiness
   * gating (the "force start" affordance on a task card). Reuses the scheduler's
   * own startTask so a force-started task gets the same augmented prompt, session
   * tracking, and exit handling — callers must not re-spawn the runner themselves.
   * No-op if the task is unknown, not an AI task, or already running.
   */
  async forceStartTask(taskId: string, origin: RunOrigin = 'user'): Promise<void> {
    const task = this.store.get(taskId);
    if (!task || task.type !== 'ai') return;
    if (this.attempts.has(taskId)) return;
    this.refuseOpsDuringMerge(task);
    if (!(await this.openFor(taskId, origin, () => this.forceStartTask(taskId, origin)))) return;
    this.onHold.delete(taskId);
    this.notePastGate(task);
    await this.startTask(task);
  }

  private refuseOpsDuringMerge(task: Readonly<Task>): void {
    if (this.merging && mergeExcludes(this.nextAttemptKind(task.id))) {
      throw new TaskControlError(`A Merge all is under way — ops task "${task.title}" can start once it has finished.`);
    }
  }

  /**
   * A force start passes a merge gate (ADR-0020), and the surface confirmed it
   * first; the choice is kept on the task and said, because the work it acts
   * on is not in the user's branch.
   */
  private notePastGate(task: Readonly<Task>): void {
    const unmerged = mergeGate(task, this.store, this.runs);
    if (unmerged.length === 0) return;
    const titles = unmerged.map((id) => `"${this.store.get(id)?.title ?? id}"`);
    this.store.setForcedPastGate(task.id, titles);
    this.tell('warn', `Task "${task.title}" was force-started before the work of ${titles.join(', ')} was merged into your branch.`);
  }

  /**
   * Run exactly one task outside full-plan scheduling. The active/starting
   * session still contributes to {@link hasLiveWork} so every surface exposes
   * Stop and disables Execute Plan, but onVerdict cannot auto-schedule other
   * tasks because the plan scheduler's `running` flag remains false.
   */
  async runTask(taskId: string): Promise<void> {
    if (this.hasLiveWork) return;
    const task = this.store.get(taskId);
    if (!task || task.type !== 'ai') return;
    this.refuseOpsDuringMerge(task);
    if (!(await this.openFor(taskId, 'user', () => this.runTask(taskId)))) return;
    this.onHold.delete(taskId);
    this.notePastGate(task);
    await this.startTask(task);
  }

  getCompletedCount(): number { return this.store.completedCount; }
  getTotalCount(): number { return this.store.allTasks.length; }
  isAllComplete(): boolean { return this.store.isAllComplete(); }
  isAnyFailed(): boolean { return this.store.isAnyFailed(); }

  async approveReview(origin: RunOrigin = 'user'): Promise<void> {
    if (this.reviewApproved) {
      console.log('[TaskOrchestrator] approveReview() called but already approved — no-op');
      return;
    }
    this.reviewApproved = true;
    this.planStatus = 'approved';
    this.emit('onTaskChanged');
    this.emit('onReviewApproved', { tasks: this.store.planTasks });
    await this.start(origin);
  }

  async tick(): Promise<void> {
    this.recoverOrphans();
    if (!this.running) {
      // A run the scheduler is not driving — a manual task run, or a halted
      // plan's remaining attempts — is closed by a verdict only. Ended by
      // cancel, Mark complete or a failed spawn instead, it would stay open, and
      // the next run would inherit its mode rather than decide its own.
      if (this.attempts.size === 0 && this.runs.isOpen && this.settled) await this.closeRun();
      return;
    }

    // Ahead of the run-complete check too: the turn may add work to a run
    // that would otherwise end under it. Its release ticks again.
    if (this.startHolds > 0) return;

    let readiness = this.readiness();
    // Work merged by hand opens a gate as Merge all does; only git can tell.
    // A user task's gate counts too, though the scheduler never starts one.
    const atGate = readiness.gated.length > 0 || this.store.allTasks.some((t) => t.type === 'user' && this.getMergeGate(t.id).length > 0);
    if (atGate && (await this.runs.refreshInHead())) {
      this.autoMergeBlocked = false;
      readiness = this.readiness();
    }
    if (!this.running) return;
    if (this.mergesAutomatically() && !this.autoMergeBlocked && !this.merging
      && ![...this.attempts.values()].some((a) => mergeExcludes(a.kind))) {
      const gate = this.store.allTasks.find((t) => this.getMergeGate(t.id).length > 0
        && !this.onHold.has(t.id) && t.dependencies.every((id) => this.store.isCompleted(id)));
      if (gate) {
        // Another landing must not repeatedly attempt a merge the user now
        // needs to resolve. A user merge or a new run releases this hold.
        this.autoMergeBlocked = true;
        await this.mergeLanded({ kind: 'gate', taskId: gate.id });
        readiness = this.readiness();
      }
    }
    if (!this.running) return;
    const { ready } = readiness;
    console.log(`[TaskOrchestrator] tick(): ${ready.length} ready, ${this.attempts.size} active, held=${this.startHolds}`);

    if (ready.length === 0 && this.attempts.size === 0) {
      const remaining = this.store.allTasks.filter(t => t.status !== 'completed');
      console.log(`[TaskOrchestrator] tick(): no work. remaining=${remaining.length}, completed=${this.store.isAllComplete()}`);
      const remainingById = new Map(remaining.map((t) => [t.id, t]));
      for (const { task, label } of flattenTasksWithParents(this.store.planTasks)) {
        if (!remainingById.has(task.id)) continue;
        console.log(`  - ${label}. ${task.title} [${task.type}/${task.status}] prompt=${!!task.prompt}`);
      }
      if (this.store.isAllComplete()) {
        // Genuinely done — stop the loop so a fresh Execute click can start it again.
        this.running = false;
        this.planStatus = 'completed';
        this.notifications.info('All tasks completed!');
        this.emit('onTaskChanged');
        this.emit('onTick');
        await this.closeRun();
        this.emit('onExecutionComplete');
      } else {
        // Not done — just waiting on a user task, checkpoint, or held task.
        // Keep `running` true: markTaskComplete/retryTask/forceStartTask/cancelTask
        // all re-tick() afterward, and that only ever schedules new work while
        // `running` is true. Flipping it false here would silently kill the
        // scheduler and leave dependents unblocked-but-never-started.
        // Do NOT emit onExecutionComplete here: a paused run is not a finished
        // one, and every surface treats that signal as terminal (the TUI closes
        // its execution stream on receipt, so a later fan-out from completing the
        // user task would arrive to a closed socket and be invisible).
        this.notifications.info('Remaining tasks require user action or are on hold.');
        this.sayGate();
        this.emit('onTaskChanged');
        this.emit('onTick');
      }
      return;
    }

    for (const { id } of ready) {
      // Readiness was read before this loop awaited any start: a stop, a plan
      // load, a Merge all, a user control or a concurrent tick may have come
      // since, so each id is judged again — and last with nothing awaited
      // between that and the slot startTask claims.
      if (!this.running) return;
      if (!this.stillReady(id)) continue;
      const kind = this.nextAttemptKind(id);
      if (this.merging && mergeExcludes(kind)) continue;
      if (decidesIsolation(kind) && !(await this.runs.decide(() => this.tick()))) continue;
      if (!this.running) return;
      if (!this.stillReady(id)) continue;
      const task = this.store.get(id);
      if (task) await this.startTask(task);
    }
    this.emit('onTick');
  }

  /** Whether the scheduler may start `id` now: it passes every readiness gate and a slot is free. */
  private stillReady(id: string): boolean {
    if (this.startHolds > 0 || this.attempts.has(id) || this.attempts.size >= this.config.maxParallelSessions) return false;
    const { ready } = selectReadyTasks({
      store: this.store,
      onHold: this.onHold,
      runs: this.runs,
      active: 0,
      maxParallel: Number.POSITIVE_INFINITY,
      merging: this.merging,
    });
    return ready.some((t) => t.id === id);
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

  private async startTask(task: Task, continuation: Continuation | null = null, opts: { autoResumed?: boolean } = {}): Promise<void> {
    if (this.attempts.has(task.id) || !this.store.get(task.id)) return;
    const attempt: TaskAttempt = {
      taskId: task.id,
      attempt: Math.max(this.spawnCounts.get(task.id) ?? 0, ...task.attemptUsage?.map((u) => u.attempt) ?? []) + 1,
      phase: 'starting',
      session: null,
      runner: this.store.resolveTaskRunner(task),
      cwd: null,
      worktree: false,
      integration: null,
      kind: classifyAttempt(this.store.isOps(task.id), { repair: this.landing.nextRepair(task.id), continuation }),
      snapshot: null,
      startedAt: new Date().toISOString(),
      decided: false,
      skills: [],
      autoResumed: opts.autoResumed === true,
      turnError: null,
      reminded: false,
    };
    this.spawnCounts.set(task.id, attempt.attempt);
    this.attempts.set(task.id, attempt);
    this.store.startAttemptUsage(task.id, attempt.attempt, attempt.runner, attempt.startedAt);
    this.store.markInProgress(task.id);
    this.emit('onTaskChanged');

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
   * unwound (both leave `startTask` with nothing further to announce).
   */
  private async spawnAttempt(task: Task, attempt: TaskAttempt): Promise<boolean> {
    try {
      const { kind } = attempt;
      // Nothing can drive a runner without a structured connector, so it is
      // refused before a worktree is made for it.
      if (!supportsTaskMode(attempt.runner)) {
        const name = this.registry?.get(attempt.runner)?.manifest.displayName ?? attempt.runner;
        throw new Error(`${name} has no structured connector, so Ordewell cannot run its tasks. Assign the task to Claude Code, Codex or OpenCode.`);
      }
      const { cwd, worktree, continuationMessage } = await attemptCwd(kind, task, this.runs);
      attempt.cwd = cwd;
      attempt.worktree = worktree;
      if (checksTree(kind)) attempt.snapshot = await this.runs.snapshotWorkspace();
      if (this.attempts.get(task.id) !== attempt) {
        // Ended while its worktree was being made, so whatever ended it could
        // not release it. A newer attempt's own prepare replaces it instead.
        // A repair's worktree holds work that passed, so it is only handed back.
        if (attempt.worktree && !this.attempts.has(task.id)) await this.runs.release(task.id, { keep: kind.kind === 'repair' });
        this.abandonSpawn(task, attempt);
        return false;
      }
      // Read where the attempt runs: a skill an earlier task committed is in
      // this worktree only once that task's work has landed.
      if (takesSkills(kind) && task.skills?.length) {
        attempt.skills = resolveTaskSkills(task, this.skillsAt(this.skillRoots(cwd)), worktree ? (name) => this.uncommittedSkillFolder(name) : undefined);
      }
      const finalPrompt = attemptPrompt(kind, {
        task,
        plan: this.store.planTasks,
        planMapEnabled: this.config.planMapEnabled,
        continuationMessage: continuationMessage ?? (!worktree ? 'Your previous changes are in the working tree (shared workspace).' : undefined),
        skills: attempt.skills,
        repairPrompt: (t) => this.landing.repairPrompt(t),
        previousAttempt: (taskId) => this.opsPreviousAttempt(taskId),
      });
      const env = await this.envForTask(cwd);
      const session = await this.runner.spawn({
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
        attempt: attempt.attempt,
        ...(attempt.skills.length > 0 ? { skills: attempt.skills } : {}),
        onNotice: (message) => this.tell('warn', `Task "${task.title}": ${message}`),
      });

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
      if (takesSkills(kind)) this.store.setTaskAttemptSkills(task.id, [...attempt.skills]);

      // Attached before the verifier, so the summary of the call that settles
      // the attempt is captured before its verdict asks for the final text.
      session.onEvent((event) => {
        if (event.type !== 'usage' || this.attempts.get(task.id) !== attempt) return;
        this.store.recordAttemptUsage(task.id, attempt.attempt, event.record, new Date().toISOString());
        this.emit('onUsageChanged');
      });
      this.output.attach(task.id, session);
      this.verifier.watch(task, session);
      session.onEvent((event) => {
        if (event.type === 'turn_start') attempt.turnError = null;
        else if (event.type === 'error') attempt.turnError = event.message;
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
      if (attempt.kind.kind === 'continuation') {
        const reason = unresumedMessage(task, `could not start: ${err instanceof Error ? err.message : String(err)}`);
        this.store.markFailed(task.id);
        this.store.setTaskOutputSummary(task.id, summarizeOutput(reason, ''));
        await this.runs.release(task.id, { keep: false });
        this.notifications.error(reason);
        this.emit('onTaskSettled', { taskId: task.id });
        this.emit('onTaskChanged');
        await this.tick();
        return false;
      }
      if (attempt.kind.kind === 'repair') {
        this.store.markAwaitingUser(task.id, 'conflict');
        this.settleUnlanded(task, await this.landing.unrepaired(task, `could not start: ${err instanceof Error ? err.message : String(err)}`));
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
        this.haltOnFailure();
        this.tell('error', err.message);
        this.emit('onTaskSettled', { taskId: task.id });
        this.emit('onTaskChanged');
        await this.tick();
        return false;
      }
      if (err instanceof McpAttachError) {
        this.store.markFailed(task.id);
        this.store.setTaskOutputSummary(task.id, summarizeOutput(err.message, err.message));
        await this.runs.release(task.id, { keep: true });
        this.haltOnFailure();
        this.tell('error', err.message);
        this.emit('onTaskSettled', { taskId: task.id });
        this.emit('onTaskChanged');
        await this.tick();
        return false;
      }
      // Couldn't spawn — the task was never executed, so it stays "to do".
      // Held out of auto-scheduling to avoid a spawn-throw retry loop.
      this.store.markPending(task.id);
      this.onHold.add(task.id);
      await this.runs.release(task.id, { keep: false });
      this.tell('error', `Failed to start task "${task.title}": ${err}`);
      this.emit('onTaskChanged');
      await this.tick();
      return false;
    }
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
   */
  private abandonSpawn(task: Task, attempt: TaskAttempt, session?: IRunnerSession): void {
    session?.kill();
    if (this.attempts.has(task.id) || this.store.get(task.id)?.status !== 'in_progress') return;
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
   * invalidates a spawn still in flight ({@link startTask} kills the session
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
    if (attempt) {
      this.store.endAttemptUsage(taskId, attempt.attempt, new Date().toISOString());
      this.output.detach(taskId);
    }
    const session = attempt?.session ?? null;
    if (session) this.saveNativeSession(taskId, session.nativeSessionId());
    if (stopsRunner(reason)) {
      const task = this.store.get(taskId);
      if (task) this.verifier.clear(task);
      if (session) this.runner.stop(session.id);
    }
    return attempt;
  }

  /** Kept on the task once the attempt ends, so a continue can resume it after a reload (ADR-0018, K1). */
  private saveNativeSession(taskId: string, nativeSessionId: string | null): void {
    if (nativeSessionId) this.store.setTaskRunnerSessionId(taskId, nativeSessionId);
  }

  private endAllAttempts(reason: 'stop' | 'load'): TaskAttempt[] {
    const ended = [...this.attempts.values()];
    for (const { taskId } of ended) this.endAttempt(taskId, reason);
    this.verifier.reset();
    if (reason === 'load') this.output.reset();
    return ended;
  }
}

/** How long after its limit resets a task resumes: the runner's clock and ours need not agree to the second. */
const RESUME_MARGIN_MS = 60_000;

/** A resumed attempt that hits the limit again within this did not get past the reset, so it is not resumed again. */
const RELAPSE_MS = 5 * 60_000;

const LIMIT_RESET_MESSAGE = 'Your usage limit has reset. Carry on with the task from where you stopped.';

/** How much of an ops task's last attempt the next one is shown. */
const OPS_RETRY_TAIL_LINES = 60;

function unresumedMessage(task: Task, why: string): string {
  return `Could not continue task "${task.title}": ${why}. Retry starts it afresh.`;
}
