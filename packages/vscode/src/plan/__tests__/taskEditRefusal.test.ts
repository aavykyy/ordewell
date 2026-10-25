import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as vscode from 'vscode';
import { PlanEditError } from '@ordewell/core';
import { handleTaskEdit, type PlanManagerDeps } from '../PlanManager';

const showWarningMessage = vscode.window.showWarningMessage as unknown as ReturnType<typeof vi.fn>;

const IDLE = { starting: false, running: false, scheduled: false, resumable: false, advancesOnItsOwn: false };

/** A host over a Session that holds `t1` in `status` with the run facts given. */
function hostOf(session: Record<string, unknown>, status: string, plan: { status: string; tasks: unknown[] }) {
  const chatProvider = { showPlan: vi.fn() };
  const d = {
    session: { isExecuting: false, planTasks: [{ id: 't1', status }, { id: 't2', status: 'pending' }], ...session },
    chatProvider, getCurrentPlan: () => plan, setCurrentPlan: vi.fn(), persistState: vi.fn(), saveCurrentSession: vi.fn(),
  } as unknown as PlanManagerDeps;
  return { d, chatProvider };
}

// The card's own model picker sends the edit; a live runner's model is the
// runner's (#106), so the session refuses it and the card must say why.
describe('a task card model edit the session refuses', () => {
  beforeEach(() => showWarningMessage.mockReset());

  it('shows the session\'s reason and re-shows the plan as it stands', async () => {
    const reason = '"Build" has a live runner, so its model and effort cannot change now: stop the task first, or use the runner\'s own /model';
    const plan = { status: 'running', tasks: [] };
    const session = { activity: IDLE, updateTask: vi.fn().mockRejectedValue(new PlanEditError(reason)), planState: plan };
    const { d, chatProvider } = hostOf(session, 'completed', plan);

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
    const session = { isExecuting: true, activity: { ...IDLE, running: true, scheduled: true, advancesOnItsOwn: true }, updateTask: vi.fn(), setTaskRunner: vi.fn(), setTaskDependencies: vi.fn(), planState: plan };
    const { d, chatProvider } = hostOf(session, 'pending', plan);

    await handleTaskEdit('t1', edit, d);

    expect(session[method as 'updateTask' | 'setTaskRunner' | 'setTaskDependencies']).toHaveBeenCalledWith(...expected);
    expect(chatProvider.showPlan).toHaveBeenCalledWith(plan);
  });

  // Nothing is live while the scheduler waits on a manual task, a gate or a
  // hold, or while a start is opening the run, yet the next claim can land on
  // the task mid-edit: the card holds back its editors then, on the same fact.
  it.each([
    ['scheduled', { ...IDLE, scheduled: true, advancesOnItsOwn: true }],
    ['starting', { ...IDLE, starting: true, advancesOnItsOwn: true }],
    ['held on a usage limit', { ...IDLE, resumable: true, advancesOnItsOwn: true }],
  ])('guards an edit while the run is %s with nothing live, a settled task included', async (_name, activity) => {
    const session = { activity, updateTask: vi.fn(), planState: plan };
    const { d } = hostOf(session, 'completed', plan);

    await handleTaskEdit('t1', { kind: 'skills', skills: ['cache'] }, d);

    expect(session.updateTask).toHaveBeenCalledWith('t1', { skills: ['cache'] }, { requireUnstarted: true });
  });

  // Nothing advances after a failed run until a retry or skip, and the card
  // offers the failed task's editors so it can be fixed and retried: the host
  // must not refuse what the card offers.
  it('leaves the failed task of a run that ended on it the direct edit', async () => {
    const session = { activity: { ...IDLE, resumable: true }, updateTask: vi.fn(), planState: plan };
    const { d } = hostOf(session, 'failed', plan);

    await handleTaskEdit('t1', { kind: 'prompt', prompt: 'fixed' }, d);

    expect(session.updateTask).toHaveBeenCalledWith('t1', { prompt: 'fixed', description: 'fixed' });
  });

  // The edit awaits discovery or a skills check, and a start can claim the
  // task meanwhile; deciding at call time from the run alone leaves it open.
  it.each(['pending', 'approved', 'blocked'])('guards an edit to a %s task even when the plan is idle', async (status) => {
    const session = { activity: IDLE, updateTask: vi.fn(), planState: plan };
    const { d } = hostOf(session, status, plan);

    await handleTaskEdit('t1', { kind: 'skills', skills: ['cache'] }, d);

    expect(session.updateTask).toHaveBeenCalledWith('t1', { skills: ['cache'] }, { requireUnstarted: true });
  });

  it('leaves the wider direct edit alone for a settled task when no run is live', async () => {
    const session = { activity: IDLE, updateTask: vi.fn(), planState: plan };
    const { d } = hostOf(session, 'completed', plan);

    await handleTaskEdit('t1', { kind: 'prompt', prompt: 'Later' }, d);

    expect(session.updateTask).toHaveBeenCalledWith('t1', { prompt: 'Later', description: 'Later' });
  });
});
