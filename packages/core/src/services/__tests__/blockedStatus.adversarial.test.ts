import { describe, it, expect, vi } from 'vitest';
import { TaskOrchestrator } from '../TaskOrchestrator';
import { PlanStore } from '../PlanStore';
import { createTask, type Task } from '../../models/Task';
import type { IRunner } from '../../interfaces/IRunner';
import { fakeConfig, FakeRunnerSession } from '../../testing';
import { fakeNotification } from './sessionTestKit';
import { BufferedTaskOutputSource } from '../BufferedTaskOutputSource';
import { blockingFailures } from '../blocking';

/**
 * Adversarial: the stored `blocked` status is gone. A plan file that still
 * holds one loads it as pending, and whether a task is blocked is decided by
 * the derived rule alone — so a failure, and the retry that lifts it, are all
 * it takes.
 */

/** A task saved before ADR-0034, when the status was stored. */
const saved = (id: string, over: Partial<Task> = {}): Task =>
  ({ ...createTask({ id, title: id, ...over }), status: 'blocked' } as unknown as Task);

describe('adversarial: a plan file with a stored blocked status', () => {
  it('loads it as pending, and the derived rule blocks it while a dependency is failed', () => {
    const store = new PlanStore();
    store.load([createTask({ id: 'a', title: 'a', status: 'failed' }), saved('b', { dependencies: ['a'] })], ['claude-code']);
    // load gives a failed task a fresh chance; a run fails it again.
    store.markFailed('a');

    expect(store.get('b')!.status).toBe('pending');
    expect(blockingFailures(store.allTasks).get('b')).toEqual(['a']);

    store.markPending('a');
    expect(blockingFailures(store.allTasks).has('b')).toBe(false);
  });

  it('reads a blocked subtask as pending too, and follows the same rule', () => {
    const store = new PlanStore();
    const parent: Task = { ...createTask({ id: 'p', title: 'p' }), subtasks: [saved('s', { dependencies: ['x'] })] };
    store.load([createTask({ id: 'x', title: 'x', status: 'failed' }), parent], ['claude-code']);
    store.markFailed('x');

    expect(store.get('s')!.status).toBe('pending');
    expect(blockingFailures(store.allTasks).get('s')).toEqual(['x']);
  });

  it('a reconciled edit (a mid-run plan) reads a stored blocked task as pending, keeping the failure that blocks it', () => {
    const sessions: FakeRunnerSession[] = [];
    const runner: IRunner = {
      spawn: vi.fn(async (opts: Parameters<IRunner['spawn']>[0]) => {
        const session = new FakeRunnerSession(`s${sessions.length + 1}`, opts.taskId);
        sessions.push(session);
        return session;
      }),
      stop: vi.fn(),
      stopAll: vi.fn(),
      activeCount: 0,
    };
    const orchestrator = TaskOrchestrator.compose({
      config: fakeConfig(),
      notifications: fakeNotification(),
      runner,
      output: new BufferedTaskOutputSource(),
      workspaceRoot: () => '/repo',
    });
    orchestrator.loadPlan([createTask({ id: 'a', title: 'a', prompt: 'do a' }), createTask({ id: 'b', title: 'b', prompt: 'do b', dependencies: ['a'] })]);
    orchestrator.storeInstance.markFailed('a');
    expect(orchestrator.getBlockedBy('b')).toEqual(['a']);

    orchestrator.reconcilePlan([
      createTask({ id: 'a', title: 'a', prompt: 'do a', status: 'failed' }),
      saved('b', { prompt: 'do b', dependencies: ['a'] }),
    ]);

    expect(orchestrator.storeInstance.get('b')!.status).toBe('pending');
    expect(orchestrator.getBlockedBy('b')).toEqual(['a']);
  });
});
