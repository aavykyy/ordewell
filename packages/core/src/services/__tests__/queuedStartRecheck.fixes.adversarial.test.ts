import { describe, it, expect, vi } from 'vitest';
import { TaskOrchestrator } from '../TaskOrchestrator';
import { createTask, type Task } from '../../models/Task';
import type { IRunner } from '../../interfaces/IRunner';
import { fakeConfig, FakeRunnerSession, FakeWorktreeIsolation, flushMicrotasks } from '../../testing';
import { fakeNotification } from './sessionTestKit';
import { BufferedTaskOutputSource } from '../BufferedTaskOutputSource';

/**
 * Adversarial, round two: the re-judgement a force start makes once its run
 * has opened (ADR-0034). The first round fixed a fresh dependency under way
 * sending it back; the neighbouring cases are a dependency removed again, one
 * already finished, and a planner turn's start hold taken while the run opens.
 */

function setup(isolation = new FakeWorktreeIsolation()) {
  const sessions: FakeRunnerSession[] = [];
  const spawn = vi.fn(async (opts: Parameters<IRunner['spawn']>[0]) => {
    const session = new FakeRunnerSession(`s${sessions.length + 1}`, opts.taskId, `native-${opts.taskId}-${sessions.length + 1}`);
    sessions.push(session);
    return session;
  });
  const runner: IRunner = { spawn, stop: vi.fn(), stopAll: vi.fn(), activeCount: 0 };
  const orchestrator = TaskOrchestrator.compose({
    config: fakeConfig(),
    notifications: fakeNotification(),
    runner,
    output: new BufferedTaskOutputSource(),
    isolation,
    workspaceRoot: () => '/repo',
    workspaceEnv: async () => ({ env: {}, blockedEnvrc: null, refused: [], trackedEnvFile: null }),
  });
  const store = orchestrator.storeInstance;
  const spawned = (taskId: string) => spawn.mock.calls.filter(([o]) => o.taskId === taskId).map(([o]) => o);
  const status = (taskId: string) => store.get(taskId)!.status;
  return { orchestrator, isolation, store, spawn, spawned, status };
}

const change = (id: string, order: number, over: Partial<Task> = {}) =>
  createTask({ id, order, title: `Task ${id}`, prompt: `do ${id}`, ...over });

/** Run `edit` while the run the start opens checks whether it isolates, which awaits git. */
function editWhileOpening(env: ReturnType<typeof setup>, edit: () => void): void {
  const isActive = env.isolation.isActive.bind(env.isolation);
  let edited = false;
  env.isolation.isActive = async (root) => {
    if (!edited) {
      edited = true;
      edit();
    }
    return isActive(root);
  };
}

describe('adversarial: a force start re-judged as its run opens, beyond the fresh dependency', () => {
  it('starts once the dependency an edit added while its run opened is removed again', async () => {
    const env = setup();
    env.orchestrator.loadPlan([change('a', 1), change('c', 2, { dependencies: ['a'] })]);
    expect(await env.orchestrator.forceStartTask('c')).toMatch(/starts once task "Task a" finishes/);
    env.store.add({ id: 'b', order: 3, title: 'Task b', prompt: 'do b', type: 'ai' });
    // Opening: b is added, so it goes back in the queue; then the edit that put
    // it there is undone before the next tick releases it.
    editWhileOpening(env, () => {
      env.store.update('c', { dependencies: ['a', 'b'] });
      env.store.update('c', { dependencies: ['a'] });
    });

    await env.orchestrator.markTaskComplete('a');
    await flushMicrotasks();

    await vi.waitFor(() => expect(env.spawned('c')).toHaveLength(1));
    expect(env.status('c')).toBe('in_progress');
  });

  it('starts past a dependency an edit adds while its run opens when that dependency is already done', async () => {
    const env = setup();
    env.orchestrator.loadPlan([change('a', 1), change('c', 2)]);
    await env.orchestrator.markTaskComplete('a');
    // The edit names a dependency that is completed and landed: nothing under way holds the start.
    editWhileOpening(env, () => env.store.update('c', { dependencies: ['a'] }));

    await env.orchestrator.forceStartTask('c');

    await vi.waitFor(() => expect(env.spawned('c')).toHaveLength(1));
    expect(env.status('c')).toBe('in_progress');
  });

  it('waits when a planner turn takes its start hold while the queued start opens, and goes once the hold is released', async () => {
    const env = setup();
    env.orchestrator.loadPlan([change('a', 1), change('c', 2, { dependencies: ['a'] })]);
    expect(await env.orchestrator.forceStartTask('c')).toMatch(/starts once task "Task a" finishes/);
    // The planner turn lands mid-open: new starts wait for its reply (ADR-0029).
    let releaseHold: (() => void) | undefined;
    editWhileOpening(env, () => { releaseHold = env.orchestrator.holdStarts(); });

    await env.orchestrator.markTaskComplete('a');
    await flushMicrotasks();

    expect(env.spawned('c')).toHaveLength(0);
    expect(env.orchestrator.startsPending).toBe(true);

    releaseHold!();
    await env.orchestrator.tick();

    await vi.waitFor(() => expect(env.spawned('c')).toHaveLength(1));
    expect(env.status('c')).toBe('in_progress');
  });
});
