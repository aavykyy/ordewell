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

describe('consent to a script task does not outlive its type', () => {
  it('leaves the approved set when an edit makes the approved script an AI task, which the scheduler then does not start', async () => {
    const env = await editedDuringRun([{ op: 'update', taskId: 's2', changes: { type: 'ai', prompt: 'do something else entirely' } }]);

    expect(approved(env)).toEqual(['t1']);
    env.run.of('t1').reportComplete({ status: 'done', summary: '' });
    await until(() => taskOf(env.session, 't1')!.status === 'completed');
    await settled();

    expect(env.run.spawnedIds()).toEqual(['t1']);
    expect(env.session.waitsForApproval('s2')).toBe(true);
  });
});

describe('with autorun on, a script task the planner writes in the user\'s turn', () => {
  /** A run under way, the user's turn adding a script task with `ops`, landed. */
  async function scriptAdded(options: Parameters<typeof supervised>[1], ops?: TaskOp[]): Promise<Env> {
    const env = await supervised([task('t1', 1)], options);
    void env.session.continueConversation('push main');
    await until(() => env.planner.calls.length === 1);
    const edit = await env.planner.tools().editPlan!({ ops: ops ?? [{ op: 'add', task: { title: 'Push main', type: 'script', commands: push } }] }, ctx);
    expect(edit.isError).toBeFalsy();
    env.planner.calls[0].finish(prose('Added the push.'));
    await settled();
    return env;
  }
  const script = (env: Env) => env.session.planTasks.find((t) => t.type === 'script')!;

  it('waits for the user\'s approval under Guarded, and the scheduler does not start it', async () => {
    const env = await scriptAdded({ config: { autonomousMode: false }, settings: { supervisorLevel: 'off', autorun: true } });

    expect(approved(env)).toEqual(['t1']);
    expect(env.session.waitsForApproval(script(env).id)).toBe(true);
    await settled();
    expect(env.scripts.spawnedIds()).toEqual([]);
  });

  it('is approved as it lands under Guarded when the effect allowlist covers it', async () => {
    const env = await scriptAdded({ config: { autonomousMode: false, effectAllowlist: ['git push origin *'] }, settings: { supervisorLevel: 'off', autorun: true } });

    expect(approved(env)).toContain(script(env).id);
  });

  it('is approved as it lands under Full, as run_script would run it', async () => {
    const env = await scriptAdded({ config: { autonomousMode: true }, settings: { supervisorLevel: 'off', autorun: true } });

    expect(approved(env)).toContain(script(env).id);
  });

  it('keeps autorun\'s approval of the AI task written beside it under Guarded', async () => {
    const env = await scriptAdded({ config: { autonomousMode: false }, settings: { supervisorLevel: 'off', autorun: true } }, [
      { op: 'add', task: { title: 'Add a cache', prompt: 'add a cache' } },
      { op: 'add', task: { title: 'Push main', type: 'script', commands: push } },
    ]);
    const cache = env.session.planTasks.find((t) => t.title === 'Add a cache')!;

    expect(approved(env)).toEqual(['t1', cache.id]);
  });

  it('stays unapproved under Guarded when the turn rewrites a script whose card the user denied', async () => {
    const env = await supervised([task('t1', 1)], { config: { autonomousMode: false }, settings: { supervisorLevel: 'off', autorun: true } });
    void env.session.continueConversation('push main');
    await until(() => env.planner.calls.length === 1);
    const reply = env.planner.tools().runScript!({ title: 'Push main', commands: push }, ctx);
    await until(() => env.messages.some((m) => m.type === 'approval_request'));
    const card = env.messages.find((m) => m.type === 'approval_request')!;
    if (card.type !== 'approval_request') throw new Error('no card');
    env.session.resolveApproval(card.id, false);
    await reply;
    const edit = await env.planner.tools().editPlan!({ ops: [{ op: 'update', taskId: '#2', changes: { commands: [['git', 'push', 'origin', 'main', '--force']] } }] }, ctx);
    expect(edit.isError).toBeFalsy();
    env.planner.calls[0].finish(prose('Changed the push.'));
    await settled();

    expect(approved(env)).toEqual(['t1']);
    expect(env.scripts.spawnedIds()).toEqual([]);
  });
});
