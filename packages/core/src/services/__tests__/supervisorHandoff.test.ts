import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FakeWorktreeIsolation } from '../../testing';
import type { SupervisorLevel } from '../../models/Execution';
import type { SessionMessage } from '../SessionMessage';
import { EMPTY_RUN, reduceRun } from '../runView';
import { ctx, NOW, prose, settled, supervised, task, until, type Env } from './supervisorTestKit';

/**
 * The end-of-run handoff under a supervisor (ADR-0029): at Act it is sent
 * marked as the supervisor's to handle, and sent again unmarked once its
 * wake-up turn for the run's end is over and the run is still unmerged.
 */

type Handoff = Extract<SessionMessage, { type: 'isolation_handoff' }>;

beforeEach(() => {
  vi.useFakeTimers({ now: NOW, toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
});

afterEach(() => {
  vi.useRealTimers();
});

/** A one-task isolated run under `level`, its task passed and the run settled. */
async function finished(level: SupervisorLevel, isolation = new FakeWorktreeIsolation(), mergeAtGatesAutomatically = false) {
  const env = await supervised([task('t1', 1)], {
    settings: { supervisorLevel: level, mergeAtGatesAutomatically },
    isolation,
    config: { worktreeIsolation: true },
  });
  env.run.of('t1').reportComplete({ status: 'done', summary: '' });
  await until(() => env.messages.some((m) => m.type === 'execution_complete'));
  return { ...env, isolation };
}

const handoffs = (env: Env): Handoff[] => env.messages.filter((m): m is Handoff => m.type === 'isolation_handoff');

describe('the end-of-run handoff with the supervisor at Act', () => {
  it('is marked deferred to the supervisor, and sent again unmarked when its wake-up turn ends without a merge', async () => {
    const env = await finished('act');
    expect(handoffs(env)).toEqual([expect.objectContaining({ deferredTo: 'supervisor', landed: [expect.objectContaining({ taskId: 't1' })] })]);

    await until(() => env.planner.calls.length === 1);
    expect(env.planner.calls[0].message).toContain('the run finished');
    expect(handoffs(env)).toHaveLength(1);

    env.planner.calls[0].finish(prose('Task 1 is done; the run is yours to merge.'));
    await settled();

    expect(handoffs(env)).toHaveLength(2);
    expect(handoffs(env)[1]).not.toHaveProperty('deferredTo');
    expect(handoffs(env)[1].landed).toEqual([expect.objectContaining({ taskId: 't1' })]);
  });

  it('is not sent again after the supervisor merges it', async () => {
    const env = await finished('act');
    await until(() => env.planner.calls.length === 1);

    expect((await env.planner.tools().mergeAll!({}, ctx)).isError).toBeFalsy();
    env.planner.calls[0].finish(prose('Merged.'));
    await settled();

    expect(handoffs(env)).toHaveLength(1);
    expect(env.messages).toContainEqual({ type: 'isolation_merge', result: { outcome: 'merged' } });
    expect(env.session.isolationView()).toBeNull();
  });

  it('is sent again unmarked when the wake-up turn fails', async () => {
    const env = await finished('act');
    await until(() => env.planner.calls.length === 1);

    env.planner.calls[0].fail(new Error('the planner crashed'));
    await settled();

    expect(handoffs(env).map((h) => h.deferredTo)).toEqual(['supervisor', undefined]);
  });

  it.each(['watch', 'off'] as const)('is sent again unmarked at once when the user sets the supervisor to %s', async (level) => {
    const env = await finished('act');
    await until(() => env.planner.calls.length === 1);

    Object.assign(env.settings, { supervisorLevel: level });
    env.session.applyRunSettings({ supervisorLevel: level });

    expect(handoffs(env).map((h) => h.deferredTo)).toEqual(['supervisor', undefined]);
    env.planner.calls[0].finish(prose('Noted.'));
    await settled();
    expect(handoffs(env)).toHaveLength(2);
  });

  it('stays the isolation view\'s, for a surface that reloads meanwhile', async () => {
    const env = await finished('act');

    expect(env.session.isolationView()?.handoff.landed).toEqual([expect.objectContaining({ taskId: 't1' })]);
  });

  it('follows an automatic Merge all that stopped, which the supervisor hears of', async () => {
    const isolation = new FakeWorktreeIsolation();
    isolation.mergeResult = { outcome: 'conflict', repo: '.' };
    const env = await finished('act', isolation, true);

    expect(handoffs(env)).toEqual([expect.objectContaining({ deferredTo: 'supervisor' })]);
    await until(() => env.planner.calls.length === 1);
    expect(env.planner.calls[0].message).toContain('automatic Merge all at the end of the run stopped');
  });

  it('never comes when the automatic Merge all succeeds', async () => {
    const env = await finished('act', new FakeWorktreeIsolation(), true);
    await until(() => env.planner.calls.length === 1);
    env.planner.calls[0].finish(prose('All merged.'));
    await settled();

    expect(handoffs(env)).toEqual([]);
    expect(env.session.isolationView()).toBeNull();
  });
});

describe.each(['watch', 'off'] as const)('the end-of-run handoff with the supervisor at %s', (level) => {
  it('is sent once, unmarked', async () => {
    const env = await finished(level);
    await settled();
    if (env.planner.calls.length > 0) {
      env.planner.calls[0].finish(prose('The run finished.'));
      await settled();
    }

    expect(handoffs(env)).toEqual([expect.not.objectContaining({ deferredTo: expect.anything() })]);
  });
});

describe('the run snapshot\'s handoff is the one the live messages built', () => {
  const live = (env: Env) => env.messages.reduce(reduceRun, EMPTY_RUN).handoff;

  it('marked as the supervisor\'s while an Act supervisor has it, unmarked once it hands it over', async () => {
    const env = await finished('act');
    expect(env.session.runSnapshot().handoff).toEqual(live(env));
    expect(live(env)).toMatchObject({ deferredTo: 'supervisor' });

    await until(() => env.planner.calls.length === 1);
    env.planner.calls[0].finish(prose('The run is yours to merge.'));
    await settled();

    expect(env.session.runSnapshot().handoff).toEqual(live(env));
    expect(live(env)).not.toHaveProperty('deferredTo');
  });

  it('handed over again to a surface that joins after the session is reloaded', async () => {
    const env = await finished('off');
    await settled();

    env.session.loadPlan(structuredClone(env.session.planState!), 'build it', '/repo');

    expect(env.session.runSnapshot().handoff).toEqual(live(env));
    expect(live(env)?.landed).toEqual([expect.objectContaining({ taskId: 't1' })]);
  });

  it('none after a stop, which hands nothing over', async () => {
    const env = await supervised([task('t1', 1), task('t2', 2)], { settings: { supervisorLevel: 'off' }, isolation: new FakeWorktreeIsolation(), config: { worktreeIsolation: true } });
    env.run.of('t1').reportComplete({ status: 'done', summary: '' });
    await until(() => env.session.isolationView()?.handoff.landed.length === 1);

    env.session.stopExecution();
    await settled();

    expect(live(env)).toBeNull();
    expect(env.session.runSnapshot().handoff).toBeNull();
  });
});
