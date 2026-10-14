import { flattenTasks, flattenTasksWithParents, type RunSettings, type SupervisionSnapshot, type Task } from '../models/Task';
import type { ExecutionActor, ExecutionRecord, SupervisorLevel } from '../models/Execution';
import type { IsolationHandoff } from '../interfaces/IWorktreeIsolation';
import type { GlobalRunSettings } from './SettingsService';
import type { RunOrigin } from './TaskOrchestrator';
import type { ExecutionCommand, LoopGuard } from './ExecutionCommands';
import type { WakeUpTurn } from './PlannerConversation';
import { Supervisor, type RunEventInput, type SupervisorHost, type SupervisorOptions } from './Supervisor';
import { SupervisionMemory, type GuardTarget, type GuardTrip } from './LoopGuards';
import { SUPERVISOR_LEVEL_LABEL } from './runSettingsText';
import { executionSummary } from './SessionMessage';
import { blockingFailures } from './blocking';

/** Supervisor levels, lowest first: an automatic lowering only ever goes down. */
const LEVEL_RANK: Record<SupervisorLevel, number> = { off: 0, watch: 1, act: 2 };

/** A run the supervisor opens continues the last; every other actor asks for the user (ADR-0029, ADR-0030). */
export function runOrigin(actor: ExecutionActor): RunOrigin {
  return actor.kind === 'supervisor' ? 'supervisor' : 'user';
}

/**
 * What {@link RunSupervision} reaches outside the run: where its settings are
 * saved, the user's settings, the transcript, and what the supervisor's
 * wake-ups need of the planner.
 */
export interface RunSupervisionHost extends Pick<SupervisorHost, 'deliver' | 'pump' | 'plannerRunner' | 'restartPlanner' | 'abandonTurn' | 'notice'> {
  /** The plan the run belongs to: its `runSettings` are the run's own, saved with it. Null with no plan. */
  plan(): { runSettings?: RunSettings } | null;
  /** The user's run settings as they stand now (ADR-0030). */
  userSettings(): GlobalRunSettings;
  /** The plan's task tree, as the guards and the run updates read it. */
  tasks(): readonly Task[];
  /** What a task waiting at a checkpoint asked, if it said. */
  checkpointQuestion(taskId: string): string | undefined;
  /** The last few lines a task's runner wrote. */
  recentOutput(taskId: string): string | undefined;
  /** A line in the transcript in Ordewell's voice, saved and announced with the run's settings as they are now. */
  systemNote(text: string): void;
  /** A message to the user in the supervisor's voice, saved and announced. */
  supervisorNote(text: string): void;
  /** The run's settings changed with nothing to say: save and announce the plan. */
  changed(): void;
  /** Save the plan in the background: what supervision remembers goes with it. */
  save(): void;
  /** Send the end-of-run handoff again, unmarked, unless the run merged meanwhile or a new one opened. */
  resendHandoff(): void;
}

/**
 * One plan's run supervision (ADR-0029, ADR-0030): the one owner of the run's
 * settings (`runSettings` on the plan) and of everything that reads or lowers
 * them — whether a run starts afresh or continues the last, the user's change
 * applied at once, a failed supervisor or a tripped guard lowering the run,
 * the loop guards' memory, and the end-of-run handoff an Act supervisor has
 * first. It feeds the {@link Supervisor}, which decides when the planner
 * wakes. The session's observer forwards run events here and reads nothing
 * back but the level.
 */
export class RunSupervision {
  private readonly supervisor: Supervisor;
  /** What the loop guards remember from the user's start of a run to their next. */
  private readonly guards = new SupervisionMemory();
  /** The run's handoff went out marked as an Act supervisor's, and is owed unmarked unless it merges. */
  private handoffDeferred = false;

  constructor(private readonly host: RunSupervisionHost, options: SupervisorOptions = {}) {
    this.supervisor = new Supervisor({
      run: () => {
        const settings = this.settings();
        return settings ? { level: settings.supervisorLevel ?? 'off', ...(settings.unsupervised ? { unsupervised: settings.unsupervised } : {}) } : null;
      },
      deliver: (digest) => host.deliver(digest),
      pump: () => host.pump(),
      saveState: () => host.save(),
      describeTask: (taskId) => this.describeTask(taskId),
      blockedBy: (failedId) => [...blockingFailures([...this.host.tasks()])].filter(([, failures]) => failures.includes(failedId)).map(([taskId]) => taskId),
      readBudget: () => this.settings()?.wakeUpReadBudget ?? host.userSettings().wakeUpReadBudget,
      retryLimit: () => this.retryLimit(),
      plannerRunner: () => host.plannerRunner(),
      restartPlanner: () => host.restartPlanner(),
      abandonTurn: () => host.abandonTurn(),
      goUnsupervised: (reason) => this.goUnsupervised(reason),
      wakeUpEnded: () => {
        if (!this.supervisor.awaitsRunEnd) this.handOver();
      },
      dropToWatch: (reason) => this.dropToWatch(reason),
      notice: (level, message) => host.notice(level, message),
    }, options);
  }

  /** The level the supervisor acts at now: the run's, lowered during it perhaps, and Off once it failed. */
  get level(): SupervisorLevel {
    return this.supervisor.level;
  }

  /**
   * A run opened. Only the user's starts its supervision afresh, from their
   * settings as they stand. A run the supervisor opens itself, or a
   * usage-limit reset resumes, carries on the one before: its settings, its
   * level as lowered, and what the loop guards remember.
   */
  runStarted(origin: RunOrigin): void {
    const plan = this.host.plan();
    if (!plan) return;
    const continued = plan.runSettings !== undefined && origin !== 'user';
    if (!continued) {
      const user = this.host.userSettings();
      plan.runSettings = {
        mergeAtGatesAutomatically: user.mergeAtGatesAutomatically,
        supervisorLevel: user.supervisorLevel,
        supervisorRetryLimit: user.supervisorRetryLimit,
        wakeUpReadBudget: user.wakeUpReadBudget,
      };
      this.guards.forget();
    }
    this.supervisor.runStarted(continued);
  }

  /**
   * The user changed run settings in this session (ADR-0030), already saved
   * as theirs: the run under way takes them at once, in either direction.
   * Their level lifts what a failure or a guard lowered — a fresh consent —
   * with the guards' memory kept. No run, nothing to apply: the next copies
   * the user's.
   */
  apply(changes: Partial<GlobalRunSettings>): void {
    const settings = this.settings();
    if (!settings) return;
    const level = changes.supervisorLevel;
    if (level !== undefined && (level !== (settings.supervisorLevel ?? 'off') || settings.unsupervised !== undefined)) {
      settings.supervisorLevel = level;
      delete settings.unsupervised;
      this.host.systemNote(`You set the supervisor to ${SUPERVISOR_LEVEL_LABEL[level]}.`);
      if (level === 'off') this.supervisor.standDown();
      else this.supervisor.setByUser();
      if (level !== 'act') this.handOver();
    }
    if (changes.mergeAtGatesAutomatically !== undefined) settings.mergeAtGatesAutomatically = changes.mergeAtGatesAutomatically;
    if (changes.supervisorRetryLimit !== undefined) settings.supervisorRetryLimit = changes.supervisorRetryLimit;
    if (changes.wakeUpReadBudget !== undefined) settings.wakeUpReadBudget = changes.wakeUpReadBudget;
    this.host.save();
  }

  /** A run event for the supervisor to batch; see {@link Supervisor.observe}. */
  observe(event: RunEventInput): void {
    this.supervisor.observe(event);
  }

  /** A task settled on its own: the guards remember a failure's shape, and the supervisor hears of it. */
  taskSettled(task: Readonly<Task>): void {
    this.guards.settled(task);
    const event = this.settledEvent(task);
    if (event) this.supervisor.observe(event);
  }

  /** The run finished; a handoff deferred to the supervisor is resent once its wake-up turn on it is over. */
  runFinished(): void {
    const { total, completed, failed, blocked, skipped } = executionSummary(flattenTasks([...this.host.tasks()]));
    this.supervisor.observe({ kind: 'run_finished', detail: `${completed} of ${total} tasks completed${failed > 0 ? `, ${failed} failed` : ''}${blocked > 0 ? `, ${blocked} blocked` : ''}${skipped > 0 ? `, ${skipped} skipped` : ''}` });
    if (!this.supervisor.awaitsRunEnd) this.handOver();
  }

  /** The end-of-run handoff as the surfaces get it: marked as the supervisor's first while it is at Act (ADR-0029). */
  handoff(handoff: IsolationHandoff): IsolationHandoff {
    this.handoffDeferred = this.level === 'act';
    return this.handoffDeferred ? { ...handoff, deferredTo: 'supervisor' } : handoff;
  }

  /** Whether wake-ups alone may open a planner turn now. */
  mayWake(): boolean {
    return this.supervisor.mayWake();
  }

  /** Run one wake-up turn, held to the run's level; see {@link Supervisor.turn}. */
  wakeUp<T>(reply: (signal: AbortSignal, turn: WakeUpTurn) => Promise<T>, signal?: AbortSignal): Promise<T> {
    return this.supervisor.turn((turnSignal) => reply(turnSignal, this.supervisor.wakeUpTurn()), signal);
  }

  /** The command seam's loop guard: a supervisor's call checked against what this run remembers. */
  readonly guard: LoopGuard = (actor, command: ExecutionCommand, target: GuardTarget | undefined) =>
    (actor.kind === 'supervisor' ? this.guards.check(command, target, [...this.host.tasks()], this.retryLimit()) : null);

  /** A call went through the seam: a supervisor's retry is counted. */
  executed(record: ExecutionRecord): void {
    this.guards.done(record, [...this.host.tasks()]);
  }

  /** The oscillation guard on a supervisor's edit taking the plan from `before` to `after`; a trip is told to the user. */
  checkEdit(before: readonly Task[], after: readonly Task[]): GuardTrip | null {
    const trip = this.guards.checkEdit(before, after);
    if (trip) this.guardTripped(trip);
    return trip;
  }

  /** One of the supervisor's edits landed. */
  edited(before: readonly Task[], after: readonly Task[]): void {
    this.guards.edited(before, after);
  }

  /** A loop guard stopped the supervisor: the user hears of it once, as the supervisor's message. */
  guardTripped(trip: GuardTrip): void {
    if (this.guards.firstReport(trip)) this.host.supervisorNote(trip.escalation);
  }

  /** What supervision remembers, for the plan's save (ADR-0029). */
  snapshot(): SupervisionSnapshot {
    return { guards: this.guards.snapshot(), wake: this.supervisor.snapshot() };
  }

  /** Put back what a save remembered, for a plan adopted off disk. */
  restore(snapshot: SupervisionSnapshot | undefined): void {
    this.guards.restore(snapshot?.guards);
    this.supervisor.restore(snapshot?.wake);
  }

  /** The plan is gone: nothing supervision gathered, remembered or owes carries over. */
  reset(): void {
    this.supervisor.reset();
    this.handoffDeferred = false;
    this.guards.forget();
  }

  private settings(): RunSettings | undefined {
    return this.host.plan()?.runSettings;
  }

  /** Retries an Act supervisor may make of one task (a loop guard), as the run holds them. */
  private retryLimit(): number {
    return this.settings()?.supervisorRetryLimit ?? this.host.userSettings().supervisorRetryLimit;
  }

  /**
   * The supervisor failed for the rest of the run: the run carries on as Off.
   * Said in the transcript, where its notes would have been, and as a notice.
   */
  private goUnsupervised(reason: string): void {
    const settings = this.settings();
    if (!settings || settings.unsupervised) return;
    const text = `The supervisor stopped: ${reason}. The run carries on unsupervised; what it was not told reaches the planner with your next message.`;
    settings.unsupervised = reason;
    this.host.systemNote(text);
    this.host.notice('warn', text);
    this.handOver();
  }

  /** The wake-up rate guard tripped: the run carries on at Watch, and the user is told in the supervisor's voice. */
  private dropToWatch(reason: string): void {
    const settings = this.settings();
    if (!settings || LEVEL_RANK[settings.supervisorLevel ?? 'off'] <= LEVEL_RANK.watch) return;
    settings.supervisorLevel = 'watch';
    this.host.changed();
    this.handOver();
    const text = `Loop guard, wake-up rate: I ${reason}, so I am at Watch for the rest of this run: I tell you what needs you and suggest, and act only when you say so.`;
    this.host.supervisorNote(text);
    this.host.notice('warn', text);
  }

  /**
   * Send a handoff deferred to an Act supervisor again, unmarked, once the
   * supervisor no longer has it: its wake-up turn on the run's end is over, it
   * was lowered, or it failed.
   */
  private handOver(): void {
    if (!this.handoffDeferred) return;
    this.handoffDeferred = false;
    this.host.resendHandoff();
  }

  /** `#3 "Title"`, how a run update names a task. */
  private describeTask(taskId: string): string {
    const found = flattenTasksWithParents([...this.host.tasks()]).find(({ task }) => task.id === taskId);
    return found ? `${found.ref} "${found.task.title}"` : taskId;
  }

  /** The event a task settling on its own is for the supervisor; null for one it hears of another way. */
  private settledEvent(task: Readonly<Task>): RunEventInput | null {
    const taskId = task.id;
    if (task.status === 'completed') return { kind: 'task_passed', taskId };
    if (task.status === 'failed') return { kind: 'task_failed', taskId, ...(task.verdict?.reason ? { detail: task.verdict.reason } : {}) };
    if (task.status !== 'awaiting_user') return null;
    switch (task.awaitingReason) {
      case 'checkpoint': {
        const question = this.host.checkpointQuestion(taskId);
        return { kind: 'waiting_input', taskId, detail: `at a checkpoint${question ? `: ${question}` : ''}` };
      }
      case 'conflict': return { kind: 'landing_conflict', taskId };
      case 'files-changed':
        return { kind: 'waiting_input', taskId, detail: 'the ops task changed tracked files in the user\'s checkout; nothing was committed, and the user marks it complete or retries it' };
      // Heard from the orchestrator's wait, with the runner and its reset.
      case 'usage-limit': return null;
      default: {
        const said = this.host.recentOutput(taskId);
        return { kind: 'waiting_input', taskId, ...(said ? { detail: said } : {}) };
      }
    }
  }
}
