import { describe, it, expect, vi } from 'vitest';
import { createTask, type LegacyPlanState, type Task } from '../../models/Task';
import { FakeRunnerSession, makeSession, testWorkspace, taskOf, saves, type SessionOverrides } from './sessionTestKit';
import { PlanStore } from '../PlanStore';
import type { ModelResolver } from '../ModelResolver';
import type { IRunner } from '../../interfaces/IRunner';
import { RUN_SETTINGS_DEFAULTS } from '../SettingsService';

/** One AI task, so a removal leaves the scheduler with nothing else to spawn. */
function soloPlan(): LegacyPlanState {
  return {
    tasks: [createTask({ id: 'only', order: 1, title: 'Only', prompt: 'do it', assignedRunner: 'claude-code' })],
    generatedAt: new Date().toISOString(),
    status: 'approved',
    runners: ['claude-code'],
    lastUpdated: new Date().toISOString(),
  };
}

/**
 * A plan the scheduler has already run into a pause: the first task completed,
 * the second is the user's to do, the third waits on it. Nothing is live, but
 * the scheduler stays armed so completing the user task fans the third out.
 */
function pausedOnUserTask(): LegacyPlanState {
  return {
    tasks: [
      createTask({ id: 'a', order: 1, title: 'Setup', prompt: 'setup', status: 'completed', assignedRunner: 'claude-code' }),
      createTask({ id: 'b', order: 2, title: 'Sign off', type: 'user', dependencies: ['a'], assignedRunner: 'claude-code' }),
      createTask({ id: 'c', order: 3, title: 'Ship', prompt: 'ship', dependencies: ['b'], assignedRunner: 'claude-code' }),
    ],
    generatedAt: new Date().toISOString(),
    status: 'approved',
    runners: ['claude-code'],
    lastUpdated: new Date().toISOString(),
  };
}

/** A runner double that records what it spawned and what it was told to stop. */
function recordingRunner(): IRunner & { spawned: string[]; stopped: string[] } {
  const spawned: string[] = [];
  const stopped: string[] = [];
  return {
    spawn: vi.fn(async ({ taskId }: { taskId: string }) => {
      spawned.push(taskId);
      return new FakeRunnerSession(`s-${taskId}`, taskId);
    }),
    stop: vi.fn((sessionId: string) => { stopped.push(sessionId); }),
    stopAll: vi.fn(),
    activeCount: 0,
    spawned,
    stopped,
  } as unknown as IRunner & { spawned: string[]; stopped: string[] };
}

function planWith(runners: string[] = ['claude-code']): LegacyPlanState {
  return {
    tasks: [
      createTask({ id: 't1', order: 1, title: 'Setup', prompt: 'setup', assignedRunner: runners[0] }),
      createTask({ id: 't2', order: 2, title: 'Build', prompt: 'build', assignedRunner: runners[0], dependencies: ['t1'] }),
    ],
    generatedAt: new Date().toISOString(),
    status: 'approved',
    runners,
    lastUpdated: new Date().toISOString(),
  };
}

function resolverFor(models: Record<string, { modelId: string; modelLabel: string; variants: { id: string; label: string }[] }[]>) {
  return { modelsForRunners: vi.fn().mockResolvedValue(models) } as unknown as Pick<ModelResolver, 'modelsForRunners'>;
}

const CLAUDE_CATALOG = {
  'claude-code': [
    { modelId: 'claude-sonnet-4-5', modelLabel: 'Claude Sonnet 4.5', variants: [{ id: 'low', label: 'Low' }, { id: 'high', label: 'High' }] },
    { modelId: 'claude-haiku-4-5', modelLabel: 'Claude Haiku 4.5', variants: [] },
  ],
};

describe('Session.addTask', () => {
  it('gives a hand-added task a runnable assignment from the plan first runner', async () => {
    const session = makeSession({ modelResolver: resolverFor(CLAUDE_CATALOG) });
    session.loadPlan(planWith(), 'goal', testWorkspace, { persist: false });

    const state = await session.addTask({ title: 'Docs', prompt: 'write docs' });

    const added = state!.tasks.find((t) => t.title === 'Docs')!;
    expect(added.assignedRunner).toBe('claude-code');
    expect(added.assignedModel!.modelId).toBe('claude-sonnet-4-5');
    expect(added.taskMode).toBeTruthy();
    expect(added.status).toBe('pending');
  });

  it('adds the first task to a plan that has none yet', async () => {
    const session = makeSession({ modelResolver: resolverFor(CLAUDE_CATALOG) });
    const now = new Date().toISOString();
    session.loadPlan(
      { tasks: [], generatedAt: now, status: 'draft', runners: ['claude-code'], lastUpdated: now },
      'goal',
      testWorkspace,
      { persist: false },
    );

    const state = await session.addTask({ title: 'First', prompt: 'do first' });

    expect(state!.tasks.map((t) => t.title)).toEqual(['First']);
    expect(state!.tasks[0].assignedRunner).toBe('claude-code');
  });

  it('keeps an explicit runner and admits it into the plan runner set', async () => {
    const session = makeSession({
      modelResolver: resolverFor({ codex: [{ modelId: 'gpt-5-codex', modelLabel: 'GPT-5 Codex', variants: [] }] }),
    });
    session.loadPlan(planWith(), 'goal', testWorkspace, { persist: false });

    const state = await session.addTask({ title: 'Docs', prompt: 'write docs', assignedRunner: 'codex' });

    expect(state!.tasks.find((t) => t.title === 'Docs')!.assignedRunner).toBe('codex');
    expect(state!.runners).toContain('codex');
  });

  it('keeps a model the caller chose when the runner offers it', async () => {
    const session = makeSession({ modelResolver: resolverFor(CLAUDE_CATALOG) });
    session.loadPlan(planWith(), 'goal', testWorkspace, { persist: false });

    const state = await session.addTask({
      title: 'Docs',
      assignedModel: { modelId: 'claude-haiku-4-5', modelLabel: 'Claude Haiku 4.5' },
    });

    expect(state!.tasks.find((t) => t.title === 'Docs')!.assignedModel!.modelId).toBe('claude-haiku-4-5');
  });

  it('carries the dependencies the caller picked', async () => {
    const session = makeSession({ modelResolver: resolverFor(CLAUDE_CATALOG) });
    session.loadPlan(planWith(), 'goal', testWorkspace, { persist: false });

    const state = await session.addTask({ title: 'Docs', dependencies: ['t1', 't2'] });

    expect(state!.tasks.find((t) => t.title === 'Docs')!.dependencies).toEqual(['t1', 't2']);
  });

  it('drops a dependency on a task that is no longer in the plan', async () => {
    const session = makeSession({ modelResolver: resolverFor(CLAUDE_CATALOG) });
    session.loadPlan(planWith(), 'goal', testWorkspace, { persist: false });

    const state = await session.addTask({ title: 'Docs', dependencies: ['t1', 'ghost'] });

    expect(state!.tasks.find((t) => t.title === 'Docs')!.dependencies).toEqual(['t1']);
  });

  it('never spawns a runner for a manual task', async () => {
    const resolver = resolverFor(CLAUDE_CATALOG);
    const session = makeSession({ modelResolver: resolver });
    session.loadPlan(planWith(), 'goal', testWorkspace, { persist: false });

    const state = await session.addTask({ title: 'Sign off', type: 'user' });

    expect(state!.tasks.find((t) => t.title === 'Sign off')!.assignedModel).toBeUndefined();
    expect(resolver.modelsForRunners).not.toHaveBeenCalled();
  });

  // Nothing wakes an armed-but-paused scheduler after a hand edit unless the
  // edit does it: a direct edit never queues, so the queue-drain path never runs.
  it('starts an added task whose dependencies are already complete', async () => {
    const runner = recordingRunner();
    const session = makeSession({ runner, modelResolver: resolverFor(CLAUDE_CATALOG) });
    session.loadPlan(pausedOnUserTask(), 'goal', testWorkspace, { persist: false });
    await session.execute({ command: 'run_plan' }, { kind: 'user' });
    expect(runner.spawned).toEqual([]);

    const state = await session.addTask({ title: 'Docs', prompt: 'write docs', dependencies: ['a'] });

    const added = state!.tasks.find((t) => t.title === 'Docs')!;
    expect(runner.spawned).toEqual([added.id]);
    expect(taskOf(session, added.id)!.status).toBe('in_progress');
  });
});

describe('Session.removeTask', () => {
  it('releases a live descendant runner before removing its parent', async () => {
    const runner = recordingRunner();
    const session = makeSession({ runner });
    const plan = soloPlan();
    plan.tasks[0].type = 'user';
    plan.tasks[0].subtasks = [createTask({ id: 'child', order: 1, prompt: 'inspect' })];
    session.loadPlan(plan, 'goal', testWorkspace, { persist: false });
    await session.execute({ command: 'run_plan' }, { kind: 'user' });
    expect(runner.spawned).toEqual(['child']);

    await session.removeTask('only');

    expect(runner.stopped).toEqual(['s-child']);
    expect(session.isExecuting).toBe(false);
  });

  it('detaches dependencies on every descendant and starts the freed task', async () => {
    const runner = recordingRunner();
    const session = makeSession({ runner });
    const plan = planWith();
    plan.tasks[0].subtasks = [createTask({ id: 'child', order: 1, type: 'user', subtasks: [
      createTask({ id: 'leaf', order: 1, type: 'user' }),
    ] })];
    plan.tasks[1].dependencies = ['child', 'leaf'];
    session.loadPlan(plan, 'goal', testWorkspace, { persist: false });
    await session.execute({ command: 'run_plan' }, { kind: 'user' });

    await session.removeTask('t1');

    expect(session.planTasks[0].dependencies).toEqual([]);
    expect(runner.spawned).toEqual(['t1', 't2']);
  });

  it('detaches the removed task from everything that depended on it', async () => {
    const session = makeSession({ modelResolver: resolverFor(CLAUDE_CATALOG) });
    session.loadPlan(planWith(), 'goal', testWorkspace, { persist: false });

    const state = await session.removeTask('t1');

    expect(state!.tasks.map((t) => t.id)).toEqual(['t2']);
    expect(state!.tasks[0].dependencies).toEqual([]);
  });

  // A plan that drops a running task can no longer reach the runner it spawned:
  // the tmux session keeps going and the orchestrator's entry for it is never
  // cleared, which is one of the ways "Execution is running" became permanent.
  it('cancels a live runner before dropping the task that owns it', async () => {
    const runner = recordingRunner();
    const session = makeSession({ runner, modelResolver: resolverFor(CLAUDE_CATALOG) });
    session.loadPlan(soloPlan(), 'goal', testWorkspace, { persist: false });
    await session.execute({ command: 'run_plan' }, { kind: 'user' });
    expect(runner.spawned).toEqual(['only']);

    await session.removeTask('only');

    expect(runner.stopped).toEqual(['s-only']);
    expect(session.isExecuting).toBe(false);
    expect(session.planTasks).toEqual([]);
  });

  // The scheduler stays armed after the removal, and nothing but this re-tick
  // wakes it — a direct edit never queues, so the queue-drain path never runs.
  it('fans the dependents out once their blocker is removed', async () => {
    const runner = recordingRunner();
    const session = makeSession({ runner, modelResolver: resolverFor(CLAUDE_CATALOG) });
    session.loadPlan(planWith(), 'goal', testWorkspace, { persist: false });
    await session.execute({ command: 'run_plan' }, { kind: 'user' });

    await session.removeTask('t1');

    expect(runner.spawned).toEqual(['t1', 't2']);
  });

  // Deleting one's own finished task is allowed — the plan belongs to the user.
  // What must not happen is the rest of the plan losing its way afterwards: the
  // completed id leaves the completed set, so anything still pointing at it
  // would never satisfy its dependency check again.
  it('leaves the dependents of a removed completed task schedulable', async () => {
    const runner = recordingRunner();
    const session = makeSession({ runner, modelResolver: resolverFor(CLAUDE_CATALOG) });
    session.loadPlan(pausedOnUserTask(), 'goal', testWorkspace, { persist: false });
    await session.execute({ command: 'run_plan' }, { kind: 'user' });

    await session.removeTask('a');

    expect(session.planTasks.map((t) => t.id)).toEqual(['b', 'c']);
    expect(taskOf(session, 'b')!.dependencies).toEqual([]);
    expect(taskOf(session, 'b')!.status).toBe('pending');

    // Still schedulable: the run is armed, so finishing the user task fans out.
    await session.execute({ command: 'mark_complete', task: 'b' }, { kind: 'user' });
    expect(runner.spawned).toEqual(['c']);
  });
});

describe('Session.updateTask on a completed task', () => {
  // The AI's task_ops path refuses this (see TaskOps.test.ts, "refuses to
  // modify or remove a running or completed task"); the user's own hand edit
  // is a different call and must not carry that same refusal — the plan
  // belongs to the user, editing their own record of a finished step included.
  it('is allowed — the user, not the planner, is the caller', async () => {
    const session = makeSession({ modelResolver: resolverFor(CLAUDE_CATALOG) });
    session.loadPlan(pausedOnUserTask(), 'goal', testWorkspace, { persist: false });

    const state = await session.updateTask('a', { title: 'Setup (renamed)' });

    expect(state!.tasks.find((t) => t.id === 'a')!.title).toBe('Setup (renamed)');
  });
});

describe('Session.setTaskDependencies', () => {
  it('keeps a dependency on another task’s subtask when editing its full list', async () => {
    const session = makeSession();
    const plan = planWith();
    plan.tasks[0].subtasks = [createTask({ id: 'child', order: 1, title: 'Inspect' })];
    plan.tasks[1].dependencies = ['child'];
    session.loadPlan(plan, 'goal', testWorkspace, { persist: false });

    const state = await session.setTaskDependencies('t2', ['child', 't1']);

    expect(state!.tasks[1].dependencies).toEqual(['child', 't1']);
  });

  it('replaces the list', async () => {
    const session = makeSession({ modelResolver: resolverFor(CLAUDE_CATALOG) });
    session.loadPlan(planWith(), 'goal', testWorkspace, { persist: false });

    const state = await session.setTaskDependencies('t2', []);

    expect(state!.tasks.find((t) => t.id === 't2')!.dependencies).toEqual([]);
  });

  it('refuses a dependency cycle, saying why', async () => {
    const session = makeSession({ modelResolver: resolverFor(CLAUDE_CATALOG) });
    session.loadPlan(planWith(), 'goal', testWorkspace, { persist: false });

    await expect(session.setTaskDependencies('t1', ['t2'])).rejects.toThrow(/cycle/i);
    expect(session.planState!.tasks.find((t) => t.id === 't1')!.dependencies).toEqual([]);
  });

  // Position is not something a user sets any more, so the refusal must not
  // point at a control that no longer exists.
  it('does not tell the user to move the task instead', async () => {
    const session = makeSession({ modelResolver: resolverFor(CLAUDE_CATALOG) });
    session.loadPlan(planWith(), 'goal', testWorkspace, { persist: false });

    await expect(session.setTaskDependencies('t1', ['t2'])).rejects.not.toThrow(/reorder|move it/i);
  });

  // A dependency list arriving as a plain field patch must meet the same rule —
  // otherwise the picker's guard is bypassed by anything that patches fields.
  it('applies the same guard when dependencies arrive as a field patch', async () => {
    const session = makeSession({ modelResolver: resolverFor(CLAUDE_CATALOG) });
    session.loadPlan(planWith(), 'goal', testWorkspace, { persist: false });

    await expect(session.updateTask('t1', { dependencies: ['t2'] })).rejects.toThrow(/cycle/i);
    await expect(session.updateTask('t2', { dependencies: ['ghost'] })).rejects.toThrow(/Unknown dependency/);
  });
});

describe('Session.updateTask — type coherence on AI <-> MAN flips', () => {
  // The direct-edit path shares the planner's coherence rule (see
  // TaskOps.test.ts, "type coherence on AI <-> MAN flips") rather than a
  // second copy of it — a surface's task-card edit is refused the same way.
  it('refuses a flip to MAN without user steps, and to AI without a prompt', async () => {
    const session = makeSession({ modelResolver: resolverFor(CLAUDE_CATALOG) });
    session.loadPlan(planWith(), 'goal', testWorkspace, { persist: false });

    await expect(session.updateTask('t1', { type: 'user' })).rejects.toThrow(/user steps/i);

    const plan = planWith();
    plan.tasks[0].type = 'user';
    plan.tasks[0].userSteps = [{ order: 1, instruction: 'do it', completed: false }];
    const manSession = makeSession({ modelResolver: resolverFor(CLAUDE_CATALOG) });
    manSession.loadPlan(plan, 'goal', testWorkspace, { persist: false });
    await expect(manSession.updateTask('t1', { type: 'ai' })).rejects.toThrow(/prompt/i);
  });

  it('flips a task to MAN when user steps are supplied, clearing the AI-only fields', async () => {
    const session = makeSession({ modelResolver: resolverFor(CLAUDE_CATALOG) });
    session.loadPlan(planWith(), 'goal', testWorkspace, { persist: false });

    const state = await session.updateTask('t1', {
      type: 'user',
      userSteps: [{ order: 1, instruction: 'flip the switch', completed: false }],
    });

    const updated = state!.tasks.find((t) => t.id === 't1')!;
    expect(updated.type).toBe('user');
    expect(updated.userSteps).toHaveLength(1);
    expect(updated.taskMode).toBeUndefined();
  });
});

describe('Session.updateTask — the rules the plan\'s tasks are held to together', () => {
  // Bug: these ran on the planner's paths only.
  it('refuses a manual task made AFK, an AFK task given user steps, and an ops task on a read-only mode', async () => {
    const plan = planWith();
    plan.tasks.push(createTask({ id: 'u', order: 3, title: 'Sign off', type: 'user', sliceType: 'HITL', userSteps: [{ order: 1, instruction: 'sign', completed: false }], assignedRunner: 'claude-code' }));
    plan.tasks[1].ops = true;
    plan.tasks[1].taskMode = 'bypassPermissions';
    const session = makeSession({ modelResolver: resolverFor(CLAUDE_CATALOG) });
    session.loadPlan(plan, 'goal', testWorkspace, { persist: false });
    const steps = [{ order: 1, instruction: 'check by hand', completed: false }];

    await expect(session.updateTask('u', { sliceType: 'AFK' })).rejects.toThrow('User Task "Sign off" has sliceType "AFK". User tasks must have sliceType "HITL".');
    await expect(session.updateTask('t1', { autonomy: 'AFK', userSteps: steps })).rejects.toThrow('Task "Setup" has autonomy "AFK" but contains userSteps. AFK tasks must not have user touchpoints.');
    await expect(session.updateTask('t2', { taskMode: 'plan' })).rejects.toThrow('Task "Build" is an ops task, which acts in the workspace, so it cannot use the read-only profile');

    expect(taskOf(session, 'u')?.sliceType).toBe('HITL');
    expect(taskOf(session, 't1')?.autonomy).toBeUndefined();
    expect(taskOf(session, 't2')?.taskMode).toBe('bypassPermissions');
  });

  it('lets an edit through a plan that already broke a rule elsewhere', async () => {
    const plan = planWith();
    plan.tasks.push(createTask({ id: 'u', order: 3, title: 'Sign off', type: 'user', sliceType: 'AFK', assignedRunner: 'claude-code' }));
    const session = makeSession({ modelResolver: resolverFor(CLAUDE_CATALOG) });
    session.loadPlan(plan, 'goal', testWorkspace, { persist: false });

    await session.updateTask('t1', { title: 'Renamed' });

    expect(taskOf(session, 't1')?.title).toBe('Renamed');
  });
});

describe('Session.updateTask — the ops flag (ADR-0020)', () => {
  function loaded(plan = planWith()) {
    const session = makeSession({ modelResolver: resolverFor(CLAUDE_CATALOG) });
    session.loadPlan(plan, 'goal', testWorkspace, { persist: false });
    return session;
  }

  it('flips a pending AI task to ops and back', async () => {
    const session = loaded();

    let state = await session.updateTask('t2', { ops: true });
    expect(state!.tasks.find((t) => t.id === 't2')!.ops).toBe(true);

    state = await session.updateTask('t2', { ops: false });
    expect(state!.tasks.find((t) => t.id === 't2')!.ops).toBeUndefined();
  });

  it('refuses it on a manual task, and once the task has started', async () => {
    const plan = planWith();
    plan.tasks[0].type = 'user';
    plan.tasks[0].userSteps = [{ order: 1, instruction: 'do it', completed: false }];
    plan.tasks[1].status = 'completed';
    const session = loaded(plan);

    await expect(session.updateTask('t1', { ops: true })).rejects.toThrow(/only an AI task/);
    await expect(session.updateTask('t2', { ops: true })).rejects.toThrow(/has started/);
  });

  it('clears it when the task becomes manual', async () => {
    const plan = planWith();
    plan.tasks[0].ops = true;
    const session = loaded(plan);

    const state = await session.updateTask('t1', { type: 'user', userSteps: [{ order: 1, instruction: 'by hand', completed: false }] });

    expect(state!.tasks.find((t) => t.id === 't1')!.ops).toBeUndefined();
  });
});

describe('Session.updateTask — model and task-mode validity', () => {
  // addTask populates modelsCache via catalogFor/admitRunner, giving the
  // direct-edit path a real catalog to check against — the same rule the
  // planner's task-ops applier enforces (TaskOps.test.ts, "model and
  // task-mode validity"), applied to a surface's own field patch.
  it('refuses a model the runner does not offer', async () => {
    const session = makeSession({ modelResolver: resolverFor(CLAUDE_CATALOG) });
    session.loadPlan(planWith(), 'goal', testWorkspace, { persist: false });
    await session.addTask({ title: 'Docs', prompt: 'write docs' }); // seeds modelsCache

    await expect(session.updateTask('t1', {
      assignedModel: { modelId: 'gpt-9-imaginary', modelLabel: 'GPT-9' },
    })).rejects.toThrow(/claude-code/);
  });

  it('accepts a model the runner offers', async () => {
    const session = makeSession({ modelResolver: resolverFor(CLAUDE_CATALOG) });
    session.loadPlan(planWith(), 'goal', testWorkspace, { persist: false });
    await session.addTask({ title: 'Docs', prompt: 'write docs' });

    const state = await session.updateTask('t1', {
      assignedModel: { modelId: 'claude-haiku-4-5', modelLabel: 'Claude Haiku 4.5' },
    });

    expect(state!.tasks.find((t) => t.id === 't1')!.assignedModel?.modelId).toBe('claude-haiku-4-5');
  });

  // Bug: a direct edit's effort was never checked, so a level the model lacks reached its spawn.
  it('holds the effort to what the model offers, at the nearest level, and says so', async () => {
    const onNotice = vi.fn();
    const session = makeSession({ modelResolver: resolverFor(CLAUDE_CATALOG), onNotice });
    session.loadPlan(planWith(), 'goal', testWorkspace, { persist: false });
    await session.addTask({ title: 'Docs', prompt: 'write docs' });

    await session.updateTask('t1', { assignedModel: { modelId: 'claude-sonnet-4-5', modelLabel: 'Claude Sonnet 4.5', thinkingEffort: 'max' } });

    expect(taskOf(session, 't1')?.assignedModel).toMatchObject({ modelId: 'claude-sonnet-4-5', thinkingEffort: 'high' });
    expect(onNotice).toHaveBeenCalledWith(expect.objectContaining({ level: 'info', message: 'Task "Setup": effort max → high.' }));
  });
});

/**
 * A task's model belongs to its runner while the runner is up (#106): what
 * the plan says must be what runs, and a live process cannot be re-modelled
 * from outside it.
 */
describe('Session.updateTask — model of a task with a live runner', () => {
  const haiku = { modelId: 'claude-haiku-4-5', modelLabel: 'Claude Haiku 4.5' };
  const refusal = /stop the task first, or use the runner's own \/model/;

  async function running() {
    const sessions: FakeRunnerSession[] = [];
    const runner = {
      spawn: vi.fn(async ({ taskId }: { taskId: string }) => {
        const live = new FakeRunnerSession(`s-${taskId}`, taskId);
        sessions.push(live);
        return live;
      }),
      stop: vi.fn(),
      stopAll: vi.fn(),
      activeCount: 0,
    } as unknown as IRunner;
    const session = makeSession({ runner, modelResolver: resolverFor(CLAUDE_CATALOG) });
    session.loadPlan(soloPlan(), 'goal', testWorkspace, { persist: false });
    await session.execute({ command: 'run_plan' }, { kind: 'user' });
    expect(sessions).toHaveLength(1);
    return { session, live: sessions[0] };
  }

  it('refuses the user\'s own model or effort edit while the task runs, and allows it once stopped', async () => {
    const { session } = await running();

    await expect(session.updateTask('only', { assignedModel: haiku })).rejects.toThrow(refusal);
    await expect(session.updateTask('only', { assignedModel: { ...haiku, thinkingEffort: 'high' } })).rejects.toThrow(refusal);
    expect(taskOf(session, 'only')?.assignedModel).toBeUndefined();

    await session.execute({ command: 'stop_task', task: 'only' }, { kind: 'user' });
    await session.updateTask('only', { assignedModel: haiku });
    expect(taskOf(session, 'only')?.assignedModel?.modelId).toBe('claude-haiku-4-5');
  });

  // A flip to manual clears the model without the patch naming it.
  it('refuses a flip to a manual task, which would clear the model its runner runs', async () => {
    const { session, live } = await followable();
    live.waitForInput();
    await vi.waitFor(() => expect(taskOf(session, 'only')?.status).toBe('awaiting_user'));

    await expect(session.updateTask('only', { type: 'user', userSteps: [{ order: 1, instruction: 'by hand', completed: false }] })).rejects.toThrow(refusal);
    expect(taskOf(session, 'only')?.type).toBe('ai');
    expect(taskOf(session, 'only')?.assignedModel).toEqual(planned);
  });

  it('refuses it while the runner waits for input, its process still up', async () => {
    const { session, live } = await running();
    live.waitForInput();
    await vi.waitFor(() => expect(taskOf(session, 'only')?.status).toBe('awaiting_user'));

    await expect(session.updateTask('only', { assignedModel: haiku })).rejects.toThrow(refusal);
  });

  // A runner change re-derives the model from the new runner, so the lock covers it too.
  it('refuses moving the task to another runner while it runs or waits for input', async () => {
    const { session, live } = await running();
    const runnerRefusal = /has a live runner, so its runner cannot change now: stop the task first/;

    await expect(session.setTaskRunner('only', 'codex')).rejects.toThrow(runnerRefusal);
    live.waitForInput();
    await vi.waitFor(() => expect(taskOf(session, 'only')?.status).toBe('awaiting_user'));
    await expect(session.setTaskRunner('only', 'codex')).rejects.toThrow(runnerRefusal);
    await expect(session.updateTask('only', { assignedRunner: 'codex' })).rejects.toThrow(runnerRefusal);
    expect(taskOf(session, 'only')).toMatchObject({ assignedRunner: 'claude-code' });
    expect(session.isExecuting).toBe(true);
  });

  it('refuses a runner move whose discovery the task started during', async () => {
    let listed: (models: typeof CLAUDE_CATALOG) => void = () => {};
    const modelsForRunners = vi.fn()
      .mockImplementationOnce(() => new Promise((resolve) => { listed = resolve; }))
      .mockResolvedValue(CLAUDE_CATALOG);
    const runner = {
      spawn: vi.fn(async ({ taskId }: { taskId: string }) => new FakeRunnerSession(`s-${taskId}`, taskId)),
      stop: vi.fn(), stopAll: vi.fn(), activeCount: 0,
    } as unknown as IRunner;
    const session = makeSession({ runner, modelResolver: { modelsForRunners } as unknown as Pick<ModelResolver, 'modelsForRunners'> });
    session.loadPlan(soloPlan(), 'goal', testWorkspace, { persist: false });

    const moving = session.setTaskRunner('only', 'codex');
    await session.execute({ command: 'run_plan' }, { kind: 'user' });
    expect(taskOf(session, 'only')?.status).toBe('in_progress');
    listed(CLAUDE_CATALOG);

    await expect(moving).rejects.toThrow(/has a live runner, so its runner cannot change now/);
    expect(taskOf(session, 'only')).toMatchObject({ assignedRunner: 'claude-code' });
  });

  it('refuses clearing the model of a task that runs', async () => {
    const { session } = await followable();

    await expect(session.updateTask('only', { assignedModel: undefined })).rejects.toThrow(refusal);
    expect(taskOf(session, 'only')?.assignedModel).toEqual(planned);
  });

  /** A running task on Sonnet, high effort, whose allowlist holds Sonnet alone; the catalog is seeded. */
  async function followable(aiService?: SessionOverrides['aiService']) {
    const broadcast = vi.fn();
    const sessions: FakeRunnerSession[] = [];
    const runner = {
      spawn: vi.fn(async ({ taskId }: { taskId: string }) => {
        const live = new FakeRunnerSession(`s-${taskId}`, taskId);
        sessions.push(live);
        return live;
      }),
      stop: vi.fn(), stopAll: vi.fn(), activeCount: 0,
    } as unknown as IRunner;
    const session = makeSession({
      runner, broadcast, aiService, modelResolver: resolverFor(CLAUDE_CATALOG),
      settings: () => ({ run: { ...RUN_SETTINGS_DEFAULTS, supervisorLevel: 'off' }, modelAllowlist: { 'claude-code': ['claude-sonnet-4-5'] } }),
    });
    const plan = soloPlan();
    plan.tasks[0].assignedModel = { modelId: 'claude-sonnet-4-5', modelLabel: 'Claude Sonnet 4.5', thinkingEffort: 'high' };
    session.loadPlan(plan, 'goal', testWorkspace, { persist: false });
    await session.addTask({ title: 'Docs', prompt: 'write docs', dependencies: ['only'] }); // seeds the catalog
    await session.execute({ command: 'run_plan' }, { kind: 'user' });
    /** The model lines of the task's log, as surfaces are sent them. */
    const logged = () => broadcast.mock.calls.map(([m]) => m as { type: string; events?: { type: string }[] })
      .flatMap((m) => (m.type === 'task_log' ? m.events ?? [] : []))
      .filter((e) => e.type === 'model_switched');
    return { session, broadcast, live: sessions[0], logged };
  }

  const sonnet = { model: 'claude-sonnet-4-5', label: 'Sonnet 4.5' };
  const haikuRef = { model: 'claude-haiku-4-5', label: 'Haiku 4.5' };
  const planned = { modelId: 'claude-sonnet-4-5', modelLabel: 'Claude Sonnet 4.5', thinkingEffort: 'high' };

  it('follows a switch made with the runner\'s own /model as a visible edit, off the allowlist too', async () => {
    const { session, broadcast, live, logged } = await followable();

    live.emitEvent({ type: 'model_switched', from: sonnet, to: haikuRef });

    // Haiku offers no effort, so the plan's `high` does not ride onto it.
    const followed = { modelId: 'claude-haiku-4-5', modelLabel: 'Claude Haiku 4.5', availableVariants: [] };
    await vi.waitFor(() => expect(taskOf(session, 'only')?.assignedModel).toEqual(followed));
    expect(broadcast).toHaveBeenCalledWith({ type: 'task_updated', taskId: 'only', changes: { assignedModel: followed } });
    // The log says what the plan took, under the catalog's name for it.
    await vi.waitFor(() => expect(logged()).toEqual([
      { type: 'model_switched', from: sonnet, to: haikuRef, plan: { model: { model: 'claude-haiku-4-5', label: 'Claude Haiku 4.5' } } },
    ]));
  });

  // The allowlist shapes what the planner writes, not a task it left alone (ADR-0043).
  it('keeps a followed off-list model through a planner edit of another task', async () => {
    const { session, live } = await followable({
      startConversation: vi.fn(),
      continueConversation: vi.fn().mockResolvedValue({
        kind: 'task_ops', ops: [{ op: 'update', taskId: '#2', changes: { title: 'Docs, renamed' } }], text: '', researchLog: [],
      }),
      hasActiveConversation: () => true,
      reset: vi.fn(),
    });
    live.emitEvent({ type: 'model_switched', from: sonnet, to: haikuRef });
    await vi.waitFor(() => expect(taskOf(session, 'only')?.assignedModel?.modelId).toBe('claude-haiku-4-5'));

    await session.continueConversation('rename the docs task');

    expect(session.planTasks.find((t) => t.title === 'Docs, renamed')).toBeDefined();
    expect(taskOf(session, 'only')?.assignedModel?.modelId).toBe('claude-haiku-4-5');
  });

  it('states a change no model command asked for, and leaves the plan as it was', async () => {
    const { session, live, logged } = await followable();

    live.emitEvent({ type: 'model_drifted', from: sonnet, to: haikuRef });

    await vi.waitFor(() => expect(logged()).toEqual([
      { type: 'model_switched', from: sonnet, to: haikuRef, plan: { model: { model: 'claude-sonnet-4-5', label: 'Claude Sonnet 4.5' }, effort: 'high' }, kept: 'no model command in the chat asked for it' },
    ]));
    expect(taskOf(session, 'only')?.assignedModel).toEqual(planned);
  });

  // The plan may be another one by then, so the log says the runner's change alone.
  it('leaves the plan as it was when the switch arrives after the attempt ended', async () => {
    const { session, live, logged } = await followable();
    await session.execute({ command: 'stop_task', task: 'only' }, { kind: 'user' });

    live.emitEvent({ type: 'model_switched', from: sonnet, to: haikuRef });

    await vi.waitFor(() => expect(logged()).toEqual([
      { type: 'model_switched', from: sonnet, to: haikuRef, kept: 'its attempt had already ended' },
    ]));
    expect(taskOf(session, 'only')?.assignedModel).toEqual(planned);
  });

  it('leaves a plan loaded before the queued write-back lands as it is, though a task in it has the same id', async () => {
    const { session, live } = await followable();

    live.emitEvent({ type: 'model_switched', from: sonnet, to: haikuRef });
    const other = soloPlan();
    other.runners = ['codex'];
    other.tasks[0] = { ...other.tasks[0], assignedRunner: 'codex', assignedModel: { modelId: 'gpt-5', modelLabel: 'GPT-5' } };
    session.loadPlan(other, 'goal', testWorkspace, { persist: false });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(taskOf(session, 'only')?.assignedModel).toEqual({ modelId: 'gpt-5', modelLabel: 'GPT-5' });
  });

  it('says nothing of a replacement plan when the switch arrives after it loaded', async () => {
    const { session, live, logged } = await followable();
    const other = soloPlan();
    other.runners = ['codex'];
    other.tasks[0] = { ...other.tasks[0], assignedRunner: 'codex', assignedModel: { modelId: 'gpt-5', modelLabel: 'GPT-5' } };
    session.loadPlan(other, 'goal', testWorkspace, { persist: false });

    live.emitEvent({ type: 'model_switched', from: sonnet, to: haikuRef });

    await vi.waitFor(() => expect(logged()).toEqual([
      { type: 'model_switched', from: sonnet, to: haikuRef, kept: 'its attempt had already ended' },
    ]));
    expect(taskOf(session, 'only')?.assignedModel).toEqual({ modelId: 'gpt-5', modelLabel: 'GPT-5' });
  });

  it('lets other fields of a running task change, and a model edit that changes nothing through', async () => {
    const { session } = await running();
    await session.updateTask('only', { title: 'Only, renamed', assignedModel: undefined });
    expect(taskOf(session, 'only')?.title).toBe('Only, renamed');
  });
});

describe('reordering is not part of the plan API', () => {
  // Independent tasks fan out, so a stored position never was the execution
  // order it looked like. Nothing may reintroduce a positional mutator.
  it('exposes no reorder on the session or its store', () => {
    const session = makeSession({ modelResolver: resolverFor(CLAUDE_CATALOG) });
    session.loadPlan(planWith(), 'goal', testWorkspace, { persist: false });

    expect((session as unknown as Record<string, unknown>).reorderTasks).toBeUndefined();
    expect((new PlanStore() as unknown as Record<string, unknown>).reorder).toBeUndefined();
  });
});

describe('Session.updateTask — what a field patch saves and announces', () => {
  function loaded(plan = planWith()) {
    const broadcast = vi.fn();
    const session = makeSession({ modelResolver: resolverFor(CLAUDE_CATALOG), broadcast });
    session.loadPlan(plan, 'goal', testWorkspace, { persist: false });
    const order: string[] = [];
    saves(session).mockImplementation(() => { order.push('save'); });
    broadcast.mockImplementation((m: { type: string }) => { order.push(m.type); });
    const updates = () => broadcast.mock.calls.map(([m]) => m as { type: string; changes?: Record<string, unknown> }).filter((m) => m.type === 'task_updated');
    return { session, broadcast, order, updates };
  }

  it('saves the patch, then announces it as task_updated rather than a whole plan', async () => {
    const { session, broadcast, order } = loaded();

    await session.updateTask('t1', { title: 'Renamed' });

    expect(broadcast).toHaveBeenCalledWith({ type: 'task_updated', taskId: 't1', changes: { title: 'Renamed' } });
    expect(order.indexOf('save')).toBeLessThan(order.indexOf('task_updated'));
    expect(order).not.toContain('plan_generated');
  });

  it('announces the fields a flip to MAN cleared, so no surface keeps showing them', async () => {
    const { session, updates } = loaded();

    await session.updateTask('t1', { type: 'user', userSteps: [{ order: 1, instruction: 'by hand', completed: false }] });

    const [update] = updates();
    expect(update.changes).toHaveProperty('taskMode', undefined);
    expect(update.changes).toHaveProperty('type', 'user');
  });

  it('announces an ops flag turned off as cleared, not as false', async () => {
    const plan = planWith();
    plan.tasks[1].ops = true;
    const { session, updates } = loaded(plan);

    await session.updateTask('t2', { ops: false });

    expect(updates()[0].changes).toEqual({ ops: undefined });
    expect(updates()[0].changes).toHaveProperty('ops');
  });

  // Bug: a direct edit wrote any field, so a PUT could mark a task done with no verdict, or replace its subtree unchecked.
  it('takes only the fields a direct edit may set: never a status, a verdict or a subtree', async () => {
    const { session, updates } = loaded();
    const smuggled = { status: 'completed', verdict: { outcome: 'pass', checks: [], decidedAt: '2026-01-01T00:00:00Z' }, subtasks: [createTask({ id: 'x', title: 'Smuggled' })] } as unknown as Partial<Task>;

    await session.updateTask('t1', { ...smuggled, title: 'Renamed' });

    expect(taskOf(session, 't1')).toMatchObject({ status: 'pending', title: 'Renamed', subtasks: [] });
    expect(taskOf(session, 't1')?.verdict).toBeUndefined();
    expect(updates().map((u) => u.changes)).toEqual([{ title: 'Renamed' }]);
  });

  it('saves nothing for a patch of fields a direct edit may not set, and still answers that the task exists', async () => {
    const { session, order } = loaded();

    expect(await session.updateTask('t1', { status: 'completed' })).not.toBeNull();
    expect(await session.updateTask('ghost', { status: 'completed' })).toBeNull();

    expect(taskOf(session, 't1')?.status).toBe('pending');
    expect(order).toEqual([]);
  });

  it('adds a task with only the fields a new task may be given', async () => {
    const { session } = loaded();

    await session.addTask({ title: 'Docs', prompt: 'write docs', status: 'completed', subtasks: [createTask({ id: 'x', title: 'Smuggled' })] } as Partial<Task>);

    expect(session.planTasks.at(-1)).toMatchObject({ title: 'Docs', status: 'pending', subtasks: [] });
  });

  // The direct-edit reschedule covers a field patch as it covers add and remove.
  it('starts a task its new dependency list frees, on an armed scheduler', async () => {
    const runner = recordingRunner();
    const session = makeSession({ runner, modelResolver: resolverFor(CLAUDE_CATALOG) });
    session.loadPlan(pausedOnUserTask(), 'goal', testWorkspace, { persist: false });
    await session.execute({ command: 'run_plan' }, { kind: 'user' });
    expect(runner.spawned).toEqual([]);

    await session.setTaskDependencies('c', ['a']);

    expect(runner.spawned).toEqual(['c']);
  });
});

describe('Session.addTask — what it saves and announces', () => {
  it('saves the added task before announcing the plan it is in', async () => {
    const broadcast = vi.fn();
    const session = makeSession({ modelResolver: resolverFor(CLAUDE_CATALOG), broadcast });
    session.loadPlan(planWith(), 'goal', testWorkspace, { persist: false });
    const order: string[] = [];
    saves(session).mockImplementation((plan) => { order.push(`save:${plan.tasks.length}`); });
    broadcast.mockImplementation((m: { type: string }) => { order.push(m.type); });

    await session.addTask({ title: 'Docs', prompt: 'write docs' });

    expect(order.indexOf('save:3')).toBeGreaterThanOrEqual(0);
    expect(order.indexOf('save:3')).toBeLessThan(order.indexOf('plan_generated'));
  });
});

describe('Session.removeTask of a task not in the plan', () => {
  it('answers null, saves nothing and stops nothing', async () => {
    const runner = recordingRunner();
    const session = makeSession({ runner, modelResolver: resolverFor(CLAUDE_CATALOG) });
    session.loadPlan(soloPlan(), 'goal', testWorkspace, { persist: false });
    await session.execute({ command: 'run_plan' }, { kind: 'user' });
    saves(session).mockClear();

    expect(await session.removeTask('ghost')).toBeNull();

    expect(runner.stopped).toEqual([]);
    expect(session.isExecuting).toBe(true);
    expect(saves(session)).not.toHaveBeenCalled();
  });
});

describe('plan edits on a session with no plan', () => {
  it('change nothing, ask discovery nothing, and answer null', async () => {
    const resolver = resolverFor(CLAUDE_CATALOG);
    const broadcast = vi.fn();
    const session = makeSession({ modelResolver: resolver, broadcast });

    expect(await session.updateTask('t1', { title: 'x' })).toBeNull();
    expect(await session.setTaskDependencies('t1', [])).toBeNull();
    expect(await session.setTaskRunner('t1', 'codex')).toBeNull();
    expect(await session.addTask({ title: 'x', prompt: 'x' })).toBeNull();
    expect(await session.removeTask('t1')).toBeNull();
    expect(await session.resolveConflictAsTask('t1')).toBeNull();

    expect(resolver.modelsForRunners).not.toHaveBeenCalled();
    expect(saves(session)).not.toHaveBeenCalled();
    expect(broadcast).not.toHaveBeenCalled();
    expect(session.planTasks).toEqual([]);
  });
});
