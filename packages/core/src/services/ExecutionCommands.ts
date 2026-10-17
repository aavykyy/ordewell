import { flattenTasksWithParents, pausedOnLimit, type Task, type TaskStatus } from '../models/Task';
import { resolveTaskRef } from './TaskRefs';
import type { ExecutionActor, ExecutionCommandName, ExecutionRecord, SupervisorLevel } from '../models/Execution';
import type { ApprovalRequest, IApproval } from '../interfaces/IApproval';
import type { IsolationMergeResult } from '../interfaces/IWorktreeIsolation';
import { continuability } from './continuation';
import type { GuardTarget, GuardTrip } from './LoopGuards';
import { STOPPED_BEFORE_START, type StartAdmission } from './TaskOrchestrator';

/** One call at the command seam, as every route words it (ADR-0029). Task references are resolved here. */
export type ExecutionCommand =
  | { command: 'run_plan' }
  | { command: 'run_task'; task: string }
  | { command: 'stop_task'; task: string }
  | { command: 'stop_run' }
  /**
   * `session`: continue the saved runner session with `message` (ADR-0018, K1),
   * or resume a task paused on a usage limit in it, the message optional;
   * `fresh`: a new attempt from the task's prompt.
   */
  | { command: 'retry_task'; task: string; from: 'fresh' | 'session'; message?: string }
  | { command: 'message_task'; task: string; text: string }
  /** `answer` is checked here rather than typed: an `allow` must reach the seam to be refused with its reason. */
  | { command: 'answer_approval'; task: string; approval?: string; answer: string; note?: string }
  /** Merge all: the run's landed work into the user's branch (ADR-0013). */
  | { command: 'merge_all' }
  /** End a task as skipped: nothing it did lands, and its dependents go ahead without it once the work it waited on is done. `reason` is required of anyone but the user. */
  | { command: 'skip_task'; task: string; reason?: string };

/**
 * What a call came to: `message` is written for the caller, a model included,
 * to act on. `id` is the queued message's id for `message_task`, the value the
 * surface's button already answered with.
 */
export type CommandOutcome =
  | { ok: true; message: string; id?: string }
  | { ok: false; outcome: 'refused' | 'declined'; message: string };

/** What the seam does with a valid command: run it, ask the user first, or refuse with a note the caller can act on. */
export type Consent = { kind: 'allow' } | { kind: 'ask' } | { kind: 'refuse'; reason: string };

/**
 * What a supervisor at `level` may do. The mandate (#23) replaces this check;
 * nothing above it moves.
 */
export type SupervisorPolicy = (level: SupervisorLevel, command: ExecutionCommandName) => Consent;

/**
 * The supervisor levels (ADR-0029). Off: it does not act. Watch: it reads and
 * suggests, and every execution command it calls is refused. Act: every
 * command runs without asking — choosing Act is the consent — inside the loop
 * guards; what a command may never do, like allowing an approval, is still
 * refused by the command itself.
 */
export const SUPERVISOR_LEVELS: SupervisorPolicy = (level) => {
  switch (level) {
    case 'act': return { kind: 'allow' };
    case 'watch': return { kind: 'refuse', reason: 'You are the supervisor at Watch: you read and suggest, and cannot run, stop, retry, skip or message tasks, answer approvals or merge. Suggest it to the user instead; their reply is an ordinary message, and you can do it then.' };
    case 'off': return { kind: 'refuse', reason: 'The supervisor is off for this run, so it cannot act. Suggest it to the user instead.' };
  }
};

/**
 * A check that stops an actor spinning (ADR-0029's loop guards): the trip —
 * the note naming the guard and what would be accepted, and what the user is
 * told — or null to let the call through. Run once the call is valid and
 * consented to, before anyone is asked.
 */
export type LoopGuard = (actor: ExecutionActor, command: ExecutionCommand, target: GuardTarget | undefined) => GuardTrip | null;

/** A runner request waiting on a task, as the caller is shown it. */
export interface WaitingRequest {
  id: string;
  subject: string;
}

/**
 * What the seam reads and calls. The Session supplies it from its own public
 * operations, the ones the surfaces' buttons call, so a command lands exactly
 * as the matching button press does.
 */
export interface ExecutionHost {
  /** The plan's task tree; null when there is no plan. */
  tasks(): readonly Task[] | null;
  /** The user approved the whole plan by executing it. */
  planApproved(): boolean;
  /** The user approved this task: it was in the plan they executed, or they started it themselves. */
  taskApproved(taskId: string): boolean;
  /** A start the user consented to approves these tasks, before it acts. */
  approve(taskIds: readonly string[]): void;
  /** Full autonomy: starts follow plan approval without a question. */
  autonomous(): boolean;
  /** The user's autorun setting, as it is now (ADR-0030). */
  autorun(): boolean;
  /** The scheduler is driving the plan: ready tasks start as slots free. */
  scheduling(): boolean;
  /** An open planner turn holds the scheduler's new starts until its reply ends. */
  startsHeld(): boolean;
  /** Work is running right now. */
  hasLiveWork(): boolean;
  /** Something will start without being asked again: a start admitted and not yet claimed, or a scheduled resume. */
  startsPending(): boolean;
  /** Admit a start that waits before it claims; see {@link StartAdmission}. */
  admitStart(): StartAdmission;
  /** The task's attempt is live: starting, running or landing. */
  running(taskId: string): boolean;
  maxParallel(): number;
  /** The run waits on the user to stash or skip isolation before anything starts. */
  runBlocked(): boolean;
  /** The tasks a task's dependencies still hold it back for: unmet dependencies, or the unfinished work behind a skipped one. */
  unmetDependencies(task: Readonly<Task>): string[];
  /** The ancestors a task would wait on at its merge gate if it started now, whatever its status (ADR-0020). */
  mergeGate(taskId: string): string[];
  /** The failed tasks a task not started waits on through its dependencies (ADR-0034). */
  blockedBy(taskId: string): string[];
  /** The runner requests waiting on a task for an answer. */
  waitingRequests(taskId: string): readonly WaitingRequest[];
  /** A start is told who asked: whether a run it opens continues the last one depends on it (ADR-0029). */
  runPlan(actor: ExecutionActor): Promise<void>;
  startTask(taskId: string, actor: ExecutionActor): Promise<void>;
  stopTask(taskId: string): Promise<void>;
  stopRun(): void;
  retryTask(taskId: string, actor: ExecutionActor): Promise<void>;
  /** End the task as skipped, landing nothing of it; see {@link TaskOrchestrator.skipTask}. */
  skipTask(taskId: string, reason: string | undefined, actor: ExecutionActor): Promise<void>;
  continueTask(taskId: string, message: string, actor: ExecutionActor): Promise<void>;
  /** Resume a task paused on a usage limit now; see {@link TaskOrchestrator.resumeNow}. */
  resumeNow(taskId: string, message: string | undefined, actor: ExecutionActor): Promise<void>;
  messageTask(taskId: string, text: string): string;
  denyRequest(requestId: string, note?: string): boolean;
  /** Merge all, through the queue landings and the user's Merge all share. */
  mergeAll(): Promise<IsolationMergeResult>;
  /** Keep the call in the timeline, worded as `text`. */
  record(record: ExecutionRecord, text: string): void;
  /** A loop guard stopped a call: the user is told, as the supervisor's message. */
  guardTripped(trip: GuardTrip): void;
  /**
   * The open planner turn holds an edit — to this task, or to any when none is
   * named — that lands only when its reply ends.
   */
  heldEdit(taskId?: string): boolean;
  /** The plan's task tree as the open turn's held edit leaves it: as it is, when it holds none or one that would not apply. */
  editedTasks(): readonly Task[];
  /** The id of the task the open turn's held edit makes under this batch handle; undefined when it names none. */
  heldHandle(name: string): string | undefined;
  /**
   * Run the command again, as the same actor, once the open turn's reply has
   * landed its edit; `intent` names it if it never does. `admission` is
   * released once it has run or been dropped.
   */
  deferUntilLanded(command: ExecutionCommand, actor: ExecutionActor, intent: string, admission: StartAdmission): void;
  /** A command deferred behind an edit did not run once the edit landed: the user is told, and so is the planner's next turn. */
  queuedNotRun(text: string): void;
}

export interface ExecutionCommandsDeps {
  host: ExecutionHost;
  /** The approval card channel a Guarded start asks through. */
  consent: Pick<IApproval, 'request'>;
  supervisor?: SupervisorPolicy;
  guards?: readonly LoopGuard[];
  now?: () => string;
}

/** Commands that start work: they need the user's approval of what they start, and ask in Guarded. */
const STARTS: ReadonlySet<ExecutionCommandName> = new Set(['run_plan', 'run_task', 'retry_task']);

const MERGE_IS_USERS = 'Merge all is the user\'s: they are in this conversation, and press Merge all themselves. Tell them the work is ready to merge.';

const SKIP_IS_USERS = 'Skipping a task is the user\'s in their own turn: they are in this conversation, and skip it themselves. Suggest it, with why; only the supervisor at Act skips, in a wake-up turn.';

const NEVER_ALLOWS = 'answer_approval never allows. A runner asks because its mode did not cover the request, and allowing it would widen the mode the plan gave the task. Deny it with a note saying what to do instead, or escalate it to the user.';

interface Located {
  task: Task;
  ref: string;
  /** Paused on its runner's usage limit as the call arrived: a continue of it is a resume, worded as one once it has run. */
  paused: boolean;
}

interface Acted {
  message: string;
  id?: string;
}

/**
 * `approves`: the tasks the start runs that the user has not approved, which
 * a Guarded planner start in their turn asks them to approve rather than
 * being refused for. `act` is told whether a Stop came since the call was
 * admitted, for a start that goes on after an await of its own.
 */
type Prepared = { refusal: string } | { act: (stopped: () => boolean) => Promise<Acted>; approves?: Located[] };

/**
 * The command seam (ADR-0029, #91): the one place an execution action from
 * anyone but a button reaches the scheduler. It resolves the task, checks the
 * call against the plan's state, who asked and the user's approval, asks the
 * user where consent needs a person, runs the Session operation the matching
 * button runs, and records the call in the timeline with who asked. A refusal
 * names the task and the reason, worded for a model to act on.
 */
export class ExecutionCommands {
  private readonly host: ExecutionHost;
  private readonly supervisor: SupervisorPolicy;
  private readonly guards: readonly LoopGuard[];
  private readonly now: () => string;

  constructor(private readonly deps: ExecutionCommandsDeps) {
    this.host = deps.host;
    this.supervisor = deps.supervisor ?? SUPERVISOR_LEVELS;
    this.guards = deps.guards ?? [];
    this.now = deps.now ?? (() => new Date().toISOString());
  }

  /**
   * `admitted`: a deferred start's admission, taken as it was queued, which
   * its owner releases; a start asked for now takes its own.
   */
  async run(asked: ExecutionCommand, actor: ExecutionActor, admitted?: StartAdmission): Promise<CommandOutcome> {
    if (!this.host.tasks()) return { ok: false, outcome: 'refused', message: 'There is no plan yet, so there is nothing to run or stop.' };
    const located = 'task' in asked ? this.locate(asked.task) : undefined;
    // A start queued before the user's Stop is what the Stop withdrew, whatever else has changed since.
    if (admitted && !admitted.current()) return this.refuse(asked, actor, located, STOPPED_BEFORE_START);
    // A paused task has no turn to message: what is sent to it resumes it, and is consented to, guarded and recorded as that resume.
    const command: ExecutionCommand = asked.command === 'message_task' && located?.paused
      ? { command: 'retry_task', task: asked.task, from: 'session', message: asked.text }
      : asked;
    const consent = this.consent(actor, command.command);
    if ('task' in command && !located) {
      const missing = `No task matches "${command.task}" in the current plan.`;
      const naming = 'Name it by id, "#order" (a subtask "#order.sub") or exact title.';
      if (actor.kind === 'user' || !this.host.heldEdit()) return this.refuse(command, actor, undefined, `${missing} ${naming}`);
      // The turn's own edit may be adding it: a start the user is asked for, or one under the autorun exception, waits for it, as a start of an edited task does.
      if (startsFromPrompt(command) && (this.addedMayStart(actor) || this.asksToApprove(actor))) {
        return this.locateAsEdited(command.task)
          ? this.judgeAsEdited(command, actor, undefined, consent)
          : this.refuse(command, actor, undefined, `${missing} Your edit does not add it either. ${naming}`);
      }
      // A task the turn's own edit adds is not in the plan until the reply ends, and nothing then starts it on the turn's behalf.
      return this.refuse(command, actor, undefined, command.command === 'skip_task'
        ? `${missing} If your edit adds it, a task you add in this reply cannot be skipped in it: leave it out of the edit instead.`
        : `${missing} If your edit adds it, it lands as this reply ends, so it cannot start in this turn: tell the user, who starts it.`);
    }

    if (consent.kind === 'refuse') return this.refuse(command, actor, located, consent.reason);
    // The plan holds what runs (ADR-0029): a start the turn's own held edit changes waits for that edit to land.
    if (actor.kind !== 'user' && startsFromPrompt(command) && this.host.heldEdit(located?.task.id)) {
      return this.judgeAsEdited(command, actor, located, consent);
    }

    const first = this.prepare(command, actor, located);
    if ('refusal' in first) return this.refuse(command, actor, located, first.refusal);
    const tripped = this.tripped(command, actor, located);
    if (tripped) return tripped;

    // A start counts as live work for Stop until it has acted — on the card, and while it starts (ADR-0029).
    const admission = admitted ?? (STARTS.has(command.command) ? this.host.admitStart() : null);
    try {
      return await this.carryOut(command, actor, located, consent, first, admission);
    } finally {
      if (!admitted) admission?.release();
    }
  }

  /** A valid, consented call, from the user's answer where one is needed to the act and its record. */
  private async carryOut(command: ExecutionCommand, actor: ExecutionActor, located: Located | undefined, consent: Consent, first: Extract<Prepared, { act: unknown }>, admission: StartAdmission | null): Promise<CommandOutcome> {
    const stopped = () => admission !== null && !admission.current();
    let prepared = first;
    if (consent.kind === 'ask') {
      const plan = this.host.tasks();
      const allowed = await this.deps.consent.request(this.question(command, actor, located, first.approves));
      // A Stop clears the card as it withdraws the start: a no it answered for the user is not theirs.
      if (stopped()) return this.refuse(command, actor, located, STOPPED_BEFORE_START);
      if (!allowed) {
        this.keep(command, actor, located, 'declined');
        return { ok: false, outcome: 'declined', message: `The user did not approve: ${this.intent(command, located)}. Do not ask again unless they say so.` };
      }
      // Answering took time: the plan, or the task's state, may have moved on.
      if (this.host.tasks() !== plan) return this.refuse(command, actor, located, 'The plan changed while the user was asked, so nothing was done.');
      const again = this.prepare(command, actor, located);
      if ('refusal' in again) return this.refuse(command, actor, located, again.refusal);
      prepared = again;
    }

    // Taken at the last check, before the start awaits anything: a planner edit landing while the spawn is
    // under way changes the plan, and the user consented to the plan as it was checked, not as it becomes.
    // Recorded before it acts too because the scheduler starts only approved tasks (ADR-0035), and a retry
    // or run it hands over is started by the scheduler.
    this.host.approve(this.consented(command, actor, located, prepared.approves));
    let acted: Acted;
    try {
      acted = await prepared.act(stopped);
    } catch (err) {
      return this.refuse(command, actor, located, err instanceof Error ? err.message : String(err));
    }
    this.keep(command, actor, located, 'done', doneDetail(command));
    return { ok: true, message: acted.message, ...(acted.id !== undefined ? { id: acted.id } : {}) };
  }

  /**
   * A command deferred behind the turn's edit, run now that the edit landed.
   * Nobody reads its answer, so one that does not run is kept as refused and
   * said, to the user and to the planner's next turn.
   */
  async replay(command: ExecutionCommand, actor: ExecutionActor, admission: StartAdmission): Promise<void> {
    const located = 'task' in command ? this.locate(command.task) : undefined;
    let outcome: CommandOutcome;
    try {
      outcome = await this.run(command, actor, admission);
    } catch (err) {
      outcome = this.refuse(command, actor, located, err instanceof Error ? err.message : String(err));
    }
    if (outcome.ok || outcome.outcome !== 'refused') return;
    this.host.queuedNotRun(admission.current()
      ? `The queued ${queued(command, located)} did not run: ${outcome.message}`
      : `Not done: the queued ${queued(command, located)} was stopped before it could start.`);
  }

  /**
   * A start that waits for the turn's edit is judged now, against the plan as
   * that edit leaves it — the edit counts as the change a retry needs — so one
   * that could never run is refused while the caller still reads the answer,
   * and one the user will be asked about says so. `located` is the task as the
   * plan has it now, absent for a task the edit adds.
   */
  private judgeAsEdited(command: ExecutionCommand, actor: ExecutionActor, located: Located | undefined, consent: Consent): CommandOutcome {
    const tasks = this.host.editedTasks();
    const asEdited = located ? this.located(located.task.id, tasks) : 'task' in command ? this.locateAsEdited(command.task, tasks) : undefined;
    if (located && !asEdited) return this.refuse(command, actor, located, `${capitalize(describe(located))} is removed by your edit, so it cannot start.`);
    const prepared = this.prepare(command, actor, asEdited, tasks);
    if ('refusal' in prepared) return this.refuse(command, actor, located, prepared.refusal);
    // Named by id once the edit lands: a handle is the edit's alone, and an order or title may be what the edit changes.
    const pinned = 'task' in command && asEdited ? { ...command, task: asEdited.task.id } : command;
    return this.tripped(command, actor, asEdited) ?? this.defer(pinned, actor, asEdited, consent.kind === 'ask' ? prepared.approves ?? [] : null);
  }

  private tripped(command: ExecutionCommand, actor: ExecutionActor, located: Located | undefined): CommandOutcome | null {
    for (const guard of this.guards) {
      const trip = guard(actor, command, located);
      if (!trip) continue;
      const refused = this.refuse(command, actor, located, trip.refusal);
      this.host.guardTripped(trip);
      return refused;
    }
    return null;
  }

  /** `approves` is null for a start that runs without asking, else what the user's yes would approve. */
  private defer(command: ExecutionCommand, actor: ExecutionActor, located: Located | undefined, approves: readonly Located[] | null): CommandOutcome {
    const intent = this.intent(command, located);
    this.host.deferUntilLanded(command, actor, intent, this.host.admitStart());
    return {
      ok: true,
      message: approves
        ? `Queued: once your edit lands, as this reply ends, the user is asked on the approval card ${asking(command, intent, approves)}. Say so in your reply; you are not told what they answer.`
        : `Queued: ${intent} happens once your edit lands, as this reply ends, so it runs as edited. Say so in your reply; you are not told how it goes.`,
    };
  }

  /**
   * The tasks a start approves, read from the plan as it stands at the
   * command's last check. Autorun starts a plan as the user's standing
   * instruction, so its start approves what it runs as the user's does; so
   * does a start under its exception for added tasks. A yes on the card
   * approves the tasks the card named, and no others.
   */
  private consented(command: ExecutionCommand, actor: ExecutionActor, located: Located | undefined, named: readonly Located[] = []): string[] {
    if (!STARTS.has(command.command)) return [];
    if (this.asksToApprove(actor)) return named.flatMap(({ task }) => withSubtasks(task));
    if (actor.kind !== 'user' && actor.kind !== 'autorun' && !this.addedMayStart(actor)) return [];
    return located ? withSubtasks(located.task) : this.all().map(({ task }) => task.id);
  }

  /**
   * With autorun on and Full, a planner turn may start a task added after the
   * user approved the plan (ADR-0030). Read at each start, so switching either
   * off stops it at once; never on a plan the user has not approved.
   */
  private addedMayStart(actor: ExecutionActor): boolean {
    return actor.kind === 'planner-turn' && this.host.autorun() && this.host.autonomous() && this.host.planApproved();
  }

  /**
   * Guarded means "ask the user first": a planner start in the user's own
   * turn asks, so tasks they have not approved go into the question rather
   * than refusing it. The supervisor's starts stay within what the user
   * approved (ADR-0029).
   */
  private asksToApprove(actor: ExecutionActor): boolean {
    return actor.kind === 'planner-turn' && this.consent(actor, 'run_task').kind === 'ask';
  }

  /**
   * Who may do what without the mandate (#23): the user's own call needs no
   * consent; a planner turn may always end or steer work, and starts it only
   * as the autonomy level says; the supervisor's level decides for it.
   */
  private consent(actor: ExecutionActor, command: ExecutionCommandName): Consent {
    switch (actor.kind) {
      case 'user':
      case 'autorun': return { kind: 'allow' };
      // A merge by proxy would add a route to the user's branch for nothing: they are present, and can press it (ADR-0029).
      case 'planner-turn': if (command === 'merge_all') return { kind: 'refuse', reason: MERGE_IS_USERS };
        // Skip decides that work will not be waited for: the user decides that, or a supervisor they let act.
        if (command === 'skip_task') return { kind: 'refuse', reason: SKIP_IS_USERS };
        return !STARTS.has(command) || this.host.autonomous() ? { kind: 'allow' } : { kind: 'ask' };
      case 'supervisor': return this.supervisor(actor.level, command);
    }
  }

  /**
   * Whether the command can run now, and how, judged against `tasks`: the
   * plan, or the plan as the turn's held edit leaves it. Read afresh after a
   * question, since answering takes time.
   */
  private prepare(command: ExecutionCommand, actor: ExecutionActor, located: Located | undefined, tasks: readonly Task[] = this.host.tasks() ?? []): Prepared {
    switch (command.command) {
      case 'run_plan': return this.prepareRunPlan(actor, tasks);
      case 'run_task': return this.prepareStart(located!, actor, 'run', tasks);
      case 'retry_task': return command.from === 'fresh'
        ? this.prepareStart(located!, actor, 'retry', tasks)
        : located!.paused ? this.prepareResume(located!, actor, command.message) : this.prepareContinue(located!, actor, command.message);
      case 'stop_task': return this.prepareStop(located!);
      case 'stop_run': return this.prepareStopRun();
      case 'message_task': return this.prepareMessage(located!, command.text);
      case 'answer_approval': return this.prepareAnswer(located!, command);
      case 'merge_all': return this.prepareMergeAll();
      case 'skip_task': return this.prepareSkip(located!, actor, command.reason);
    }
  }

  private prepareRunPlan(actor: ExecutionActor, tasks: readonly Task[]): Prepared {
    const all = this.all(tasks);
    const live = all.filter(({ task }) => this.host.running(task.id));
    if (this.host.hasLiveWork()) {
      return { refusal: `The plan is already running (${named(live)} ${live.length === 1 ? 'is' : 'are'} running). Start one more ready task with run_task, or wait.` };
    }
    // A new run leaves a skipped task skipped, as it leaves a completed one done.
    const toRun = all.filter(({ task }) => task.type === 'ai' && task.status !== 'completed' && task.status !== 'skipped');
    if (toRun.length === 0) return { refusal: 'Every task has already completed: there is nothing left to run.' };
    let approves: Located[] = [];
    // Autorun is the user's standing instruction: its run is the user's approval, as Execute plan is.
    if (actor.kind !== 'user' && actor.kind !== 'autorun') {
      // Executing the plan is how the user first takes it as theirs, so no card stands in for it.
      if (!this.host.planApproved()) {
        return { refusal: 'The user has not approved this plan yet: they approve it by executing it themselves (Execute plan). Ask them to.' };
      }
      approves = this.addedMayStart(actor) ? [] : toRun.filter(({ task }) => !this.host.taskApproved(task.id));
      if (approves.length > 0 && !this.asksToApprove(actor)) {
        const one = approves.length === 1;
        return { refusal: `${capitalize(named(approves))} ${one ? 'was' : 'were'} added after the user approved the plan, so ${one ? 'it is' : 'they are'} not approved to run. Ask the user to execute the plan themselves, which approves ${one ? 'it' : 'them'}.` };
      }
    }
    return {
      ...(approves.length > 0 ? { approves } : {}),
      act: async () => {
        await this.host.runPlan(actor);
        if (this.host.runBlocked()) return { message: BLOCKED_RUN };
        const started = this.all().filter(({ task }) => this.host.running(task.id));
        if (started.length > 0) return { message: `The plan is running: ${named(started)} started, and the rest start as their dependencies finish.` };
        return {
          message: this.host.startsHeld()
            ? 'The plan is running: what is ready starts once this reply ends, and the rest as their dependencies finish.'
            : 'The plan is running; nothing could start yet. Read the plan to see what each task waits on.',
        };
      },
    };
  }

  /** A start of one task: `run_task`, or a fresh `retry_task`, which also takes a task that failed or waits on the user. */
  private prepareStart(located: Located, actor: ExecutionActor, how: 'run' | 'retry', tasks: readonly Task[]): Prepared {
    const { task } = located;
    const label = describe(located);
    if (task.type === 'user') return { refusal: `${capitalize(label)} is a user task: the user does it by hand, and no runner starts it.` };
    if (this.host.running(task.id) || task.status === 'in_progress') {
      return { refusal: how === 'run' ? `${capitalize(label)} is already running.` : `${capitalize(label)} is running: stop it first with stop_task, or steer it with message_task.` };
    }
    if (task.status === 'completed') {
      return { refusal: `${capitalize(label)} has already completed. Continue it with retry_task from "session" and a message, or ask the user to mark it not done.` };
    }
    const skipped = this.skippedRefusal(located, actor);
    if (skipped) return { refusal: skipped };
    const settled = task.status === 'failed' || task.status === 'awaiting_user' || task.status === 'skipped';
    if (how === 'run' && settled) {
      const next = task.status === 'awaiting_user' && task.awaitingReason === 'input'
        ? 'Answer it with message_task, or start a new attempt with retry_task.'
        : located.paused ? 'Resume it in its saved session with retry_task from "session".' : 'Start a new attempt with retry_task.';
      return { refusal: `${capitalize(label)} ${statusWords(task)}. ${next}` };
    }
    const failed = this.host.blockedBy(task.id).flatMap((id) => this.located(id, tasks) ?? []);
    if (task.status === 'blocked' || failed.length > 0) {
      return { refusal: `${capitalize(label)} is blocked${failed.length > 0 ? `: ${named(failed)} failed. Retry ${failed.length === 1 ? 'it' : 'them'} first` : '. Ask the user to skip it or fix what blocks it'}.` };
    }
    const approval = this.unapproved(located, actor);
    if (approval && 'refusal' in approval) return approval;

    const unmet = this.host.unmetDependencies(task).flatMap((id) => this.located(id, tasks) ?? []);
    if (unmet.length > 0) {
      const one = unmet.length === 1;
      // Work reached through a skip is not a dependency the caller can see on the task.
      const behindSkip = unmet.some((dep) => !task.dependencies.includes(dep.task.id)) ? ': skipping a task does not skip the work behind it' : '';
      return { refusal: `${capitalize(label)} depends on ${unmet.map((dep) => `${describe(dep)} (${depState(dep.task)})`).join(', ')}, which ${one ? 'has' : 'have'} not finished${behindSkip}. It can start once ${one ? 'it has' : 'they have'}.` };
    }
    const gate = this.host.mergeGate(task.id).flatMap((id) => this.located(id, tasks) ?? []);
    if (gate.length > 0) {
      return { refusal: `${capitalize(label)} waits for Merge all: the work of ${named(gate)} is not merged into the user's branch yet. Ask the user to merge (Merge all), or to force start it.` };
    }
    // A retry under a running scheduler is left to it, as the Retry button leaves it, so only a start of our own takes a slot.
    const live = this.all(tasks).filter(({ task: t }) => this.host.running(t.id)).length;
    if (!(settled && this.host.scheduling()) && live >= this.host.maxParallel()) {
      return { refusal: `${live} tasks are already running, the most this session runs at once. Wait for one to finish, or stop one first.` };
    }

    return {
      ...approval,
      act: async (stopped) => {
        // The Retry button's own path: it continues a run that ended on a failure, and hands the task to a scheduler that runs.
        if (settled) await this.host.retryTask(task.id, actor);
        // A Stop while the retry let go of the old worktree withdrew the start that would follow it.
        if (stopped()) throw new Error(STOPPED_BEFORE_START);
        if (!this.host.running(task.id) && !(settled && this.host.scheduling())) await this.host.startTask(task.id, actor);
        if (this.host.runBlocked()) return { message: BLOCKED_RUN };
        const verb = how === 'run' ? 'Started' : 'Retrying';
        return {
          message: this.host.running(task.id)
            ? `${verb} ${label}.`
            : `${capitalize(label)} is back in the run and starts when a slot is free.`,
        };
      },
    };
  }

  private prepareContinue(located: Located, actor: ExecutionActor, message: string | undefined): Prepared {
    const { task } = located;
    const label = describe(located);
    if (this.host.running(task.id) || task.status === 'in_progress') {
      return { refusal: `${capitalize(label)} is running: stop it first with stop_task, or steer it with message_task.` };
    }
    const skipped = this.skippedRefusal(located, actor);
    if (skipped) return { refusal: skipped };
    const eligible = continuability(task);
    if (!eligible.ok) return { refusal: `${eligible.reason} A fresh retry (from "fresh") starts it over from its prompt.` };
    if (!message?.trim()) return { refusal: `Continuing ${label} in its saved session needs a message: what the runner should do next.` };
    const approval = this.unapproved(located, actor);
    if (approval && 'refusal' in approval) return approval;
    return {
      ...approval,
      act: async () => {
        await this.host.continueTask(task.id, message, actor);
        if (this.host.runBlocked()) return { message: BLOCKED_RUN };
        return { message: `Continuing ${label} in its saved session with your message.` };
      },
    };
  }

  /**
   * A pause is not a failure: the attempt stopped on its account's limit, so
   * its saved session goes on where it was, told the limit has reset. The
   * message is what to add to that; none is needed.
   */
  private prepareResume(located: Located, actor: ExecutionActor, message: string | undefined): Prepared {
    const { task } = located;
    const label = describe(located);
    const eligible = continuability(task);
    if (!eligible.ok) return { refusal: `${eligible.reason} A fresh retry (from "fresh") starts it over from its prompt.` };
    const approval = this.unapproved(located, actor);
    if (approval && 'refusal' in approval) return approval;
    const text = message?.trim();
    return {
      ...approval,
      act: async () => {
        await this.host.resumeNow(task.id, text || undefined, actor);
        if (this.host.runBlocked()) return { message: BLOCKED_RUN };
        return { message: `Resumed ${label} in its saved session${text ? ' with your message' : ''}.` };
      },
    };
  }

  private prepareStop(located: Located): Prepared {
    const { task } = located;
    const label = describe(located);
    if (!this.host.running(task.id) && task.status !== 'in_progress') {
      return { refusal: `${capitalize(label)} is not running (it ${statusWords(task)}): there is nothing to stop.` };
    }
    return {
      act: async () => {
        await this.host.stopTask(task.id);
        return { message: `Stopped ${label}: it is back to not started and held until it is retried, and its open approvals were denied.${task.ops ? ' A retry is told what this attempt did.' : ''}` };
      },
    };
  }

  private prepareStopRun(): Prepared {
    const live = this.all().filter(({ task }) => this.host.running(task.id));
    // A start admitted but not yet claimed would begin after a refused Stop, so it is a run to stop too.
    const pending = this.host.startsPending();
    if (!this.host.hasLiveWork() && !this.host.scheduling() && !pending) return { refusal: 'Nothing is running: there is no run to stop.' };
    return {
      act: async () => {
        this.host.stopRun();
        return {
          message: live.length > 0
            ? `Stopped the run: ${named(live)} ${live.length === 1 ? 'is' : 'are'} back to not started, and the plan is kept. Start again with run_plan or run_task.`
            : pending
              ? 'Stopped the run before anything more started: nothing was running, and what was about to start will not. The plan is kept.'
              : 'Stopped the run; nothing was running. The plan is kept.',
        };
      },
    };
  }

  private prepareMessage(located: Located, text: string): Prepared {
    const label = describe(located);
    return {
      act: async () => {
        const id = this.host.messageTask(located.task.id, text);
        return { message: `Sent to ${label}. The runner reads it at its next step, or when its turn ends.`, id };
      },
    };
  }

  private prepareAnswer(located: Located, command: Extract<ExecutionCommand, { command: 'answer_approval' }>): Prepared {
    const label = describe(located);
    const answer = command.answer.trim().toLowerCase();
    if (answer === 'allow' || answer === 'allowfortask') return { refusal: NEVER_ALLOWS };
    if (answer !== 'deny' && answer !== 'escalate') return { refusal: `"${command.answer}" is not an answer: use "deny" or "escalate".` };
    const waiting = this.host.waitingRequests(located.task.id);
    const listed = waiting.map((r) => `${r.id} (${r.subject})`).join('; ');
    if (waiting.length === 0) return { refusal: `${capitalize(label)} has no request waiting for an answer.` };
    const request = command.approval === undefined && waiting.length === 1 ? waiting[0] : waiting.find((r) => r.id === command.approval);
    if (!request) {
      return {
        refusal: command.approval === undefined
          ? `${capitalize(label)} has ${waiting.length} requests waiting: ${listed}. Name one with "approval".`
          : `No request "${command.approval}" waits on ${label}. Its requests: ${listed}.`,
      };
    }
    return {
      act: async () => {
        if (answer === 'escalate') return { message: `Left ${label}'s request (${request.subject}) for the user to answer. Tell them why in your reply.` };
        if (!this.host.denyRequest(request.id, command.note?.trim() || undefined)) throw new Error(`The request ${request.id} was answered meanwhile.`);
        return { message: `Denied ${label}'s request (${request.subject}).${command.note?.trim() ? ' The runner is given your note.' : ''}` };
      },
    };
  }

  private prepareMergeAll(): Prepared {
    return {
      act: async () => {
        const result = await this.host.mergeAll();
        if (result.outcome !== 'merged') throw new Error(`Merge all stopped: ${mergeStopped(result)}. Nothing was merged; tell the user, who resolves it.`);
        return { message: 'Merged the run\'s landed work into the user\'s branch. Tasks waiting at a merge gate for it can start.' };
      },
    };
  }

  /**
   * A skip is a decision not to wait for the task. Running it again undoes
   * that decision, so the supervisor leaves it to the user rather than going
   * round between the two.
   */
  private skippedRefusal(located: Located, actor: ExecutionActor): string | null {
    if (located.task.status !== 'skipped' || actor.kind !== 'supervisor') return null;
    return `${capitalize(describe(located))} was skipped: whether it runs again is the user's to decide. Tell them if it should.`;
  }

  /**
   * A skip ends a task without a verdict and lands nothing, so it never
   * vouches for work. Anyone but the user names why, and the supervisor only
   * gives up on a task that already needs someone: failed, blocked, or
   * waiting for input.
   */
  private prepareSkip(located: Located, actor: ExecutionActor, reason: string | undefined): Prepared {
    const { task } = located;
    const label = describe(located);
    const why = reason?.trim() || undefined;
    if (task.status === 'in_progress') return { refusal: `${capitalize(label)} is running: stop it first with stop_task, or let it finish.` };
    if (task.status === 'completed') return { refusal: `${capitalize(label)} has completed: its work landed, so there is nothing to skip.` };
    if (task.status === 'skipped') return { refusal: `${capitalize(label)} is already skipped.` };
    if (actor.kind !== 'user') {
      if (!why) return { refusal: `Skipping ${label} needs a reason: it is shown to the user and told to the tasks that depend on it.` };
      const waits = task.status === 'failed' || task.status === 'blocked' || task.status === 'awaiting_user' || this.host.blockedBy(task.id).length > 0;
      if (!waits) return { refusal: `${capitalize(label)} has not started and nothing blocks it: the supervisor skips only a task that failed, is blocked or is waiting for input.` };
    }
    return {
      act: async () => {
        await this.host.skipTask(task.id, why, actor);
        return { message: `Skipped ${label}: none of its work lands, and the tasks that depend on it go ahead without it once the work it waited on is done, told why.` };
      },
    };
  }

  /**
   * Why a start is not the user's to have made, or the task it asks them to
   * approve, or null: the user's own call is its own approval.
   */
  private unapproved(located: Located, actor: ExecutionActor): { refusal: string } | { approves: Located[] } | null {
    if (actor.kind === 'user' || actor.kind === 'autorun' || this.addedMayStart(actor) || this.host.taskApproved(located.task.id)) return null;
    const label = describe(located);
    if (!this.host.planApproved()) {
      return { refusal: `The user has not approved ${label}: they approve the plan by executing it themselves (Execute plan), or a task by starting it. Ask them to.` };
    }
    if (this.asksToApprove(actor)) return { approves: [located] };
    return { refusal: `${capitalize(label)} was added after the user approved the plan, so it is not approved to run. Ask the user to start it, or to execute the plan, which approves it.` };
  }

  /**
   * The Guarded question, on the card the user answers other planner requests
   * on. It names every task a yes approves, since a yes is the user's
   * approval of them as Execute plan would be.
   */
  private question(command: ExecutionCommand, actor: ExecutionActor, located: Located | undefined, approves: readonly Located[] = []): ApprovalRequest {
    const subject = capitalize(this.intent(command, located));
    const how = located?.task.type === 'ai'
      ? ` It runs on ${located.task.assignedRunner}${located.task.taskMode ? ` in ${located.task.taskMode} mode` : ''}, as the plan set it.`
      : ' Each task runs on its runner, in the mode the plan set.';
    const one = approves.length === 1;
    const approving = approves.length === 0 ? '' : command.command === 'run_plan'
      ? ` Allowing approves ${named(approves)}, added since you approved the plan, and starts ${one ? 'it' : 'them'} with the rest.`
      : ` Allowing approves ${named(approves)}, added since you approved the plan.`;
    return {
      kind: 'task_start',
      perInvocation: true,
      subject,
      scope: subject,
      detail: `${actor.kind === 'supervisor' ? 'The supervisor' : 'The planner'} wants to start work.${approving}${how}`,
    };
  }

  /** What was asked, as "start task #4 "Title"". */
  private intent(command: ExecutionCommand, located: Located | undefined): string {
    const label = located ? describe(located) : 'task' in command ? `"${command.task}"` : '';
    switch (command.command) {
      case 'run_plan': return 'run the plan';
      case 'run_task': return `start ${label}`;
      case 'retry_task': return command.from === 'fresh' ? `retry ${label}` : `${located?.paused ? 'resume' : 'continue'} ${label} in its saved session`;
      case 'stop_task': return `stop ${label}`;
      case 'stop_run': return 'stop the run';
      case 'message_task': return `message ${label}`;
      case 'answer_approval': return `answer ${label}'s request`;
      case 'merge_all': return 'merge all';
      case 'skip_task': return `skip ${label}`;
    }
  }

  private refuse(command: ExecutionCommand, actor: ExecutionActor, located: Located | undefined, reason: string): CommandOutcome {
    this.keep(command, actor, located, 'refused', reason);
    return { ok: false, outcome: 'refused', message: reason };
  }

  private keep(command: ExecutionCommand, actor: ExecutionActor, located: Located | undefined, outcome: ExecutionRecord['outcome'], detail?: string): void {
    const record: ExecutionRecord = {
      command: command.command,
      actor: actor.kind,
      ...(actor.kind === 'supervisor' ? { level: actor.level } : {}),
      ...(located ? { task: { id: located.task.id, ref: located.ref, title: located.task.title } } : {}),
      outcome,
      ...(detail ? { detail } : {}),
      at: this.now(),
    };
    this.host.record(record, describeExecution(record, command, located?.paused));
  }

  private all(tasks: readonly Task[] = this.host.tasks() ?? []): Located[] {
    return flattenTasksWithParents(tasks).map(({ task, ref }) => ({ task, ref, paused: pausedOnLimit(task) }));
  }

  private located(id: string, tasks?: readonly Task[]): Located | undefined {
    return this.all(tasks).find(({ task }) => task.id === id);
  }

  /** A reference read against the plan as the held edit leaves it, where the handles its batch gives come first. */
  private locateAsEdited(ref: string, tasks: readonly Task[] = this.host.editedTasks()): Located | undefined {
    const id = this.host.heldHandle(ref.trim());
    return id ? this.located(id, tasks) : this.locate(ref, tasks);
  }

  /** A reference as a caller writes one — see {@link resolveTaskRef}. */
  private locate(ref: string, tasks: readonly Task[] = this.host.tasks() ?? []): Located | undefined {
    const task = resolveTaskRef(tasks, ref);
    return task && this.located(task.id, tasks);
  }
}

const BLOCKED_RUN = 'Nothing started: the user\'s checkout has uncommitted changes, and the run waits for them to stash them or run without isolation. Tell them.';

/** A deferred start as a noun: "retry of task #4 "Title"". */
function queued(command: ExecutionCommand, located: Located | undefined): string {
  const label = located ? describe(located) : 'task' in command ? `"${command.task}"` : '';
  switch (command.command) {
    case 'run_plan': return 'run of the plan';
    case 'retry_task': return command.from === 'session' ? `continuation of ${label}` : `retry of ${label}`;
    default: return `start of ${label}`;
  }
}

/** What a Guarded start asks the user: "to approve and start task #2 "A", and run the plan". */
function asking(command: ExecutionCommand, intent: string, approves: readonly Located[]): string {
  if (approves.length === 0) return `to ${intent}`;
  return command.command === 'run_plan' ? `to approve and start ${named(approves)}, and run the plan` : `to ${intent}, which approves it`;
}

/** A command that starts work from the task's prompt as the plan holds it. A continue starts from its message instead. */
function startsFromPrompt(command: ExecutionCommand): boolean {
  return command.command === 'run_plan' || command.command === 'run_task' || (command.command === 'retry_task' && command.from === 'fresh');
}

function withSubtasks(task: Readonly<Task>): string[] {
  return [task.id, ...task.subtasks.flatMap(withSubtasks)];
}

function describe({ task, ref }: Located): string {
  return `task ${ref} "${task.title}"`;
}

function named(tasks: readonly Located[]): string {
  const labels = tasks.map(describe);
  return labels.length < 2 ? labels.join('') : `${labels.slice(0, -1).join(', ')} and ${labels[labels.length - 1]}`;
}

function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

const STATUS_WORDS: Record<TaskStatus, string> = {
  pending: 'has not started',
  approved: 'has not started',
  in_progress: 'is running',
  completed: 'has completed',
  failed: 'failed',
  blocked: 'is blocked',
  awaiting_user: 'is waiting for the user',
  skipped: 'was skipped',
};

function statusWords(task: Readonly<Task>): string {
  if (task.status === 'awaiting_user' && task.awaitingReason === 'input') return 'is waiting for input';
  if (task.status === 'awaiting_user' && task.awaitingReason === 'checkpoint') return 'is waiting at a checkpoint for the user';
  if (pausedOnLimit(task)) return 'is paused on its runner\'s usage limit';
  return STATUS_WORDS[task.status];
}

/** Why a dependency does not count as finished yet; a completed one is done but its work has not landed. */
function depState(task: Readonly<Task>): string {
  return task.status === 'completed' ? 'done, not landed yet' : statusWords(task).replace(/^(is|has) /, '');
}

/** The extra a record keeps for a call that went through: the message it sent, or the note a denial carried. */
function doneDetail(command: ExecutionCommand): string | undefined {
  if (command.command === 'message_task') return command.text;
  if (command.command === 'retry_task' && command.from === 'session') return command.message;
  if (command.command === 'answer_approval') return command.note?.trim() || undefined;
  if (command.command === 'skip_task') return command.reason?.trim() || undefined;
  return undefined;
}

const WHO: Record<ExecutionActor['kind'], string> = {
  user: 'You',
  'planner-turn': 'The planner',
  supervisor: 'The supervisor',
  autorun: 'Autorun',
};

/** The timeline's line for one call: who asked, what, and how it ended. */
function describeExecution(record: ExecutionRecord, command?: ExecutionCommand, paused = false): string {
  const who = WHO[record.actor];
  // A refusal for a task the plan does not have names it as the caller did.
  const label = record.task ? `task ${record.task.ref} "${record.task.title}"` : command && 'task' in command ? `"${command.task}"` : '';
  const continued = command?.command === 'retry_task' && command.from === 'session' ? (paused ? 'resume' : 'continue') : null;
  const escalated = command?.command === 'answer_approval' && command.answer.trim().toLowerCase() === 'escalate';
  if (record.outcome !== 'done') {
    const asked = {
      run_plan: 'run the plan',
      run_task: `start ${label}`,
      retry_task: continued ? `${continued} ${label}` : `retry ${label}`,
      stop_task: `stop ${label}`,
      stop_run: 'stop the run',
      message_task: `message ${label}`,
      answer_approval: `answer a request of ${label}`,
      merge_all: 'merge all',
      skip_task: `skip ${label}`,
    }[record.command];
    return record.outcome === 'declined'
      ? `${who} asked to ${asked}; you declined.`
      : `${who} asked to ${asked}; refused: ${record.detail ?? 'no reason given'}`;
  }
  const { action, tail } = doneWords(record, label, continued, escalated);
  // The supervisor and autorun act unattended, so their line reads as the action itself — the button press — and then who pressed it.
  return record.actor === 'supervisor' || record.actor === 'autorun'
    ? `${capitalize(action)}: by ${record.actor}${tail.startsWith(' ') ? `,${tail}` : tail}`
    : `${who} ${action}${tail}`;
}

/** What a call that went through did, and what follows it in the line: a full stop, the quoted message, or the note. */
function doneWords(record: ExecutionRecord, label: string, continued: 'resume' | 'continue' | null, escalated: boolean): { action: string; tail: string } {
  const quoted = record.detail ? `: "${record.detail}"` : '.';
  switch (record.command) {
    case 'run_plan': return { action: 'started the plan', tail: '.' };
    case 'run_task': return { action: `started ${label}`, tail: '.' };
    case 'retry_task': return continued ? { action: `${continued}d ${label} in its saved session`, tail: quoted } : { action: `retried ${label}`, tail: '.' };
    case 'stop_task': return { action: `stopped ${label}`, tail: '.' };
    case 'stop_run': return { action: 'stopped the run', tail: '.' };
    case 'message_task': return { action: `sent ${label} a message`, tail: quoted };
    case 'answer_approval': return escalated
      ? { action: `left a request of ${label} for you to answer`, tail: '.' }
      : { action: `denied a request of ${label}`, tail: record.detail ? ` with the note "${record.detail}".` : '.' };
    case 'merge_all': return { action: 'merged the run\'s work into your branch', tail: '.' };
    case 'skip_task': return { action: `skipped ${label}`, tail: quoted };
  }
}

/** How a Merge all ended, in a clause: why it stopped, for a model or a run update to read. */
export function mergeStopped(result: IsolationMergeResult): string {
  switch (result.outcome) {
    case 'merged': return 'it merged';
    case 'blocked': {
      const off = result.blocked.filter((b) => b.reason === 'wrong-branch');
      if (off.length === 0) return 'the user\'s checkout has changes that overlap what it would merge';
      return off.map((b) => `${b.repo === '.' ? 'the checkout' : b.repo} is ${b.actual ? `on ${b.actual}` : 'on a detached HEAD'}, not ${b.expected}, which the run started on`).join('; ');
    }
    case 'conflict': return `it conflicts in ${result.repo}${result.files?.length ? `: ${result.files.slice(0, 5).join(', ')}` : ''}`;
    case 'failed': return `it failed in ${result.repo}`;
  }
}
