import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { taskOf } from './sessionTestKit';
import { ctx, NOW, prose, settled, supervised, task, until, type Env, type Options } from './supervisorTestKit';

/**
 * The user approves tasks the planner added after the plan was approved: by
 * running the plan while a run is under way, or by force starting one, and
 * neither starts a task before its dependencies finish.
 */

beforeEach(() => {
  vi.useFakeTimers({ now: NOW, toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
});

afterEach(() => {
  vi.useRealTimers();
});

const AUTORUN_OFF: Options = { settings: { supervisorLevel: 'off', autorun: false }, config: { autonomousMode: true } };

const byTitle = (env: Env, title: string) => env.session.planTasks.find((t) => t.title === title)!;
const infoNotices = (env: Env) => env.notices.filter((n) => n.level === 'info').map((n) => n.message);

/** A run under way on t1, and tasks the planner added in the user's turn since, each waiting for approval. */
async function waitingDuringRun(adds: { title: string; dependencies?: string[] }[], tasks = [task('t1', 1)]): Promise<Env> {
  const env = await supervised(tasks, AUTORUN_OFF);
  void env.session.continueConversation('add some tasks');
  await until(() => env.planner.calls.length === 1);
  const edit = await env.planner.tools().editPlan!({
    ops: adds.map(({ title, dependencies }) => ({ op: 'add', task: { title, prompt: title.toLowerCase(), ...(dependencies ? { dependencies } : {}) } })),
  }, ctx);
  expect(edit.isError).toBeFalsy();
  env.planner.calls[0].finish(prose('Added them.'));
  await settled();
  for (const { title } of adds) expect(env.session.waitsForApproval(byTitle(env, title).id)).toBe(true);
  return env;
}

describe('running the plan while a run is under way', () => {
  it('approves every task that waits for approval, and each starts once its dependencies finish', async () => {
    const env = await waitingDuringRun([
      { title: 'Add a cache', dependencies: ['#1'] },
      { title: 'Warm the cache', dependencies: ['#1'] },
    ]);

    const outcome = await env.session.execute({ command: 'run_plan' }, { kind: 'user' });

    expect(outcome).toMatchObject({ ok: true, message: 'Approved 2 tasks; each starts once its dependencies finish.' });
    expect(infoNotices(env)).toContain('Approved 2 tasks; each starts once its dependencies finish.');
    expect(env.session.waitsForApproval(byTitle(env, 'Add a cache').id)).toBe(false);
    expect(env.run.spawnedIds()).toEqual(['t1']);

    env.run.of('t1').reportComplete({ status: 'done', summary: '' });
    await until(() => env.run.spawnedIds().length === 3);
  });

  it('starts at once an approved task with nothing left to wait on', async () => {
    const env = await waitingDuringRun([{ title: 'Add a cache' }]);

    await env.session.executePlan();

    expect(infoNotices(env)).toContain('Approved 1 task; it starts once its dependencies finish.');
    await until(() => env.run.spawnedIds().includes(byTitle(env, 'Add a cache').id));
    expect(taskOf(env.session, 't1')!.status).toBe('in_progress');
  });

  it('says so when nothing waits for approval', async () => {
    const env = await supervised([task('t1', 1)], AUTORUN_OFF);

    const outcome = await env.session.execute({ command: 'run_plan' }, { kind: 'user' });

    expect(outcome).toMatchObject({ ok: true, message: 'The plan is already running, and no task waits for your approval.' });
    expect(env.run.spawnedIds()).toEqual(['t1']);
  });
});

describe('force starting a task whose dependencies have not finished', () => {
  it('approves it and queues it rather than starting it early, and says so; it starts once they finish', async () => {
    const env = await waitingDuringRun([{ title: 'Add a cache', dependencies: ['#1'] }]);
    const cache = byTitle(env, 'Add a cache').id;

    await env.session.forceStartTask(cache);

    expect(env.run.spawnedIds()).toEqual(['t1']);
    expect(env.session.waitsForApproval(cache)).toBe(false);
    expect(infoNotices(env)).toContain('Task "Add a cache" is approved and starts once task "Task t1" finishes.');

    env.run.of('t1').reportComplete({ status: 'done', summary: '' });
    await until(() => env.run.spawnedIds().includes(cache));
  });

  it('says that nothing will start it while no run is under way', async () => {
    const env = await supervised([task('t1', 1), task('t2', 2, { dependencies: ['t1'] })], { ...AUTORUN_OFF, execute: false });

    await env.session.forceStartTask('t2');

    expect(env.run.spawnedIds()).toEqual([]);
    expect(infoNotices(env)).toContain('Task "Task t2" is approved and starts once task "Task t1" finishes. Nothing is running now: run the plan to start them.');
  });

  it('still starts a task blocked by a failed dependency: forcing past a failure is the user\'s call (ADR-0034)', async () => {
    const env = await supervised([task('t1', 1), task('t2', 2, { dependencies: ['t1'] })], AUTORUN_OFF);
    env.run.of('t1').reportComplete({ status: 'failed', summary: 'broke' });
    await until(() => taskOf(env.session, 't1')!.status === 'failed');

    await env.session.forceStartTask('t2');

    expect(env.run.spawnedIds()).toEqual(['t1', 't2']);
  });
});
