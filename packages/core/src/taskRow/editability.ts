import { NOT_STARTED } from './status';

/**
 * The run's live facts for one task, as a card reads them beside its plan
 * fields. Only facts that can name an attempt before the status stream does: a
 * task starting has its worktree, and one whose runner waits on the user has a
 * request. A kept worktree, a merged branch or a stale silence is history, not
 * a live attempt, so it is deliberately absent: a task returned to pending
 * after a stop is editable.
 */
export interface TaskRunFacts {
  awaitingApproval?: number;
  isolation?: { state: string } | null;
}

/**
 * Whether a task keeps its editors while its plan is running — the card's own
 * rule, narrower than the direct-edit path. Pending, approved and blocked
 * tasks, including one waiting on a dependency, its approval record or a
 * merge gate, have not started and stay editable. A task execution has
 * reached — starting, running, waiting mid-attempt or settled — does not.
 */
export function editableWhileRunning(task: { status: string }, run?: TaskRunFacts): boolean {
  if (!NOT_STARTED.has(task.status)) return false;
  if (!run) return true;
  if ((run.awaitingApproval ?? 0) > 0) return false;
  return run.isolation?.state !== 'active' && run.isolation?.state !== 'repairing';
}
