import { titledTaskRef, titledTaskRefOf } from '../services/TaskRefs';
import { checkOf, type TaskLoop } from '../models/Loop';

interface Named {
  id: string;
  order: number;
  title: string;
  subtasks?: readonly Named[];
  loop?: TaskLoop;
}

/** Each id as "#N title", subtasks dotted, by the plan's tree; one it no longer holds stays a bare id. */
export function titledRefs(ids: readonly string[], tasks: readonly Named[]): string[] {
  return ids.map((id) => titledTaskRefOf(tasks, id) ?? id);
}

/**
 * What removing a task does to the tasks that depend on it, or null when none
 * do. Named rather than counted: the removal rewrites their dependency lists,
 * and a bare "Remove task?" would hide that.
 */
export function dependentsNotice(dependents: readonly { id?: string; order: number; title: string }[], tasks: readonly Named[] = []): string | null {
  if (dependents.length === 0) return null;
  const subject = dependents.length === 1 ? '1 task depends' : `${dependents.length} tasks depend`;
  return `${subject} on it and will lose that dependency: ${dependents.map((t) => (t.id ? titledTaskRefOf(tasks, t.id) : undefined) ?? titledTaskRef(t)).join(', ')}.`;
}

/**
 * What removing a loop's body task does to its loop (ADR-0045 L8), or null for
 * a task in none: it leaves the body, and a loop left with no body is dropped.
 * A check is not here: core refuses its removal (`loopRemovalRefusal`).
 */
export function loopLeaveNotice(tasks: readonly Named[], taskId: string): string | null {
  const check = checkOf(tasks, taskId);
  if (!check?.loop) return null;
  const [named] = titledRefs([check.id], tasks);
  return check.loop.body.length > 1
    ? `It is in the body of ${named}'s loop, and leaves it.`
    : `It is the whole body of ${named}'s loop, so the loop is dropped with it.`;
}

/**
 * What a start past a merge gate is asked with (ADR-0020): the work the task
 * would act without, named. `subject` is how the asking surface refers to the
 * task — "It" under a title that already names it.
 */
export function pastGateConfirmation(unmerged: readonly string[], subject = 'This task'): string {
  return `${subject} waits for Merge all: the work of ${unmerged.join(', ')} is not merged into your branch yet, so it would act without it. Starting it now is kept on the task.`;
}

export interface NewTaskFields {
  title: string;
  description: string;
  prompt: string;
  type: 'ai';
}

/**
 * What a hand-added task starts as: an AI task whose description is its title
 * and whose prompt, unless one was typed, is too. Null for a title with nothing
 * in it, rather than a nameless task. Assignments are left for the session to
 * derive from the runner's catalog.
 */
export function newTaskFields(title: string, prompt?: string): NewTaskFields | null {
  const name = title.trim();
  if (!name) return null;
  return { title: name, description: name, prompt: prompt?.trim() ? prompt : name, type: 'ai' };
}
