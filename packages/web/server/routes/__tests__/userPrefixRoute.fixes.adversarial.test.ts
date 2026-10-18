import { describe, it, expect, vi } from 'vitest';
import { Hono } from 'hono';
import { createTask, SessionNotFoundError } from '@ordewell/core';
import { OrchestratorPool } from '../../pool/orchestratorPool';
import { plansRoute } from '../plans';

/**
 * Adversarial, round two: the user's unique id prefix is read by the command
 * seam (ADR-0029's task reference rule), and the daemon's own reads read it
 * the same way: `idOfRef` (routes/plans.ts) resolves the reference as the seam
 * does, so a prefixed reference names the task to the merge-gate read and to
 * a checkpoint answer.
 */

function appFor(session: Record<string, unknown>) {
  const pool = {
    session: vi.fn((id: string) => {
      if (id !== 's1') throw new SessionNotFoundError();
      return session;
    }),
  } as unknown as OrchestratorPool;
  const app = new Hono();
  app.route('/api/plans', plansRoute(pool));
  return app;
}

const planState = {
  tasks: [
    createTask({ id: 'fix-0', order: 1, title: 'Fix' }),
    createTask({ id: 'bump-1', order: 2, title: 'Bump' }),
  ],
};

describe('adversarial: the daemon reads a user task reference as the seam does', () => {
  it('resolves a unique id prefix for the merge-gate the CLI asks about before a start', async () => {
    const mergeGate = vi.fn((id: string) => (id === 'bump-1' ? ['fix-0'] : []));
    const app = appFor({ mergeGate, planState });

    const res = await app.request('/api/plans/s1/tasks/bump/merge-gate');

    expect(res.status).toBe(200);
    expect(mergeGate).toHaveBeenCalledWith('bump-1');
    expect(await res.json()).toEqual({ mergeGate: [{ id: 'fix-0', order: 1, title: 'Fix' }] });
  });

  it('lets a checkpoint be answered by a unique id prefix', async () => {
    const awaitsCheckpoint = vi.fn((id: string) => id === 'bump-1');
    const execute = vi.fn().mockResolvedValue({ ok: true, message: 'Approved.' });
    const app = appFor({ awaitsCheckpoint, execute, planState });

    const res = await app.request('/api/plans/s1/tasks/bump/checkpoint/approve', { method: 'POST' });

    expect(res.status).toBe(200);
    expect(awaitsCheckpoint).toHaveBeenCalledWith('bump-1');
    expect(execute).toHaveBeenCalledWith({ command: 'answer_checkpoint', task: 'bump-1', answer: 'approve' }, { kind: 'user' });
  });
});
