import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTask, type LegacyPlanState } from '../../models/Task';
import type { IRunner } from '../../interfaces/IRunner';
import { FakeWorktreeIsolation, fakeConfig } from '../../testing';
import { RUN_SETTINGS_DEFAULTS, type GlobalRunSettings } from '../SettingsService';
import type { SessionMessage } from '../SessionMessage';
import { FakeRunnerSession, makeSession, taskOf } from './sessionTestKit';

/**
 * Adversarial: the isolated-run path the whole change touches — a merge gate,
 * a Merge all taken mid-run, and a skipped task. Core owns when the run is
 * closed (ADR-0013/0020); this checks the three together through a real
 * Session, with the messages the surfaces fold.
 */

const change = createTask({ id: 'c1', order: 1, title: 'Change', prompt: 'change' });
const verify = createTask({ id: 'v2', order: 2, title: 'Verify', prompt: 'verify', dependencies: ['c1'] });
const deploy = createTask({ id: 'o3', order: 3, title: 'Deploy', prompt: 'deploy', ops: true, dependencies: ['v2'] });
const other = createTask({ id: 'x4', order: 4, title: 'Other', prompt: 'other' });
const plan = (tasks = [change, verify, deploy, other]): LegacyPlanState => ({
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
  return { session, sessions, spawn, messages, sessionOf };
}

async function settle(): Promise<void> {
  for (let i = 0; i < 40; i += 1) await vi.advanceTimersByTimeAsync(10);
}

describe('adversarial: a merge gate, a Merge all mid-run and a skipped task', () => {
  it('keeps the run open through a mid-run Merge all, then lets a skipped failure go and ends once more', async () => {
    const { session, messages, sessionOf, spawn } = harness();
    session.loadPlan(plan(), 'goal', '/repo');
    await session.execute({ command: 'run_plan' }, { kind: 'user' });

    sessionOf('c1').reportComplete({ status: 'done', summary: 'done' });
    await settle();
    await vi.waitFor(() => expect(taskOf(session, 'v2')!.status).not.toBe('pending'));
    sessionOf('v2').reportComplete({ status: 'failed', summary: '', reason: 'flaky' });
    await settle();

    // v2's failure blocks o3; x4 keeps running, so the run is still going.
    expect(taskOf(session, 'o3')!.status).toBe('approved');
    expect(taskOf(session, 'x4')!.status).toBe('in_progress');
    await vi.waitFor(() => expect(session.mergeGate('o3')).toEqual(['c1']));

    // The user's Merge all, taken mid-run.
    const merged = await session.execute({ command: 'merge_all' }, { kind: 'user' });
    expect(merged.ok).toBe(true);
    expect(merged.payload).toMatchObject({ kind: 'merge', result: { outcome: 'merged' }, closed: false });
    expect(session.mergeGate('o3')).toEqual([]);
    // The run is still open: the surfaces keep their marks until the Session says so (ADR-0013).
    expect(messages.filter((m) => m.type === 'run_closed')).toHaveLength(0);
    expect(messages.filter((m) => m.type === 'execution_complete')).toHaveLength(0);

    // x4 finishes; nothing can start (o3 is blocked by the failure) so the run ends once.
    sessionOf('x4').reportComplete({ status: 'done', summary: 'done' });
    await settle();
    await vi.waitFor(() => expect(messages.filter((m) => m.type === 'execution_complete')).toHaveLength(1));
    // v2's kept worktree holds work that never landed, so the run is not cleared up.
    expect(messages.filter((m) => m.type === 'run_closed')).toHaveLength(0);

    // The user skips the failed task: its dependent starts — the gate is clear now — and the run ends again.
    const skipped = await session.execute({ command: 'skip_task', task: 'v2' }, { kind: 'user' });
    expect(skipped.ok).toBe(true);
    await settle();
    await vi.waitFor(() => expect(spawn.mock.calls.map(([o]) => o.taskId)).toContain('o3'));
    sessionOf('o3').reportComplete({ status: 'done', summary: 'done' });
    await settle();
    await vi.waitFor(() => expect(messages.filter((m) => m.type === 'execution_complete')).toHaveLength(2));
  });
});
