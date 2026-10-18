import { describe, it, expect, vi } from 'vitest';
import { SessionNotFoundError } from '@ordewell/core';
import { Hono } from 'hono';
import type { OrchestratorPool } from '../../pool/orchestratorPool';
import { plansRoute } from '../plans';

function appFor(session: Record<string, unknown>, known = true) {
  const pool = {
    session: vi.fn(() => {
      if (!known) throw new SessionNotFoundError();
      return session;
    }),
  } as unknown as OrchestratorPool;
  const app = new Hono();
  app.route('/api/plans', plansRoute(pool));
  return app;
}

const post = (app: Hono, path: string, body?: unknown) => app.request(`/api/plans/s1/tasks/t1/checkpoint/${path}`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
});

describe('answering a task checkpoint over the daemon', () => {
  const said = { ok: true, message: 'Approved the checkpoint of task #1 "Build": it goes on.' };

  it('approves the waiting checkpoint through the command seam as the user, answering its line', async () => {
    const execute = vi.fn().mockResolvedValue(said);
    const res = await post(appFor({ awaitsCheckpoint: () => true, execute }), 'approve');

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(said);
    expect(execute).toHaveBeenCalledWith({ command: 'answer_checkpoint', task: 't1', answer: 'approve' }, { kind: 'user' });
  });

  it('rejects it with the reason, trimmed', async () => {
    const execute = vi.fn().mockResolvedValue(said);
    const res = await post(appFor({ awaitsCheckpoint: () => true, execute }), 'reject', { reason: '  keep the table  ' });

    expect(res.status).toBe(200);
    expect(execute).toHaveBeenCalledWith({ command: 'answer_checkpoint', task: 't1', answer: 'reject', reason: 'keep the table' }, { kind: 'user' });
  });

  it.each([
    ['no body', undefined],
    ['an empty reason', { reason: '   ' }],
    ['a reason that is not text', { reason: 4 }],
  ])('rejects with no reason for %s', async (_name, body) => {
    const execute = vi.fn().mockResolvedValue(said);
    const res = await post(appFor({ awaitsCheckpoint: () => true, execute }), 'reject', body);

    expect(res.status).toBe(200);
    expect(execute).toHaveBeenCalledWith({ command: 'answer_checkpoint', task: 't1', answer: 'reject' }, { kind: 'user' });
  });

  it('answers 409 and says why when nothing is waiting, for either answer', async () => {
    const execute = vi.fn();
    const app = appFor({ awaitsCheckpoint: () => false, execute });

    for (const res of [await post(app, 'approve'), await post(app, 'reject', { reason: 'no' })]) {
      expect(res.status).toBe(409);
      expect(await res.json()).toEqual({ error: expect.stringContaining('not waiting at a checkpoint'), code: 'checkpoint_not_waiting' });
    }
    expect(execute).not.toHaveBeenCalled();
  });

  it('answers the seam\'s refusal with 400 and its reason', async () => {
    const execute = vi.fn().mockResolvedValue({ ok: false, outcome: 'refused', message: 'The plan changed.' });
    const res = await post(appFor({ awaitsCheckpoint: () => true, execute }), 'approve');

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'The plan changed.', code: 'refused' });
  });

  it('answers 404 for a session the daemon does not have', async () => {
    expect((await post(appFor({}, false), 'approve')).status).toBe(404);
    expect((await post(appFor({}, false), 'reject')).status).toBe(404);
  });
});
