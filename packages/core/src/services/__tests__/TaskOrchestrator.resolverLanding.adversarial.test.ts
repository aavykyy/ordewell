import { describe, it, expect, vi } from 'vitest';
import { TaskOrchestrator } from '../TaskOrchestrator';
import { createTask, type Task } from '../../models/Task';
import type { IRunner } from '../../interfaces/IRunner';
import { fakeConfig, FakeRunnerSession, FakeWorktreeIsolation, flushMicrotasks } from '../../testing';
import { fakeNotification } from './sessionTestKit';
import { BufferedTaskOutputSource } from '../BufferedTaskOutputSource';

/**
 * Adversarial: a task's worktree is not torn down under a landing that
 * belongs to it but was started by another task — the conflict resolver a
 * passed verdict or Mark complete lands the conflicted task through
 * (`Landing.landResolved`). A delete of the conflicted task while its
 * resolver lands waits for the merge, and a retry is refused, as they are
 * under the task's own Mark complete (the release takes the workspace admin
 * lock, a landing holds the turn, so nothing else orders them).
 */

function setup(config: Parameters<typeof fakeConfig>[0] = {}) {
  const sessions: FakeRunnerSession[] = [];
  const spawn = vi.fn(async (opts: Parameters<IRunner['spawn']>[0]) => {
    const session = new FakeRunnerSession(`s${sessions.length + 1}`, opts.taskId, `native-${opts.taskId}-${sessions.length + 1}`);
    sessions.push(session);
    return session;
  });
  const runner: IRunner = { spawn, stop: vi.fn(), stopAll: vi.fn(), activeCount: 0 };
  const isolation = new FakeWorktreeIsolation();
  const orchestrator = TaskOrchestrator.compose({
    config: fakeConfig(config),
    notifications: fakeNotification(),
    runner,
    output: new BufferedTaskOutputSource(),
    isolation,
    workspaceRoot: () => '/repo',
    workspaceEnv: async () => ({ env: {}, blockedEnvrc: null, refused: [], trackedEnvFile: null }),
  });
  const latest = (taskId: string) => sessions.filter((s) => s.taskId === taskId).at(-1)!;
  const ops = () => isolation.calls.map((c) => ('taskId' in c ? `${c.op}:${c.taskId}` : c.op));
  return { orchestrator, isolation, latest, ops };
}

const change = (id: string, order: number, over: Partial<Task> = {}) =>
  createTask({ id, order, title: `Task ${id}`, prompt: `do ${id}`, ...over });

/** t1 conflicted and waits on the user; t2, its resolver, is running. */
async function resolving() {
  const env = setup({ conflictRepairAttempts: 0 });
  env.isolation.outcomes.set('t1', 'conflict');
  env.orchestrator.loadPlan([change('t1', 1), change('t2', 2)]);
  await env.orchestrator.forceStartTask('t1');
  env.latest('t1').reportComplete({ status: 'done', summary: '' });
  await vi.waitFor(() => expect(env.orchestrator.storeInstance.get('t1')!.status).toBe('awaiting_user'));
  await env.orchestrator.forceStartTask('t2');
  env.orchestrator.runs.linkResolver('t2', 't1');
  // The resolver brought t1's branch along, so landing t1 now merges clean.
  env.isolation.outcomes.set('t1', 'merged');
  return env;
}

describe('execution audit: a release waits for a landing started by a resolver', () => {
  it('holds a delete of the conflicted task until a passed resolver has landed it', async () => {
    const env = await resolving();
    const openMerge = env.isolation.holdIntegration('t1');
    env.latest('t2').reportComplete({ status: 'done', summary: '' });
    await vi.waitFor(() => expect(env.isolation.taskIdsFor('integrate').filter((id) => id === 't1')).toHaveLength(2));

    let released = false;
    const release = env.orchestrator.releaseTask('t1').then(() => { released = true; });
    await flushMicrotasks();
    expect(released).toBe(false);
    expect(env.isolation.taskIdsFor('release')).toEqual([]);

    openMerge();
    await release;
    const ops = env.ops();
    expect(ops.lastIndexOf('release:t1')).toBeGreaterThan(ops.lastIndexOf('integrate:t1'));
  });

  it('refuses a retry of the conflicted task while its resolver lands it, and lands it', async () => {
    const env = await resolving();
    const openMerge = env.isolation.holdIntegration('t1');
    const marked = env.orchestrator.markTaskComplete('t2');
    await vi.waitFor(() => expect(env.isolation.taskIdsFor('integrate').filter((id) => id === 't1')).toHaveLength(2));

    await expect(env.orchestrator.retryTask('t1')).rejects.toThrow('is being marked complete: its work is landing');
    expect(env.isolation.taskIdsFor('release')).toEqual([]);

    openMerge();
    await marked;
    expect(env.orchestrator.storeInstance.get('t1')!.status).toBe('completed');
  });

  it('does not release the conflicted task while its resolver lands it', async () => {
    const env = await resolving();
    const openMerge = env.isolation.holdIntegration('t1');
    const marked = env.orchestrator.markTaskComplete('t2');
    await vi.waitFor(() => expect(env.isolation.taskIdsFor('integrate').filter((id) => id === 't1')).toHaveLength(2));

    // What PlanEditor.removeTask calls for the conflicted task while the resolver lands it.
    let released = false;
    const release = env.orchestrator.releaseTask('t1').then(() => { released = true; });
    await flushMicrotasks();
    expect(released).toBe(false);
    expect(env.isolation.taskIdsFor('release')).toEqual([]);

    openMerge();
    await marked;
    await release;
    const ops = env.ops();
    expect(ops.lastIndexOf('release:t1')).toBeGreaterThan(ops.lastIndexOf('integrate:t1'));
  });
});
