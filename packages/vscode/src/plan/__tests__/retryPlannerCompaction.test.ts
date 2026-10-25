import { describe, it, expect, vi } from 'vitest';
import { ConversationEditError, PlannerTurnStoppedError } from '@ordewell/core';
import { handleSystemCommand, type PlanManagerDeps } from '../PlanManager';

/** Retry compaction from the bar above the composer: a planner turn, which fails or stops as one does. */
function deps(retry: () => Promise<unknown>) {
  const plan = { status: 'draft', tasks: [] };
  const session = { retryPlannerCompaction: vi.fn(retry) };
  const chatProvider = { showPlan: vi.fn(), showError: vi.fn() };
  const d = { session, chatProvider, getCurrentPlan: () => plan, persistState: vi.fn(), log: vi.fn() } as unknown as PlanManagerDeps;
  return { d, session, chatProvider, plan };
}

describe('Retry compaction in VS Code', () => {
  it('retries the paused turn on the session, then shows the plan it landed and saves it', async () => {
    const { d, session, chatProvider, plan } = deps(async () => ({}));

    await handleSystemCommand('retryPlannerCompaction', '', d);

    expect(session.retryPlannerCompaction).toHaveBeenCalledOnce();
    expect(chatProvider.showError).not.toHaveBeenCalled();
    expect(chatProvider.showPlan).toHaveBeenCalledWith(plan);
    expect(d.persistState).toHaveBeenCalled();
  });

  it('says in the chat why a retry was refused', async () => {
    const { d, chatProvider } = deps(async () => { throw new ConversationEditError('The planner is not paused on its context: there is nothing to retry.'); });

    await handleSystemCommand('retryPlannerCompaction', '', d);

    expect(chatProvider.showError).toHaveBeenCalledWith('Planner failed: The planner is not paused on its context: there is nothing to retry.');
  });

  it('says nothing of a retry the user stopped: the stop ended it on screen', async () => {
    const { d, chatProvider } = deps(async () => { throw new PlannerTurnStoppedError(); });

    await handleSystemCommand('retryPlannerCompaction', '', d);

    expect(chatProvider.showError).not.toHaveBeenCalled();
  });
});
