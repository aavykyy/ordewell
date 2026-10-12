import { describe, it, expect } from 'vitest';
import { createTask, serializePlan, type Task } from '@ordewell/core';
import { initialState, reduce } from '../reducer';
import type { TaskView } from '../state';

/**
 * The plan an Act supervisor's `edit_plan` broadcasts after a run: nothing
 * follows it, so the statuses on it are all the pane has. The wire plan is
 * built by core's own serializer so this pins the real shape, not a fixture's.
 */

const wirePlan = (tasks: Task[]) => serializePlan({
  tasks, generatedAt: '2026-01-01T00:00:00Z', status: 'approved', runners: ['claude-code'], lastUpdated: '2026-01-01T00:00:00Z',
});

const statusOf = (tasks: TaskView[]): Record<string, string> =>
  Object.fromEntries(tasks.map((t) => [t.id, t.status]));

describe('a plan broadcast after a run', () => {
  const finished: Task[] = [
    createTask({ id: 't1', order: 1, title: 'First', prompt: 'a', status: 'completed' }),
    createTask({
      id: 't2', order: 2, title: 'Second', prompt: 'b', status: 'completed',
      subtasks: [createTask({ id: 't2a', order: 1, title: 'Second A', prompt: 'c', status: 'completed' })],
    }),
    { ...createTask({ id: 't3', order: 3, title: 'Third', prompt: 'd', status: 'awaiting_user' }), awaitingReason: 'usage-limit', resumeAt: '2026-01-01T05:00:00Z' },
  ];

  it('keeps finished tasks finished when a task is added, and shows the new one pending', () => {
    const idle = initialState({ sessionId: 's1' });
    const loaded = reduce(idle, { type: 'planUpdated', plan: wirePlan(finished), sessionId: 's1' }).state;

    const added = createTask({ id: 't4', order: 4, title: 'Fourth', prompt: 'e' });
    const { state } = reduce(loaded, { type: 'planBroadcast', plan: wirePlan([...finished, added]), sessionId: 's1' });

    expect(statusOf(state.tasks)).toEqual({ t1: 'completed', t2: 'completed', t3: 'awaiting_user', t4: 'pending' });
    expect(statusOf(state.tasks[1].subtasks ?? [])).toEqual({ t2a: 'completed' });
    expect(state.tasks[2]).toMatchObject({ awaitingReason: 'usage-limit', resumeAt: '2026-01-01T05:00:00Z' });
  });

  it('shows a plan still being drafted as all pending', () => {
    const drafted = [
      createTask({ id: 't1', order: 1, title: 'First', prompt: 'a' }),
      createTask({ id: 't2', order: 2, title: 'Second', prompt: 'b' }),
    ];
    const { state } = reduce(initialState({ sessionId: 's1' }), { type: 'planBroadcast', plan: wirePlan(drafted), sessionId: 's1' });

    expect(statusOf(state.tasks)).toEqual({ t1: 'pending', t2: 'pending' });
  });
});
