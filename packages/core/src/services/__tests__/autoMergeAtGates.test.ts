import { afterEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { createTask, type LegacyPlanState } from '../../models/Task';
import type { IRunner } from '../../interfaces/IRunner';
import type { IWorktreeIsolation } from '../../interfaces/IWorktreeIsolation';
import { FakeWorktreeIsolation, fakeConfig } from '../../testing';
import { createWorktreeIsolation } from '../GitWorktreeIsolation';
import { TaskOrchestrator } from '../TaskOrchestrator';
import { fromTranscript } from '../../conversation/transcript';
import { loadSession, saveSession } from '../../utils/sessionStore';
import { FakeRunnerSession, fakeNotification, makeSession, saves } from './sessionTestKit';
import type { SessionMessage, SessionNotice } from '../SessionMessage';

const change = createTask({ id: 'c1', order: 1, title: 'Change', prompt: 'change' });
const ops = createTask({ id: 'o2', order: 2, title: 'Deploy', prompt: 'deploy', ops: true, dependencies: ['c1'] });
const user = createTask({ id: 'u2', order: 2, title: 'Check', type: 'user', dependencies: ['c1'] });
const plans = (enabled?: boolean, tasks = [change, ops]): LegacyPlanState => ({
  tasks, generatedAt: '2026-10-11T00:00:00Z', lastUpdated: '2026-10-11T00:00:00Z',
  status: 'approved', runners: ['claude-code'],
  ...(enabled === undefined ? {} : { mergeAtGatesAutomatically: enabled }),
});
const cleanup: (() => void)[] = [];
afterEach(() => { while (cleanup.length) cleanup.pop()!(); });

function harness(isolation: IWorktreeIsolation = new FakeWorktreeIsolation(), workspace = '/repo', disk = false) {
  const sessions: FakeRunnerSession[] = [];
  const spawn = vi.fn(async ({ taskId }: Parameters<IRunner['spawn']>[0]) => {
    const runner = new FakeRunnerSession(`s${sessions.length}`, taskId);
    sessions.push(runner);
    return runner;
  });
  const runner: IRunner = { spawn, stop: vi.fn(), stopAll: vi.fn(), activeCount: 0 };
  const messages: SessionMessage[] = [];
  const notices: SessionNotice[] = [];
  const session = makeSession({ isolation, runner, workspaceRoot: () => workspace,
    config: fakeConfig({ worktreeIsolation: true }), broadcast: (m) => messages.push(m), onNotice: (n) => notices.push(n),
    ...(disk ? { saveSession } : {}),
  });
  cleanup.push(() => session.destroy());
  const pass = (id = 'c1') => [...sessions].reverse().find((s) => s.taskId === id)!.reportComplete({ status: 'done', summary: 'done' });
  return { session, sessions, spawn, runner, pass, messages, notices };
}

const merged = (iso: FakeWorktreeIsolation) => iso.calls.filter((c) => c.op === 'mergeIntoCheckedOut');

describe('Merge at gates automatically', () => {
  it.each([ops, user])('merges for the gate of $type task without a supervisor and records the actor', async (gated) => {
    const iso = new FakeWorktreeIsolation();
    const { session, pass, messages } = harness(iso);
    session.loadPlan(plans(true, [change, gated]), 'goal', '/repo');
    await session.executePlan();
    pass();
    await vi.waitFor(() => expect(merged(iso)).toHaveLength(1));
    await vi.waitFor(() => expect(session.mergeGate(gated.id)).toEqual([]));
    expect(session.planState!.runSettings).toEqual({ mergeAtGatesAutomatically: true });
    const history = session.planState!.conversationHistory!;
    expect(history).toContainEqual(expect.objectContaining({ kind: 'system', actor: 'Ordewell setting', content: 'Ordewell setting: auto-merged for task 2' }));
    expect(fromTranscript(history, []).blocks).toContainEqual(expect.objectContaining({ type: 'message', role: 'system', text: 'Ordewell setting: auto-merged for task 2' }));
    expect(messages).toContainEqual({ type: 'isolation_merge', result: { outcome: 'merged' } });
  });

  it.each([undefined, false])('waits with setting %s, including older saved plans', async (enabled) => {
    const iso = new FakeWorktreeIsolation();
    const { session, pass } = harness(iso);
    session.loadPlan(plans(enabled), 'goal', '/repo');
    await session.executePlan();
    pass();
    await vi.waitFor(() => expect(session.mergeGate('o2')).toEqual(['c1']));
    expect(merged(iso)).toEqual([]);
    expect(session.planState!.runSettings).toEqual({ mergeAtGatesAutomatically: false });
  });

  it.each([false, true])('changing %s mid-run applies only to the next run', async (initial) => {
    const iso = new FakeWorktreeIsolation();
    const { session, pass } = harness(iso);
    session.loadPlan(plans(initial, [change, user]), 'goal', '/repo');
    await session.executePlan();
    session.setMergeAtGatesAutomatically(!initial);
    pass();
    await vi.waitFor(() => expect(session.planTasks[0].status).toBe('completed'));
    await session.reschedule();
    expect(merged(iso)).toHaveLength(initial ? 1 : 0);
    expect(session.planState!.runSettings).toEqual({ mergeAtGatesAutomatically: initial });
    expect(saves(session).mock.calls.at(-1)![0].mergeAtGatesAutomatically).toBe(!initial);
    session.stopExecution();
    await session.executePlan();
    expect(session.planState!.runSettings).toEqual({ mergeAtGatesAutomatically: !initial });
    if (!initial) await vi.waitFor(() => expect(merged(iso)).toHaveLength(1));
  });

  it.each(['clean', 'manual', 'by hand'] as const)('merges at successive gates after a %s first gate while leaving other change tasks running', async (first) => {
    const iso = new FakeWorktreeIsolation();
    const { session, pass, spawn } = harness(iso);
    const second = createTask({ id: 'c3', order: 3, prompt: 'second', dependencies: ['u2'] });
    const last = createTask({ id: 'u4', order: 4, type: 'user', dependencies: ['c3'] });
    const parallel = createTask({ id: 'c5', order: 5, prompt: 'parallel' });
    session.loadPlan(plans(true, [change, user, second, last, parallel]), 'goal', '/repo');
    await session.executePlan();
    if (first !== 'clean') iso.mergeResult = { outcome: 'conflict', repo: '.' };
    pass();
    await vi.waitFor(() => expect(merged(iso)).toHaveLength(1));
    if (first !== 'clean') {
      await vi.waitFor(() => expect(session.mergeGate('u2')).toEqual(['c1']));
      iso.mergeResult = { outcome: 'merged' };
      if (first === 'manual') await session.mergeRun();
      else {
        iso.mergedByHand.add('c1');
        await session.reschedule();
      }
    }
    expect(session.planTasks.find((t) => t.id === 'c5')!.status).toBe('in_progress');
    await session.markTaskComplete('u2');
    await vi.waitFor(() => expect(spawn.mock.calls.some(([o]) => o.taskId === 'c3')).toBe(true));
    pass('c3');
    await vi.waitFor(() => expect(merged(iso)).toHaveLength(first === 'manual' ? 3 : 2));
    expect(session.mergeGate('u4')).toEqual([]);
    expect(session.planState!.conversationHistory!.map((e) => e.content)).toEqual([
      ...(first === 'clean' ? ['Ordewell setting: auto-merged for task 2'] : []), 'Ordewell setting: auto-merged for task 4',
    ]);
  });

  it('leaves unmerged landings alone when no task reaches a gate', async () => {
    const iso = new FakeWorktreeIsolation();
    const { session, pass } = harness(iso);
    const next = createTask({ id: 'c2', order: 2, prompt: 'next', dependencies: ['c1'] });
    session.loadPlan(plans(true, [change, next]), 'goal', '/repo');
    await session.executePlan();
    pass();
    await vi.waitFor(() => expect(session.planTasks[1].status).toBe('in_progress'));
    expect(merged(iso)).toHaveLength(0);
    expect(session.runMergeView()).toMatchObject({ waitingAtGate: false });
  });

  it('waits for a running ops task, then merges through the same path', async () => {
    const iso = new FakeWorktreeIsolation();
    const { session, pass } = harness(iso);
    const unrelated = createTask({ id: 'o3', order: 3, ops: true, prompt: 'other ops' });
    session.loadPlan(plans(true, [change, ops, unrelated]), 'goal', '/repo');
    await session.executePlan();
    pass();
    await vi.waitFor(() => expect(session.mergeGate('o2')).toEqual(['c1']));
    expect(merged(iso)).toHaveLength(0);
    pass('o3');
    await vi.waitFor(() => expect(merged(iso)).toHaveLength(1));
  });

  it('emits an observer event on refusal, leaves the gate waiting and does not retry on ticks', async () => {
    const iso = new FakeWorktreeIsolation();
    iso.mergeResult = { outcome: 'blocked', blocked: [{ repo: '.', reason: 'conflict', files: ['x'] }] };
    const { runner, sessions } = harness(iso);
    const orchestrator = TaskOrchestrator.compose({ config: fakeConfig(), notifications: fakeNotification(), runner, isolation: iso });
    cleanup.push(() => orchestrator.stop());
    const event = vi.fn();
    orchestrator.subscribe({ onAutoMerge: event });
    orchestrator.loadPlan([change, ops]);
    orchestrator.setMergeAtGatesAutomatically(true);
    await orchestrator.approveReview();
    sessions.at(-1)!.reportComplete({ status: 'done', summary: 'done' });
    await vi.waitFor(() => expect(event).toHaveBeenCalledWith({ taskId: 'o2', result: iso.mergeResult }));
    await orchestrator.tick();
    await orchestrator.tick();
    expect(orchestrator.getMergeGate('o2')).toEqual(['c1']);
    expect(merged(iso)).toHaveLength(1);
  });

  it('exposes the core merge_all operation without exposing a planner tool', async () => {
    const iso = new FakeWorktreeIsolation();
    const { session, pass } = harness(iso);
    session.loadPlan(plans(false), 'goal', '/repo');
    await session.executePlan();
    pass();
    await vi.waitFor(() => expect(session.mergeGate('o2')).toEqual(['c1']));
    expect(await session.merge_all()).toEqual({ outcome: 'merged' });
    expect(session.mergeGate('o2')).toEqual([]);
  });
});

function git(root: string, ...args: string[]): string {
  const env = { ...process.env };
  for (const key of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_COMMON_DIR', 'GIT_PREFIX']) delete env[key];
  return execFileSync('git', args, { cwd: root, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}
function repo(): string {
  const root = mkdtempSync(join(tmpdir(), 'ordewell-auto-merge-'));
  cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  git(root, 'init', '-q', '-b', 'main');
  git(root, 'config', 'user.name', 'Test');
  git(root, 'config', 'user.email', 'test@example.com');
  git(root, 'config', 'commit.gpgsign', 'false');
  writeFileSync(join(root, '.gitignore'), '.ordewell/\n');
  writeFileSync(join(root, 'x'), 'original\n');
  git(root, 'add', '.');
  git(root, 'commit', '-qm', 'initial');
  return root;
}

describe('automatic gate merging with real git', () => {
  it.each(['conflict', 'dirty'] as const)('aborts a %s and leaves HEAD, index and user files untouched', async (reason) => {
    const root = repo();
    const iso = createWorktreeIsolation({ config: fakeConfig({ worktreeIsolation: true }), resolvePath: async () => process.env.PATH ?? '' });
    const { session, spawn, pass, notices } = harness(iso, root);
    session.loadPlan(plans(true), 'goal', root);
    await session.executePlan();
    const cwd = spawn.mock.calls[0][0].cwd!;
    writeFileSync(join(cwd, 'x'), 'runner\n');
    git(cwd, 'add', 'x');
    git(cwd, 'commit', '-qm', 'runner change');
    writeFileSync(join(root, 'x'), 'user\n');
    if (reason === 'conflict') {
      git(root, 'add', 'x');
      git(root, 'commit', '-qm', 'user change');
    }
    const before = [git(root, 'rev-parse', 'HEAD'), git(root, 'ls-files', '-s'), git(root, 'status', '--porcelain'), readFileSync(join(root, 'x'), 'utf8')];
    pass();
    await vi.waitFor(() => expect(notices.some((n) => n.message.includes('merge gate is waiting for you'))).toBe(true), { timeout: 10000 });
    expect(session.mergeGate('o2')).toEqual(['c1']);
    expect(session.runMergeView()).toMatchObject({ waitingAtGate: true, paused: true });
    expect(spawn).toHaveBeenCalledTimes(1);
    expect([git(root, 'rev-parse', 'HEAD'), git(root, 'ls-files', '-s'), git(root, 'status', '--porcelain'), readFileSync(join(root, 'x'), 'utf8')]).toEqual(before);
    expect(existsSync(join(root, '.git', 'MERGE_HEAD'))).toBe(false);
  }, 15000);

  it('persists the requested setting and run snapshot and restores them', async () => {
    const root = repo();
    const { session } = harness(new FakeWorktreeIsolation(), root, true);
    session.loadPlan(plans(), 'goal', root);
    session.setMergeAtGatesAutomatically(true);
    await session.executePlan();
    session.setMergeAtGatesAutomatically(false);
    const loaded = loadSession(session.sessionId, root)!;
    expect(loaded.plan.mergeAtGatesAutomatically).toBe(false);
    expect(loaded.plan.runSettings).toEqual({ mergeAtGatesAutomatically: true });
    const restored = harness().session;
    restored.loadPlan(loaded.plan, 'goal', root);
    expect(restored.planState!.mergeAtGatesAutomatically).toBe(false);
    expect(restored.planState!.runSettings).toEqual({ mergeAtGatesAutomatically: true });
    await restored.executePlan();
    expect(restored.planState!.runSettings).toEqual({ mergeAtGatesAutomatically: false });
  });
});
