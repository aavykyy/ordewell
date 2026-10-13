import type { LegacyPlanState, PendingPlanTurn, PlanTurnSource, SkillLoad } from '../models/Task';
import { ConversationBusyError, PlannerTurnDiscardedError, PlannerTurnStoppedError } from './PlannerConversation';
import type { SkillInvocation } from './skillInvocation';

/**
 * How long a turn may hold new starts. Past it the run goes on without the
 * turn's answer, which still lands: an edit is checked against the tasks as
 * they are when it applies, so a task that started meanwhile refuses it.
 */
export const START_HOLD_TIMEOUT_MS = 5 * 60_000;

export interface PlanTurnInput {
  source: PlanTurnSource;
  text: string;
  skills?: readonly SkillLoad[];
  /** Stops the turn that takes this input. Not saved: a replayed input has no caller left to stop it. */
  signal?: AbortSignal;
}

/**
 * One turn's input: the user's messages joined, with the skills they loaded,
 * and the wake-up digests delivered with them. `source` is `supervisor` only
 * when nothing in the turn came from the user — a wake-up turn (ADR-0029).
 */
export interface TurnPrompt extends SkillInvocation {
  source: PlanTurnSource;
  wakeUps: string[];
  /** The message was force sent: the turn replaces the one it stopped. */
  forced?: true;
}

export interface PlanTurnsHost {
  plan(): LegacyPlanState | null;
  /** A planner turn this module did not open holds the conversation: an opening, a compaction, plan generation. */
  conversationBusy(): boolean;
  /** Whether wake-ups alone may open a turn now; when not, they wait for one that may, or for the user's next message. */
  mayWake(): boolean;
  /** Save the pending list. A background save: it must not count as settling a turn in flight. */
  persist(): void;
  /**
   * Stop the planner turn holding the conversation for a force send: it ends
   * as stopped by one, not by the user. The run's tasks are not touched.
   */
  interrupt(): void;
  /** Hold the scheduler's new starts; the returned release is idempotent. */
  holdStarts(): () => void;
  /** Tick an armed scheduler after a release, so what became ready during the turn starts. */
  resumeStarts(): Promise<void>;
  /**
   * One planner turn on `prompt`. `taken` must run inside the mutation that
   * lands the turn's outcome, so the saved plan loses the inputs together
   * with the change they made.
   */
  run(prompt: TurnPrompt, opts: { taken: () => void; signal?: AbortSignal }): Promise<LegacyPlanState>;
  /** Tell the user what no caller is waiting to hear: a replayed input's failed turn, a resume that failed. */
  notice(message: string): void;
}

interface Waiter {
  resolve(plan: LegacyPlanState): void;
  reject(err: unknown): void;
  signal?: AbortSignal;
}

/** The turn in flight, compared by identity: an abandoned one finds another, or none, in its place. */
interface Running {
  release: () => void;
  /** The inputs it took, which stay on the plan until it ends. */
  ids: ReadonlySet<string>;
}

/** One planner message for a batch: the inputs in the order they came, each with the skills it loaded. */
export function turnPrompt(batch: readonly PendingPlanTurn[]): TurnPrompt {
  const fromUser = batch.filter((t) => t.source === 'user');
  return {
    source: fromUser.length > 0 ? 'user' : 'supervisor',
    text: fromUser.map((t) => t.text).join('\n\n'),
    skills: fromUser.flatMap((t) => t.skills ?? []),
    wakeUps: batch.filter((t) => t.source === 'supervisor').map((t) => t.text),
    ...(batch.some((t) => t.forced) ? { forced: true } : {}),
  };
}

/**
 * Live planner turns (ADR-0029): every input to the planner conversation after
 * its opening — a user's message, and later a wake-up batch — goes through
 * {@link enqueue}, during a run or not. Turns run one at a time and at once;
 * inputs that arrive during a turn are taken together by the next one.
 *
 * A turn holds the scheduler's new starts while it runs and always lets them
 * go when it ends — settled, stopped, failed, timed out on its hold, or
 * abandoned with its plan — so a planner that crashes cannot freeze the run.
 *
 * Inputs wait on the plan (`pendingTurns`), saved as they arrive, and leave it
 * in the save that lands their turn's outcome; a turn that ends without one
 * drops the user's then. A wake-up batch is only delivered by a turn that
 * lands with it, so it stays through a failed one — unless the user stopped
 * the turn, which was their answer to it. A reload therefore replays exactly
 * what no turn answered.
 */
export class PlanTurns {
  private readonly waiters = new Map<string, Waiter>();
  private running: Running | null = null;
  private seq = 0;

  constructor(private readonly host: PlanTurnsHost, private readonly holdTimeoutMs = START_HOLD_TIMEOUT_MS) {}

  /** Whether a turn this module opened is in flight. */
  get busy(): boolean {
    return this.running !== null;
  }

  /**
   * Hand the planner an input; it settles with the plan the turn that takes it
   * lands, or rejects as that turn does. While another of these turns runs the
   * input waits for the next; while a turn of another kind holds the
   * conversation it is refused, as a reply always was.
   */
  enqueue(input: PlanTurnInput): Promise<LegacyPlanState> {
    // A wake-up is never refused: it waits for the conversation like any input
    // that arrives during a turn, and is delivered when it frees.
    if (input.source === 'user' && this.host.plan() && !this.running && this.host.conversationBusy()) return Promise.reject(new ConversationBusyError('send a message'));
    return this.admit(input, false);
  }

  /**
   * Force send (ADR-0023, F5): stop the planner turn in flight — whatever
   * kind holds the conversation — and answer this input in the turn that
   * replaces it, alone, ahead of every input waiting but an earlier forced
   * one; the rest keep their order behind it. Nothing can start between the
   * two: the input waits before the stop, and the next turn takes it first.
   * With no turn in flight it is a plain send.
   */
  forceSend(input: PlanTurnInput): Promise<LegacyPlanState> {
    if (!this.running && !this.host.conversationBusy()) return this.enqueue(input);
    const settled = this.admit(input, true);
    this.host.interrupt();
    return settled;
  }

  private admit(input: PlanTurnInput, forced: boolean): Promise<LegacyPlanState> {
    const plan = this.host.plan();
    if (!plan) return Promise.reject(new Error('No planning conversation to continue'));
    const entry: PendingPlanTurn = {
      id: `turn-${Date.now()}-${++this.seq}`,
      source: input.source,
      text: input.text,
      timestamp: new Date().toISOString(),
      ...(input.skills && input.skills.length > 0 ? { skills: [...input.skills] } : {}),
      ...(forced ? { forced: true } : {}),
    };
    const pending = plan.pendingTurns ?? [];
    const at = forced ? pending.findIndex((t) => !t.forced && !this.running?.ids.has(t.id)) : -1;
    plan.pendingTurns = at === -1 ? [...pending, entry] : [...pending.slice(0, at), entry, ...pending.slice(at)];
    this.host.persist();
    const settled = new Promise<LegacyPlanState>((resolve, reject) => {
      this.waiters.set(entry.id, { resolve, reject, signal: input.signal });
    });
    this.pump();
    return settled;
  }

  /**
   * Start the next turn if one is due: nothing of ours is in flight, the
   * conversation is free, and inputs wait. The host calls it when any planner
   * turn lets the conversation go, and after a load, to replay what waited.
   */
  pump(): void {
    if (this.running) return;
    const plan = this.host.plan();
    if (!plan || this.host.conversationBusy()) return;
    const batch = this.liveBatch(plan);
    if (batch.length === 0) return;
    if (batch.every((t) => t.source === 'supervisor') && !this.host.mayWake()) return;
    void this.run(plan, batch);
  }

  /**
   * The plan these turns served is gone (a new plan, another session adopted,
   * the session closed): the hold goes now, and every caller still waiting
   * hears that its turn was discarded. The turn in flight is the
   * conversation's to abandon; whatever it settles lands nothing here.
   */
  abandon(): void {
    this.running?.release();
    this.running = null;
    for (const waiter of this.waiters.values()) waiter.reject(new PlannerTurnDiscardedError());
    this.waiters.clear();
  }

  /**
   * What the next turn takes: what waits, oldest first, less any input whose
   * caller stopped it before its turn began — or a forced input alone.
   */
  private liveBatch(plan: LegacyPlanState): PendingPlanTurn[] {
    const pending = plan.pendingTurns ?? [];
    const stopped = pending.filter((t) => this.waiters.get(t.id)?.signal?.aborted);
    if (stopped.length > 0) {
      this.take(plan, new Set(stopped.map((t) => t.id)));
      this.host.persist();
      for (const t of stopped) this.settle(t.id, (w) => w.reject(new PlannerTurnStoppedError()));
    }
    const live = plan.pendingTurns ?? [];
    return live[0]?.forced ? [live[0]] : live;
  }

  private async run(plan: LegacyPlanState, batch: readonly PendingPlanTurn[]): Promise<void> {
    const ids = new Set(batch.map((t) => t.id));
    const running: Running = { release: this.host.holdStarts(), ids };
    this.running = running;
    const timeout = setTimeout(() => {
      running.release();
      this.host.resumeStarts().catch((err: unknown) => this.host.notice(`New tasks could not start: ${reasonOf(err)}`));
    }, this.holdTimeoutMs);
    const signals = batch.flatMap((t) => this.waiters.get(t.id)?.signal ?? []);
    let outcome: { ok: true; plan: LegacyPlanState } | { ok: false; err: unknown };
    try {
      const landed = await this.host.run(turnPrompt(batch), {
        taken: () => this.take(plan, ids),
        signal: signals.length > 0 ? AbortSignal.any(signals) : undefined,
      });
      outcome = { ok: true, plan: landed };
    } catch (err) {
      outcome = { ok: false, err };
    }
    clearTimeout(timeout);
    // Abandoned: the hold is gone and every waiter has heard.
    if (this.running !== running) return;
    try {
      // A turn that landed nothing still had its say; the user's inputs go
      // with it. A failure leaves the wake-ups undelivered.
      const dropped = outcome.ok || isInterruption(outcome.err)
        ? ids
        : new Set(batch.filter((t) => t.source === 'user').map((t) => t.id));
      if (this.take(plan, dropped)) this.host.persist();
      running.release();
      await this.host.resumeStarts();
    } catch (err) {
      if (outcome.ok) outcome = { ok: false, err };
    } finally {
      running.release();
      this.running = null;
      const ended = outcome;
      for (const t of batch) {
        const delivered = this.settle(t.id, (w) => (ended.ok ? w.resolve(ended.plan) : w.reject(ended.err)));
        if (!delivered && !ended.ok && !isInterruption(ended.err) && t.source === 'user') this.host.notice(replayFailed(t, ended.err));
      }
      this.pump();
    }
  }

  /** Drop these inputs from the plan's list; true when any were still there. */
  private take(plan: LegacyPlanState, ids: ReadonlySet<string>): boolean {
    const pending = plan.pendingTurns ?? [];
    const kept = pending.filter((t) => !ids.has(t.id));
    if (kept.length === pending.length) return false;
    plan.pendingTurns = kept;
    return true;
  }

  private settle(id: string, how: (waiter: Waiter) => void): boolean {
    const waiter = this.waiters.get(id);
    if (!waiter) return false;
    this.waiters.delete(id);
    how(waiter);
    return true;
  }
}

function isInterruption(err: unknown): boolean {
  return err instanceof PlannerTurnStoppedError || err instanceof PlannerTurnDiscardedError;
}

function reasonOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function replayFailed(input: PendingPlanTurn, err: unknown): string {
  const line = input.text.split('\n')[0];
  return `The planner could not answer "${line}", sent before the session reloaded: ${reasonOf(err)}. Send it again to retry.`;
}
