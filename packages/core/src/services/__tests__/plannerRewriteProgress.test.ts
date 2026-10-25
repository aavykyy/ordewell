import { describe, it, expect, vi } from 'vitest';
import { createTask, type LegacyPlanState, type Task } from '../../models/Task';
import { FakeRunnerSession, makeSession, testWorkspace, taskOf } from './sessionTestKit';
import type { IRunner } from '../../interfaces/IRunner';

function recordingRunner(spawned: string[], sessions: FakeRunnerSession[] = []): IRunner {
  return {
    spawn: vi.fn(async ({ taskId }: { taskId: string }) => {
      spawned.push(taskId);
      const session = new FakeRunnerSession(`s-${taskId}`, taskId);
      sessions.push(session);
      return session;
    }),
    stop: vi.fn(),
    stopAll: vi.fn(),
    activeCount: 0,
  } as unknown as IRunner;
}

/** Two tasks already done in an earlier run, one left to do. */
function halfDonePlan(): LegacyPlanState {
  return {
    tasks: [
      createTask({ id: 'a', order: 1, title: 'Setup', prompt: 'set it up', status: 'completed', assignedRunner: 'claude-code' }),
      createTask({ id: 'b', order: 2, title: 'Build', prompt: 'build it', status: 'completed', dependencies: ['a'], assignedRunner: 'claude-code' }),
      createTask({ id: 'c', order: 3, title: 'Ship', prompt: 'ship it', dependencies: ['b'], assignedRunner: 'claude-code' }),
    ],
    generatedAt: new Date().toISOString(),
    status: 'approved',
    runners: ['claude-code'],
    lastUpdated: new Date().toISOString(),
    conversationHistory: [
      { role: 'user', content: 'build it', timestamp: '2026-01-01T00:00:00Z' },
      { role: 'assistant', content: 'Plan generated with 3 tasks.', timestamp: '2026-01-01T00:00:01Z', kind: 'plan_generated' },
    ],
  };
}

/**
 * What a planner hands back when asked to add a task and it answers with the
 * whole plan: every task it already had, as it chose to echo them, plus the
 * new one. Recorded from a real session — the finished tasks came back
 * `pending` with a placeholder prompt.
 */
/** The tasks not yet done, depending only on each other. */
function withoutDone(tasks: readonly Task[]): Task[] {
  const kept = tasks.filter((t) => t.status !== 'completed');
  const ids = new Set(kept.map((t) => t.id));
  return kept.map((t) => ({ ...t, dependencies: t.dependencies.filter((d) => ids.has(d)) }));
}

function rewrittenWithAddedTask(current: readonly Task[]): Task[] {
  return [
    ...current.map((t) => ({
      ...t,
      status: 'pending' as const,
      prompt: t.status === 'completed' ? 'Completed in an earlier round; retained for dependency integrity.' : t.prompt,
    })),
    createTask({ id: 'd', order: current.length + 1, title: 'Docs', prompt: 'write the docs', dependencies: ['c'], assignedRunner: 'claude-code' }),
  ];
}

describe('a planner rewrite never undoes finished work', () => {
  it('keeps completed tasks completed when the planner answers an add with the whole plan', async () => {
    const spawned: string[] = [];
    const session = makeSession({
      runner: recordingRunner(spawned),
      aiService: {
        startConversation: vi.fn(),
        continueConversation: vi.fn(async () => ({
          kind: 'plan' as const,
          tasks: rewrittenWithAddedTask(session.planTasks),
          text: '',
          researchLog: [],
        })),
        hasActiveConversation: () => true,
        reset: vi.fn(),
      },
    });
    session.loadPlan(halfDonePlan(), 'build it', testWorkspace, { persist: false });

    await session.continueConversation('add a docs task');

    expect(taskOf(session, 'a')).toMatchObject({ status: 'completed', prompt: 'set it up' });
    expect(taskOf(session, 'b')).toMatchObject({ status: 'completed', prompt: 'build it' });
    expect(taskOf(session, 'd')).toBeDefined();

    await session.execute({ command: 'run_plan' }, { kind: 'user' });
    expect(spawned).toEqual(['c']);
  });

  // A whole plan would replace a run's tasks under it; mid-run the planner is
  // sent back to task edits, and nothing it rewrote lands.
  it('refuses a whole-plan reply while a task runs, leaving finished and running work as it was', async () => {
    const spawned: string[] = [];
    const continueConversation = vi.fn(async () => ({
      kind: 'plan' as const,
      tasks: rewrittenWithAddedTask(session.planTasks),
      text: '',
      researchLog: [],
    }));
    const session = makeSession({
      runner: recordingRunner(spawned),
      aiService: { startConversation: vi.fn(), continueConversation, hasActiveConversation: () => true, reset: vi.fn() },
    });
    session.loadPlan(halfDonePlan(), 'build it', testWorkspace, { persist: false });
    await session.execute({ command: 'run_plan' }, { kind: 'user' });
    expect(spawned).toEqual(['c']);

    const plan = await session.continueConversation('add a docs task');

    expect(continueConversation).toHaveBeenCalledTimes(3);
    expect(taskOf(session, 'a')).toMatchObject({ status: 'completed', prompt: 'set it up' });
    expect(taskOf(session, 'b')).toMatchObject({ status: 'completed', prompt: 'build it' });
    expect(taskOf(session, 'c')!.status).toBe('in_progress');
    expect(taskOf(session, 'd')).toBeUndefined();
    expect(spawned).toEqual(['c']);
    expect(plan.conversationHistory!.at(-1)!.content).toMatch(/Tasks are running, so a whole new plan cannot replace this one now/);
  });

  it('keeps a task finished in this run when a paused run takes a whole plan that leaves it out', async () => {
    const spawned: string[] = [];
    const live: FakeRunnerSession[] = [];
    const session = makeSession({
      runner: recordingRunner(spawned, live),
      aiService: {
        startConversation: vi.fn(),
        // Asked only for what is still to run, a planner drops the tasks already done, and with them the dependencies on them: a plan naming a task it left out is refused.
        continueConversation: vi.fn(async () => ({
          kind: 'plan' as const,
          tasks: rewrittenWithAddedTask(withoutDone(session.planTasks)),
          text: '',
          researchLog: [],
        })),
        hasActiveConversation: () => true,
        reset: vi.fn(),
      },
    });
    const plan = halfDonePlan();
    plan.tasks[1] = createTask({ ...plan.tasks[1], status: 'pending' });
    plan.tasks.push(createTask({ id: 'e', order: 4, title: 'Lint', prompt: 'lint it', dependencies: ['a'], assignedRunner: 'claude-code' }));
    session.loadPlan(plan, 'build it', testWorkspace, { persist: false });
    await session.execute({ command: 'run_plan' }, { kind: 'user' }); // 'b' and 'e' go live
    live.find((r) => r.taskId === 'e')!.reportComplete({ status: 'done', summary: '' }); // finished in this run, so it is in the execution log
    await vi.waitFor(() => expect(taskOf(session, 'e')!.status).toBe('completed'));
    await session.execute({ command: 'stop_task', task: 'b' }, { kind: 'user' }); // the run stays armed with nothing live
    expect(session.isExecuting).toBe(false);

    await session.continueConversation('add a docs task');

    expect(taskOf(session, 'a')).toMatchObject({ status: 'completed' });
    expect(taskOf(session, 'e')).toMatchObject({ status: 'completed', title: 'Lint' });
    expect(taskOf(session, 'd')).toBeDefined();
  });

  it('does not re-spawn a cancelled task when a paused run takes a whole-plan reply', async () => {
    const spawned: string[] = [];
    const session = makeSession({
      runner: recordingRunner(spawned),
      aiService: {
        startConversation: vi.fn(),
        continueConversation: vi.fn(async () => ({
          kind: 'plan' as const,
          tasks: rewrittenWithAddedTask(session.planTasks),
          text: '',
          researchLog: [],
        })),
        hasActiveConversation: () => true,
        reset: vi.fn(),
      },
    });
    session.loadPlan(halfDonePlan(), 'build it', testWorkspace, { persist: false });
    await session.execute({ command: 'run_plan' }, { kind: 'user' });
    await session.execute({ command: 'stop_task', task: 'c' }, { kind: 'user' }); // the run stays armed with nothing live

    await session.continueConversation('add a docs task');

    expect(taskOf(session, 'c')!.status).toBe('pending');
    expect(spawned).toEqual(['c']);
  });
});

describe('a planner rewrite keeps the modes the user picked (ADR-0031)', () => {
  it('keeps a pending task\'s hand-picked mode where the rewrite leaves it writable, and takes read-only from the rewrite', async () => {
    const session = makeSession({
      aiService: {
        startConversation: vi.fn(),
        continueConversation: vi.fn(async () => ({
          kind: 'plan' as const,
          // As a parse hands them over: every mode freshly decided, the level's or read-only.
          tasks: session.planTasks.map((t) => ({ ...t, taskMode: t.id === 'b' ? 'plan' : 'bypassPermissions' })),
          text: '',
          researchLog: [],
        })),
        hasActiveConversation: () => true,
        reset: vi.fn(),
      },
    });
    const plan = halfDonePlan();
    plan.tasks = [
      createTask({ id: 'a', order: 1, title: 'Setup', prompt: 'set it up', assignedRunner: 'claude-code', taskMode: 'default' }),
      createTask({ id: 'b', order: 2, title: 'Review', prompt: 'review it', assignedRunner: 'claude-code', taskMode: 'acceptEdits' }),
      createTask({ id: 'c', order: 3, title: 'Ship', prompt: 'ship it', assignedRunner: 'claude-code', taskMode: 'plan' }),
    ];
    session.loadPlan(plan, 'build it', testWorkspace, { persist: false });

    await session.continueConversation('tidy the plan');

    expect(session.planTasks.map((t) => [t.id, t.taskMode])).toEqual([['a', 'default'], ['b', 'plan'], ['c', 'bypassPermissions']]);
  });
});
