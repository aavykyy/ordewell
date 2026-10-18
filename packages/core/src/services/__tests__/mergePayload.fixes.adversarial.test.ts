import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTask, type LegacyPlanState } from '../../models/Task';
import type { IRunner } from '../../interfaces/IRunner';
import { FakeWorktreeIsolation, fakeConfig } from '../../testing';
import { RUN_SETTINGS_DEFAULTS, type GlobalRunSettings } from '../SettingsService';
import type { SessionMessage } from '../SessionMessage';
import { FakeRunnerSession, makeSession } from './sessionTestKit';

/**
 * Adversarial, round two: the Merge all payload no longer carries whether the
 * merge closed the run (the first round removed the unread flag). The card
 * reads the Session's `run_closed` instead — so the payload must not smuggle
 * a second answer, and a merge that leaves the run going must not say closed.
 */

let userSettings: GlobalRunSettings;

beforeEach(() => {
  vi.useFakeTimers({ now: new Date('2026-10-11T18:00:00Z') });
  userSettings = { ...RUN_SETTINGS_DEFAULTS, supervisorLevel: 'off', mergeAtGatesAutomatically: false };
});

afterEach(() => {
  vi.useRealTimers();
});

function harness() {
  const sessions: FakeRunnerSession[] = [];
  const spawn = vi.fn(async ({ taskId }: Parameters<IRunner['spawn']>[0]) => {
    const runner = new FakeRunnerSession(`s${sessions.length}`, taskId);
    sessions.push(runner);
    return runner;
  });
  const runner: IRunner = { spawn, stop: vi.fn(), stopAll: vi.fn(), activeCount: 0 };
  const messages: SessionMessage[] = [];
  const session = makeSession({
    isolation: new FakeWorktreeIsolation(), runner, workspaceRoot: () => '/repo',
    config: fakeConfig({ worktreeIsolation: true, maxParallelSessions: 2 }),
    settings: () => ({ run: { ...userSettings } }),
    broadcast: (m) => messages.push(m),
  });
  const sessionOf = (taskId: string) => [...sessions].reverse().find((s) => s.taskId === taskId)!;
  return { session, messages, sessionOf };
}

const plan = (tasks: LegacyPlanState['tasks']): LegacyPlanState => ({
  tasks, generatedAt: '2026-10-11T00:00:00Z', lastUpdated: '2026-10-11T00:00:00Z',
  status: 'approved', runners: ['claude-code'],
});

describe('adversarial: the Merge all payload carries no second answer about the run being closed', () => {
  it('answers the merge result alone while the run goes on, and only run_closed says otherwise', async () => {
    const { session, messages, sessionOf } = harness();
    session.loadPlan(plan([
      createTask({ id: 'c1', order: 1, title: 'Change', prompt: 'change' }),
      createTask({ id: 'o2', order: 2, title: 'Deploy', prompt: 'deploy', ops: true, dependencies: ['c1'] }),
    ]), 'goal', '/repo');
    await session.execute({ command: 'run_plan' }, { kind: 'user' });
    sessionOf('c1').reportComplete({ status: 'done', summary: '' });
    await vi.waitFor(() => expect(session.mergeGate('o2')).toEqual(['c1']));

    const merged = await session.execute({ command: 'merge_all' }, { kind: 'user' });

    expect(merged.ok).toBe(true);
    expect(merged.payload).toMatchObject({ kind: 'merge', result: { outcome: 'merged' } });
    expect(Object.keys(merged.payload!).sort()).toEqual(['kind', 'result']);
    expect((merged.payload as { closed?: boolean }).closed).toBeUndefined();
    expect(messages.filter((m) => m.type === 'run_closed')).toHaveLength(0);
  });

  it('answers the same payload for a merge that clears the run, whose closing is run_closed alone', async () => {
    const { session, messages, sessionOf } = harness();
    session.loadPlan(plan([
      createTask({ id: 'c1', order: 1, title: 'Change', prompt: 'change' }),
    ]), 'goal', '/repo');
    await session.execute({ command: 'run_plan' }, { kind: 'user' });
    sessionOf('c1').reportComplete({ status: 'done', summary: '' });
    await vi.waitFor(() => expect(session.runMergeView()).not.toBeNull());

    const merged = await session.execute({ command: 'merge_all' }, { kind: 'user' });

    expect(merged.ok).toBe(true);
    expect(Object.keys(merged.payload!).sort()).toEqual(['kind', 'result']);
    expect((merged.payload as { closed?: boolean }).closed).toBeUndefined();
    expect(messages.filter((m) => m.type === 'run_closed')).toHaveLength(1);
  });
});
