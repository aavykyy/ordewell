import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { IDLE_ACTIVITY, createEmptyPlan, createTask, type RunActivity } from '@ordewell/core';
import { registerCommands, type CommandDeps } from '../CommandRegistry';

const registerCommand = vscode.commands.registerCommand as unknown as ReturnType<typeof vi.fn>;
const showWarningMessage = vscode.window.showWarningMessage as unknown as ReturnType<typeof vi.fn>;
const showInformationMessage = vscode.window.showInformationMessage as unknown as ReturnType<typeof vi.fn>;

function registered({ isExecuting = false, activity = IDLE_ACTIVITY, unsaved = null as string | null, tasks = [createTask({ id: 't1', order: 1, title: 'Parse JSON' })] } = {}) {
  registerCommand.mockClear();
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'ordewell-plan-commands-'));
  const calls: string[] = [];
  const deps = {
    session: { isExecuting, activity, reset: vi.fn(() => calls.push('reset')) },
    chatProvider: { setState: vi.fn(), conversation: { reset: vi.fn() }, run: { reset: vi.fn() } },
    fsAdapter: { getWorkspaceRoot: () => workspace },
    getCurrentPlan: () => ({ ...createEmptyPlan(), tasks }),
    setCurrentPlan: vi.fn(),
    getCurrentGoal: () => 'build me a parser',
    setCurrentGoal: vi.fn(),
    handleStartPlanning: vi.fn(async () => {}),
    saveCurrentSession: vi.fn(() => unsaved),
    sendRunSettings: vi.fn(() => calls.push('sendRunSettings')),
  };
  registerCommands({ subscriptions: [] } as unknown as vscode.ExtensionContext, deps as unknown as CommandDeps);
  const command = (name: string) => registerCommand.mock.calls.find(([id]) => id === name)![1] as () => Promise<void>;
  return { deps, calls, command };
}

beforeEach(() => {
  showWarningMessage.mockReset();
  showInformationMessage.mockClear();
});

// Planning afresh ends the old plan's scope, and with it the run (createSession's dropPlanScope).
describe('ordewell.regeneratePlan', () => {
  it('asks first while a run is live, and leaves it running on a no', async () => {
    const h = registered({ isExecuting: true });
    showWarningMessage.mockResolvedValueOnce(undefined);

    await h.command('ordewell.regeneratePlan')();

    expect(showWarningMessage.mock.calls[0]![0]).toContain('The run in progress is stopped');
    expect(h.deps.handleStartPlanning).not.toHaveBeenCalled();
  });

  it.each<[string, RunActivity]>([
    ['held on a usage limit', { ...IDLE_ACTIVITY, resumable: true, advancesOnItsOwn: true }],
    ['waiting on a retry it resumes after', { ...IDLE_ACTIVITY, resumable: true }],
  ])('asks first while the run is %s, with no attempt live', async (_, activity) => {
    const h = registered({ activity });
    showWarningMessage.mockResolvedValueOnce('Regenerate');

    await h.command('ordewell.regeneratePlan')();

    expect(showWarningMessage).toHaveBeenCalled();
    expect(h.deps.handleStartPlanning).toHaveBeenCalledWith('build me a parser');
  });

  // startPlanning drops the old plan before the planner answers, so even a failed regenerate loses it.
  it('asks before replacing an idle plan, and keeps it on a no', async () => {
    const h = registered({ tasks: [createTask({ id: 't1', order: 1, title: 'Parse JSON', status: 'completed' })] });
    showWarningMessage.mockResolvedValueOnce(undefined);

    await h.command('ordewell.regeneratePlan')();

    expect(showWarningMessage.mock.calls[0]![0]).toBe('Regenerate the plan? The current plan and its progress are replaced.');
    expect(h.deps.handleStartPlanning).not.toHaveBeenCalled();
  });

  it('asks nothing with no plan and no run to lose', async () => {
    const h = registered({ tasks: [] });

    await h.command('ordewell.regeneratePlan')();

    expect(showWarningMessage).not.toHaveBeenCalled();
    expect(h.deps.handleStartPlanning).toHaveBeenCalledWith('build me a parser');
  });
});

describe('ordewell.clearPlan', () => {
  // The Session keeps its run-settings copy across reset(); with no plan open the file is what the next one opens with (ADR-0030).
  it('re-seeds the run settings from the file after the reset, and clears the run view', async () => {
    const h = registered();
    showWarningMessage.mockResolvedValueOnce('Yes, clear all');

    await h.command('ordewell.clearPlan')();

    expect(h.calls).toEqual(['reset', 'sendRunSettings']);
    expect(h.deps.chatProvider.run.reset).toHaveBeenCalled();
  });
});

describe('ordewell.saveSession', () => {
  const showInputBox = vi.fn(async () => 'JSON parser');
  beforeEach(() => { Object.assign(vscode.window, { showInputBox }); });

  it('says the session was saved once it was', async () => {
    const h = registered();

    await h.command('ordewell.saveSession')();

    expect(showInformationMessage).toHaveBeenCalledWith('Session saved: "JSON parser"');
  });

  it('says why when nothing was written, and claims no save', async () => {
    const h = registered({ unsaved: 'it has no tasks yet.' });

    await h.command('ordewell.saveSession')();

    expect(showWarningMessage).toHaveBeenCalledWith('Session not saved: it has no tasks yet.');
    expect(showInformationMessage).not.toHaveBeenCalled();
  });
});
