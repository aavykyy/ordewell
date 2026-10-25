import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as vscode from 'vscode';
import { PlanEditError } from '@ordewell/core';
import { handleTaskEdit, type PlanManagerDeps } from '../PlanManager';

const showWarningMessage = vscode.window.showWarningMessage as unknown as ReturnType<typeof vi.fn>;

// The card's own model picker sends the edit; a live runner's model is the
// runner's (#106), so the session refuses it and the card must say why.
describe('a task card model edit the session refuses', () => {
  beforeEach(() => showWarningMessage.mockReset());

  it('shows the session\'s reason and re-shows the plan as it stands', async () => {
    const reason = '"Build" has a live runner, so its model and effort cannot change now: stop the task first, or use the runner\'s own /model';
    const plan = { status: 'running', tasks: [] };
    const session = { updateTask: vi.fn().mockRejectedValue(new PlanEditError(reason)), planState: plan };
    const chatProvider = { showPlan: vi.fn() };
    const d = {
      session, chatProvider, getCurrentPlan: () => plan, setCurrentPlan: vi.fn(), persistState: vi.fn(), saveCurrentSession: vi.fn(),
    } as unknown as PlanManagerDeps;

    await handleTaskEdit('t1', { kind: 'model', assignment: { modelId: 'haiku', modelLabel: 'Haiku' } }, d);

    expect(session.updateTask).toHaveBeenCalledWith('t1', { assignedModel: { modelId: 'haiku', modelLabel: 'Haiku' } });
    expect(showWarningMessage).toHaveBeenCalledWith(reason);
    expect(chatProvider.showPlan).toHaveBeenCalledWith(plan);
  });
});

// The card offers these editors only on a task that has not started, so while
// a run is live the host hands the Session that narrower precondition too: a
// task the scheduler claims during discovery must not be rewritten.
describe('a card edit while the plan runs', () => {
  beforeEach(() => showWarningMessage.mockReset());

  const plan = { status: 'running', tasks: [] };

  it.each([
    ['runner', { kind: 'runner' as const, runner: 'codex' }, 'setTaskRunner', ['t1', 'codex', { requireUnstarted: true }]],
    ['model', { kind: 'model' as const, assignment: { modelId: 'haiku', modelLabel: 'Haiku' } }, 'updateTask', ['t1', { assignedModel: { modelId: 'haiku', modelLabel: 'Haiku' } }, { requireUnstarted: true }]],
    ['mode', { kind: 'mode' as const, mode: 'plan' }, 'updateTask', ['t1', { taskMode: 'plan' }, { requireUnstarted: true }]],
    ['prompt', { kind: 'prompt' as const, prompt: 'Do it differently' }, 'updateTask', ['t1', { prompt: 'Do it differently', description: 'Do it differently' }, { requireUnstarted: true }]],
    ['dependencies', { kind: 'dependencies' as const, dependencies: ['t2'] }, 'setTaskDependencies', ['t1', ['t2'], { requireUnstarted: true }]],
    ['skills', { kind: 'skills' as const, skills: ['tdd'] }, 'updateTask', ['t1', { skills: ['tdd'] }, { requireUnstarted: true }]],
    ['ops', { kind: 'ops' as const, ops: true }, 'updateTask', ['t1', { ops: true }, { requireUnstarted: true }]],
  ])('guards a %s edit', async (_kind, edit, method, expected) => {
    const session = { isExecuting: true, updateTask: vi.fn(), setTaskRunner: vi.fn(), setTaskDependencies: vi.fn(), planState: plan };
    const chatProvider = { showPlan: vi.fn() };
    const d = {
      session, chatProvider, getCurrentPlan: () => plan, setCurrentPlan: vi.fn(), persistState: vi.fn(), saveCurrentSession: vi.fn(),
    } as unknown as PlanManagerDeps;

    await handleTaskEdit('t1', edit, d);

    expect(session[method as 'updateTask' | 'setTaskRunner' | 'setTaskDependencies']).toHaveBeenCalledWith(...expected);
    expect(chatProvider.showPlan).toHaveBeenCalledWith(plan);
  });

  it('leaves the wider direct edit alone when no run is live', async () => {
    const session = { isExecuting: false, updateTask: vi.fn(), planState: plan };
    const d = {
      session, chatProvider: { showPlan: vi.fn() }, getCurrentPlan: () => plan, setCurrentPlan: vi.fn(), persistState: vi.fn(), saveCurrentSession: vi.fn(),
    } as unknown as PlanManagerDeps;

    await handleTaskEdit('t1', { kind: 'prompt', prompt: 'Later' }, d);

    expect(session.updateTask).toHaveBeenCalledWith('t1', { prompt: 'Later', description: 'Later' });
  });
});
