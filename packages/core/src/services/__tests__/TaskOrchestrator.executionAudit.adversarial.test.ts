import { describe, it, expect, vi } from 'vitest';
import { TaskOrchestrator } from '../TaskOrchestrator';
import { createTask, type Task } from '../../models/Task';
import type { IRunner } from '../../interfaces/IRunner';
import { fakeConfig, FakeRunnerSession, FakeWorktreeIsolation, flushMicrotasks } from '../../testing';
import { fakeNotification } from './sessionTestKit';
import { BufferedTaskOutputSource } from '../BufferedTaskOutputSource';

/**
 * Adversarial: execution-audit reproductions.
 *
 * - Two force starts queued behind the same dependency both wait for a slot;
 *   a start that cannot claim one stays queued (the start rule leaves slots to
 *   the claim), rather than being dropped with a warning.
 * - Mark complete owns the worktree while it lands: a release, as PlanEditor's
 *   removeTask makes, must not tear the worktree down under the integration.
 * - A planner turn's start hold holds every new spawn, conflict repairs
 *   included (ADR-0029), so a repair does not start under the turn's edits.
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
  const notifications = fakeNotification();
  const orchestrator = TaskOrchestrator.compose({
    config: fakeConfig(config),
    notifications,
    runner,
    output: new BufferedTaskOutputSource(),
    isolation,
    workspaceRoot: () => '/repo',
    workspaceEnv: async () => ({ env: {}, blockedEnvrc: null, refused: [], trackedEnvFile: null }),
  });
  const spawned = (taskId: string) => sessions.filter((s) => s.taskId === taskId).length;
  const latest = (taskId: string) => sessions.filter((s) => s.taskId === taskId).at(-1)!;
  const notices = () => (['info', 'warn', 'error'] as const)
    .flatMap((level) => vi.mocked(notifications[level]).mock.calls.map(([message]) => String(message)));
  const ops = () => isolation.calls.map((c) => ('taskId' in c ? `${c.op}:${c.taskId}` : c.op));
  return { orchestrator, isolation, sessions, spawn, spawned, latest, notices, ops };
}

const change = (id: string, order: number, over: Partial<Task> = {}) =>
  createTask({ id, order, title: `Task ${id}`, prompt: `do ${id}`, ...over });

describe('execution audit: a queued force start waits for a slot', () => {
  it('keeps the second force start queued when the first takes the only slot', async () => {
    const env = setup({ maxParallelSessions: 1 });
    env.orchestrator.loadPlan([
      change('a', 1),
      change('c', 2, { dependencies: ['a'] }),
      change('d', 3, { dependencies: ['a'] }),
    ]);
    await env.orchestrator.forceStartTask('a');
    expect(await env.orchestrator.forceStartTask('c')).toMatch(/starts once task "Task a" finishes/);
    expect(await env.orchestrator.forceStartTask('d')).toMatch(/starts once task "Task a" finishes/);

    env.latest('a').reportComplete({ status: 'done', summary: '' });
    await vi.waitFor(() => expect(env.spawned('c')).toBe(1));

    // d's dependency finished too. It cannot claim the only slot c holds, so it
    // is still queued and starts when c frees it — not silently forgotten.
    expect(env.spawned('d')).toBe(0);
    expect(env.orchestrator.startsPending).toBe(true);
    expect(env.notices()).not.toContainEqual(expect.stringContaining('did not start once its dependencies finished'));

    env.latest('c').reportComplete({ status: 'done', summary: '' });
    await vi.waitFor(() => expect(env.spawned('d')).toBe(1));
    expect(env.orchestrator.startsPending).toBe(false);
  });
});

describe('execution audit: a release does not tear down a landing', () => {
  it('releaseTask waits for Mark complete\'s integration before releasing its worktree', async () => {
    const env = setup();
    env.orchestrator.loadPlan([change('t1', 1)]);
    await env.orchestrator.forceStartTask('t1');

    const openMerge = env.isolation.holdIntegration('t1');
    const marked = env.orchestrator.markTaskComplete('t1');
    await vi.waitFor(() => expect(env.isolation.taskIdsFor('integrate')).toEqual(['t1']));

    // What PlanEditor.removeTask calls for every task of a removal.
    let released = false;
    const release = env.orchestrator.releaseTask('t1').then(() => { released = true; });
    await flushMicrotasks();
    expect(released).toBe(false);
    expect(env.isolation.taskIdsFor('release')).toEqual([]);

    openMerge();
    await marked;
    await release;
    const ops = env.ops();
    expect(ops.indexOf('release:t1')).toBeGreaterThan(ops.indexOf('integrate:t1'));
    expect(env.isolation.calls).toContainEqual({ op: 'release', taskId: 't1', keep: false });
  });

  it('cancels the repair a conflicting Mark complete claims, rather than leaving it running for a removed task', async () => {
    const env = setup({ conflictRepairAttempts: 1 });
    env.isolation.outcomes.set('t1', 'conflict');
    env.orchestrator.loadPlan([change('t1', 1)]);
    await env.orchestrator.forceStartTask('t1');

    const openMerge = env.isolation.holdIntegration('t1');
    const marked = env.orchestrator.markTaskComplete('t1');
    await vi.waitFor(() => expect(env.isolation.taskIdsFor('integrate')).toEqual(['t1']));
    const release = env.orchestrator.releaseTask('t1');

    openMerge();
    await marked;
    await release;
    await flushMicrotasks();

    expect(env.orchestrator.activeTaskIds).toEqual([]);
    for (const session of env.sessions.slice(1)) expect(session.killed || session.stopped).toBe(true);
  });
});

describe('execution audit: a planner start hold holds repairs too', () => {
  it('does not spawn a conflict repair while starts are held, and keeps the run open for it', async () => {
    const env = setup({ maxParallelSessions: 2, conflictRepairAttempts: 1 });
    env.isolation.outcomes.set('t1', 'conflict');
    env.orchestrator.loadPlan([change('t1', 1)]);
    await env.orchestrator.forceStartTask('t1');

    const releaseStarts = env.orchestrator.holdStarts();
    env.latest('t1').reportComplete({ status: 'done', summary: '' });
    await vi.waitFor(() => expect(env.isolation.taskIdsFor('integrate')).toEqual(['t1']));
    await flushMicrotasks();

    expect(env.spawned('t1')).toBe(1);
    expect(env.notices()).toContainEqual('Task "Task t1" is repaired once the planner\'s turn ends.');
    // The repair still owed is a start on its way: the run is not handed over under it.
    expect(env.orchestrator.startsPending).toBe(true);
    expect(env.ops()).not.toContain('handoff');

    releaseStarts();
    await env.orchestrator.tick();
    await vi.waitFor(() => expect(env.spawned('t1')).toBe(2));
    expect(env.orchestrator.startsPending).toBe(false);
  });
});
