import { NOT_STARTED } from './status';

/** What a user can do to one task from its row. `cancel-resume` keeps a task paused on a usage limit from resuming on its own. */
export type TaskRowAction = 'cancel' | 'cancel-resume' | 'skip' | 'force-start' | 'complete' | 'uncomplete';

/** A subtask runs with its parent, so its row offers a different set than a top-level task's. */
export type TaskRowPlacement = 'task' | 'subtask';

interface ActionSubject {
  status: string;
  type: 'ai' | 'user';
  awaitingReason?: string;
  resumeAt?: string | null;
}

type Rule = readonly [TaskRowAction, (task: ActionSubject) => boolean];

const UNSTARTED_AI = (t: ActionSubject): boolean => t.type === 'ai' && NOT_STARTED.has(t.status);
const QUEUED = (t: ActionSubject): boolean => t.status === 'pending' || t.status === 'approved';
const RESUMES = (t: ActionSubject): boolean => t.status === 'awaiting_user' && t.awaitingReason === 'usage-limit' && !!t.resumeAt;
/** Work that holds up what depends on it until someone acts: Skip lets the run go on without it. */
const HOLDS_UP = (t: ActionSubject): boolean => t.status === 'failed' || t.status === 'blocked' || t.status === 'awaiting_user';

// Order is the order a surface lays the actions out in.
const TASK_RULES: readonly Rule[] = [
  ['cancel', (t) => t.status === 'in_progress'],
  ['cancel-resume', RESUMES],
  ['skip', HOLDS_UP],
  ['force-start', UNSTARTED_AI],
  // A manual task has no runner to report it done, so it can always be marked;
  // a skipped one's kept work can still be vouched for.
  ['complete', (t) => t.status === 'awaiting_user' || t.status === 'skipped' || t.type === 'user'],
  ['uncomplete', (t) => t.status === 'completed'],
];

const SUBTASK_RULES: readonly Rule[] = [
  ['cancel', (t) => t.status === 'in_progress'],
  ['cancel-resume', RESUMES],
  ['complete', (t) => t.status === 'in_progress' && t.type === 'ai'],
  ['force-start', (t) => t.type === 'ai' && QUEUED(t)],
  ['skip', (t) => QUEUED(t) || t.status === 'failed'],
  ['complete', (t) => t.status === 'awaiting_user' || t.status === 'skipped'],
  ['uncomplete', (t) => t.status === 'completed'],
];

/** The actions a task's row offers while a plan runs, in the order they are laid out. */
export function taskRowActions(task: ActionSubject, placement: TaskRowPlacement = 'task'): TaskRowAction[] {
  const rules = placement === 'subtask' ? SUBTASK_RULES : TASK_RULES;
  return rules.filter(([, applies]) => applies(task)).map(([action]) => action);
}

/**
 * One toggle in both directions: a done task is taken back, anything else is
 * marked done. A second control for the reverse is one nobody remembers.
 */
export function markAction(task: { status: string }): 'complete' | 'uncomplete' {
  return task.status === 'completed' ? 'uncomplete' : 'complete';
}

/**
 * The mark an action asks the session for, or null when it is not a mark.
 * Skip is not one: it ends the task without vouching for its work, which
 * only Mark complete does.
 */
export function markRequestFor(action: string): 'complete' | 'uncomplete' | null {
  if (action === 'complete') return 'complete';
  if (action === 'uncomplete') return 'uncomplete';
  return null;
}

/** Change versus ops can still be flipped (ADR-0020): an AI task that has not started. */
export function opsEditable(task: ActionSubject): boolean {
  return UNSTARTED_AI(task);
}
