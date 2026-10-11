import type { SupervisorLevel } from '../models/Execution';
import { createWakePolicy, type RunEvent, type WakeBatch, type WakePolicy } from './WakePolicy';
import { classifyRunnerStop, readUsageLimitReset } from './runnerExit';
import { PlannerTurnDiscardedError, PlannerTurnStoppedError, type WakeUpTurn } from './PlannerConversation';

/** How long the first attention event waits for others to join its wake-up. */
export const WAKE_DEBOUNCE_MS = 5_000;

/** How long a wake-up turn may run before it counts as hung and is stopped. */
export const WAKE_UP_TURN_TIMEOUT_MS = 10 * 60_000;

/** How long a stopped wake-up turn has to end before the conversation is taken back from it. */
export const HUNG_TURN_GRACE_MS = 30_000;

/**
 * Reads a wake-up turn may make when the plan sets none. A supervisor reads
 * to explain a failure — the task, its log, its diff, a neighbour's — and a
 * wake-up has no user message to keep it short (ADR-0029).
 */
export const DEFAULT_WAKE_UP_READ_BUDGET = 12;

/** Past the planner's usage-limit reset before a wake-up is tried again, as a task's resume waits (#84). */
const RESET_MARGIN_MS = 60_000;

/** How long one event's detail runs in a digest: what happened, never the log behind it. */
const DETAIL_CHARS = 240;

/** A run event as the host reports it; the supervisor stamps it. */
export type RunEventInput = Omit<RunEvent, 'at' | 'taskIds'>;

/** What the run started with, as saved on the plan. */
export interface SupervisedRun {
  level: SupervisorLevel;
  /** Why the supervisor stopped for the rest of the run; absent while it watches. */
  unsupervised?: string;
}

export interface SupervisorHost {
  /** The current run's saved settings; null when no run has started. */
  run(): SupervisedRun | null;
  /** Hand the planner a wake-up digest as the supervisor's input; it settles as the turn that takes it does. */
  deliver(digest: string): Promise<unknown>;
  /** Start whatever planner turn is now due. */
  pump(): void;
  /** How a digest names a task: `#3 "Title"`. */
  describeTask(taskId: string): string;
  /** Reads a wake-up turn may make, as the plan sets them. */
  readBudget(): number;
  /** The runner the planner runs as, whose usage-limit message says when it resets; null when there is none. */
  plannerRunner(): string | null;
  /** End the planner's process but keep its session id, so the retry resumes it (ADR-0009). */
  restartPlanner(): void;
  /** Free the conversation from a turn that did not end when stopped, taking back what it wrote. */
  abandonTurn(): void;
  /** The run carries on as Off: save why, and tell the user. */
  goUnsupervised(reason: string): void;
  notice(level: 'info' | 'warn', message: string): void;
}

export interface SupervisorOptions {
  debounceMs?: number;
  turnTimeoutMs?: number;
  hungGraceMs?: number;
  now?: () => number;
}

/** A wake-up turn ran past its time and was stopped. */
export class WakeUpTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`the wake-up turn did not finish within ${Math.round(timeoutMs / 1000)}s`);
    this.name = 'WakeUpTimeoutError';
  }
}

/**
 * The supervisor of a run (ADR-0029, #27): the planner conversation that wrote
 * the plan, woken during the run by the events that need attention. This
 * module decides when it wakes and what it is told, and keeps the run from
 * ever depending on it.
 *
 * Events reach it from the session; {@link WakePolicy} batches them, and each
 * due batch becomes a digest handed to the planner turns as the supervisor's
 * input. A turn on wake-ups alone is a wake-up turn, run through {@link turn}:
 * timed out if it hangs, retried once with the planner restarted if it fails,
 * and after that the run goes unsupervised — it carries on as Off, and what
 * was not delivered waits for the user's next message. A planner usage limit
 * is waited out instead. What the supervisor may do in its turns is the
 * level's, checked at the command seam and the edit path, never here.
 */
export class Supervisor {
  private policy: WakePolicy;
  private tick: ReturnType<typeof setTimeout> | null = null;
  /** Wake-up turns failed in a row this run; the second ends supervision. */
  private failures = 0;
  /** The run's end was reported: the scheduler can announce it more than once. */
  private finished = false;
  /** While the planner's usage limit holds wake-ups back: when it lets them go. */
  private limited: { until: number; timer: ReturnType<typeof setTimeout> } | null = null;
  private readonly debounceMs: number;
  private readonly turnTimeoutMs: number;
  private readonly hungGraceMs: number;
  private readonly now: () => number;

  constructor(private readonly host: SupervisorHost, options: SupervisorOptions = {}) {
    this.debounceMs = options.debounceMs ?? WAKE_DEBOUNCE_MS;
    this.turnTimeoutMs = options.turnTimeoutMs ?? WAKE_UP_TURN_TIMEOUT_MS;
    this.hungGraceMs = options.hungGraceMs ?? HUNG_TURN_GRACE_MS;
    this.now = options.now ?? Date.now;
    this.policy = createWakePolicy({ debounceMs: this.debounceMs });
  }

  /** The run has a supervisor at Watch or Act that has not failed in it. */
  get watching(): boolean {
    const run = this.host.run();
    return run !== null && run.level !== 'off' && run.unsupervised === undefined;
  }

  /** Whether wake-ups alone may open a turn now: the supervisor watches, and no usage limit holds it. */
  mayWake(): boolean {
    return this.watching && this.limited === null;
  }

  /** What a wake-up turn is held to under the run's level. */
  wakeUpTurn(): WakeUpTurn {
    const readBudget = this.host.readBudget();
    // Act runs as Watch until its own rules exist.
    return { readBudget, editsRefused: EDITS_REFUSED, brief: watchBrief(readBudget) };
  }

  /** A run event. Ignored unless the supervisor watches: at Off, or once it failed, nothing is gathered. */
  observe(event: RunEventInput): void {
    if (!this.watching) return;
    if (event.kind === 'run_finished') {
      if (this.finished) return;
      this.finished = true;
    }
    this.policy.push({ ...event, at: this.now() });
    this.arm();
  }

  /** A run started: its supervisor starts with a clean record. */
  runStarted(): void {
    this.failures = 0;
    this.finished = false;
  }

  /** The plan these events were about is gone: nothing gathered or waited on carries over. */
  reset(): void {
    this.disarm();
    if (this.limited) clearTimeout(this.limited.timer);
    this.limited = null;
    this.failures = 0;
    this.finished = false;
    this.policy = createWakePolicy({ debounceMs: this.debounceMs });
  }

  /**
   * Run one wake-up turn. A turn that runs past its time is stopped, and one
   * that does not end when stopped has the conversation taken from it, so the
   * run is never left waiting on a hung planner. A failure is counted before
   * the caller hears of it, so the retry the caller's next pump makes is
   * already the supervisor's decision.
   */
  async turn<T>(run: (signal: AbortSignal) => Promise<T>, signal?: AbortSignal): Promise<T> {
    const controller = new AbortController();
    const relay = () => controller.abort();
    if (signal?.aborted) controller.abort();
    else signal?.addEventListener('abort', relay, { once: true });
    let timedOut = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let grace: ReturnType<typeof setTimeout> | undefined;
    const answered = run(controller.signal);
    // Raced below; once the race is lost, the turn's own failure is nobody's to hear.
    answered.catch(() => {});
    const hung = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        timedOut = true;
        controller.abort();
        grace = setTimeout(() => {
          this.host.abandonTurn();
          reject(new WakeUpTimeoutError(this.turnTimeoutMs));
        }, this.hungGraceMs);
      }, this.turnTimeoutMs);
    });
    try {
      const landed = await Promise.race([answered, hung]);
      this.failures = 0;
      return landed;
    } catch (err) {
      const failure = timedOut ? new WakeUpTimeoutError(this.turnTimeoutMs) : err;
      this.failed(failure);
      throw failure;
    } finally {
      clearTimeout(timer);
      clearTimeout(grace);
      signal?.removeEventListener('abort', relay);
    }
  }

  private failed(err: unknown): void {
    // The user's stop, or a plan change: the supervisor did not fail.
    if (err instanceof PlannerTurnStoppedError || err instanceof PlannerTurnDiscardedError) return;
    const reason = err instanceof Error ? err.message : String(err);
    if (!(err instanceof WakeUpTimeoutError) && classifyRunnerStop(reason) === 'usage-limit') {
      this.waitForReset(reason);
      return;
    }
    this.failures++;
    this.host.restartPlanner();
    if (this.failures < 2) {
      this.host.notice('warn', `The supervisor's wake-up turn failed (${brief(reason)}). Retrying once with the planner restarted.`);
      return;
    }
    this.giveUp(`its wake-up turn failed twice (${brief(reason)})`);
  }

  private waitForReset(said: string): void {
    const runner = this.host.plannerRunner();
    const reset = runner ? readUsageLimitReset(runner, said, new Date(this.now())) : null;
    if (!reset) {
      this.giveUp('the planner hit its usage limit and did not say when it resets');
      return;
    }
    if (this.limited) clearTimeout(this.limited.timer);
    const until = reset.getTime() + RESET_MARGIN_MS;
    const timer = setTimeout(() => {
      this.limited = null;
      this.host.pump();
    }, Math.max(0, until - this.now()));
    this.limited = { until, timer };
    this.host.notice('info', `The planner hit its usage limit. The supervisor's wake-ups wait until ${new Date(until).toISOString()}, and are delivered together then.`);
  }

  /**
   * The run goes on without a supervisor. What the policy still holds joins
   * the batches already waiting, so nothing that happened is lost: they all
   * reach the conversation with the user's next message.
   */
  private giveUp(reason: string): void {
    this.host.goUnsupervised(reason);
    this.disarm();
    const held = this.policy.poll(Number.POSITIVE_INFINITY);
    if (held) this.deliver(held);
  }

  private arm(): void {
    const due = this.policy.dueAt();
    if (due === null) return;
    this.disarm();
    this.tick = setTimeout(() => {
      this.tick = null;
      const batch = this.policy.poll(this.now());
      if (batch) this.deliver(batch);
      else this.arm();
    }, Math.max(0, due - this.now()));
  }

  private disarm(): void {
    if (this.tick) clearTimeout(this.tick);
    this.tick = null;
  }

  private deliver(batch: WakeBatch): void {
    // A failure is the wake-up turn's to handle, in {@link turn}; the batch stays pending meanwhile.
    this.host.deliver(wakeUpDigest(batch, (taskId) => this.host.describeTask(taskId))).catch(() => {});
  }
}

const EDITS_REFUSED =
  'Plan edits are refused in a wake-up turn: you are the supervisor at Watch, and nothing was changed. ' +
  'Do not call submit_plan or edit_plan, or emit plan or taskOps JSON, this turn. Reply in prose instead: ' +
  'say what you would change and why, and ask the user. Their reply is an ordinary message, and you make the change then.';

/** What a wake-up turn is told after its digests, never saved: who it is, and what its level lets it do. */
function watchBrief(readBudget: number): string {
  return [
    'You are this plan\'s supervisor, woken by the run update above; the user did not write to you.',
    'Tell the user, in a few lines, what needs their attention and what you suggest, so they can answer.',
    `Read more with task_output, task_diff or task_query if you need to: up to ${readBudget} reads this turn. The update names what happened; it does not hold the logs.`,
    'At Watch you only suggest. Running, stopping, retrying or messaging tasks, answering approvals and editing the plan are refused in this turn: the user\'s reply is how a suggestion is applied.',
  ].join('\n');
}

/**
 * What a wake-up tells the planner: each event that woke it, with its task
 * and a short detail, and the passes since the last one. A digest, never a
 * log — the supervisor reads more itself.
 */
export function wakeUpDigest(batch: WakeBatch, describe: (taskId: string) => string): string {
  const passed = [...new Set(batch.sinceLast.flatMap((e) => e.taskId ?? []))];
  return [
    'Run update:',
    ...batch.attention.map((e) => `- ${attentionLine(e, describe)}`),
    ...(passed.length > 0 ? [`Since the last update: ${passed.length === 1 ? 'task' : 'tasks'} ${listed(passed.map(describe))} passed.`] : []),
  ].join('\n');
}

function attentionLine(event: RunEvent, describe: (taskId: string) => string): string {
  const task = event.taskId === undefined ? 'a task' : `task ${describe(event.taskId)}`;
  const detail = event.detail ? brief(event.detail) : '';
  const colon = detail ? `: ${detail}` : '';
  switch (event.kind) {
    case 'task_failed': return `${task} failed${colon}`;
    case 'waiting_input': return `${task} is waiting for input${colon}`;
    case 'waiting_approval': return `${task} is waiting for approval${colon}`;
    case 'task_idle': return `${task} has gone quiet${detail ? ` (${detail})` : ''}`;
    case 'landing_conflict': return `${task} finished, but its work conflicts and could not land${colon}`;
    case 'auto_merge_stopped': return `automatic Merge all at the merge gate of ${task} stopped${colon}; the gate waits for the user`;
    case 'run_finished': return `the run finished${colon}`;
    case 'task_passed': return `${task} passed`;
    case 'usage_limit': {
      const ids = event.taskIds ?? (event.taskId === undefined ? [] : [event.taskId]);
      const one = ids.length === 1;
      const tasks = ids.length === 0 ? 'a task' : `${one ? 'task' : 'tasks'} ${listed(ids.map(describe))}`;
      const resume = event.resumeAt
        ? `${one ? 'it resumes' : 'they resume'} on ${one ? 'its' : 'their'} own at ${event.resumeAt}`
        : `${one ? 'it waits' : 'they wait'} for a retry, as the reset time could not be read`;
      return `${tasks} paused on ${event.runner ?? 'its runner'}'s usage limit; ${resume}`;
    }
  }
}

function listed(items: readonly string[]): string {
  return items.length < 2 ? items.join('') : `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}

/** One line, cut to fit a digest. */
function brief(text: string): string {
  const line = text.replace(/\s+/g, ' ').trim();
  return line.length > DETAIL_CHARS ? `${line.slice(0, DETAIL_CHARS - 1)}…` : line;
}
