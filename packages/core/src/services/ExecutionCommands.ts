import { flattenTasksWithParents, resolveOrderLabel, taskRef, type Task, type TaskStatus } from '../models/Task';
import type { ExecutionActor, ExecutionCommandName, ExecutionRecord, SupervisorLevel } from '../models/Execution';
import type { ApprovalRequest, IApproval } from '../interfaces/IApproval';
import type { IsolationMergeResult } from '../interfaces/IWorktreeIsolation';
import { continuability } from './continuation';
import type { GuardTarget, GuardTrip } from './LoopGuards';

/** One call at the command seam, as every route words it (ADR-0029). Task references are resolved here. */
export type ExecutionCommand =
  | { command: 'run_plan' }
  | { command: 'run_task'; task: string }
  | { command: 'stop_task'; task: string }
  | { command: 'stop_run' }
  /** `session`: continue the saved runner session with `message` (ADR-0018, K1); `fresh`: a new attempt from the task's prompt. */
  | { command: 'retry_task'; task: string; from: 'fresh' | 'session'; message?: string }
  | { command: 'message_task'; task: string; text: string }
  /** `answer` is checked here rather than typed: an `allow` must reach the seam to be refused with its reason. */
  | { command: 'answer_approval'; task: string; approval?: string; answer: string; note?: string }
  /** Merge all: the run's landed work into the user's branch (ADR-0013). */
  | { command: 'merge_all' };

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
    case 'watch': return { kind: 'refuse', reason: 'You are the supervisor at Watch: you read and suggest, and cannot run, stop, retry or message tasks, answer approvals or merge. Suggest it to the user instead; their reply is an ordinary message, and you can do it then.' };
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
  /** A command of the user's own approves what it starts. */
  approve(taskIds: readonly string[]): void;
  /** Full autonomy: starts follow plan approval without a question. */
  autonomous(): boolean;
  /** The scheduler is driving the plan: ready tasks start as slots free. */
  scheduling(): boolean;
  /** Work is running right now. */
  hasLiveWork(): boolean;
  /** The task's attempt is live: starting, running or landing. */
  running(taskId: string): boolean;
  maxParallel(): number;
  /** The run waits on the user to stash or skip isolation before anything starts. */
  runBlocked(): boolean;
  /** A dependency is met once its work is where the dependent will run. */
  dependencyMet(depId: string): boolean;
  /** The dependencies a task waits on at its merge gate (ADR-0020). */
  mergeGate(taskId: string): string[];
  /** The runner requests waiting on a task for an answer. */
  waitingRequests(taskId: string): readonly WaitingRequest[];
  runPlan(): Promise<void>;
  startTask(taskId: string): Promise<void>;
  stopTask(taskId: string): Promise<void>;
  stopRun(): void;
  retryTask(taskId: string): Promise<void>;
  continueTask(taskId: string, message: string): Promise<void>;
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
  /** Run the command again, as the same actor, once the open turn's reply has landed its edit. */
  deferUntilLanded(command: ExecutionCommand, actor: ExecutionActor): void;
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

const NEVER_ALLOWS = 'answer_approval never allows. A runner asks because its mode did not cover the request, and allowing it would widen the mode the plan gave the task. Deny it with a note saying what to do instead, or escalate it to the user.';

interface Located {
  task: Task;
  ref: string;
}

interface Acted {
  message: string;
  id?: string;
}

type Prepared = { refusal: string } | { act: () => Promise<Acted> };

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

  async run(command: ExecutionCommand, actor: ExecutionActor): Promise<CommandOutcome> {
    if (!this.host.tasks()) return { ok: false, outcome: 'refused', message: 'There is no plan yet, so there is nothing to run or stop.' };
    const located = 'task' in command ? this.locate(command.task) : undefined;
    if ('task' in command && !located) {
      return this.refuse(command, actor, undefined, `No task matches "${command.task}" in the current plan. Name it by id, "#order" or exact title.`);
    }

    const consent = this.consent(actor, command.command);
    if (consent.kind === 'refuse') return this.refuse(command, actor, located, consent.reason);
    // The plan holds what runs (ADR-0029): a start the turn's own held edit changes waits for that edit to land.
    if (actor.kind !== 'user' && startsFromPrompt(command) && this.host.heldEdit(located?.task.id)) {
      this.host.deferUntilLanded(command, actor);
      return { ok: true, message: `Queued: ${this.intent(command, located)} happens once your edit lands, as this reply ends, so it runs as edited. Say so in your reply; you are not told how it goes.` };
    }

    const first = this.prepare(command, actor, located);
    if ('refusal' in first) return this.refuse(command, actor, located, first.refusal);
    for (const guard of this.guards) {
      const trip = guard(actor, command, located);
      if (!trip) continue;
      const refused = this.refuse(command, actor, located, trip.refusal);
      this.host.guardTripped(trip);
      return refused;
    }

    let act = first.act;
    if (consent.kind === 'ask') {
      const plan = this.host.tasks();
      if (!(await this.deps.consent.request(this.question(command, actor, located)))) {
        this.keep(command, actor, located, 'declined');
        return { ok: false, outcome: 'declined', message: `The user did not approve: ${this.intent(command, located)}. Do not ask again unless they say so.` };
      }
      // Answering took time: the plan, or the task's state, may have moved on.
      if (this.host.tasks() !== plan) return this.refuse(command, actor, located, 'The plan changed while the user was asked, so nothing was done.');
      const again = this.prepare(command, actor, located);
      if ('refusal' in again) return this.refuse(command, actor, located, again.refusal);
      act = again.act;
    }

    let acted: Acted;
    try {
      acted = await act();
    } catch (err) {
      return this.refuse(command, actor, located, err instanceof Error ? err.message : String(err));
    }
    if (actor.kind === 'user' && STARTS.has(command.command)) {
      this.host.approve(located ? withSubtasks(located.task) : this.all().map(({ task }) => task.id));
    }
    this.keep(command, actor, located, 'done', doneDetail(command));
    return { ok: true, message: acted.message, ...(acted.id !== undefined ? { id: acted.id } : {}) };
  }

  /**
   * Who may do what without the mandate (#23): the user's own call needs no
   * consent; a planner turn may always end or steer work, and starts it only
   * as the autonomy level says; the supervisor's level decides for it.
   */
  private consent(actor: ExecutionActor, command: ExecutionCommandName): Consent {
    switch (actor.kind) {
      case 'user': return { kind: 'allow' };
      // A merge by proxy would add a route to the user's branch for nothing: they are present, and can press it (ADR-0029).
      case 'planner-turn': if (command === 'merge_all') return { kind: 'refuse', reason: MERGE_IS_USERS };
        return !STARTS.has(command) || this.host.autonomous() ? { kind: 'allow' } : { kind: 'ask' };
      case 'supervisor': return this.supervisor(actor.level, command);
    }
  }

  /** Whether the command can run now, and how. Read afresh after a question, since answering takes time. */
  private prepare(command: ExecutionCommand, actor: ExecutionActor, located: Located | undefined): Prepared {
    switch (command.command) {
      case 'run_plan': return this.prepareRunPlan(actor);
      case 'run_task': return this.prepareStart(located!, actor, 'run');
      case 'retry_task': return command.from === 'session'
        ? this.prepareContinue(located!, actor, command.message)
        : this.prepareStart(located!, actor, 'retry');
      case 'stop_task': return this.prepareStop(located!);
      case 'stop_run': return this.prepareStopRun();
      case 'message_task': return this.prepareMessage(located!, command.text);
      case 'answer_approval': return this.prepareAnswer(located!, command);
      case 'merge_all': return this.prepareMergeAll();
    }
  }

  private prepareRunPlan(actor: ExecutionActor): Prepared {
    const all = this.all();
    const live = all.filter(({ task }) => this.host.running(task.id));
    if (this.host.hasLiveWork()) {
      return { refusal: `The plan is already running (${named(live)} ${live.length === 1 ? 'is' : 'are'} running). Start one more ready task with run_task, or wait.` };
    }
    const toRun = all.filter(({ task }) => task.type === 'ai' && task.status !== 'completed');
    if (toRun.length === 0) return { refusal: 'Every task has already completed: there is nothing left to run.' };
    if (actor.kind !== 'user') {
      if (!this.host.planApproved()) {
        return { refusal: 'The user has not approved this plan yet: they approve it by executing it themselves (Execute plan). Ask them to.' };
      }
      const unapproved = toRun.filter(({ task }) => !this.host.taskApproved(task.id));
      if (unapproved.length > 0) {
        const one = unapproved.length === 1;
        return { refusal: `${capitalize(named(unapproved))} ${one ? 'was' : 'were'} added after the user approved the plan, so ${one ? 'it is' : 'they are'} not approved to run. Ask the user to execute the plan themselves, which approves ${one ? 'it' : 'them'}.` };
      }
    }
    return {
      act: async () => {
        await this.host.runPlan();
        if (this.host.runBlocked()) return { message: BLOCKED_RUN };
        const started = this.all().filter(({ task }) => this.host.running(task.id));
        return {
          message: started.length === 0
            ? 'The plan is running; nothing could start yet. Read the plan to see what each task waits on.'
            : `The plan is running: ${named(started)} started, and the rest start as their dependencies finish.`,
        };
      },
    };
  }

  /** A start of one task: `run_task`, or a fresh `retry_task`, which also takes a task that failed or waits on the user. */
  private prepareStart(located: Located, actor: ExecutionActor, how: 'run' | 'retry'): Prepared {
    const { task } = located;
    const label = describe(located);
    if (task.type === 'user') return { refusal: `${capitalize(label)} is a user task: the user does it by hand, and no runner starts it.` };
    if (this.host.running(task.id) || task.status === 'in_progress') {
      return { refusal: how === 'run' ? `${capitalize(label)} is already running.` : `${capitalize(label)} is running: stop it first with stop_task, or steer it with message_task.` };
    }
    if (task.status === 'completed') {
      return { refusal: `${capitalize(label)} has already completed. Continue it with retry_task from "session" and a message, or ask the user to mark it not done.` };
    }
    const settled = task.status === 'failed' || task.status === 'awaiting_user';
    if (how === 'run' && settled) {
      const next = task.status === 'awaiting_user' && task.awaitingReason === 'input'
        ? 'Answer it with message_task, or start a new attempt with retry_task.'
        : 'Start a new attempt with retry_task.';
      return { refusal: `${capitalize(label)} ${statusWords(task)}. ${next}` };
    }
    const failed = task.dependencies.flatMap((id) => this.located(id) ?? []).filter(({ task: dep }) => dep.status === 'failed');
    if (task.status === 'blocked' || failed.length > 0) {
      return { refusal: `${capitalize(label)} is blocked${failed.length > 0 ? `: ${named(failed)} failed. Retry ${failed.length === 1 ? 'it' : 'them'} first` : '. Ask the user to skip it or fix what blocks it'}.` };
    }
    const unapproved = this.unapproved(located, actor);
    if (unapproved) return { refusal: unapproved };

    const unmet = task.dependencies.filter((id) => !this.host.dependencyMet(id)).flatMap((id) => this.located(id) ?? []);
    if (unmet.length > 0) {
      const one = unmet.length === 1;
      return { refusal: `${capitalize(label)} depends on ${unmet.map((dep) => `${describe(dep)} (${depState(dep.task)})`).join(', ')}, which ${one ? 'has' : 'have'} not finished. It can start once ${one ? 'it has' : 'they have'}.` };
    }
    const gate = this.host.mergeGate(task.id).flatMap((id) => this.located(id) ?? []);
    if (gate.length > 0) {
      return { refusal: `${capitalize(label)} waits for Merge all: the work of ${named(gate)} is not merged into the user's branch yet. Ask the user to merge (Merge all), or to force start it.` };
    }
    // A retry under a running scheduler is left to it, as the Retry button leaves it, so only a start of our own takes a slot.
    const live = this.all().filter(({ task: t }) => this.host.running(t.id)).length;
    if (!(settled && this.host.scheduling()) && live >= this.host.maxParallel()) {
      return { refusal: `${live} tasks are already running, the most this session runs at once. Wait for one to finish, or stop one first.` };
    }

    return {
      act: async () => {
        // The Retry button's own path: it restarts a run a failure halted, and hands the task to a scheduler that runs.
        if (settled) await this.host.retryTask(task.id);
        if (!this.host.running(task.id) && !(settled && this.host.scheduling())) await this.host.startTask(task.id);
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
    const eligible = continuability(task);
    if (!eligible.ok) return { refusal: `${eligible.reason} A fresh retry (from "fresh") starts it over from its prompt.` };
    if (!message?.trim()) return { refusal: `Continuing ${label} in its saved session needs a message: what the runner should do next.` };
    const unapproved = this.unapproved(located, actor);
    if (unapproved) return { refusal: unapproved };
    return {
      act: async () => {
        await this.host.continueTask(task.id, message);
        if (this.host.runBlocked()) return { message: BLOCKED_RUN };
        return { message: `Continuing ${label} in its saved session with your message.` };
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
    if (!this.host.hasLiveWork() && !this.host.scheduling()) return { refusal: 'Nothing is running: there is no run to stop.' };
    return {
      act: async () => {
        this.host.stopRun();
        return {
          message: live.length > 0
            ? `Stopped the run: ${named(live)} ${live.length === 1 ? 'is' : 'are'} back to not started, and the plan is kept. Start again with run_plan or run_task.`
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

  /** Why a start is not the user's to have made, or null: the user's own call is its own approval. */
  private unapproved(located: Located, actor: ExecutionActor): string | null {
    if (actor.kind === 'user' || this.host.taskApproved(located.task.id)) return null;
    const label = describe(located);
    return this.host.planApproved()
      ? `${capitalize(label)} was added after the user approved the plan, so it is not approved to run. Ask the user to start it, or to execute the plan, which approves it.`
      : `The user has not approved ${label}: they approve the plan by executing it themselves (Execute plan), or a task by starting it. Ask them to.`;
  }

  /** The Guarded question, on the card the user answers other planner requests on. */
  private question(command: ExecutionCommand, actor: ExecutionActor, located: Located | undefined): ApprovalRequest {
    const subject = capitalize(this.intent(command, located));
    const how = located?.task.type === 'ai'
      ? ` It runs on ${located.task.assignedRunner}${located.task.taskMode ? ` in ${located.task.taskMode} mode` : ''}, as the plan set it.`
      : ' Each task runs on its runner, in the mode the plan set.';
    return {
      kind: 'task_start',
      perInvocation: true,
      subject,
      scope: subject,
      detail: `${actor.kind === 'supervisor' ? 'The supervisor' : 'The planner'} wants to start work.${how}`,
    };
  }

  /** What was asked, as "start task #4 "Title"". */
  private intent(command: ExecutionCommand, located: Located | undefined): string {
    const label = located ? describe(located) : '';
    switch (command.command) {
      case 'run_plan': return 'run the plan';
      case 'run_task': return `start ${label}`;
      case 'retry_task': return command.from === 'session' ? `continue ${label} in its saved session` : `retry ${label}`;
      case 'stop_task': return `stop ${label}`;
      case 'stop_run': return 'stop the run';
      case 'message_task': return `message ${label}`;
      case 'answer_approval': return `answer ${label}'s request`;
      case 'merge_all': return 'merge all';
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
    this.host.record(record, describeExecution(record, command));
  }

  private all(): Located[] {
    return flattenTasksWithParents(this.host.tasks() ?? []).map(({ task, parent }) => ({ task, ref: taskRef(task, parent ?? undefined) }));
  }

  private located(id: string): Located | undefined {
    return this.all().find(({ task }) => task.id === id);
  }

  /** A reference as a caller writes one: an id, "#order" or a dotted "#4.1", a bare order, or an exact title. */
  private locate(ref: string): Located | undefined {
    const ref_ = ref.trim();
    const all = this.all();
    const byId = all.find(({ task }) => task.id === ref_);
    if (byId) return byId;
    const label = ref_.startsWith('#') ? ref_.slice(1) : ref_;
    const byOrder = resolveOrderLabel([...(this.host.tasks() ?? [])], label);
    if (byOrder) return all.find(({ task }) => task.id === byOrder.id);
    return all.find(({ task }) => task.title === ref_);
  }
}

const BLOCKED_RUN = 'Nothing started: the user\'s checkout has uncommitted changes, and the run waits for them to stash them or run without isolation. Tell them.';

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
};

function statusWords(task: Readonly<Task>): string {
  if (task.status === 'awaiting_user' && task.awaitingReason === 'input') return 'is waiting for input';
  if (task.status === 'awaiting_user' && task.awaitingReason === 'checkpoint') return 'is waiting at a checkpoint for the user';
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
  return undefined;
}

const WHO: Record<ExecutionActor['kind'], string> = {
  user: 'You',
  'planner-turn': 'The planner',
  supervisor: 'The supervisor',
};

/** The timeline's line for one call: who asked, what, and how it ended. */
function describeExecution(record: ExecutionRecord, command?: ExecutionCommand): string {
  const who = WHO[record.actor];
  const label = record.task ? `task ${record.task.ref} "${record.task.title}"` : '';
  const continued = command?.command === 'retry_task' && command.from === 'session';
  const escalated = command?.command === 'answer_approval' && command.answer.trim().toLowerCase() === 'escalate';
  if (record.outcome !== 'done') {
    const asked = {
      run_plan: 'run the plan',
      run_task: `start ${label}`,
      retry_task: continued ? `continue ${label}` : `retry ${label}`,
      stop_task: `stop ${label}`,
      stop_run: 'stop the run',
      message_task: `message ${label}`,
      answer_approval: `answer a request of ${label}`,
      merge_all: 'merge all',
    }[record.command];
    return record.outcome === 'declined'
      ? `${who} asked to ${asked}; you declined.`
      : `${who} asked to ${asked}; refused: ${record.detail ?? 'no reason given'}`;
  }
  const { action, tail } = doneWords(record, label, continued, escalated);
  // The supervisor acts unattended, so its line reads as the action itself — the button press — and then who pressed it.
  return record.actor === 'supervisor'
    ? `${capitalize(action)} — by supervisor${tail.startsWith(' ') ? `,${tail}` : tail}`
    : `${who} ${action}${tail}`;
}

/** What a call that went through did, and what follows it in the line: a full stop, the quoted message, or the note. */
function doneWords(record: ExecutionRecord, label: string, continued: boolean, escalated: boolean): { action: string; tail: string } {
  const quoted = record.detail ? `: "${record.detail}"` : '.';
  switch (record.command) {
    case 'run_plan': return { action: 'started the plan', tail: '.' };
    case 'run_task': return { action: `started ${label}`, tail: '.' };
    case 'retry_task': return continued ? { action: `continued ${label} in its saved session`, tail: quoted } : { action: `retried ${label}`, tail: '.' };
    case 'stop_task': return { action: `stopped ${label}`, tail: '.' };
    case 'stop_run': return { action: 'stopped the run', tail: '.' };
    case 'message_task': return { action: `sent ${label} a message`, tail: quoted };
    case 'answer_approval': return escalated
      ? { action: `left a request of ${label} for you to answer`, tail: '.' }
      : { action: `denied a request of ${label}`, tail: record.detail ? ` with the note "${record.detail}".` : '.' };
    case 'merge_all': return { action: 'merged the run\'s work into your branch', tail: '.' };
  }
}

/** How a Merge all ended, in a clause: why it stopped, for a model or a run update to read. */
export function mergeStopped(result: IsolationMergeResult): string {
  switch (result.outcome) {
    case 'merged': return 'it merged';
    case 'blocked': return 'the user\'s checkout has changes that overlap what it would merge';
    case 'conflict': return `it conflicts in ${result.repo}${result.files?.length ? `: ${result.files.slice(0, 5).join(', ')}` : ''}`;
    case 'failed': return `it failed in ${result.repo}`;
  }
}
