import { describe, it, expect, vi } from 'vitest';
import { createTask, type LegacyPlanState } from '../../models/Task';
import { makeSession, testWorkspace } from './sessionTestKit';
import { FakeRunnerSession } from '../../testing';
import type { IRunner } from '../../interfaces/IRunner';

/**
 * Adversarial: the command seam's refusals read the start rule (ADR-0034), so
 * the user's Run gives the same answer as the scheduler for every reason the
 * rule names, a task with no prompt included.
 */

function plan(tasks: ReturnType<typeof createTask>[]): LegacyPlanState {
  const now = new Date().toISOString();
  return { tasks, generatedAt: now, status: 'approved', runners: ['claude-code'], lastUpdated: now };
}

function setup() {
  const spawned: string[] = [];
  const runner: IRunner = {
    spawn: vi.fn(async ({ taskId }: { taskId: string }) => {
      spawned.push(taskId);
      return new FakeRunnerSession('s', taskId);
    }),
    stop: vi.fn(),
    stopAll: vi.fn(),
    activeCount: 0,
  } as unknown as IRunner;
  const session = makeSession({ runner });
  return { session, spawned };
}

describe('the user\'s Run and the start rule', () => {
  it('starts a task with a prompt', async () => {
    const { session, spawned } = setup();
    session.loadPlan(plan([createTask({ id: 't1', order: 1, title: 'Ready', prompt: 'do it' })]), 'goal', testWorkspace, { persist: false });

    const outcome = await session.execute({ command: 'run_task', task: 't1' }, { kind: 'user' });

    expect(outcome.ok).toBe(true);
    expect(spawned).toEqual(['t1']);
  });

  it('refuses a task with no prompt, as the scheduler does', async () => {
    const { session, spawned } = setup();
    session.loadPlan(plan([createTask({ id: 'np', order: 1, title: 'No prompt' })]), 'goal', testWorkspace, { persist: false });

    const outcome = await session.execute({ command: 'run_task', task: 'np' }, { kind: 'user' });

    expect(outcome).toMatchObject({ ok: false, message: expect.stringMatching(/no prompt/i) });
    expect(spawned).toEqual([]);
  });

  it('refuses a force start of a task with no prompt too', async () => {
    const { session, spawned } = setup();
    session.loadPlan(plan([createTask({ id: 'np', order: 1, title: 'No prompt' })]), 'goal', testWorkspace, { persist: false });

    const outcome = await session.execute({ command: 'force_start', task: 'np' }, { kind: 'user' });

    expect(outcome).toMatchObject({ ok: false, message: expect.stringMatching(/no prompt/i) });
    expect(spawned).toEqual([]);
  });
});
