import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as vscode from 'vscode';
import { createTask } from '@ordewell/core';
import { handleRemoveTask, type PlanManagerDeps } from '../PlanManager';

const showWarningMessage = vscode.window.showWarningMessage as unknown as ReturnType<typeof vi.fn>;

// Core refuses to remove a loop's check (ADR-0045 L8); asking first would promise a removal it will not make.
describe('removing a task from a loop', () => {
  const plan = [
    createTask({ id: 'c', order: 1, title: 'Review', loop: { body: ['f'], maxRounds: 3 } }),
    createTask({ id: 'f', order: 2, title: 'Fix', dependencies: ['c'] }),
  ];
  const deps = (removeTask = vi.fn()) => ({
    session: { planTasks: plan, removeTask },
    chatProvider: { showPlan: vi.fn(), setState: vi.fn() },
    persistState: vi.fn(),
    saveCurrentSession: vi.fn(),
    getCurrentPlan: () => ({ tasks: plan }),
    setCurrentPlan: vi.fn(),
  }) as unknown as PlanManagerDeps & { session: { removeTask: ReturnType<typeof vi.fn> } };

  beforeEach(() => showWarningMessage.mockReset());

  it('refuses a check with core\'s reason, without asking', async () => {
    const d = deps();

    await handleRemoveTask('c', d);

    expect(showWarningMessage).toHaveBeenCalledTimes(1);
    expect(showWarningMessage).toHaveBeenCalledWith(expect.stringContaining('"Review" is a loop\'s check: remove its body tasks first'));
    expect(d.session.removeTask).not.toHaveBeenCalled();
  });

  it('asks before removing a body task, and says it leaves its loop', async () => {
    showWarningMessage.mockResolvedValue('Remove');
    const d = deps();

    await handleRemoveTask('f', d);

    expect(showWarningMessage).toHaveBeenCalledWith(expect.stringContaining('the loop is dropped with it'), { modal: true }, 'Remove');
    expect(d.session.removeTask).toHaveBeenCalledWith('f');
  });
});
