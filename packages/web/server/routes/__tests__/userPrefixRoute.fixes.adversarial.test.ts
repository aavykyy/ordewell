import { describe, it, expect, vi } from 'vitest';
import { Hono } from 'hono';
import { createTask, SessionNotFoundError } from '@ordewell/core';
import { OrchestratorPool } from '../../pool/orchestratorPool';
import { plansRoute } from '../plans';

/**
 * Adversarial, round two: the user's unique id prefix is read by the command
 * seam (ADR-0029's task reference rule), and the daemon's own reads must read
 * it the same way. `idOfRef` (routes/plans.ts) still resolves with
 * `resolveTaskRef` alone, so a prefix names no task there: the merge-gate read
 * answers "nothing gates it" and the CLI's start confirmation is skipped, and
 * a checkpoint answer by prefix is refused 409.
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
    createTask({ id: 'fix-1', order: 2, title: 'Bump' }),
  ],
};

describe('adversarial: the daemon reads a user task reference as the seam does', () => {
  // ADVERSARIAL FINDING (user-ref): `idOfRef` (packages/web/server/routes/plans.ts:39) resolves with
  // `resolveTaskRef` alone, while the command seam reads the user's unique id prefix (`resolveUserTaskRef`).
  // A prefixed reference therefore names no task to the merge-gate read: the route answers "nothing gates
  // it", the CLI's `ordewell run`/`force-start` confirmation is skipped, and the seam then force-starts
  // past the gate. Expected: the read resolves the reference as the seam does, so the gate is found and
  // the user is asked.
  it.skip('resolves a unique id prefix for the merge-gate the CLI asks about before a start', async () => {
    const mergeGate = vi.fn((id: string) => (id === 'fix-1' ? ['fix-0'] : []));
    const app = appFor({ mergeGate, planState });

    const res = await app.request('/api/plans/s1/tasks/fix/merge-gate');

    expect(res.status).toBe(200);
    expect(mergeGate).toHaveBeenCalledWith('fix-1');
    expect(await res.json()).toEqual({ mergeGate: [{ id: 'fix-0', order: 1, title: 'Fix' }] });
  });

  // ADVERSARIAL FINDING (user-ref): the checkpoint route pre-checks `awaitsCheckpoint(idOfRef(...))`, which
  // drops the prefix, so a checkpoint answer by prefix is refused 409 before the seam — which would resolve
  // it — ever runs. Expected: the pre-check reads the reference as the seam does.
  it.skip('lets a checkpoint be answered by a unique id prefix', async () => {
    const awaitsCheckpoint = vi.fn((id: string) => id === 'fix-1');
    const execute = vi.fn().mockResolvedValue({ ok: true, message: 'Approved.' });
    const app = appFor({ awaitsCheckpoint, execute, planState });

    const res = await app.request('/api/plans/s1/tasks/fix/checkpoint/approve', { method: 'POST' });

    expect(res.status).toBe(200);
    expect(execute).toHaveBeenCalledWith({ command: 'answer_checkpoint', task: 'fix', answer: 'approve' }, { kind: 'user' });
  });
});
