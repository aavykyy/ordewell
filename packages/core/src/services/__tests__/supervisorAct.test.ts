import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ExecutionRecord } from '../../models/Execution';
import { makeSession, taskOf, testWorkspace } from './sessionTestKit';
import { FakeWorktreeIsolation } from '../../testing';
import { ctx, hitLimit, NOW, plan, prose, RESUME_AT, settled, supervised, task, until, waitForInput, wokenUp, type Env, type Options } from './supervisorTestKit';
import { WAKE_DEBOUNCE_MS } from '../Supervisor';
import { WAKE_UP_RATE } from '../LoopGuards';

const ACT: Options = { plan: { supervisorLevel: 'act' } };

const records = (env: Env): ExecutionRecord[] =>
  env.session.planState!.conversationHistory!.flatMap((e) => (e.execution ? [e.execution] : []));

beforeEach(() => {
  vi.useFakeTimers({ now: NOW, toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
});

afterEach(() => {
  vi.useRealTimers();
});

describe('a wake-up turn at Act', () => {
  it('runs the execution tools without asking, recorded as the supervisor\'s', async () => {
    const env = await wokenUp({ ...ACT, config: { autonomousMode: false } });
    const tools = env.planner.tools();

    const answered = await tools.messageTask!({ task: '1', text: 'use Postgres' }, ctx);
    const stopped = await tools.stopTask!({ task: '2' }, ctx);

    expect(answered.isError).toBeFalsy();
    expect(stopped.isError).toBeFalsy();
    expect(env.run.of('t1').delivered).toContain('use Postgres');
    expect(taskOf(env.session, 't2')!.status).toBe('pending');
    expect(records(env).map((r) => [r.command, r.actor, r.level, r.outcome])).toEqual([
      ['message_task', 'supervisor', 'act', 'done'],
      ['stop_task', 'supervisor', 'act', 'done'],
    ]);
  });

  it('edits the plan through the recorded edit path, shown as the supervisor\'s', async () => {
    const env = await wokenUp(ACT, [task('t1', 1), task('t2', 2, { dependencies: ['t1'] })]);

    const edit = await env.planner.tools().editPlan!({ ops: [{ op: 'update', taskId: '#2', changes: { prompt: 'do t2 with Postgres' } }] }, ctx);
    expect(edit.isError).toBeFalsy();
    env.planner.calls[0].finish(prose('Task 2 now uses Postgres.'));
    await settled();

    expect(taskOf(env.session, 't2')!.prompt).toBe('do t2 with Postgres');
    const tail = env.session.planState!.conversationHistory!.slice(-2);
    expect(tail.map((e) => [e.kind, e.content])).toEqual([
      ['supervisor', 'Task 2 now uses Postgres.'],
      ['supervisor', 'Tasks updated:\n- Updated "Task t2" (prompt)'],
    ]);
  });

  it('refuses a whole new plan: the supervisor edits, it does not replan from scratch', async () => {
    const env = await wokenUp(ACT);

    const submit = await env.planner.tools().submitPlan!({ tasks: [{ title: 'Something else' }] }, ctx);

    expect(submit.isError).toBe(true);
    expect(JSON.parse(submit.text).errors[0].message).toMatch(/^A whole new plan is refused in a wake-up turn/);
  });
});

const SUPERVISOR = { kind: 'supervisor', level: 'act' } as const;

const byTitle = (env: Env, title: string) => env.session.planTasks.find((t) => t.title === title)!;

describe('tasks the supervisor adds at Act', () => {
  it('are marked as the supervisor\'s, approved to run, and start without the user — an ops task included', async () => {
    const env = await wokenUp(ACT, [task('t1', 1), task('t2', 2, { dependencies: ['t1'] })]);

    await env.planner.tools().editPlan!({ ops: [
      { op: 'add', task: { title: 'Add a cache', prompt: 'add a cache' } },
      { op: 'add', task: { title: 'Restart the service', prompt: 'restart it', ops: true } },
    ] }, ctx);
    env.planner.calls[0].finish(prose('Added a cache and a restart.'));
    await settled();

    const cache = byTitle(env, 'Add a cache');
    const restart = byTitle(env, 'Restart the service');
    expect([cache.addedBy, restart.addedBy]).toEqual(['supervisor', 'supervisor']);
    expect(restart.ops).toBe(true);
    expect(env.session.planState!.approvedTasks).toEqual(expect.arrayContaining([cache.id, restart.id]));
    await until(() => env.run.spawnedIds().includes(cache.id) && env.run.spawnedIds().includes(restart.id));
  });

  it('may be started by the supervisor itself once the run has stopped, where a task the user\'s turn added may not', async () => {
    const env = await wokenUp(ACT, [task('t1', 1)]);
    await env.planner.tools().editPlan!({ ops: [{ op: 'add', task: { title: 'Add a cache', prompt: 'add a cache' } }] }, ctx);
    env.planner.calls[0].finish(prose('Added a cache.'));
    await settled();
    await env.session.execute({ command: 'stop_run' }, { kind: 'user' });

    const answered = env.session.continueConversation('add a docs task');
    await until(() => env.planner.calls.length === 2);
    env.planner.calls[1].finish({ kind: 'task_ops', ops: [{ op: 'add', task: { title: 'Write docs', prompt: 'write docs' } }], text: '', researchLog: [] });
    await answered;
    const docs = byTitle(env, 'Write docs');
    expect(docs.addedBy).toBeUndefined();

    expect(await env.session.execute({ command: 'run_task', task: byTitle(env, 'Add a cache').id }, SUPERVISOR)).toMatchObject({ ok: true });
    expect(await env.session.execute({ command: 'run_task', task: docs.id }, SUPERVISOR)).toMatchObject({ ok: false, message: expect.stringMatching(/added after the user approved the plan/) });
    expect(env.run.spawnedIds()).not.toContain(docs.id);
  });

  it('cannot be marked as the supervisor\'s by the planner itself', async () => {
    const env = await wokenUp(ACT, [task('t1', 1)]);
    env.planner.calls[0].finish(prose('Task 1 waits for input.'));
    await settled();

    const answered = env.session.continueConversation('add a docs task');
    await until(() => env.planner.calls.length === 2);
    env.planner.calls[1].finish({ kind: 'task_ops', ops: [{ op: 'add', task: { title: 'Write docs', prompt: 'write docs', addedBy: 'supervisor' } }], text: '', researchLog: [] });
    await answered;

    const docs = byTitle(env, 'Write docs');
    expect(docs.addedBy).toBeUndefined();
    expect(env.session.planState!.approvedTasks).not.toContain(docs.id);
  });
});

/** Task 1 paused on claude-code's usage limit, and the supervisor woken to it at Act. */
async function limited(tasks = [task('t1', 1), task('t2', 2)], pause: string[] = ['t1']): Promise<Env> {
  const env = await supervised(tasks, ACT);
  for (const id of pause) hitLimit(env.run.of(id));
  await settled();
  await vi.advanceTimersByTimeAsync(WAKE_DEBOUNCE_MS);
  await until(() => env.planner.calls.length === 1);
  expect(taskOf(env.session, 't1')!.resumeAt).toBe(RESUME_AT);
  return env;
}

const moveToOpus = { op: 'update', taskId: '#1', changes: { assignedModel: { modelId: 'claude-opus-4', modelLabel: 'Opus' } } } as const;

describe('moving a task paused on a usage limit', () => {
  it('cancels its scheduled resume: it waits for a retry on what it was moved to', async () => {
    const env = await limited();

    await env.planner.tools().editPlan!({ ops: [moveToOpus] }, ctx);
    env.planner.calls[0].finish(prose('Moved task 1 to Opus.'));
    await settled();

    const t1 = taskOf(env.session, 't1')!;
    expect(t1.assignedModel?.modelId).toBe('claude-opus-4');
    expect([t1.status, t1.awaitingReason, t1.resumeAt]).toEqual(['awaiting_user', 'usage-limit', undefined]);
    await vi.advanceTimersByTimeAsync(Date.parse(RESUME_AT) - Date.now() + 1000);
    await settled();
    expect(env.run.spawnedIds().filter((id) => id === 't1')).toHaveLength(1);
  });

  it('leaves the resume of every other paused task alone, with nothing else running', async () => {
    const env = await limited([task('t1', 1), task('t2', 2)], ['t1', 't2']);
    expect(env.session.isExecuting).toBe(false);

    await env.planner.tools().editPlan!({ ops: [moveToOpus] }, ctx);
    env.planner.calls[0].finish(prose('Moved task 1 to Opus.'));
    await settled();

    expect(taskOf(env.session, 't1')!.resumeAt).toBeUndefined();
    expect(taskOf(env.session, 't2')!.resumeAt).toBe(RESUME_AT);
    await vi.advanceTimersByTimeAsync(Date.parse(RESUME_AT) - Date.now() + 1000);
    await until(() => env.run.spawnedIds().filter((id) => id === 't2').length === 2);
    expect(env.run.spawnedIds().filter((id) => id === 't1')).toHaveLength(1);
  });
});

const notes = (env: Env) => env.session.planState!.conversationHistory!.filter((e) => e.kind === 'supervisor').map((e) => e.content);

/** A one-task run whose task failed, with the supervisor woken to it at Act. */
async function failedOnce(over: Options['plan'] = {}): Promise<Env> {
  const env = await supervised([task('t1', 1)], { plan: { supervisorLevel: 'act', ...over } });
  env.run.of('t1').reportComplete({ status: 'failed', summary: '', reason: 'the import is wrong' });
  await until(() => env.planner.calls.length === 1);
  return env;
}

/** The next wake-up turn, on task 1 failing again. */
async function failsAgain(env: Env, calls: number): Promise<void> {
  await until(() => env.run.spawnedIds().filter((id) => id === 't1').length === calls);
  env.run.of('t1').reportComplete({ status: 'failed', summary: '', reason: 'still wrong' });
  await until(() => env.planner.calls.length === calls);
}

describe('the loop guards', () => {
  it('refuses a retry past the plan\'s retry limit, and escalates the task to the user once', async () => {
    const env = await failedOnce({ supervisorRetryLimit: 1 });
    const first = await env.planner.tools().retryTask!({ task: '1', from: 'session', message: 'fix the import' }, ctx);
    expect(first.isError).toBeFalsy();
    env.planner.calls[0].finish(prose('Retried task 1 with a fix.'));
    await failsAgain(env, 2);

    const second = await env.planner.tools().retryTask!({ task: '1', from: 'session', message: 'try harder' }, ctx);
    const third = await env.planner.tools().retryTask!({ task: '1', from: 'session', message: 'once more' }, ctx);

    expect(JSON.parse(second.text).reason).toBe('Refused by the retry limit: you have retried task #1 "Task t1" once this run, the most the plan allows. It is escalated to the user now: tell them what you tried, and do not retry it again.');
    expect(third.isError).toBe(true);
    expect(env.run.spawnedIds().filter((id) => id === 't1')).toHaveLength(2);
    expect(notes(env).filter((n) => n.startsWith('Loop guard, retry limit'))).toEqual([
      'Loop guard, retry limit: I retried task #1 "Task t1" once this run, the most the plan allows, and stopped. It needs you: retry it, change it or skip it.',
    ]);
  });

  it('counts retries across the runs the supervisor restarts itself, and starts afresh when the user starts', async () => {
    const env = await failedOnce({ supervisorRetryLimit: 1 });
    await env.planner.tools().retryTask!({ task: '1', from: 'session', message: 'fix the import' }, ctx);
    env.planner.calls[0].finish(prose('Retried task 1.'));
    await failsAgain(env, 2);
    env.planner.calls[1].finish(prose('Task 1 failed again.'));
    await settled();

    await env.session.retryTask('t1');
    await failsAgain(env, 3);

    expect((await env.planner.tools().retryTask!({ task: '1', from: 'session', message: 'and again' }, ctx)).isError).toBeFalsy();
  });

  it('refuses a retry after a failure with the prompt and model unchanged: change something or escalate', async () => {
    const env = await failedOnce();

    const retry = await env.planner.tools().retryTask!({ task: '1', from: 'fresh' }, ctx);

    expect(retry.isError).toBe(true);
    expect(JSON.parse(retry.text).reason).toMatch(/^Refused: task #1 "Task t1" failed with this same prompt and model.*Change something or escalate/);
    expect(notes(env)).toContainEqual(expect.stringMatching(/^Loop guard, identical retry: I tried to retry task #1 "Task t1" unchanged/));
    expect(env.run.spawnedIds()).toEqual(['t1']);
  });

  it('runs a retry asked for after an edit in the same reply once the edit lands, as edited', async () => {
    const env = await failedOnce();

    await env.planner.tools().editPlan!({ ops: [{ op: 'update', taskId: '#1', changes: { prompt: 'do t1, importing from ./lib' } }] }, ctx);
    const retry = await env.planner.tools().retryTask!({ task: '1', from: 'fresh' }, ctx);
    expect(JSON.parse(retry.text).result).toMatch(/^Queued: retry task #1 "Task t1" happens once your edit lands/);
    expect(env.run.spawnedIds()).toEqual(['t1']);
    env.planner.calls[0].finish(prose('Fixed the import in task 1 and retried it.'));

    await until(() => env.run.spawnedIds().length === 2);
    expect(env.run.runner.spawn.mock.calls[1][0].prompt).toContain('do t1, importing from ./lib');
    expect(env.session.planState!.conversationHistory!.at(-1)).toMatchObject({ kind: 'execution', content: 'Retried task #1 "Task t1" — by supervisor.' });
  });

  it('refuses re-adding a task it removed this run, and undoing its own edit', async () => {
    const env = await wokenUp(ACT, [task('t1', 1), task('t2', 2, { dependencies: ['t1'] }), task('t3', 3, { dependencies: ['t1'] })]);
    await env.planner.tools().editPlan!({ ops: [{ op: 'remove', taskId: '#3' }, { op: 'update', taskId: '#2', changes: { prompt: 'do t2 with Postgres' } }] }, ctx);
    env.planner.calls[0].finish(prose('Dropped task 3; task 2 uses Postgres.'));
    await settled();
    await env.session.execute({ command: 'message_task', task: 't1', text: 'carry on' }, { kind: 'user' });
    waitForInput(env.run.of('t1'));
    await settled();
    await vi.advanceTimersByTimeAsync(WAKE_DEBOUNCE_MS);
    await until(() => env.planner.calls.length === 2);

    const readd = await env.planner.tools().editPlan!({ ops: [{ op: 'add', task: { title: 'Task t3', prompt: 'do t3' } }] }, ctx);
    const revert = await env.planner.tools().editPlan!({ ops: [{ op: 'update', taskId: '#2', changes: { prompt: 'do t2' } }] }, ctx);

    expect(JSON.parse(readd.text).errors[0].message).toMatch(/^Edit refused: it re-adds "task t3", which you removed earlier this run/);
    expect(JSON.parse(revert.text).errors[0].message).toMatch(/^Edit refused: it changes the prompt of "Task t2" back to what it was before your own earlier edit/);
    expect(notes(env).filter((n) => n.startsWith('Loop guard, oscillating edits'))).toHaveLength(2);
    env.planner.calls[1].finish(prose('I would undo that, but it needs you.'));
    await settled();
    expect(taskOf(env.session, 't2')!.prompt).toBe('do t2 with Postgres');
  });

  it('drops the run to Watch when it keeps waking with nothing passing, with a notice', async () => {
    const env = await supervised([task('t1', 1)], ACT);
    for (let i = 0; i < WAKE_UP_RATE.max + 1; i++) {
      waitForInput(env.run.of('t1'));
      await settled();
      await vi.advanceTimersByTimeAsync(WAKE_DEBOUNCE_MS);
      await until(() => env.planner.calls.length === i + 1);
      if (i === WAKE_UP_RATE.max) break;
      expect(env.planner.calls[i].message).toMatch(/At Act you may act/);
      env.planner.calls[i].finish(prose('Answered task 1.'));
      await settled();
      await env.session.execute({ command: 'message_task', task: 't1', text: 'carry on' }, { kind: 'user' });
    }

    expect(env.planner.calls.at(-1)!.message).toMatch(/At Watch you only suggest/);
    expect(env.session.planState!.runSettings!.supervisorLevel).toBe('watch');
    expect(env.session.planState!.supervisorLevel).toBe('act');
    expect(env.notices).toContainEqual(expect.objectContaining({ level: 'warn', message: expect.stringMatching(/^Loop guard, wake-up rate: /) }));
    expect(notes(env)).toContainEqual(expect.stringMatching(/^Loop guard, wake-up rate: I woke 7 times .* with no task passing.*Watch for the rest of this run/));
  });
});

describe('merge_all as a planner tool', () => {
  /** An Act run whose change task landed, its ops task waiting at the gate, and the supervisor woken by task 3. */
  async function gated() {
    const isolation = new FakeWorktreeIsolation();
    const tasks = [task('t1', 1), task('o2', 2, { ops: true, dependencies: ['t1'] }), task('t3', 3)];
    const env = await supervised(tasks, { ...ACT, isolation, config: { worktreeIsolation: true } });
    env.run.of('t1').reportComplete({ status: 'done', summary: '' });
    await until(() => env.session.mergeGate('o2').length === 1);
    waitForInput(env.run.of('t3'));
    await settled();
    await vi.advanceTimersByTimeAsync(WAKE_DEBOUNCE_MS);
    await until(() => env.planner.calls.length === 1);
    return { ...env, merges: () => isolation.calls.filter((c) => c.op === 'mergeIntoCheckedOut').length };
  }

  it('merges in a wake-up turn at Act, and the gate opens', async () => {
    const env = await gated();

    const merged = await env.planner.tools().mergeAll!({}, ctx);

    expect(merged.isError).toBeFalsy();
    expect(env.merges()).toBe(1);
    expect(env.session.mergeGate('o2')).toEqual([]);
  });

  it('is refused in the user\'s own turn: they press Merge all themselves', async () => {
    const env = await gated();
    env.planner.calls[0].finish(prose('Task 3 waits for input.'));
    await settled();

    void env.session.continueConversation('merge it for me');
    await until(() => env.planner.calls.length === 2);
    const merge = await env.planner.tools().mergeAll!({}, ctx);

    expect(merge.isError).toBe(true);
    expect(JSON.parse(merge.text).reason).toMatch(/^Merge all is the user's/);
    expect(env.merges()).toBe(0);
  });
});

describe('lowering the supervisor mid-run', () => {
  it('to Watch applies at once, in the wake-up turn under way too, and leaves the next run\'s setting alone', async () => {
    const env = await wokenUp(ACT);

    env.session.lowerSupervisor('watch');
    const stop = await env.planner.tools().stopTask!({ task: '2' }, ctx);
    const edit = await env.planner.tools().editPlan!({ ops: [{ op: 'update', taskId: '#2', changes: { prompt: 'do t2 better' } }] }, ctx);

    expect(JSON.parse(stop.text).reason).toMatch(/You are the supervisor at Watch/);
    expect(JSON.parse(edit.text).errors[0].message).toMatch(/you are the supervisor at Watch/);
    expect(taskOf(env.session, 't2')!.status).toBe('in_progress');
    expect(env.session.planState!.runSettings!.supervisorLevel).toBe('watch');
    expect(env.session.planState!.supervisorLevel).toBe('act');
    expect(env.session.planState!.conversationHistory!).toContainEqual(expect.objectContaining({ kind: 'system', content: 'You dropped the supervisor to Watch for the rest of this run.' }));
  });

  it('off stops the wake-ups; what was gathered reaches the planner with the user\'s next message', async () => {
    const env = await supervised([task('t1', 1), task('t2', 2)], ACT);
    waitForInput(env.run.of('t1'));
    await settled();

    env.session.lowerSupervisor('off');
    await vi.advanceTimersByTimeAsync(WAKE_DEBOUNCE_MS * 4);
    waitForInput(env.run.of('t2'));
    await settled();
    await vi.advanceTimersByTimeAsync(WAKE_DEBOUNCE_MS * 4);
    expect(env.planner.calls).toHaveLength(0);
    expect(env.session.planState!.runSettings!.supervisorLevel).toBe('off');

    void env.session.continueConversation('what is waiting?');
    await until(() => env.planner.calls.length === 1);
    expect(env.planner.calls[0].message).toMatch(/Run update:\n- task #1 "Task t1" is waiting for input[\s\S]*what is waiting\?$/);
    expect(env.planner.calls[0].message).not.toMatch(/task #2/);
  });

  it('never raises it, and needs a run', async () => {
    const env = await supervised([task('t1', 1)], { plan: { supervisorLevel: 'watch' } });
    env.session.lowerSupervisor('watch');
    expect(env.session.planState!.conversationHistory!.filter((e) => e.content.includes('dropped the supervisor'))).toHaveLength(0);

    env.session.lowerSupervisor('off');
    env.session.lowerSupervisor('watch');
    expect(env.session.planState!.runSettings!.supervisorLevel).toBe('off');

    const idle = makeSession({});
    idle.loadPlan(plan([task('t1', 1)], { supervisorLevel: 'act' }), 'build it', testWorkspace, { persist: false });
    expect(() => idle.lowerSupervisor('off')).toThrow(/No run has started/);
  });
});
