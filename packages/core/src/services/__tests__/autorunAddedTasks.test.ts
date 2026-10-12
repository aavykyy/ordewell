import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { taskOf } from './sessionTestKit';
import { changeSettings, ctx, NOW, prose, settled, supervised, task, until, type Env, type Options } from './supervisorTestKit';

/**
 * With autorun on and Full, the planner may start a task added after the plan
 * was approved, when it asks; both are read at the start (ADR-0030).
 */

beforeEach(() => {
  vi.useFakeTimers({ now: NOW, toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
});

afterEach(() => {
  vi.useRealTimers();
});

const AUTORUN_FULL: Options = { settings: { supervisorLevel: 'off', autorun: true }, config: { autonomousMode: true } };

/** A plan the user ran, its one task finished, and the user's next turn open. */
async function finishedRun(options: Options = AUTORUN_FULL): Promise<Env> {
  const env = await supervised([task('t1', 1)], options);
  env.run.of('t1').reportComplete({ status: 'done', summary: '' });
  await until(() => taskOf(env.session, 't1')!.status === 'completed');
  await settled();
  void env.session.continueConversation('also add a cache and run it');
  await until(() => env.planner.calls.length === 1);
  return env;
}

const added = (env: Env) => env.session.planTasks.find((t) => t.title === 'Add a cache');

async function addCache(env: Env, ops = false): Promise<void> {
  const edit = await env.planner.tools().editPlan!({ ops: [{ op: 'add', task: { title: 'Add a cache', prompt: 'add a cache', ...(ops ? { ops: true } : {}) } }] }, ctx);
  expect(edit.isError).toBeFalsy();
}

async function landEdit(env: Env, call = 0): Promise<void> {
  env.planner.calls[call].finish(prose('Added a cache.'));
  await settled();
}

const executionLines = (env: Env) =>
  (env.session.planState!.conversationHistory ?? []).filter((e) => e.kind === 'execution').map((e) => e.content);

describe('a task the planner adds after approval, with autorun on and Full', () => {
  it('starts when the planner asks in a later reply, and the start approves it', async () => {
    const env = await finishedRun();
    await addCache(env);
    await landEdit(env);
    void env.session.continueConversation('run it');
    await until(() => env.planner.calls.length === 2);

    const started = await env.planner.tools().runTask!({ task: 'Add a cache' }, ctx);

    expect(started.isError).toBeFalsy();
    await until(() => env.run.spawnedIds().includes(added(env)!.id));
    expect(env.session.planState!.approvedTasks).toContain(added(env)!.id);
    expect(executionLines(env).at(-1)).toBe(`The planner started task #2 "Add a cache".`);
  });

  it('starts once the edit lands when the planner adds it and asks in the same reply', async () => {
    const env = await finishedRun();
    await addCache(env);

    const queued = await env.planner.tools().runTask!({ task: 'Add a cache' }, ctx);
    expect(JSON.parse(queued.text).result).toMatch(/^Queued: start "Add a cache" happens once your edit lands/);
    expect(env.run.spawnedIds()).toEqual(['t1']);
    await landEdit(env);

    await until(() => env.run.spawnedIds().includes(added(env)!.id));
  });

  it('starts an added ops task too', async () => {
    const env = await finishedRun();
    await addCache(env, true);
    await landEdit(env);
    void env.session.continueConversation('run it');
    await until(() => env.planner.calls.length === 2);

    expect((await env.planner.tools().runTask!({ task: 'Add a cache' }, ctx)).isError).toBeFalsy();
  });

  it('runs the plan with its added task through run_plan', async () => {
    const env = await finishedRun();
    await addCache(env);
    await landEdit(env);
    void env.session.continueConversation('run the plan');
    await until(() => env.planner.calls.length === 2);

    const ran = await env.planner.tools().runPlan!({}, ctx);

    expect(ran.isError).toBeFalsy();
    // The scheduler holds new starts while the turn is open.
    expect(JSON.parse(ran.text).result).toBe('The plan is running: what is ready starts once this reply ends, and the rest as their dependencies finish.');
    env.planner.calls[1].finish(prose('Running it.'));
    await until(() => env.run.spawnedIds().includes(added(env)!.id));
  });
});

describe('a task the planner adds after approval waits for the user', () => {
  async function refusedStart(env: Env): Promise<string> {
    await addCache(env);
    await landEdit(env);
    void env.session.continueConversation('run it');
    await until(() => env.planner.calls.length === 2);
    const start = await env.planner.tools().runTask!({ task: 'Add a cache' }, ctx);
    expect(start.isError).toBe(true);
    await settled();
    expect(env.run.spawnedIds()).toEqual(['t1']);
    return JSON.parse(start.text).reason as string;
  }

  it('with autorun off', async () => {
    const env = await finishedRun({ settings: { supervisorLevel: 'off', autorun: false }, config: { autonomousMode: true } });
    expect(await refusedStart(env)).toMatch(/was added after the user approved the plan/);
  });

  it('under Guarded, without asking on the card first', async () => {
    const env = await finishedRun({ settings: { supervisorLevel: 'off', autorun: true }, config: { autonomousMode: false } });
    expect(await refusedStart(env)).toMatch(/was added after the user approved the plan/);
    expect(env.messages.filter((m) => m.type === 'approval_request')).toEqual([]);
  });

  it('when autorun is turned off after the task was added: the setting is read at the start', async () => {
    const env = await finishedRun();
    await addCache(env);
    await landEdit(env);
    changeSettings(env, { autorun: false });
    void env.session.continueConversation('run it');
    await until(() => env.planner.calls.length === 2);

    const start = await env.planner.tools().runTask!({ task: 'Add a cache' }, ctx);

    expect(start.isError).toBe(true);
    expect(env.session.planState!.approvedTasks).not.toContain(added(env)!.id);
  });
});
