/**
 * Task references: the one grammar for naming a task in a plan, both ways.
 * A label is rendered from a task's order under its parent ("2", "2.1"), and
 * a reference written by anyone — the planner, a tool call, a command — is
 * resolved back against the plan tree. Pure and import-free so a
 * browser-bundled surface can use it through `@ordewell/core/plan-utils`.
 */

/** The shape a reference resolves over: the plan's task tree, or a surface's projection of it. */
export interface RefTask<T> {
  id: string;
  order: number;
  title: string;
  subtasks?: readonly T[];
}

/** Parent-scoped dotted order label for a task, e.g. "2.1" for the first subtask of task 2. */
export function taskOrderLabel(task: { order: number }, parent?: { order: number }): string {
  return parent ? `${parent.order}.${task.order}` : String(task.order);
}

/** How a surface refers to a task in prose: "#2", or "#2.1" for a subtask. */
export function taskRef(task: { order: number }, parent?: { order: number }): string {
  return `#${taskOrderLabel(task, parent)}`;
}

/** A task named in full, as a confirmation or a picker title does: "#2 Deploy". */
export function titledTaskRef(task: { order: number; title: string }, parent?: { order: number }): string {
  return `${taskRef(task, parent)} ${task.title}`;
}

/** A task found in a plan tree, with the parent whose order its label extends. */
export interface RefTaskMatch<T> {
  task: T;
  parent?: T;
}

function* depthFirst<T extends RefTask<T>>(tasks: readonly T[], parent?: T): Generator<RefTaskMatch<T>> {
  for (const task of tasks) {
    yield { task, parent };
    yield* depthFirst(task.subtasks ?? [], task);
  }
}

/** The task a plan tree holds, by id, with its parent; undefined when the tree holds none. */
export function findTaskRef<T extends RefTask<T>>(tasks: readonly T[], id: string): RefTaskMatch<T> | undefined {
  for (const match of depthFirst(tasks)) if (match.task.id === id) return match;
  return undefined;
}

/**
 * The reference {@link taskRef} renders for the task a plan tree holds, by id
 * — dotted for a subtask. Undefined when the tree holds no such task.
 */
export function taskRefOf<T extends RefTask<T>>(tasks: readonly T[], id: string): string | undefined {
  const found = findTaskRef(tasks, id);
  return found && taskRef(found.task, found.parent);
}

/**
 * Resolve a written reference to a task at any depth: an id, then an order
 * label with or without "#" ("#2", "2", "#2.1"), then an exact title.
 *
 * An order label is read against the tree, never a flattened list: subtask
 * orders restart at 1 under each parent, so "#2" always means top-level task 2
 * and a subtask is reachable only by its dotted label.
 */
export function resolveTaskRef<T extends RefTask<T>>(tasks: readonly T[], ref: string | number): T | undefined {
  const s = String(ref).trim();
  if (!s) return undefined;
  for (const { task } of depthFirst(tasks)) if (task.id === s) return task;
  const label = s.startsWith('#') ? s.slice(1) : s;
  if (/^\d+(\.\d+)?$/.test(label)) {
    const [top, sub] = label.split('.').map(Number);
    const parent = tasks.find((t) => t.order === top);
    return sub === undefined ? parent : parent?.subtasks?.find((t) => t.order === sub);
  }
  for (const { task } of depthFirst(tasks)) if (task.title === s) return task;
  return undefined;
}
