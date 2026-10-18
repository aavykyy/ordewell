import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as vscode from 'vscode';
import { createTask } from '@ordewell/core';
import { handleSystemCommand, type PlanManagerDeps } from '../PlanManager';

const showWarningMessage = vscode.window.showWarningMessage as unknown as ReturnType<typeof vi.fn>;

function deps(gate: string[]) {
  const plan = { status: 'running', tasks: [] };
  const session = {
    mergeGate: vi.fn(() => gate),
    planState: { tasks: [createTask({ id: 'fix', order: 1, title: 'Fix' }), createTask({ id: 'ops', order: 2, title: 'Deploy', ops: true, dependencies: ['fix'] })] },
    runTask: vi.fn().mockResolvedValue(undefined),
    execute: vi.fn().mockResolvedValue({ ok: true, message: 'done' }),
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

describe('starting a task past its merge gate (ADR-0020)', () => {
  beforeEach(() => showWarningMessage.mockReset());

  it.each([
    ['forceStart'],
    // A gated Run is the same start past the gate as Force start.
    ['runTask'],
  ] as const)('%s asks in a modal naming the unmerged work, and starts nothing on a cancel', async (command) => {
    showWarningMessage.mockResolvedValue(undefined);
    const { d, session } = deps(['fix']);

    await handleSystemCommand(command, 'ops', d);

    const [message, options, ...choices] = showWarningMessage.mock.calls[0] as unknown as [string, { modal?: boolean }, ...string[]];
    expect(message).toContain('the work of #1 Fix is not merged into your branch yet');
    expect(options).toMatchObject({ modal: true });
    expect(choices).toEqual(['Start anyway']);
    expect(session.execute).not.toHaveBeenCalled();
  });

  it.each([
    ['forceStart'],
    ['runTask'],
  ] as const)('%s force starts the task through the command seam once the user goes ahead, clearing the isolation handoff', async (command) => {
    showWarningMessage.mockResolvedValue('Start anyway');
    const { d, session, chatProvider } = deps(['fix']);

    await handleSystemCommand(command, 'ops', d);

    expect(session.execute).toHaveBeenCalledWith({ command: 'force_start', task: 'ops' }, { kind: 'user' });
    expect(chatProvider.clearIsolationHandoff).toHaveBeenCalled();
  });

  it('runs an ungated task through the command seam as the user', async () => {
    const { d, session } = deps([]);

    await handleSystemCommand('runTask', 'ops', d);

    expect(showWarningMessage).not.toHaveBeenCalled();
    expect(session.execute).toHaveBeenCalledWith({ command: 'run_task', task: 'ops' }, { kind: 'user' });
  });

  it('asks nothing of a task no gate holds', async () => {
    const { d, session } = deps([]);

    await handleSystemCommand('forceStart', 'ops', d);

    expect(showWarningMessage).not.toHaveBeenCalled();
    expect(session.execute).toHaveBeenCalledWith({ command: 'force_start', task: 'ops' }, { kind: 'user' });
  });
});
