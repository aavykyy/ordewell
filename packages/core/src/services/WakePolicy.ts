import type { TurnAuthority } from '../models/Task';

/**
 * When the supervisor wakes during a run, and what it is told (#27). Only an
 * attention event wakes it; passes ride along as context. It keeps no clock:
 * the host stamps each event and polls on its own tick.
 *
 * `task_report` is a task addressed to the planner ending: one whose result a
 * planner turn asked for and did not get before it answered (ADR-0037, R2).
 * It is batched as any attention event is, and wakes the planner whatever the
 * supervisor's level, since the planner asked for it.
 */

export type RunEventKind =
  | 'task_passed'
  | 'task_failed'
  | 'waiting_input'
  | 'waiting_approval'
  | 'task_idle'
  | 'landing_conflict'
  | 'usage_limit'
  | 'auto_merge_stopped'
  | 'run_finished'
  | 'task_report';

export type RunEvent = {
  kind: RunEventKind;
  taskId?: string;
  /** Epoch ms, on the same clock the host passes to `poll`. */
  at: number;
  detail?: string;
  /** `usage_limit` only: the runner whose limit paused the task. */
  runner?: string;
  /** `usage_limit` only: when its tasks resume on their own (ISO time); null when they wait for a manual retry. */
  resumeAt?: string | null;
  /** `usage_limit` in a batch: every task the runner's limit paused in it, in arrival order. */
  taskIds?: string[];
  /** `task_report` only: the result the planner asked for. */
  report?: TaskReportEvent;
};

export interface TaskReportEvent {
  /** Whose turn started the task: the turn the report opens acts with its authority (ADR-0037, R3). */
  authority: TurnAuthority;
  /** Its verdict and the tail of its output, as the planner reads them: never cut to a digest line. */
  text: string;
  /** It passed: a pass, as far as the wake-up rate is concerned. */
  passed: boolean;
}

export interface WakeBatch {
  /** What woke the supervisor, in arrival order; never empty. */
  attention: RunEvent[];
  /** The passes since the previous wake-up. */
  sinceLast: RunEvent[];
}

export interface WakePolicyOptions {
  /** How long the first attention event waits for others to join its wake-up. */
  debounceMs: number;
}

/** What the policy holds before its next wake-up, for the plan (ADR-0029). */
export interface WakePolicySnapshot {
  /** Attention events inside the debounce window, in arrival order. */
  attention: RunEvent[];
  /** The passes since the previous wake-up. */
  sinceLast: RunEvent[];
}

export interface WakePolicy {
  push(event: RunEvent): void;
  poll(now: number): WakeBatch | null;
  /** When `poll` next answers a batch, on the events' clock; null while nothing would wake the supervisor. */
  dueAt(): number | null;
  /** What waits inside the debounce window, so a daemon restart still delivers it. */
  snapshot(): WakePolicySnapshot;
  /** Put back a save's waiting events, replacing whatever this held. */
  restore(snapshot: WakePolicySnapshot | undefined): void;
}

export function createWakePolicy(options: WakePolicyOptions): WakePolicy {
  const { debounceMs } = options;
  if (!Number.isFinite(debounceMs) || debounceMs < 0) {
    throw new RangeError(`debounceMs must be a finite, non-negative number of milliseconds, got ${debounceMs}`);
  }

  let attention: RunEvent[] = [];
  let sinceLast: RunEvent[] = [];

  const dueAt = (): number | null => {
    const first = attention[0];
    if (!first) return null;
    // A fixed window from the first attention event: one that restarted on
    // each event could be held off by tasks that keep settling. run_finished
    // skips it, as nothing later in the run can join the batch.
    return attention.some((e) => e.kind === 'run_finished') ? first.at : first.at + debounceMs;
  };

  return {
    push(event) {
      if (event.kind === 'task_passed') {
        sinceLast.push(event);
        return;
      }
      // Only silence and the run's end collapse: a task flickering between
      // silence and output is one fact, while two waiting_input events are two
      // questions.
      if (event.kind === 'task_idle' && attention.some((e) => e.kind === 'task_idle' && e.taskId === event.taskId)) return;
      if (event.kind === 'run_finished' && attention.some((e) => e.kind === 'run_finished')) return;
      if (event.kind === 'usage_limit') {
        // One limit is one fact however many of its runner's tasks it pauses:
        // they all resume, or wait, together.
        const at = attention.findIndex((e) => e.kind === 'usage_limit' && e.runner === event.runner);
        const taskIds = event.taskId === undefined ? [] : [event.taskId];
        if (at < 0) {
          attention.push({ ...event, taskIds });
          return;
        }
        const joined = attention[at];
        attention = attention.map((e, i) => (i !== at ? e : {
          ...joined,
          taskIds: [...new Set([...(joined.taskIds ?? []), ...taskIds])],
          resumeAt: event.resumeAt ?? joined.resumeAt ?? null,
        }));
        return;
      }
      attention.push(event);
    },

    poll(now) {
      const due = dueAt();
      if (due === null || now < due) return null;
      const batch = { attention, sinceLast };
      attention = [];
      sinceLast = [];
      return batch;
    },

    dueAt,

    snapshot() {
      return { attention: [...attention], sinceLast: [...sinceLast] };
    },

    restore(snapshot) {
      attention = [...(snapshot?.attention ?? [])];
      sinceLast = [...(snapshot?.sinceLast ?? [])];
    },
  };
}
