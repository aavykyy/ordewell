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
