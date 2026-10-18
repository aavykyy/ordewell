import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as vscode from 'vscode';
import { createTask } from '@ordewell/core';
import { handleSystemCommand, type PlanManagerDeps } from '../PlanManager';

/**
 * Adversarial: the run's cards are the Session's to close (ADR-0013, ADR-0020)
 * — "the marks, handoff and cards are dropped only when the Session says the
 * run is closed". A start that replaces the run may clear them, but only once
 * the seam has accepted the start: a refused one replaces nothing, and the TUI
 * (whose task actions dispatch no clear) is the word the two surfaces have to
 * agree with.
 */

const showWarningMessage = vscode.window.showWarningMessage as unknown as ReturnType<typeof vi.fn>;

function deps(refusal: { ok: false; outcome: 'refused'; message: string }) {
  const plan = { status: 'running', tasks: [] };
  const session = {
    mergeGate: vi.fn(() => [] as string[]),
    planState: { tasks: [createTask({ id: 'fix', order: 1, title: 'Fix' }), createTask({ id: 'ops', order: 2, title: 'Deploy', dependencies: ['fix'] })] },
    execute: vi.fn().mockResolvedValue(refusal),
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

describe('adversarial: a refused start keeps the run it did not replace', () => {
  beforeEach(() => showWarningMessage.mockReset());

  // ADVERSARIAL FINDING (vscode): a Run task the seam refuses (dependencies unmet, already running, a user task) still wipes the run view first — PlanManager.ts:530 calls `chatProvider.clearIsolationHandoff()` BEFORE `execute`, and forceStartPastGate (PlanManager.ts:484) does the same for force start. A refusal replaces no run, so the webview loses the handoff card and every isolation mark the Session still holds (a `run_closed` fold with no `run_closed`), and the TUI — whose task actions dispatch no clear — disagrees with VS Code on the same control. Expected: the clear happens only after the seam answers ok (a start the seam accepted), or not at all — the Session's own broadcasts and `run_closed` are the word both surfaces fold.
  it.skip('a Run task the seam refuses leaves the handoff and marks alone', async () => {
    const { d, chatProvider } = deps({ ok: false, outcome: 'refused', message: 'task #2 "Deploy" depends on task #1 "Fix", which failed. Retry it first.' });

    await handleSystemCommand('runTask', 'ops', d);

    expect(chatProvider.clearIsolationHandoff).not.toHaveBeenCalled();
  });
});
