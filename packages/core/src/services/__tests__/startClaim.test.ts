import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ctx, NOW, prose, settled, supervised, task, until, type Env, type Options } from './supervisorTestKit';

/**
 * Every attempt start passes one claim in the scheduler, which checks in one
 * synchronous step that the task is approved (ADR-0035), that no Stop came
 * since the start was admitted (ADR-0029), that a slot is free, and that the
 * task can still start. Driven through a real Session, its command seam and
 * its scheduler; only the runner process is faked.
 */

beforeEach(() => {
  vi.useFakeTimers({ now: NOW, toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
});

afterEach(() => {
  vi.useRealTimers();
});

const GUARDED: Options = { settings: { supervisorLevel: 'off', autorun: true }, config: { autonomousMode: false, maxParallelSessions: 2 } };

const titled = (env: Env, title: string) => env.session.planTasks.find((t) => t.title === title);
const cards = (env: Env) => env.messages.flatMap((m) => (m.type === 'approval_request' && m.kind === 'task_start' ? [m] : []));

/** The user's turn during the run adds a task with no start tool, and ends. */
async function addedInUsersTurn(env: Env, title = 'New unapproved work'): Promise<string> {
  void env.session.continueConversation('also add some new work');
  await until(() => env.planner.calls.length === 1);
  const edit = await env.planner.tools().editPlan!({ ops: [{ op: 'add', task: { title, prompt: 'do the new work' } }] }, ctx);
  expect(edit.isError).toBeFalsy();
  env.planner.calls[0].finish(prose('Added it.'));
  await settled();
  return titled(env, title)!.id;
}

describe('the scheduler starts only approved tasks', () => {
  it('leaves a task the planner added in the user\'s turn during a run waiting, without asking', async () => {
    const env = await supervised([task('t1', 1)], GUARDED);
    expect(env.run.spawnedIds()).toEqual(['t1']);

    const added = await addedInUsersTurn(env);

    expect(env.run.spawnedIds()).toEqual(['t1']);
    expect(env.session.planTasks.find((t) => t.id === added)!.status).toBe('pending');
    expect(env.session.planState!.approvedTasks).toEqual(['t1']);
    expect(cards(env)).toEqual([]);
  });
});
