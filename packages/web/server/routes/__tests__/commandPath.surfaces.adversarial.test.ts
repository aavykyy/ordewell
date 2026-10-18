import { describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { createTask } from '@ordewell/core';
import type { OrchestratorPool } from '../../pool/orchestratorPool';
import { plansRoute } from '../plans';

/**
 * Adversarial: the two routes that pre-check a task before the seam does
 * (checkpoint, merge-gate) resolve the reference themselves. ADR-0029 says a
 * task named in a route is resolved by the seam, "the user's unique id prefix"
 * included — a pre-check that reads the reference another way refuses a
 * control the seam would have taken, and answers a merge gate the CLI asks
 * about before a force start as empty.
 */

function appFor(session: Record<string, unknown>) {
  const pool = {
    session: vi.fn(() => session),
  } as unknown as OrchestratorPool;
  const app = new Hono();
  app.route('/api/plans', plansRoute(pool));
  return app;
}

const plan = {
  tasks: [
    createTask({ id: 'fix-the-parser', order: 1, title: 'Fix the parser' }),
    createTask({ id: 'deploy-the-parser', order: 2, title: 'Deploy the parser', ops: true }),
  ],
};

/** The first characters of a task's id: unique in this plan, so the seam resolves it. */
const PREFIX = 'deploy';

describe('adversarial: a route pre-check resolves the user\'s reference as the seam does', () => {
  it('a checkpoint answer naming a unique id prefix is answered, not refused as not waiting', async () => {
    const said = { ok: true, message: 'Approved the checkpoint of task #2 "Deploy the parser": it goes on.' };
    const awaitsCheckpoint = vi.fn((id: string) => id === 'deploy-the-parser');
    const execute = vi.fn().mockResolvedValue(said);
    const app = appFor({ planState: plan, awaitsCheckpoint, execute });

    const res = await app.request(`/api/plans/s1/tasks/${PREFIX}/checkpoint/approve`, { method: 'POST' });

    expect(res.status).toBe(200);
    expect(awaitsCheckpoint).toHaveBeenCalledWith('deploy-the-parser');
    expect(execute).toHaveBeenCalledWith({ command: 'answer_checkpoint', task: 'deploy-the-parser', answer: 'approve' }, { kind: 'user' });
  });

  it('a merge-gate query naming a unique id prefix names the work that gates the task', async () => {
    const mergeGate = vi.fn((id: string) => (id === 'deploy-the-parser' ? ['fix-the-parser'] : []));
    const app = appFor({ planState: plan, mergeGate });

    const res = await app.request(`/api/plans/s1/tasks/${PREFIX}/merge-gate`);

    expect(res.status).toBe(200);
    expect(mergeGate).toHaveBeenCalledWith('deploy-the-parser');
    expect(await res.json()).toEqual({ mergeGate: [{ id: 'fix-the-parser', order: 1, title: 'Fix the parser' }] });
  });
});
