import { describe, it, expect, vi, afterEach } from 'vitest';
import { Hono } from 'hono';
import {
  createSession, createTask, flattenTasks, ModelResolver, RunnerRegistry, RUN_SETTINGS_DEFAULTS,
  type ConversationRequest, type ConversationTurn, type IAiService, type IRunner, type LegacyPlanState,
  type PlannerToolHandler, type RunnerSpawnOptions, type Session,
} from '@ordewell/core';
import { FakeRunnerSession, fakeConfig, fakeFileSystem } from '@ordewell/core/testing';
import type { OrchestratorPool } from '../../pool/orchestratorPool';
import { plansRoute } from '../plans';

/**
 * Execute plan approves the plan the user executed, not the plan as it is
 * once the run has started (ADR-0029). Seen in an audit: with the spawn of the
 * first task held, a planner turn that added a task landed before Execute
 * answered, and the added task joined the approved set with nobody asked.
 */
describe('POST /:sessionId/execute approves exactly the plan the user executed', () => {
  let session: Session | undefined;

  afterEach(() => {
    session?.destroy();
    session = undefined;
  });

  /** A planner whose one turn the test answers by hand, with its tools. */
  function heldPlanner() {
    const state: { tools?: PlannerToolHandler; finish?: (turn: ConversationTurn) => void; live: boolean } = { live: false };
    const take = () => new Promise<ConversationTurn>((resolve) => { state.finish = resolve; });
    const aiService = {
      startConversation: vi.fn((req: ConversationRequest) => {
        state.live = true;
        state.tools = req.plannerTools?.handler;
        return take();
      }),
      continueConversation: vi.fn(() => take()),
      hasActiveConversation: () => state.live,
      reset: vi.fn(() => { state.live = false; }),
      restart: vi.fn(),
    } as unknown as IAiService;
    return { aiService, state };
  }

  it('leaves a task a planner turn adds while the first spawn is held unapproved, and does not start it', async () => {
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const spawned: string[] = [];
    const runner: IRunner = {
      spawn: vi.fn(async (opts: RunnerSpawnOptions) => {
        spawned.push(opts.taskId);
        await held;
        return new FakeRunnerSession(`s-${opts.taskId}`, opts.taskId);
      }),
      stop: vi.fn(),
      stopAll: vi.fn(),
      activeCount: 0,
    };
    const planner = heldPlanner();
    const registry = new RunnerRegistry();
    // One slot, Guarded, autorun off: nothing but the user's own consent starts a task.
    const config = fakeConfig({ maxParallelSessions: 1, autonomousMode: false });
    session = createSession({
      config, registry, runner,
      aiService: planner.aiService,
      notifications: { info() {}, warn() {}, error() {}, async confirm() { return undefined; } },
      workspaceRoot: () => process.cwd(),
      fsAdapter: fakeFileSystem(),
      broadcast: () => {},
      modelResolver: new ModelResolver(registry, config, { execImpl: async () => ({ stdout: '' }) }),
      settings: () => ({ run: { ...RUN_SETTINGS_DEFAULTS, supervisorLevel: 'off', autorun: false } }),
      saveSession: () => {},
      openTaskLog: () => ({ attempt: 1, append() {} }),
    });
    const plan: LegacyPlanState = {
      tasks: [createTask({ id: 't1', order: 1, title: 'Add the limiter', prompt: 'do it', assignedRunner: 'claude-code' })],
      runners: ['claude-code'], status: 'draft',
      generatedAt: '2026-10-16T10:00:00Z', lastUpdated: '2026-10-16T10:00:00Z',
      conversationHistory: [
        { role: 'user', content: 'add a limiter', timestamp: '2026-10-16T09:00:00Z' },
        { role: 'assistant', content: 'Plan generated with 1 tasks.', timestamp: '2026-10-16T09:00:01Z', kind: 'plan_generated' },
      ],
    };
    session.loadPlan(plan, 'add a limiter', process.cwd(), { persist: false });
    const app = new Hono().route('/api/plans', plansRoute({ session: () => session } as unknown as OrchestratorPool));

    const executing = app.request('/api/plans/s/execute', { method: 'POST' });
    await vi.waitFor(() => expect(spawned).toEqual(['t1']));

    const s = session;
    void s.continueConversation('also add a log');
    await vi.waitFor(() => expect(planner.state.tools).toBeDefined());
    const edit = await planner.state.tools!.editPlan!({ ops: [{ op: 'add', task: { title: 'Added after Execute', prompt: 'add a log' } }] }, { signal: new AbortController().signal });
    expect(edit.isError).toBeFalsy();
    planner.state.finish!({ kind: 'message', text: 'Added a log task.', researchLog: [] });
    const added = () => flattenTasks(s.planTasks).find((t) => t.title === 'Added after Execute');
    await vi.waitFor(() => expect(added()).toBeDefined());

    release();
    expect((await executing).status).toBe(200);

    expect(s.planState!.approvedTasks).toEqual(['t1']);
    expect(s.isApproved(added()!.id)).toBe(false);
    expect(spawned).toEqual(['t1']);
  });
});
