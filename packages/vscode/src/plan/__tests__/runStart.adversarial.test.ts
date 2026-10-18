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

  it('a Run task the seam refuses leaves the handoff and marks alone', async () => {
    const { d, chatProvider } = deps({ ok: false, outcome: 'refused', message: 'task #2 "Deploy" depends on task #1 "Fix", which failed. Retry it first.' });

    await handleSystemCommand('runTask', 'ops', d);

    expect(chatProvider.clearIsolationHandoff).not.toHaveBeenCalled();
  });

  it('a Force start the seam refuses leaves them alone too', async () => {
    const { d, chatProvider } = deps({ ok: false, outcome: 'refused', message: 'Task "Deploy" is running.' });

    await handleSystemCommand('forceStart', 'ops', d);

    expect(chatProvider.clearIsolationHandoff).not.toHaveBeenCalled();
  });

  it('a Run task the seam accepts clears the cards its run left up', async () => {
    const { d, session, chatProvider } = deps({ ok: false, outcome: 'refused', message: 'unused' });
    session.execute.mockResolvedValue({ ok: true, outcome: 'done', message: 'Started task #2 "Deploy".' });

    await handleSystemCommand('runTask', 'ops', d);

    expect(chatProvider.clearIsolationHandoff).toHaveBeenCalledTimes(1);
  });
});
