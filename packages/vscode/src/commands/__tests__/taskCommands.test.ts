import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as vscode from 'vscode';
import { createTask, type CommandOutcome } from '@ordewell/core';
import { registerCommands, type CommandDeps } from '../CommandRegistry';

const registerCommand = vscode.commands.registerCommand as unknown as ReturnType<typeof vi.fn>;
const showErrorMessage = vscode.window.showErrorMessage as unknown as ReturnType<typeof vi.fn>;

function registered(execute: () => Promise<CommandOutcome>) {
  registerCommand.mockClear();
  const session = { execute: vi.fn(execute), retryTask: vi.fn(), cancelTask: vi.fn(), mergeGate: vi.fn(() => [] as string[]), planState: { tasks: [] } };
  const chatProvider = { clearIsolationHandoff: vi.fn() };
  const persistState = vi.fn();
  registerCommands({ subscriptions: [] } as unknown as vscode.ExtensionContext, { session, chatProvider, persistState } as unknown as CommandDeps);
  const command = (name: string) => registerCommand.mock.calls.find(([id]) => id === name)![1] as (task?: unknown) => Promise<void>;
  return { session, chatProvider, persistState, command };
}

const task = createTask({ id: 't1', order: 1, title: 'Parse JSON' });

describe('the task commands', () => {
  beforeEach(() => showErrorMessage.mockClear());

  it('retry and cancel through the command seam as the user, as the plan pane\'s buttons do (ADR-0029)', async () => {
    const h = registered(async () => ({ ok: true, message: 'done' }));

    await h.command('ordewell.retryTask')(task);
    await h.command('ordewell.cancelTask')(task);

    expect(h.session.execute.mock.calls).toEqual([
      [{ command: 'retry_task', task: 't1', from: 'fresh' }, { kind: 'user' }],
      [{ command: 'stop_task', task: 't1' }, { kind: 'user' }],
    ]);
    expect(h.session.retryTask).not.toHaveBeenCalled();
    expect(h.session.cancelTask).not.toHaveBeenCalled();
    expect(h.persistState).toHaveBeenCalledTimes(2);
  });

  it('shows the seam\'s refusal', async () => {
    const h = registered(async () => ({ ok: false, outcome: 'refused', message: 'Task #1 "Parse JSON" is running: stop it first with stop_task, or steer it with message_task.' }));

    await h.command('ordewell.retryTask')(task);

    expect(showErrorMessage).toHaveBeenCalledWith('Task #1 "Parse JSON" is running: stop it first with stop_task, or steer it with message_task.');
  });

  it.each([
    ['ordewell.markTaskComplete', 'mark_complete'],
    ['ordewell.markTaskIncomplete', 'mark_not_done'],
    ['ordewell.forceStartTask', 'force_start'],
  ] as const)('%s goes through the command seam as the user, as the plan pane\'s button does', async (id, name) => {
    const h = registered(async () => ({ ok: true, message: 'done' }));

    await h.command(id)(id === 'ordewell.forceStartTask' ? task : 't1');

    expect(h.session.execute).toHaveBeenCalledWith({ command: name, task: 't1' }, { kind: 'user' });
    expect(h.persistState).toHaveBeenCalled();
  });

  it('force starts from the palette as the plan pane does, clearing the isolation handoff the start moves past', async () => {
    const h = registered(async () => ({ ok: true, message: 'done' }));

    await h.command('ordewell.forceStartTask')(task);

    expect(h.chatProvider.clearIsolationHandoff).toHaveBeenCalled();
  });

  it.each(['ordewell.markTaskComplete', 'ordewell.markTaskIncomplete', 'ordewell.forceStartTask'])('%s shows the seam\'s refusal', async (id) => {
    const h = registered(async () => ({ ok: false, outcome: 'refused', message: 'Task #1 "Parse JSON" is already complete.' }));

    await h.command(id)(id === 'ordewell.forceStartTask' ? task : 't1');

    expect(showErrorMessage).toHaveBeenCalledWith('Task #1 "Parse JSON" is already complete.');
  });
});
