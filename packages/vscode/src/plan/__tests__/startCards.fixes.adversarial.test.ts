import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as vscode from 'vscode';
import { createTask } from '@ordewell/core';
import { handleSystemCommand, type PlanManagerDeps } from '../PlanManager';

/**
 * Adversarial, round two, on the run's cards at a start: the first round made
 * the clear wait for the seam to accept the start. The neighbouring cases: a
 * gate confirmation the user cancels (no start, no clear), and an accepted
 * start past a gate clearing once — from the palette and the plan pane alike.
 */

const showWarningMessage = vscode.window.showWarningMessage as unknown as ReturnType<typeof vi.fn>;

function deps(gate: string[]) {
  const plan = { status: 'running', tasks: [] };
  const session = {
    mergeGate: vi.fn(() => gate),
    planState: { tasks: [createTask({ id: 'fix', order: 1, title: 'Fix' }), createTask({ id: 'ops', order: 2, title: 'Deploy', dependencies: ['fix'] })] },
    execute: vi.fn().mockResolvedValue({ ok: true, outcome: 'done', message: 'Started Deploy.' }),
  };
  const chatProvider = { showPlan: vi.fn(), clearIsolationHandoff: vi.fn() };
  const d = {
    session,
    chatProvider,
    getCurrentPlan: () => plan,
    persistState: vi.fn(),
    log: vi.fn(),
  } as unknown as PlanManagerDeps;
  return { d, session, chatProvider };
}

describe('adversarial: the run cards around a gated start', () => {
  beforeEach(() => showWarningMessage.mockReset());

  it('clears nothing when the user cancels the gate confirmation', async () => {
    showWarningMessage.mockResolvedValue(undefined);
    const { d, session, chatProvider } = deps(['fix']);

    await handleSystemCommand('runTask', 'ops', d);
    await handleSystemCommand('forceStart', 'ops', d);

    expect(session.execute).not.toHaveBeenCalled();
    expect(chatProvider.clearIsolationHandoff).not.toHaveBeenCalled();
  });

  it('clears the cards once when the confirmed start passes the gate from the plan pane', async () => {
    showWarningMessage.mockResolvedValue('Start anyway');
    const { d, session, chatProvider } = deps(['fix']);

    await handleSystemCommand('runTask', 'ops', d);

    expect(session.execute).toHaveBeenCalledWith({ command: 'force_start', task: 'ops' }, { kind: 'user' });
    expect(chatProvider.clearIsolationHandoff).toHaveBeenCalledTimes(1);
  });

  it('clears nothing when the seam refuses the confirmed start, and says the refusal', async () => {
    showWarningMessage.mockResolvedValue('Start anyway');
    const { d, session, chatProvider } = deps(['fix']);
    session.execute.mockResolvedValue({ ok: false, outcome: 'refused', message: 'Task "Deploy" is already running.' });

    await handleSystemCommand('forceStart', 'ops', d);

    expect(chatProvider.clearIsolationHandoff).not.toHaveBeenCalled();
    expect(showWarningMessage).toHaveBeenLastCalledWith('Task "Deploy" is already running.');
  });
});
