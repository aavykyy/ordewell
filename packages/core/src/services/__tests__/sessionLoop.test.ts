import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Task } from '../../models/Task';
import type { ExecutionActor } from '../../models/Execution';
import { WAKE_DEBOUNCE_MS } from '../Supervisor';
import { makeSession, taskOf, testWorkspace } from './sessionTestKit';
import { heldPlanner, NOW, prose, recordingRunner, settled, supervised, task, until, type Env } from './supervisorTestKit';

/**
 * A loop under supervision (ADR-0045): its rounds wake no one and count for
 * no guard, the supervisor hears once when it runs out of rounds, and a
 * saved session resumes it mid-round.
 */

beforeEach(() => {
  vi.useFakeTimers({ now: NOW, toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
});

afterEach(() => { vi.useRealTimers(); });

const ACT: ExecutionActor = { kind: 'supervisor', level: 'act' };

const looped = (maxRounds: number): Task[] => [
  task('review', 1, { loop: { body: ['fix'], maxRounds } }),
  task('fix', 2, { dependencies: ['review'] }),
  task('ship', 3, { dependencies: ['review'] }),
];

const spawns = (env: Env, taskId: string) => env.run.spawnedIds().filter((id) => id === taskId).length;

async function finish(env: Env, taskId: string, n: number, status: 'done' | 'failed', summary = `${taskId}: ${status}`): Promise<void> {
  await until(() => spawns(env, taskId) === n);
  env.run.of(taskId).reportComplete({ status, summary, ...(status === 'failed' ? { reason: summary } : {}) });
  await until(() => taskOf(env.session, taskId)?.status === (status === 'done' ? 'completed' : 'failed'));
}

describe('a loop under supervision (ADR-0045)', () => {
  it('wakes an Act supervisor once, when the loop runs out of rounds, and never for a round', async () => {
    const env = await supervised(looped(3), { settings: { supervisorLevel: 'act' } });

    await finish(env, 'review', 1, 'failed', 'Round one finding.');
    await finish(env, 'fix', 1, 'done');
    await finish(env, 'review', 2, 'failed', 'Round two finding.');
    await finish(env, 'fix', 2, 'done');
    await vi.advanceTimersByTimeAsync(WAKE_DEBOUNCE_MS * 2);
    await settled();
    expect(env.planner.calls).toHaveLength(0);
    // Three runs of the check are more than the retry limit allows the supervisor; the loop's are no retries of its.
    expect(env.session.planState!.supervision?.guards).toMatchObject({ retries: {}, failedWith: {} });

    await finish(env, 'review', 3, 'failed', 'Round three finding.');
    await vi.advanceTimersByTimeAsync(WAKE_DEBOUNCE_MS);
    await until(() => env.planner.calls.length === 1);

    const update = env.planner.calls[0].message;
    expect(update).toContain('its loop ran out of rounds: it failed all 3');
    expect(update).toContain('Round three finding.');
    expect(update).not.toContain('Round one finding.');
    env.planner.calls[0].finish(prose('The review still fails after three rounds.'));
    await settled();
    expect(env.planner.calls).toHaveLength(1);
    env.session.destroy();
  });

  it('closes a loop a direct edit leaves out of rounds, and wakes its supervisor once', async () => {
    const tasks = [
      task('review', 1, { loop: { body: ['fix', 'fix2'], maxRounds: 3 } }),
      task('fix', 2, { dependencies: ['review'] }),
      task('fix2', 3, { dependencies: ['review', 'fix'] }),
      task('ship', 4, { dependencies: ['review'] }),
    ];
    const env = await supervised(tasks, { settings: { supervisorLevel: 'act' } });
    await finish(env, 'review', 1, 'failed', 'Round one finding.');
    await until(() => spawns(env, 'fix') === 1);

    await env.session.updateTask('review', { loop: { body: ['fix', 'fix2'], maxRounds: 1 } });

    expect(taskOf(env.session, 'fix2')).toMatchObject({ status: 'skipped', skipReason: 'not run: the loop ran out of rounds' });
    await finish(env, 'fix', 1, 'done');
    await vi.advanceTimersByTimeAsync(WAKE_DEBOUNCE_MS);
    await until(() => env.planner.calls.length === 1);
    expect(env.planner.calls[0].message).toContain('its loop ran out of rounds: it failed all 1');
    env.session.destroy();
  });

  it('leaves the check between rounds to its loop: the supervisor neither retries nor skips it, and nothing is counted', async () => {
    const env = await supervised(looped(3), { settings: { supervisorLevel: 'act' } });
    await finish(env, 'review', 1, 'failed');

    const retried = await env.session.execute({ command: 'retry_task', task: 'review', from: 'fresh' }, ACT);
    const skipped = await env.session.execute({ command: 'skip_task', task: 'review', reason: 'enough' }, ACT);
    const continued = await env.session.execute({ command: 'retry_task', task: 'review', from: 'session', message: 'look again' }, ACT);

    expect(retried).toMatchObject({ ok: false });
    expect(retried.message).toContain('between rounds of its loop');
    expect(skipped).toMatchObject({ ok: false });
    expect(skipped.message).toContain('between rounds of its loop');
    expect(continued).toMatchObject({ ok: false });
    expect(continued.message).toContain('between rounds of its loop');
    expect(env.session.planState!.supervision?.guards?.retries).toEqual({});
    await finish(env, 'fix', 1, 'done');
    await finish(env, 'review', 2, 'done');
    await until(() => spawns(env, 'ship') === 1);
    env.session.destroy();
  });

  it('sends the report a check owes once a failing body task stops its loop, at any level', async () => {
    const tasks = looped(3);
    tasks[0] = { ...tasks[0], reportTo: { actor: 'planner-turn', consent: { by: 'card' } } };
    const env = await supervised(tasks, { settings: { supervisorLevel: 'off' } });

    await finish(env, 'review', 1, 'failed', 'Round one finding.');
    await finish(env, 'fix', 1, 'failed', 'Could not fix it.');
    await vi.advanceTimersByTimeAsync(WAKE_DEBOUNCE_MS * 3);

    await until(() => env.planner.calls.length === 1);
    expect(env.planner.calls[0].message).toContain('Round one finding.');
    expect(taskOf(env.session, 'review')?.reportTo).toBeUndefined();
    env.session.destroy();
  });

  it('refuses the user\'s removal of a loop\'s check, and takes a removed body task out of its loop', async () => {
    const env = await supervised(looped(3), { execute: false });

    await expect(env.session.removeTask('review')).rejects.toThrow('"Task review" is a loop\'s check: remove its body tasks first');
    await env.session.removeTask('fix');

    expect(taskOf(env.session, 'review')?.loop).toBeUndefined();
    env.session.destroy();
  });

  it('takes a loop through the user\'s direct edit, refusing one of the wrong shape', async () => {
    const env = await supervised(looped(3), { execute: false });

    await expect(env.session.updateTask('review', { loop: { body: [], maxRounds: 3 } })).rejects.toThrow('This task has a "loop" with an empty "body"');
    await env.session.updateTask('review', { loop: { body: ['fix'], maxRounds: 5 } });
    expect(taskOf(env.session, 'review')?.loop).toEqual({ body: ['fix'], maxRounds: 5 });
    await env.session.updateTask('review', { loop: null } as unknown as Partial<Task>);
    expect(taskOf(env.session, 'review')?.loop).toBeUndefined();
    env.session.destroy();
  });

  it('resumes a saved session mid-round: Execute runs the body, then the check again, as the next round', async () => {
    const env = await supervised(looped(3));
    await finish(env, 'review', 1, 'failed', 'Found it.');
    await until(() => spawns(env, 'fix') === 1);
    const saved = structuredClone(env.session.planState!);
    env.session.destroy();

    const planner = heldPlanner();
    const run = recordingRunner();
    const session = makeSession({ aiService: planner.aiService, runner: run.runner });
    session.loadPlan(saved, 'build it', testWorkspace);
    expect(taskOf(session, 'review')?.status).toBe('failed');
    expect(await session.execute({ command: 'run_plan' }, { kind: 'user' })).toMatchObject({ ok: true });

    await until(() => run.spawnedIds().includes('fix'));
    expect(run.spawnedIds()).toEqual(['fix']);
    expect(run.runner.spawn.mock.calls[0][0].prompt).toContain('Found it.');
    run.of('fix').reportComplete({ status: 'done', summary: 'fixed' });
    await until(() => run.spawnedIds().includes('review'));
    expect(taskOf(session, 'review')?.loopRound).toBe(2);
    session.destroy();
  });
});
