import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ConversationTurn } from '../AiService';
import { RUN_SETTINGS_DEFAULTS, type GlobalRunSettings } from '../SettingsService';
import { AUTORUN_OFF, AUTORUN_ON } from '../PlanPrompts';
import { makeSession, testWorkspace } from './sessionTestKit';
import { heldPlanner, NOW, plan, prose, recordingRunner, settled, task, until } from './supervisorTestKit';

/** Autorun starts a plan when the planner submits it, approved as if the user had pressed Execute (ADR-0030). */

beforeEach(() => {
  vi.useFakeTimers({ now: NOW, toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
});

afterEach(() => {
  vi.useRealTimers();
});

function planning(run: Partial<GlobalRunSettings> = {}) {
  const planner = heldPlanner();
  const runner = recordingRunner();
  const settings: GlobalRunSettings = { ...RUN_SETTINGS_DEFAULTS, supervisorLevel: 'off', ...run };
  const session = makeSession({ aiService: planner.aiService, runner: runner.runner, settings: () => ({ run: { ...settings } }) });
  return { session, planner, runner, settings };
}

const submitted = (): ConversationTurn => ({ kind: 'plan', tasks: [task('t1', 1)], text: '1. Task t1 — does t1', researchLog: [] });
const notes = (env: ReturnType<typeof planning>) => (env.session.planState?.conversationHistory ?? []).map((e) => e.content);

async function submit(env: ReturnType<typeof planning>): Promise<void> {
  const planned = env.session.startPlanning('build it', ['claude-code']);
  await until(() => env.planner.calls.length === 1);
  env.planner.calls[0].finish(submitted());
  await planned;
  await settled();
}

describe('autorun', () => {
  it('starts a plan the planner submits, approved as if the user pressed Execute, and says who started it', async () => {
    const env = planning({ autorun: true });
    await submit(env);

    await until(() => env.runner.spawnedIds().includes('t1'));
    expect(env.session.planState!.approvedTasks).toContain('t1');
    expect(notes(env)).toContainEqual(expect.stringMatching(/Started the plan: by autorun/));
  });

  it('leaves a submitted plan for the user\'s review when it is off', async () => {
    const env = planning({ autorun: false });
    await submit(env);
    await vi.advanceTimersByTimeAsync(1000);

    expect(env.runner.spawnedIds()).toEqual([]);
  });

  it('never starts a plan a session loads with, even when on', async () => {
    const env = planning({ autorun: true });
    env.session.loadPlan(plan([task('t1', 1)], { status: 'draft' }), 'build it', testWorkspace, { persist: false });
    await settled();
    await vi.advanceTimersByTimeAsync(1000);

    expect(env.runner.spawnedIds()).toEqual([]);
  });

  it('tells the planner at the start, and in the next turn after it is switched', async () => {
    const env = planning({ autorun: false });
    const planned = env.session.startPlanning('build it', ['claude-code']);
    await until(() => env.planner.calls.length === 1);
    expect(env.planner.aiService.startConversation).toHaveBeenCalledWith(expect.objectContaining({ autorun: false }));
    env.planner.calls[0].finish(prose('Which database?'));
    await planned;

    env.session.applyRunSettings({ autorun: true });
    void env.session.continueConversation('Postgres');
    await until(() => env.planner.calls.length === 2);
    env.planner.calls[1].finish(prose('Noted.'));
    await settled();
    void env.session.continueConversation('and Redis');
    await until(() => env.planner.calls.length === 3);
    env.planner.calls[2].finish(prose('Noted.'));
    await settled();
    env.session.applyRunSettings({ autorun: false });
    void env.session.continueConversation('wait');
    await until(() => env.planner.calls.length === 4);

    expect(env.planner.calls[1].message).toContain(AUTORUN_ON);
    expect(env.planner.calls[2].message).not.toContain('AUTORUN');
    expect(env.planner.calls[3].message).toContain(AUTORUN_OFF);
  });

  it('tells the planner again when the turn that first told it never got an answer', async () => {
    const env = planning({ autorun: true });
    const planned = env.session.startPlanning('build it', ['claude-code']);
    await until(() => env.planner.calls.length === 1);
    env.planner.calls[0].finish(prose('Which database?'));
    await planned;

    env.session.applyRunSettings({ autorun: false });
    const failed = env.session.continueConversation('Postgres');
    await until(() => env.planner.calls.length === 2);
    env.planner.calls[1].fail(new Error('backend down'));
    await expect(failed).rejects.toThrow('backend down');
    void env.session.continueConversation('Postgres, then');
    await until(() => env.planner.calls.length === 3);

    expect(env.planner.calls[1].message).toContain(AUTORUN_OFF);
    expect(env.planner.calls[2].message).toContain(AUTORUN_OFF);
  });
});
