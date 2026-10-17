import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { createSession, flattenTasks, RunnerRegistry, BufferedTaskOutputSource, createTask, RUN_SETTINGS_DEFAULTS } from '@ordewell/core';
import type { IAiService, IRunner, LegacyPlanState, ModelResolver, Session, SurfacePlan } from '@ordewell/core';
import { fakeConfig, fakeFileSystem, FakeRunnerSession } from '@ordewell/core/testing';
import { ChatViewProvider } from '../../providers/ChatViewProvider';
import type { HostToWebview } from '../../shared/protocol';
import { handleApprovePlan, handleSessionMessage, type PlanManagerDeps } from '../PlanManager';
import { persistState, restoreState, type PersistenceDeps } from '../../state/StatePersistence';

/**
 * Seen live: Execute plan, a run that ended with failures, and from then on
 * every planner and supervisor start was refused as unapproved. The host had
 * written its dock status onto the plan object the Session holds, and core
 * read approval from that status. Approval is the user's act, kept on its own
 * record (ADR-0029); the dock's status is the host's to keep.
 */

const PLANNER = { kind: 'planner-turn' } as const;

function plan(): LegacyPlanState {
  const at = '2026-01-01T00:00:00Z';
  return {
    tasks: [
      createTask({ id: 't1', order: 1, title: 'Parse JSON', prompt: 'do it', assignedRunner: 'claude-code', taskMode: 'acceptEdits' }),
      createTask({ id: 't2', order: 2, title: 'Stream it', prompt: 'then this', assignedRunner: 'claude-code', taskMode: 'acceptEdits' }),
    ],
    generatedAt: at,
    status: 'draft',
    runners: ['claude-code'],
    lastUpdated: at,
    conversationHistory: [{ role: 'user', content: 'build me a parser', timestamp: at }],
  };
}

/** A VS Code window as ExtensionHost wires it: every session event goes through the host's handler. */
function host(workspace: string) {
  const posts: HostToWebview[] = [];
  const chatProvider = new ChatViewProvider({ toString: () => 'file:///ext' } as unknown as vscode.Uri);
  chatProvider.postMessage = (msg) => { posts.push(msg); };
  const spawned: FakeRunnerSession[] = [];
  const runner = {
    spawn: vi.fn(async ({ taskId }: { taskId: string }) => {
      const s = new FakeRunnerSession(`s${spawned.length + 1}`, taskId);
      spawned.push(s);
      return s;
    }),
    stop: vi.fn(),
    stopAll: vi.fn(),
    activeCount: 0,
  } as unknown as IRunner;

  let current: LegacyPlanState = { ...plan(), tasks: [] };
  let goal = 'build me a parser';
  const cell: { session?: Session } = {};
  const persistence = (): PersistenceDeps => ({
    session: cell.session!,
    chatProvider,
    getCurrentPlan: () => current,
    setCurrentPlan: (p) => { current = p; },
    getCurrentGoal: () => goal,
    setCurrentGoal: (g) => { goal = g; },
    workspaceRoot: () => workspace,
    log: () => {},
  });
  const deps = {
    get session() { return cell.session!; },
    chatProvider,
    runner,
    config: { enabledRunners: ['claude-code'] },
    fsAdapter: { getWorkspaceRoot: () => workspace },
    getCurrentPlan: () => current,
    setCurrentPlan: (p: LegacyPlanState) => { current = p; },
    getCurrentGoal: () => goal,
    setCurrentGoal: (g: string) => { goal = g; },
    isGeneratingPlan: () => false,
    persistState: () => persistState(persistence()),
    saveCurrentSession: vi.fn(),
    log: () => {},
  } as unknown as PlanManagerDeps;

  cell.session = createSession({
    config: fakeConfig({ autonomousMode: true }),
    notifications: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), confirm: vi.fn().mockResolvedValue(undefined) },
    runner,
    registry: new RunnerRegistry(),
    workspaceRoot: () => workspace,
    fsAdapter: fakeFileSystem({ getWorkspaceRoot: () => workspace }),
    broadcast: (msg) => handleSessionMessage(msg, deps),
    modelResolver: { getCachedRunnerModels: () => [], modelsForRunners: vi.fn().mockResolvedValue({}) } as unknown as ModelResolver,
    // No supervisor: its wake-up turns would need a planner this test has no use for.
    settings: () => ({ run: { ...RUN_SETTINGS_DEFAULTS, supervisorLevel: 'off' } }),
    aiService: { reset: () => {}, hasActiveConversation: () => false } as unknown as IAiService,
    taskOutput: new BufferedTaskOutputSource(),
    saveSession: vi.fn(),
  });
  const session = cell.session;

  const status = (taskId: string) => flattenTasks(session.planTasks).find((t) => t.id === taskId)?.status;
  const latest = (taskId: string) => spawned.filter((s) => s.taskId === taskId).at(-1)!;
  const dock = (): SurfacePlan | undefined => posts.filter((m): m is Extract<HostToWebview, { type: 'planUpdated' }> => m.type === 'planUpdated').at(-1)?.plan;
  const restore = () => restoreState(persistence());
  const open = (opened: LegacyPlanState = plan()) => {
    session.loadPlan(opened, goal, workspace, { persist: false });
    current = session.planState!;
  };
  return { session, deps, status, latest, dock, restore, open, spawned };
}

/** Execute plan, then a run that ends with t1 failed and t2 done. */
async function runEndedWithAFailure(h: ReturnType<typeof host>) {
  h.open();
  await handleApprovePlan(h.deps);
  expect(h.dock()?.status).toBe('running');
  h.latest('t1').reportComplete({ status: 'failed', summary: '', reason: 'broke' });
  h.latest('t2').reportComplete({ status: 'done', summary: '' });
  await vi.waitFor(() => {
    expect(h.status('t1')).toBe('failed');
    expect(h.status('t2')).toBe('completed');
    expect(h.session.isExecuting).toBe(false);
  });
}

describe('VS Code: the user\'s Execute plan stays their approval after the run', () => {
  let workspace: string;
  beforeEach(() => {
    workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'ordewell-approval-'));
    (vscode.window.showErrorMessage as unknown as ReturnType<typeof vi.fn>).mockReset();
  });
  afterEach(() => { fs.rmSync(workspace, { recursive: true, force: true }); });

  it('lets the planner run the plan and retry a task after a run that ended with a failure', async () => {
    const h = host(workspace);
    await runEndedWithAFailure(h);
    // The dock no longer shows a run; the session's own plan was not rewritten for it.
    expect(h.dock()?.status).not.toBe('running');
    expect(h.session.planState!.status).toBe('approved');

    const retried = await h.session.execute({ command: 'retry_task', task: 't1', from: 'fresh' }, PLANNER);
    expect(retried).toMatchObject({ ok: true });
    h.latest('t1').reportComplete({ status: 'failed', summary: '', reason: 'broke again' });
    await vi.waitFor(() => expect(h.session.isExecuting).toBe(false));

    expect((await h.session.execute({ command: 'run_plan' }, PLANNER)).message).not.toMatch(/not approved/);
  });

  it('keeps the approval after the user stops the run', async () => {
    const h = host(workspace);
    h.open();
    await handleApprovePlan(h.deps);
    await h.session.execute({ command: 'stop_run' }, { kind: 'user' });
    expect(h.dock()?.status).not.toBe('running');

    expect(await h.session.execute({ command: 'run_plan' }, PLANNER)).toMatchObject({ ok: true });
  });

  it('keeps the approval across a window reload', async () => {
    const before = host(workspace);
    await runEndedWithAFailure(before);
    before.deps.persistState();

    const after = host(workspace);
    after.restore();

    expect(after.session.planState!.tasks.map((t) => t.id)).toEqual(['t1', 't2']);
    expect(await after.session.execute({ command: 'run_plan' }, PLANNER)).toMatchObject({ ok: true });
  });
});

describe('VS Code: Execute while a run is under way', () => {
  let workspace: string;
  beforeEach(() => {
    workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'ordewell-approval-'));
    (vscode.window.showErrorMessage as unknown as ReturnType<typeof vi.fn>).mockReset();
  });
  afterEach(() => { fs.rmSync(workspace, { recursive: true, force: true }); });

  it('approves what waits for approval and keeps the run going, rather than stopping it', async () => {
    const h = host(workspace);
    const opened = plan();
    opened.tasks[1].dependencies = ['t1'];
    h.open(opened);
    await handleApprovePlan(h.deps);
    // As the planner adding it after Execute leaves it: in the plan, outside the approval record.
    h.session.planState!.approvedTasks = ['t1'];
    expect(h.session.waitsForApproval('t2')).toBe(true);
    vi.mocked(h.deps.runner.stopAll).mockClear();

    await handleApprovePlan(h.deps);

    expect(h.deps.runner.stopAll).not.toHaveBeenCalled();
    expect(h.spawned.map((s) => s.taskId)).toEqual(['t1']);
    expect(h.session.waitsForApproval('t2')).toBe(false);
    h.latest('t1').reportComplete({ status: 'done', summary: '' });
    await vi.waitFor(() => expect(h.spawned.map((s) => s.taskId)).toEqual(['t1', 't2']));
  });
});
