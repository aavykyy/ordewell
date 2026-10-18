import { describe, it, expect, vi } from 'vitest';
import { TaskOrchestrator } from '../TaskOrchestrator';
import { createTask, type Task } from '../../models/Task';
import type { IRunner } from '../../interfaces/IRunner';
import { fakeConfig, FakeRunnerSession, FakeWorktreeIsolation, flushMicrotasks } from '../../testing';
import { fakeNotification } from './sessionTestKit';
import { BufferedTaskOutputSource } from '../BufferedTaskOutputSource';

/**
 * Adversarial: the user's Stop withdraws every start admitted before it. A
 * verdict whose landing is still in flight when the Stop comes must not land
 * its work as a completion afterwards, and nothing it would release may start.
 */

function setup() {
  const sessions: FakeRunnerSession[] = [];
  const spawn = vi.fn(async (opts: Parameters<IRunner['spawn']>[0]) => {
    const session = new FakeRunnerSession(`s${sessions.length + 1}`, opts.taskId);
    sessions.push(session);
    return session;
  });
  const runner: IRunner = { spawn, stop: vi.fn(), stopAll: vi.fn(), activeCount: 0 };
  const isolation = new FakeWorktreeIsolation();
  const orchestrator = TaskOrchestrator.compose({
    config: fakeConfig(),
    notifications: fakeNotification(),
    runner,
    output: new BufferedTaskOutputSource(),
    isolation,
    workspaceRoot: () => '/repo',
  });
  const pass = (taskId: string) => sessions.filter((s) => s.taskId === taskId).at(-1)!.reportComplete({ status: 'done', summary: '' });
  const status = (taskId: string) => orchestrator.storeInstance.get(taskId)!.status;
  return { orchestrator, isolation, spawn, pass, status };
}

const change = (id: string, order: number, over: Partial<Task> = {}) =>
  createTask({ id, order, title: `Task ${id}`, prompt: `do ${id}`, ...over });

describe('adversarial: a Stop while a landing is in flight', () => {
  it('does not complete the task or start what depended on it', async () => {
    const env = setup();
    env.orchestrator.loadPlan([change('t1', 1), change('t2', 2, { dependencies: ['t1'] })]);
    await env.orchestrator.approveReview();
    const openMerge = env.isolation.holdIntegration('t1');

    env.pass('t1');
    await vi.waitFor(() => expect(env.isolation.taskIdsFor('integrate')).toEqual(['t1']));

    env.orchestrator.stop();
    openMerge();
    await flushMicrotasks(30);

    expect(env.spawn).toHaveBeenCalledTimes(1);
    expect(env.status('t1')).toBe('pending');
    expect(env.status('t2')).toBe('pending');
    expect(env.orchestrator.hasLiveWork).toBe(false);
  });

  it('does not complete a task Mark complete landed while the Stop came', async () => {
    const env = setup();
    env.orchestrator.loadPlan([change('t1', 1)]);
    await env.orchestrator.approveReview();
    const openMerge = env.isolation.holdIntegration('t1');

    const marked = env.orchestrator.markTaskComplete('t1');
    await flushMicrotasks();
    env.orchestrator.stop();
    openMerge();
    await marked;

    // The user's own act stands: Mark complete vouches for the work.
    expect(env.status('t1')).toBe('completed');
    expect(env.orchestrator.hasLiveWork).toBe(false);
  });
});
