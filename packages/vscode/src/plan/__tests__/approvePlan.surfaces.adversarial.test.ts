import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { createTask, type LegacyPlanState } from '@ordewell/core';
import { ChatViewProvider } from '../../providers/ChatViewProvider';
import type { PlanManagerDeps } from '../PlanManager';
import { handleApprovePlan } from '../PlanManager';

/**
 * Adversarial: the run's cards are the Session's to close (ADR-0013; the
 * `startTask` rule in PlanManager). Execute plan goes through the seam too, so
 * a refusal starts no run and replaces nothing: the previous run's handoff and
 * marks must stay on screen. Clearing before the seam answers loses the card
 * for a run the Session still holds.
 */

const REFUSAL = 'Every task has already completed: there is nothing left to run.';

function deps(workspace: string) {
  const chatProvider = new ChatViewProvider({ toString: () => 'file:///ext' } as unknown as vscode.Uri);
  chatProvider.postMessage = () => {};
  const clear = vi.spyOn(chatProvider, 'clearIsolationHandoff');
  const activity = vi.spyOn(chatProvider, 'showRunActivity');

  let current: LegacyPlanState = {
    tasks: [
      createTask({ id: 't1', order: 1, title: 'Done already', prompt: 'x', status: 'completed' }),
    ],
    generatedAt: '2026-01-01T00:00:00Z',
    status: 'approved',
    runners: ['claude-code'],
    lastUpdated: '2026-01-01T00:00:00Z',
  };
  const session = {
    isExecuting: false,
    activity: { starting: false, running: false, scheduled: false, resumable: false, advancesOnItsOwn: false },
    loadPlan: vi.fn(),
    execute: vi.fn().mockResolvedValue({ ok: false, outcome: 'refused', message: REFUSAL }),
  };
  const d = {
    session,
    chatProvider,
    getCurrentPlan: () => current,
    setCurrentPlan: (p: LegacyPlanState) => { current = p; },
    getCurrentGoal: () => 'goal',
    setCurrentGoal: () => {},
    fsAdapter: { getWorkspaceRoot: () => workspace },
    persistState: vi.fn(),
    saveCurrentSession: vi.fn(),
    sendRunSettings: vi.fn(),
    log: vi.fn(),
  } as unknown as PlanManagerDeps;
  return { d, clear, activity, session };
}

describe('adversarial: Execute plan clears the run\'s cards only once the seam accepts', () => {
  let workspace: string;
  beforeEach(() => {
    workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'ordewell-approve-'));
    (vscode.window.showErrorMessage as unknown as ReturnType<typeof vi.fn>).mockReset();
  });
  afterEach(() => { fs.rmSync(workspace, { recursive: true, force: true }); });

  it('a refused Execute plan leaves the previous run\'s handoff and marks alone', async () => {
    const { d, clear } = deps(workspace);

    await handleApprovePlan(d);

    expect(clear).not.toHaveBeenCalled();
  });

  it('settles the click\'s Starting… on the run\'s own state, even when the seam refuses', async () => {
    const { d, activity } = deps(workspace);

    await handleApprovePlan(d, 7);

    expect(activity).toHaveBeenLastCalledWith(
      { starting: false, running: false, scheduled: false, resumable: false, advancesOnItsOwn: false },
      7,
    );
  });
});
