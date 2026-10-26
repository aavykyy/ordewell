import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ExecutionRecord } from '../../models/Execution';
import { taskOf } from './sessionTestKit';
import { ctx, NOW, prose, supervised, task, until, type Env } from './supervisorTestKit';

/**
 * A supervised run end to end (ADR-0029): three tasks in a chain, the second
 * fails, and the supervisor wakes to it. At Act it rewrites the task's prompt
 * and retries it; at Watch the same edit is refused and the user is told.
 */

beforeEach(() => {
  vi.useFakeTimers({ now: NOW, toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
});

afterEach(() => {
  vi.useRealTimers();
});

const chain = () => [task('t1', 1), task('t2', 2, { dependencies: ['t1'] }), task('t3', 3, { dependencies: ['t2'] })];

const records = (env: Env): ExecutionRecord[] =>
  env.session.planState!.conversationHistory!.flatMap((e) => (e.execution ? [e.execution] : []));

const supervisorSaid = (env: Env): string[] =>
  env.session.planState!.conversationHistory!.filter((e) => e.kind === 'supervisor').map((e) => e.content);

/** The run up to its wake-up turn: task 1 passed, task 2 failed, and the supervisor is woken to it. */
async function failedSecond(level: 'watch' | 'act'): Promise<Env> {
  const env = await supervised(chain(), { settings: { supervisorLevel: level } });
  env.run.of('t1').reportComplete({ status: 'done', summary: 'scaffolded' });
  await until(() => env.run.spawnedIds().includes('t2'));
  env.run.of('t2').reportComplete({ status: 'failed', summary: '', reason: 'the import is wrong' });
  await until(() => env.planner.calls.length === 1);
  expect(env.planner.calls[0].message).toMatch(/task #2 "Task t2" failed/);
  expect(env.run.spawnedIds()).toEqual(['t1', 't2']);
  return env;
}

describe('a supervised run at Act', () => {
  it('wakes on a failure, rewrites and retries the task, and the run finishes', async () => {
    const env = await failedSecond('act');

    const edit = await env.planner.tools().editPlan!({ ops: [{ op: 'update', taskId: '#2', changes: { prompt: 'do t2, importing from ./lib' } }] }, ctx);
    const retry = await env.planner.tools().retryTask!({ task: '2', from: 'fresh' }, ctx);
    expect(edit.isError, edit.text).toBeFalsy();
    expect(retry.isError, retry.text).toBeFalsy();
    // Nothing starts while the wake-up turn is open: its start hold keeps the retry, already as edited (ADR-0022 P2).
    expect(env.run.spawnedIds()).toEqual(['t1', 't2']);
    env.planner.calls[0].finish(prose('Task 2 imported from the wrong place; I fixed its prompt and retried it.'));

    await until(() => env.run.spawnedIds().length === 3);
    expect(env.run.spawnedIds()).toEqual(['t1', 't2', 't2']);
    expect(env.run.runner.spawn.mock.calls[2][0].prompt).toContain('do t2, importing from ./lib');
    env.run.of('t2').reportComplete({ status: 'done', summary: 'fixed' });
    await until(() => env.run.spawnedIds().includes('t3'));
    env.run.of('t3').reportComplete({ status: 'done', summary: 'finished' });
    await until(() => env.session.status === 'completed');

    expect(env.session.planTasks.map((t) => t.status)).toEqual(['completed', 'completed', 'completed']);
    expect(env.session.isExecuting).toBe(false);
    expect(records(env)).toEqual([
      expect.objectContaining({ command: 'run_plan', actor: 'user', outcome: 'done' }),
      expect.objectContaining({ command: 'retry_task', actor: 'supervisor', level: 'act', outcome: 'done', task: expect.objectContaining({ id: 't2', ref: '#2' }) }),
    ]);
    expect(supervisorSaid(env)).toEqual([
      'Tasks updated:\n- Updated "Task t2" (prompt)',
      'Task 2 imported from the wrong place; I fixed its prompt and retried it.',
    ]);
    expect(env.messages).toContainEqual(expect.objectContaining({ type: 'planner_message', supervisor: true }));
    expect(env.session.executionLog.find((s) => s.id === 't2')).toMatchObject({ retryCount: 1, verdict: { outcome: 'pass' } });
  });
});

describe('a supervised run at Watch', () => {
  it('refuses the same edit, retries nothing, and tells the user what it suggests', async () => {
    const env = await failedSecond('watch');

    const edit = await env.planner.tools().editPlan!({ ops: [{ op: 'update', taskId: '#2', changes: { prompt: 'do t2, importing from ./lib' } }] }, ctx);
    const retry = await env.planner.tools().retryTask!({ task: '2', from: 'fresh' }, ctx);
    expect(edit.isError).toBe(true);
    expect(JSON.parse(edit.text).errors[0].message).toMatch(/^Plan edits are refused in a wake-up turn/);
    expect(JSON.parse(retry.text)).toMatchObject({ ok: false, outcome: 'refused', reason: expect.stringMatching(/at Watch.*Suggest it to the user instead/) });
    env.planner.calls[0].finish(prose('Task 2 imports from the wrong place. I suggest pointing its prompt at ./lib and retrying it; reply "yes" and I will.'));
    await until(() => supervisorSaid(env).length === 1);

    expect(supervisorSaid(env)).toEqual(['Task 2 imports from the wrong place. I suggest pointing its prompt at ./lib and retrying it; reply "yes" and I will.']);
    expect(env.messages).toContainEqual(expect.objectContaining({ type: 'planner_message', supervisor: true }));
    expect(taskOf(env.session, 't2')).toMatchObject({ prompt: 'do t2', status: 'failed' });
    expect(env.run.spawnedIds()).toEqual(['t1', 't2']);
    expect(records(env)).toEqual([
      expect.objectContaining({ command: 'run_plan', actor: 'user', outcome: 'done' }),
      expect.objectContaining({ command: 'retry_task', actor: 'supervisor', level: 'watch', outcome: 'refused' }),
    ]);
  });
});
