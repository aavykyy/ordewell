import { flattenTasks, flattenTasksWithParents, type Task } from '../models/Task';
import { editedFields } from './LoopGuards';
import { surfaceTask, serializeTask, type HeldEdit, type HeldEditMark } from './SessionMessage';

/**
 * The plan an edit would leave, set against the one it edits: every task of
 * `after` in plan order, marked for what the edit does to it, and each task it
 * removes put back after the one that came before it. Both lists come from the
 * one applier, so this only reads what that decided.
 */
export function heldEditTasks(before: readonly Task[], after: readonly Task[]): HeldEdit['tasks'] {
  const beforeIds = flattenTasks(before).map((t) => t.id);
  const was = new Map(flattenTasks(before).map((t) => [t.id, t]));
  const rows = flattenTasksWithParents(after).map(({ task, label }) => ({ task, label, mark: markOf(was.get(task.id), task) }));
  const kept = new Set(rows.map(({ task }) => task.id));
  const removed = flattenTasksWithParents(before).filter(({ task }) => !kept.has(task.id));
  for (const { task, label } of removed) {
    // After the nearest earlier task that is still in the plan, else first.
    const earlier = beforeIds.slice(0, beforeIds.indexOf(task.id)).reverse();
    const anchor = earlier.map((id) => rows.findIndex((r) => r.task.id === id)).find((i) => i >= 0);
    rows.splice(anchor === undefined ? 0 : anchor + 1, 0, { task, label, mark: 'removed' });
  }
  // A subtask is listed flat: its parent is the row above it.
  return rows.map(({ task, label, mark }) => ({ label, ...(mark ? { mark } : {}), task: serializeTask(surfaceTask({ ...task, subtasks: [] })) }));
}

function markOf(was: Task | undefined, now: Task): HeldEditMark | undefined {
  if (!was) return 'added';
  // A rearm changes the status and nothing it lists as editable.
  return editedFields(was, now).length > 0 || was.status !== now.status ? 'changed' : undefined;
}
