import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as vscode from 'vscode';
import { createTask } from '@ordewell/core';
import { handleSystemCommand, type PlanManagerDeps } from '../PlanManager';
import { removalPrompt } from '../taskEdit';

const showWarningMessage = vscode.window.showWarningMessage as unknown as ReturnType<typeof vi.fn>;

function deps(gate: string[]) {
  const session = {
    mergeGate: vi.fn(() => gate),
    planState: { tasks: [createTask({ id: 'fix', order: 1, title: 'Fix' }), createTask({ id: 'ops', order: 2, title: 'Deploy', ops: true, dependencies: ['fix'] })] },
    execute: vi.fn().mockResolvedValue({ ok: true, message: 'Skipped.' }),
  };
  const d = {
    session,
    chatProvider: { showPlan: vi.fn(), clearIsolationHandoff: vi.fn() },
    getCurrentPlan: () => ({ status: 'running', tasks: [] }),
    persistState: vi.fn(),
    log: vi.fn(),
  } as unknown as PlanManagerDeps;
  return { d, session };
}

describe('host task texts, pinned before they move to core', () => {
  beforeEach(() => showWarningMessage.mockReset());

  it('asks before a force start past the gate in exactly these words', async () => {
    showWarningMessage.mockResolvedValue(undefined);
    await handleSystemCommand('forceStart', 'ops', deps(['fix', 'ghost']).d);
    expect(showWarningMessage.mock.calls[0][0]).toBe(
      'This task waits for Merge all: the work of #1 Fix, ghost is not merged into your branch yet, so it would act without it. Starting it now is kept on the task.',
    );
  });

  it('skip reaches the command seam as the user, and never marks the task complete', async () => {
    const { d, session } = deps([]);
    await handleSystemCommand('skip', 'fix', d);
    expect(session.execute).toHaveBeenCalledWith({ command: 'skip_task', task: 'fix' }, { kind: 'user' });
    expect(session.execute).not.toHaveBeenCalledWith(expect.objectContaining({ command: 'mark_complete' }), expect.anything());
  });

  it('names the dependents a removal rewrites, in full', () => {
    const tasks = [
      createTask({ id: 'a', order: 1, title: 'Setup' }),
      createTask({ id: 'b', order: 2, title: 'Build', dependencies: ['a'] }),
      createTask({ id: 'c', order: 3, title: 'Test', dependencies: ['a'] }),
    ];
    expect(removalPrompt(tasks, 'a')).toBe('Remove "Setup"?\n\n2 tasks depend on it and will lose that dependency: #2 Build, #3 Test.');
    expect(removalPrompt(tasks.slice(0, 2), 'a')).toBe('Remove "Setup"?\n\n1 task depends on it and will lose that dependency: #2 Build.');
  });
});
