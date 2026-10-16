import type { AwaitingReason } from '../models/Task';

/**
 * What a row's status means to a reader, before any surface picks a word,
 * icon or colour for it. `quiet` is a running task whose runner has printed
 * nothing for a while — the status is still `in_progress`, so only the row,
 * never the store, tells the two apart.
 */
export type TaskStatusKind = 'todo' | 'running' | 'quiet' | 'awaiting' | 'blocked' | 'failed' | 'skipped' | 'done';

/** A task with a runner live behind it. `in_progress` is the store's own status. */
export const isTaskRunning = (task: { status: string }): boolean =>
  task.status === 'in_progress' || task.status === 'running';

/** Statuses of a task that has not started: what can still be started by hand, or flipped between change and ops (ADR-0020). */
export const NOT_STARTED: ReadonlySet<string> = new Set(['pending', 'approved', 'blocked']);

export function taskStatusKind(task: { status: string; idleSince?: string | null }): TaskStatusKind {
  switch (task.status) {
    case 'completed': return 'done';
    case 'failed': return 'failed';
    case 'skipped': return 'skipped';
    case 'blocked': return 'blocked';
    case 'awaiting_user': return 'awaiting';
  }
  if (!isTaskRunning(task)) return 'todo';
  return task.status === 'in_progress' && task.idleSince ? 'quiet' : 'running';
}

const AWAITING_LABELS: Record<AwaitingReason, string> = {
  input: 'Waiting for your input',
  checkpoint: 'Checkpoint',
  conflict: 'Merge conflict',
  'files-changed': 'Changed tracked files',
  'usage-limit': 'Paused on a usage limit',
};

/** What an awaiting_user task waits on (ADR-0018, W1); null when no reason was saved. */
export function awaitingLabel(task: { status: string; awaitingReason?: AwaitingReason }): string | null {
  return task.status === 'awaiting_user' && task.awaitingReason ? AWAITING_LABELS[task.awaitingReason] : null;
}

/** "Blocked by #1, #2.1": the failed tasks a blocked task waits on, by reference (ADR-0034). */
export function blockedByLabel(refs: readonly string[]): string {
  return `Blocked by ${refs.join(', ')}`;
}

/** "Skipped: no GPU on this host", or "Skipped" when no reason was given. */
export function skippedLabel(reason: string | null): string {
  return reason ? `Skipped: ${reason}` : 'Skipped';
}

/**
 * A task added after the user approved the plan, which the scheduler leaves
 * for them (ADR-0035). Not a runner approval: nothing has started, so no
 * runner is asking anything.
 */
export const WAITS_FOR_APPROVAL_LABEL = 'Waiting for your approval to start';

/** Runner requests a task waits on (ADR-0018, A1); null when none do. */
export function approvalLabel(count: number | undefined): string | null {
  if (!count) return null;
  return count > 1 ? `Waiting for approval (${count})` : 'Waiting for approval';
}

/**
 * When a paused task resumes, as a reader's clock shows it: "8:10pm", or
 * "Oct 14, 8:10pm" when it is not today. Read in the local time zone of
 * whoever formats it.
 */
export function resumeTime(at: Date, now: Date = new Date()): string {
  const clock = at.toLocaleTimeString('en-US', { hour: 'numeric', minute: at.getMinutes() === 0 ? undefined : '2-digit', hour12: true })
    .replace(/[ \u202f]([AP]M)$/i, (_m, meridiem: string) => meridiem.toLowerCase());
  if (at.toDateString() === now.toDateString()) return clock;
  return `${at.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}, ${clock}`;
}

/** "Resumes at 8:10pm" for a task paused on a usage limit that resumes on its own; null for any other. */
export function resumeLabel(task: { status: string; awaitingReason?: AwaitingReason; resumeAt?: string | null }, now: Date = new Date()): string | null {
  if (task.status !== 'awaiting_user' || task.awaitingReason !== 'usage-limit' || !task.resumeAt) return null;
  const at = new Date(task.resumeAt);
  return Number.isNaN(at.getTime()) ? null : `Resumes at ${resumeTime(at, now)}`;
}
