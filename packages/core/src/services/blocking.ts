/** What the blocked rule reads of a task; structural, so a surface's own task shape answers it too. */
export interface BlockingSubject {
  id: string;
  status: string;
  dependencies: readonly string[];
  subtasks?: readonly BlockingSubject[];
}

/** Statuses of a task that has not started, the only ones a block holds back. */
const UNSTARTED: ReadonlySet<string> = new Set(['pending', 'approved']);

/**
 * The blocked rule (ADR-0034): a task not started yet is blocked while a
 * dependency failed or is itself blocked. One already at work — force-started,
 * or waiting on the user — is not, and does not pass a block on. Each
 * blocked task maps to the failed tasks it waits on, in dependency order and
 * named once; an unblocked task is absent. Nothing is stored, so a retry that
 * passes is all it takes to lift a block.
 *
 * Takes the plan tree or a flat list; a subtask follows the same rule.
 */
export function blockingFailures(tasks: readonly BlockingSubject[]): Map<string, string[]> {
  const byId = new Map<string, BlockingSubject>();
  const index = (list: readonly BlockingSubject[]): void => {
    for (const t of list) {
      byId.set(t.id, t);
      index(t.subtasks ?? []);
    }
  };
  index(tasks);

  const memo = new Map<string, string[]>();
  const failuresOf = (id: string, visiting: Set<string>): string[] => {
    const known = memo.get(id);
    if (known) return known;
    const task = byId.get(id);
    // A dependency cycle the planner left has no failure at its root.
    if (!task || !UNSTARTED.has(task.status) || visiting.has(id)) return [];
    visiting.add(id);
    const failed = new Set<string>();
    for (const depId of task.dependencies) {
      const dep = byId.get(depId);
      // A skipped dependency releases its dependents: nobody waits for it.
      if (!dep || dep.status === 'completed' || dep.status === 'skipped') continue;
      if (dep.status === 'failed') failed.add(depId);
      else for (const root of failuresOf(depId, visiting)) failed.add(root);
    }
    visiting.delete(id);
    const result = [...failed];
    memo.set(id, result);
    return result;
  };

  const blocked = new Map<string, string[]>();
  for (const id of byId.keys()) {
    const failures = failuresOf(id, new Set());
    if (failures.length > 0) blocked.set(id, failures);
  }
  return blocked;
}
