import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { taskOf } from './sessionTestKit';
import { ctx, NOW, prose, settled, supervised, task, until, type Env } from './supervisorTestKit';
import type { TaskOp } from '../TaskOps';

/**
 * Consent is to a body (ADR-0035): a script task in a plan the user executed
 * is approved with it, and an edit that changes what it runs takes it out of
 * the approval record, so the scheduler holds it until the user approves the
 * new body.
 */

beforeEach(() => {
  vi.useFakeTimers({ now: NOW, toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
});

afterEach(() => {
  vi.useRealTimers();
});

const push = [['git', 'push', 'origin', 'main']];

/** A run of a change task and the script that pushes it, the user's next turn open and answered with `ops`. */
async function editedDuringRun(ops: TaskOp[]): Promise<Env> {
  const env = await supervised(
    [task('t1', 1), task('s2', 2, { type: 'script', prompt: undefined, taskMode: undefined, commands: push, dependencies: ['t1'] })],
    { settings: { supervisorLevel: 'off', autorun: false } },
  );
  void env.session.continueConversation('push the tags too');
  await until(() => env.planner.calls.length === 1);
  const edit = await env.planner.tools().editPlan!({ ops }, ctx);
  expect(edit.isError).toBeFalsy();
  env.planner.calls[0].finish(prose('Changed the push.'));
  await settled();
  return env;
}

const approved = (env: Env) => env.session.planState!.approvedTasks ?? [];

describe('a script task\'s body and the approval record', () => {
  it('is approved with the plan the user executed, and runs once its dependency finishes', async () => {
    const env = await supervised([task('t1', 1), task('s2', 2, { type: 'script', prompt: undefined, taskMode: undefined, commands: push, dependencies: ['t1'] })]);

    expect(approved(env)).toEqual(['t1', 's2']);
    env.run.of('t1').reportComplete({ status: 'done', summary: '' });

    await until(() => env.scripts.spawnedIds().includes('s2'));
    expect(env.scripts.runner.spawn).toHaveBeenCalledWith(expect.objectContaining({ script: { commands: push, timeoutMs: 600_000 } }));
    expect(env.run.spawnedIds()).toEqual(['t1']);
  });

  it('leaves the approved set when an edit changes its body, and the scheduler does not start it', async () => {
    const env = await editedDuringRun([{ op: 'update', taskId: 's2', changes: { commands: [['git', 'push', 'origin', 'main', '--tags']] } }]);

    expect(approved(env)).toEqual(['t1']);
    expect(env.session.waitsForApproval('s2')).toBe(true);

    env.run.of('t1').reportComplete({ status: 'done', summary: '' });
    await until(() => taskOf(env.session, 't1')!.status === 'completed');
    await settled();

    expect(env.scripts.spawnedIds()).toEqual([]);
    expect(taskOf(env.session, 's2')!.status).not.toBe('in_progress');
  });

  it('leaves it too when an edit changes only its time limit', async () => {
    const env = await editedDuringRun([{ op: 'update', taskId: 's2', changes: { timeoutMs: 1_000 } }]);

    expect(approved(env)).toEqual(['t1']);
  });

  it('keeps it approved through an edit that leaves what it runs alone', async () => {
    const env = await editedDuringRun([{ op: 'update', taskId: 's2', changes: { title: 'Push main' } }]);

    expect(approved(env)).toEqual(['t1', 's2']);
  });

  it('runs the new body once the user approves it by executing the plan', async () => {
    const env = await editedDuringRun([{ op: 'update', taskId: 's2', changes: { commands: [['git', 'push', '--tags']] } }]);
    env.run.of('t1').reportComplete({ status: 'done', summary: '' });
    await until(() => taskOf(env.session, 't1')!.status === 'completed');

    await env.session.execute({ command: 'run_plan' }, { kind: 'user' });

    await until(() => env.scripts.spawnedIds().includes('s2'));
    expect(env.scripts.runner.spawn).toHaveBeenLastCalledWith(expect.objectContaining({ script: { commands: [['git', 'push', '--tags']], timeoutMs: 600_000 } }));
  });
});
