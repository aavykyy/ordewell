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

/**
 * The one run fact the card's editors and the host's edit guard both read:
 * anything that could still move a task on without being asked — a live
 * attempt, a start opening the run, a scheduler waiting on a manual task, a
 * gate or a usage-limit hold. A run that ended on a failure is not here:
 * nothing advances until a retry or skip, so the failed task stays editable.
 */
export function runHoldsEditors(isExecuting: boolean, activity: { starting: boolean; advancesOnItsOwn: boolean }): boolean {
  return isExecuting || activity.starting || activity.advancesOnItsOwn;
}

/** Whether a card shows this task's editors, given {@link runHoldsEditors}. */
export function cardEditable(runHolds: boolean, task: { status: string }, run?: TaskRunFacts): boolean {
  return !runHolds || editableWhileRunning(task, run);
}

/**
 * Whether a card edit carries the narrower precondition that the task has not
 * started when the Session applies it. It does while a run holds the editors,
 * and for a task that has not started even in an idle plan: the edit waits on
 * discovery or a skills check, and a start can claim the task meanwhile. A
 * settled task of an idle plan keeps the wider direct-edit contract.
 */
export function cardEditNeedsUnstarted(runHolds: boolean, task: { status: string }): boolean {
  return runHolds || NOT_STARTED.has(task.status);
}
