import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LegacyPlanState } from '../../models/Task';
import { makeSession, saves, testWorkspace } from './sessionTestKit';
import { WAKE_DEBOUNCE_MS } from '../Supervisor';
import { WAKE_UP_RATE } from '../LoopGuards';
import { changeSettings, NOW, plan, prose, settled, supervised, task, until, waitForInput, wokenUp } from './supervisorTestKit';

/** Run settings are the user's, read from their settings and applied at once (ADR-0030). */

beforeEach(() => {
  vi.useFakeTimers({ now: NOW, toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
});

afterEach(() => {
  vi.useRealTimers();
});

describe('run settings', () => {
  it('start a run at the user\'s supervisor level, whatever an older plan saved', async () => {
    const env = await supervised([task('t1', 1)], { settings: { supervisorLevel: 'act' }, plan: { supervisorLevel: 'off' } as Partial<LegacyPlanState> });

    expect(env.session.planState!.runSettings).toMatchObject({ supervisorLevel: 'act' });
  });

  it('are not read from an older plan, which drops its own copies when it is saved', () => {
    const session = makeSession({});
    const older = { ...plan([task('t1', 1)]), supervisorLevel: 'act', mergeAtGatesAutomatically: true, supervisorRetryLimit: 5, wakeUpReadBudget: 3 };

    session.loadPlan(older, 'build it', testWorkspace);

    const saved = saves(session).mock.calls.at(-1)![0];
    expect(saved).not.toHaveProperty('supervisorLevel');
    expect(saved).not.toHaveProperty('mergeAtGatesAutomatically');
    expect(saved).not.toHaveProperty('supervisorRetryLimit');
    expect(saved).not.toHaveProperty('wakeUpReadBudget');
  });
});

describe('the user\'s command after an automatic lowering', () => {
  it('raises a run a loop guard dropped to Watch back to Act, and the next wake-up may act', async () => {
    const env = await supervised([task('t1', 1)], { settings: { supervisorLevel: 'act' } });
    for (let i = 0; i <= WAKE_UP_RATE.max; i++) {
      waitForInput(env.run.of('t1'));
      await settled();
      await vi.advanceTimersByTimeAsync(WAKE_DEBOUNCE_MS);
      await until(() => env.planner.calls.length === i + 1);
      env.planner.calls[i].finish(prose('Answered task 1.'));
      await settled();
      if (i < WAKE_UP_RATE.max) await env.session.execute({ command: 'message_task', task: 't1', text: 'carry on' }, { kind: 'user' });
    }
    expect(env.session.planState!.runSettings!.supervisorLevel).toBe('watch');

    changeSettings(env, { supervisorLevel: 'act' });
    await env.session.execute({ command: 'message_task', task: 't1', text: 'carry on' }, { kind: 'user' });
    waitForInput(env.run.of('t1'));
    await settled();
    await vi.advanceTimersByTimeAsync(WAKE_DEBOUNCE_MS);
    await until(() => env.planner.calls.length === WAKE_UP_RATE.max + 2);

    expect(env.planner.calls.at(-1)!.message).toMatch(/At Act you may act/);
    expect(env.session.planState!.runSettings!.supervisorLevel).toBe('act');
  });

  it('brings back a supervisor that failed, and the next event wakes it', async () => {
    const env = await wokenUp();
    env.planner.calls[0].finish({ kind: 'message', text: 'Rate limit exceeded', researchLog: [], failed: true });
    await settled();
    expect(env.session.planState!.runSettings!.unsupervised).toBeDefined();

    changeSettings(env, { supervisorLevel: 'watch' });
    env.run.of('t2').reportComplete({ status: 'failed', summary: '', reason: 'broke' });
    await settled();
    await vi.advanceTimersByTimeAsync(WAKE_DEBOUNCE_MS);

    await until(() => env.planner.calls.length === 2);
    expect(env.session.planState!.runSettings!.unsupervised).toBeUndefined();
    expect(env.planner.calls[1].message).toMatch(/task #2 "Task t2" failed/);
  });
});
