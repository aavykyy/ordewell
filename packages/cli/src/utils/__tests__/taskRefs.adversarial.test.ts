import { describe, expect, it } from 'vitest';
import { createTask, type Task } from '@ordewell/core';
import { resolveTaskId } from '../tasks';
import { initialState } from '../../tui/state';
import { resolveTaskId as resolveTaskIdInTui } from '../../tui/reducers/taskEdits';

/**
 * Task references are read in two places in this package — the commands that
 * read the plan themselves (`utils/tasks.ts`, used by `remove-task` and
 * `task-assign`) and the TUI's task commands (`tui/reducers/taskEdits.ts`) —
 * both through core's `resolveUserTaskRef`, the grammar plus a unique id
 * prefix, which the command seam reads the user's controls with too. The two
 * must agree on every reference the grammar admits.
 */

const task = (id: string, order: number, over: Partial<Task> = {}): Task =>
  createTask({ id, order, title: `Task ${id}`, prompt: `do ${id}`, assignedRunner: 'claude-code', ...over });

const tasks = [
  task('alpha-1', 1),
  task('beta-2', 2, { subtasks: [task('gamma-3', 1, { title: 'A subtask' })] }),
  task('delta-4', 3),
];

/** The plan as the daemon sends it: the tree, and the flat form a saved session uses. */
const planBody = { tasks };

describe('adversarial: the two task-reference resolvers in the CLI agree', () => {
  it.each(['alpha-1', '#1', '#2.1', 'A subtask', 'delta-4'])('resolves %s the same way in both', (ref) => {
    const inCommand = resolveTaskId(planBody, ref);
    const inTui = resolveTaskIdInTui(initialState({ tasks }), ref);
    expect(inCommand).toBeDefined();
    expect(inTui).toBe(inCommand);
  });

  it('resolves a unique id prefix the same way in both, as the fallback says', () => {
    // `alph` is a unique prefix of alpha-1 and of nothing else.
    expect(resolveTaskId(planBody, 'alph')).toBe('alpha-1');
    expect(resolveTaskIdInTui(initialState({ tasks }), 'alph')).toBe('alpha-1');
  });

  it('refuses an ambiguous prefix in both', () => {
    const ambiguous = { tasks: [task('alpha-1', 1), task('alpha-2', 2)] };
    expect(resolveTaskId(ambiguous, 'alpha')).toBeUndefined();
    expect(resolveTaskIdInTui(initialState({ tasks: ambiguous.tasks }), 'alpha')).toBeNull();
  });
});
