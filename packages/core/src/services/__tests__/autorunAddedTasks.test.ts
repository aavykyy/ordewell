import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { taskOf } from './sessionTestKit';
import { EMPTY_CONVERSATION, reduceConversation } from '../../conversation';
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
    expect(JSON.parse(queued.text).result).toMatch(/^Queued: start task #2 "Add a cache" happens once your edit lands/);
    expect(env.run.spawnedIds()).toEqual(['t1']);
    await landEdit(env);

    await until(() => env.run.spawnedIds().includes(added(env)!.id));
  });

  it('starts a task named by the handle the same reply\'s edit gave it, once the edit lands', async () => {
    const env = await finishedRun();
    const edit = await env.planner.tools().editPlan!({ ops: [{ op: 'add', task: { title: 'Add a cache', prompt: 'add a cache' }, handle: 'cache' }] }, ctx);
    expect(edit.isError).toBeFalsy();

    const queued = await env.planner.tools().runTask!({ task: 'cache' }, ctx);
    expect(JSON.parse(queued.text).result).toMatch(/^Queued: start task #2 "Add a cache" happens once your edit lands/);
    await landEdit(env);

    await until(() => env.run.spawnedIds().includes(added(env)!.id));
    expect(executionLines(env).at(-1)).toBe(`The planner started task #2 "Add a cache".`);
  });

  it('refuses at once, rather than queueing, a start naming no task the plan has or the edit adds', async () => {
    const env = await finishedRun();
    await addCache(env);

    const start = await env.planner.tools().runTask!({ task: 'no-such-task' }, ctx);

    expect(start.isError).toBe(true);
    expect(JSON.parse(start.text).reason).toBe('No task matches "no-such-task" in the current plan. Your edit does not add it either. Name it by id, "#order" (a subtask "#order.sub") or exact title.');
  });

  it('refuses at once a start of a task the same reply\'s edit removes', async () => {
    const env = await finishedRun();
    await addCache(env);
    const removed = await env.planner.tools().editPlan!({ ops: [{ op: 'add', task: { title: 'Warm the cache', prompt: 'warm it' }, handle: 'warm' }, { op: 'remove', taskId: 'warm' }] }, ctx);
    expect(removed.isError).toBeFalsy();

    const start = await env.planner.tools().runTask!({ task: 'warm' }, ctx);

    expect(start.isError).toBe(true);
    expect(JSON.parse(start.text).reason).toMatch(/^No task matches "warm" in the current plan\. Your edit does not add it either\./);
    await landEdit(env);
    await settled();
    expect(env.run.spawnedIds()).toEqual(['t1']);
  });

  it('refuses at once a start behind the edit that could not run as edited, rather than queueing it', async () => {
    const env = await supervised([task('t1', 1)], AUTORUN_FULL);
    void env.session.continueConversation('add a cache after task 1 and run it');
    await until(() => env.planner.calls.length === 1);
    await env.planner.tools().editPlan!({ ops: [{ op: 'add', task: { title: 'Add a cache', prompt: 'add a cache', dependencies: ['#1'] } }] }, ctx);

    const start = await env.planner.tools().runTask!({ task: 'Add a cache' }, ctx);

    expect(start.isError).toBe(true);
    expect(JSON.parse(start.text).reason).toBe('Task #2 "Add a cache" depends on task #1 "Task t1" (running), which has not finished. It can start once it has.');
    await landEdit(env);
    expect(env.run.spawnedIds()).toEqual(['t1']);
  });

  it('says a start queued behind the edit that is refused once it lands, to the user and to the next turn', async () => {
    const env = await finishedRun();
    await addCache(env);
    const queued = await env.planner.tools().runTask!({ task: 'Add a cache' }, ctx);
    expect(JSON.parse(queued.text).result).toMatch(/^Queued: start task #2 "Add a cache"/);
    // Read at the start: the user turns autorun off before the reply ends.
    changeSettings(env, { autorun: false });

    await landEdit(env);
    await settled();

    const refusal = 'Task #2 "Add a cache" was added after the user approved the plan, so it is not approved to run. Ask the user to start it, or to execute the plan, which approves it.';
    const history = env.session.planState!.conversationHistory!;
    expect(history.filter((e) => e.execution?.outcome === 'refused').map((e) => e.execution!.detail)).toEqual([refusal]);
    expect(history.at(-1)).toMatchObject({ kind: 'system', content: `The queued start of task #2 "Add a cache" did not run: ${refusal}` });
    // The chat surfaces fold the session's messages into this view; VS Code and the TUI draw its system lines.
    const view = env.messages.reduce((v, message) => reduceConversation(v, message), EMPTY_CONVERSATION);
    expect(view.blocks.filter((b) => b.type === 'message' && b.role === 'system').map((b) => b.type === 'message' && b.text))
      .toContain(`The queued start of task #2 "Add a cache" did not run: ${refusal}`);
    void env.session.continueConversation('is it running?');
    await until(() => env.planner.calls.length === 2);
    expect(env.planner.calls[1].message).toContain(`Run update:\n- The queued start of task #2 "Add a cache" did not run: ${refusal}`);
    env.planner.calls[1].finish(prose('No.'));
    void env.session.continueConversation('and now?');
    await until(() => env.planner.calls.length === 3);
    expect(env.planner.calls[2].message).not.toContain('The queued start');
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

  it('when autorun is turned off before the edit lands: the setting is read as it lands', async () => {
    const env = await finishedRun();
    await addCache(env);
    changeSettings(env, { autorun: false });
    await landEdit(env);
    void env.session.continueConversation('run it');
    await until(() => env.planner.calls.length === 2);

    const start = await env.planner.tools().runTask!({ task: 'Add a cache' }, ctx);

    expect(start.isError).toBe(true);
    expect(env.session.planState!.approvedTasks).not.toContain(added(env)!.id);
  });
});

describe('with autorun on, a task the planner adds in the user\'s turn needs no approval', () => {
  async function addedDuringRun(options: Options): Promise<Env> {
    const env = await supervised([task('t1', 1)], options);
    void env.session.continueConversation('add a cache after task 1');
    await until(() => env.planner.calls.length === 1);
    const edit = await env.planner.tools().editPlan!({ ops: [{ op: 'add', task: { title: 'Add a cache', prompt: 'add a cache', dependencies: ['#1'] } }] }, ctx);
    expect(edit.isError).toBeFalsy();
    await landEdit(env);
    return env;
  }

  it.each([
    ['Full', AUTORUN_FULL],
    ['Guarded', { settings: { supervisorLevel: 'off', autorun: true }, config: { autonomousMode: false } } satisfies Options],
  ])('in %s: it is approved as it lands, and starts once its dependencies finish', async (_mode, options) => {
    const env = await addedDuringRun(options);

    expect(env.session.planState!.approvedTasks).toContain(added(env)!.id);
    expect(env.session.waitsForApproval(added(env)!.id)).toBe(false);
    expect(env.run.spawnedIds()).toEqual(['t1']);

    env.run.of('t1').reportComplete({ status: 'done', summary: '' });
    await until(() => env.run.spawnedIds().includes(added(env)!.id));
  });

  it('a task added while autorun was off is approved once the planner rewrites it with autorun on', async () => {
    const env = await addedDuringRun({ settings: { supervisorLevel: 'off', autorun: false }, config: { autonomousMode: true } });
    expect(env.session.waitsForApproval(added(env)!.id)).toBe(true);
    changeSettings(env, { autorun: true });
    void env.session.continueConversation('make the cache an LRU');
    await until(() => env.planner.calls.length === 2);

    const edit = await env.planner.tools().editPlan!({ ops: [{ op: 'update', taskId: '#2', changes: { prompt: 'add an LRU cache' } }] }, ctx);
    expect(edit.isError).toBeFalsy();
    await landEdit(env, 1);

    expect(env.session.waitsForApproval(added(env)!.id)).toBe(false);
  });

  it('with autorun off, it still waits for the user', async () => {
    const env = await addedDuringRun({ settings: { supervisorLevel: 'off', autorun: false }, config: { autonomousMode: true } });

    expect(env.session.waitsForApproval(added(env)!.id)).toBe(true);
    env.run.of('t1').reportComplete({ status: 'done', summary: '' });
    await until(() => taskOf(env.session, 't1')!.status === 'completed');
    await settled();
    expect(env.run.spawnedIds()).toEqual(['t1']);
  });
});
