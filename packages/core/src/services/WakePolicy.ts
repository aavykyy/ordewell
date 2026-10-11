/**
 * When the supervisor wakes during a run, and what it is told (#27). Only an
 * attention event wakes it; passes ride along as context. It keeps no clock:
 * the host stamps each event and polls on its own tick.
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
  | 'run_finished';

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
};

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

export interface WakePolicy {
  push(event: RunEvent): void;
  poll(now: number): WakeBatch | null;
  /** When `poll` next answers a batch, on the events' clock; null while nothing would wake the supervisor. */
  dueAt(): number | null;
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
  };
}
