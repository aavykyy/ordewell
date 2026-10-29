import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as vscode from 'vscode';
import { createEmptyPlan, createTask, type CommandOutcome, type Task } from '@ordewell/core';
import { registerCommands, type CommandDeps } from '../CommandRegistry';

const registerCommand = vscode.commands.registerCommand as unknown as ReturnType<typeof vi.fn>;
const showErrorMessage = vscode.window.showErrorMessage as unknown as ReturnType<typeof vi.fn>;
const showQuickPick = vscode.window.showQuickPick as unknown as ReturnType<typeof vi.fn>;
const showInformationMessage = vscode.window.showInformationMessage as unknown as ReturnType<typeof vi.fn>;

function registered(execute: () => Promise<CommandOutcome>, tasks: Task[] = []) {
  registerCommand.mockClear();
  const session = { execute: vi.fn(execute), retryTask: vi.fn(), cancelTask: vi.fn(), mergeGate: vi.fn(() => [] as string[]), planState: { tasks } };
  const chatProvider = { clearIsolationHandoff: vi.fn() };
  const persistState = vi.fn();
  const getCurrentPlan = () => ({ ...createEmptyPlan(), tasks });
  registerCommands({ subscriptions: [] } as unknown as vscode.ExtensionContext, { session, chatProvider, persistState, getCurrentPlan } as unknown as CommandDeps);
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

// The Command Palette passes no task, and no menu passes one.
describe('the task commands from the Command Palette', () => {
  beforeEach(() => { showQuickPick.mockReset(); showInformationMessage.mockClear(); });

  const failed = createTask({ id: 't1', order: 1, title: 'Parse JSON', status: 'failed' });
  const running = createTask({ id: 't2', order: 2, title: 'Write docs', status: 'in_progress' });
  const queued = createTask({ id: 't3', order: 3, title: 'Ship', status: 'pending' });
  const failedSub = createTask({ id: 's1', order: 1, title: 'Lint', status: 'failed' });
  const parent = createTask({ id: 't4', order: 4, title: 'Polish', status: 'in_progress', subtasks: [failedSub] });

  it.each([
    ['ordewell.retryTask', ['1. Parse JSON', '4.1. Lint'], { command: 'retry_task', task: 't1', from: 'fresh' }],
    ['ordewell.cancelTask', ['2. Write docs', '4. Polish'], { command: 'stop_task', task: 't1' }],
    ['ordewell.skipTask', ['1. Parse JSON', '4.1. Lint'], { command: 'skip_task', task: 't1' }],
    ['ordewell.forceStartTask', ['3. Ship'], { command: 'force_start', task: 't1' }],
  ] as const)('%s asks which task, offering only those it applies to', async (id, offered, sent) => {
    const h = registered(async () => ({ ok: true, message: 'done' }), [failed, running, queued, parent]);
    showQuickPick.mockImplementationOnce(async () => ({ label: 'picked', description: 't1' }));

    await h.command(id)();

    expect((showQuickPick.mock.calls[0]![0] as { label: string }[]).map((i) => i.label)).toEqual(offered);
    expect(h.session.execute).toHaveBeenCalledWith(sent, { kind: 'user' });
  });

  it('says so when no task fits, and sends nothing', async () => {
    const h = registered(async () => ({ ok: true, message: 'done' }), [queued]);

    await h.command('ordewell.retryTask')();

    expect(showQuickPick).not.toHaveBeenCalled();
    expect(showInformationMessage).toHaveBeenCalledWith('No failed tasks to retry.');
    expect(h.session.execute).not.toHaveBeenCalled();
  });

  it('sends nothing when the pick is dismissed', async () => {
    const h = registered(async () => ({ ok: true, message: 'done' }), [failed]);
    showQuickPick.mockImplementationOnce(async () => undefined);

    await h.command('ordewell.retryTask')();

    expect(h.session.execute).not.toHaveBeenCalled();
  });
});
