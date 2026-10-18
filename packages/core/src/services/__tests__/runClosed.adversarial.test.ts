import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTask, type LegacyPlanState } from '../../models/Task';
import type { IRunner } from '../../interfaces/IRunner';
import { EMPTY_RUN, reduceRun, type RunView } from '../runView';
import { FakeWorktreeIsolation, fakeConfig } from '../../testing';
import { RUN_SETTINGS_DEFAULTS, type GlobalRunSettings } from '../SettingsService';
import { surfacePlan, type SessionMessage } from '../SessionMessage';
import { FakeRunnerSession, makeSession, taskOf } from './sessionTestKit';

/**
 * Adversarial: "core decides when the run is closed" (ADR-0013/0020) checked
 * as one rule. The `run_closed` broadcast, the `runSnapshot()` a surface
 * joining now is handed, and the marks a surface that folded every message
 * holds must agree — before a close, through it, and after it.
 */

const first = createTask({ id: 'a1', order: 1, title: 'First', prompt: 'first' });
const second = createTask({ id: 'b2', order: 2, title: 'Second', prompt: 'second' });
const plan = (tasks = [first, second]): LegacyPlanState => ({
  tasks, generatedAt: '2026-10-11T00:00:00Z', lastUpdated: '2026-10-11T00:00:00Z',
  status: 'approved', runners: ['claude-code'],
});

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

async function settle(): Promise<void> {
  for (let i = 0; i < 40; i += 1) await vi.advanceTimersByTimeAsync(10);
}

/** The isolation state each task carries in a run view, as a surface would hold it. */
const marksOf = (view: RunView): Record<string, string | undefined> =>
  Object.fromEntries(view.tasks.map((t) => [t.id, t.isolation?.state]));

/** What a surface that folded the plan it loaded and every message since holds. */
function foldedRun(loaded: LegacyPlanState, messages: readonly SessionMessage[]): RunView {
  const seeded = reduceRun(EMPTY_RUN, { type: 'plan_snapshot', plan: surfacePlan(loaded) });
  return messages.reduce((view, message) => reduceRun(view, message), seeded);
}

describe('adversarial: one rule for when the run is closed', () => {
  it('keeps the marks through a mid-run Merge all, and drops them only when the Session says the run closed', async () => {
    const { session, messages, sessionOf } = harness();
    const loaded = plan();
    session.loadPlan(loaded, 'goal', '/repo');
    await session.execute({ command: 'run_plan' }, { kind: 'user' });

    sessionOf('a1').reportComplete({ status: 'done', summary: 'done' });
    await settle();
    await vi.waitFor(() => expect(taskOf(session, 'b2')!.status).not.toBe('pending'));
    sessionOf('b2').reportComplete({ status: 'done', summary: 'done' });
    await settle();
    await vi.waitFor(() => expect(messages.some((m) => m.type === 'execution_complete')).toBe(true));

    // The run ended with its work unmerged: the handoff stands, the run is open.
    expect(messages.filter((m) => m.type === 'run_closed')).toHaveLength(0);
    const handedOver = foldedRun(loaded, messages);
    expect(marksOf(handedOver)).toEqual({ a1: 'integrated', b2: 'integrated' });

    // A Merge all taken mid-handoff merges everything and clears the run up.
    const merged = await session.execute({ command: 'merge_all' }, { kind: 'user' });
    expect(merged.ok).toBe(true);
    expect(merged.payload).toMatchObject({ kind: 'merge', closed: true });

    // The one word on it: the message, the joining snapshot and the folded view agree.
    expect(messages.filter((m) => m.type === 'run_closed')).toHaveLength(1);
    expect(marksOf(session.runSnapshot())).toEqual({ a1: undefined, b2: undefined });
    expect(marksOf(foldedRun(loaded, messages))).toEqual({ a1: undefined, b2: undefined });
    expect(session.isolationView()).toBeNull();
  });

  it('says run_closed before execution_complete when the end-of-run merge clears the run', async () => {
    userSettings = { ...userSettings, mergeAtGatesAutomatically: true };
    const { session, messages, sessionOf } = harness();
    const loaded = plan();
    session.loadPlan(loaded, 'goal', '/repo');
    await session.execute({ command: 'run_plan' }, { kind: 'user' });

    sessionOf('a1').reportComplete({ status: 'done', summary: 'done' });
    await settle();
    await vi.waitFor(() => expect(taskOf(session, 'b2')!.status).not.toBe('pending'));
    sessionOf('b2').reportComplete({ status: 'done', summary: 'done' });
    await settle();
    await vi.waitFor(() => expect(messages.some((m) => m.type === 'execution_complete')).toBe(true));

    const closedAt = messages.findIndex((m) => m.type === 'run_closed');
    const completeAt = messages.findIndex((m) => m.type === 'execution_complete');
    expect(closedAt).toBeGreaterThanOrEqual(0);
    // A surface treats execution_complete as the end of the stream; the close must arrive first.
    expect(closedAt).toBeLessThan(completeAt);
    expect(marksOf(session.runSnapshot())).toEqual({ a1: undefined, b2: undefined });
  });

  it('announces the close for a discard, and the snapshot agrees with the folded view', async () => {
    const { session, messages, sessionOf } = harness();
    const loaded = plan();
    session.loadPlan(loaded, 'goal', '/repo');
    await session.execute({ command: 'run_plan' }, { kind: 'user' });
    sessionOf('a1').reportComplete({ status: 'done', summary: 'done' });
    sessionOf('b2').reportComplete({ status: 'done', summary: 'done' });
    await settle();
    await vi.waitFor(() => expect(messages.some((m) => m.type === 'execution_complete')).toBe(true));

    await session.discardRun();
    expect(messages.filter((m) => m.type === 'run_closed')).toHaveLength(1);
    expect(session.isolationView()).toBeNull();
    expect(marksOf(session.runSnapshot())).toEqual({ a1: undefined, b2: undefined });
    expect(marksOf(foldedRun(loaded, messages))).toEqual({ a1: undefined, b2: undefined });
  });
});
