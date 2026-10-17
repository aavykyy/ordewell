import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';
import { SessionNotFoundError } from '@ordewell/core';
import type { OrchestratorPool } from '../../pool/orchestratorPool';

describe('POST /converse/resend/cancel', () => {
  let app: Hono;
  let session: { cancelPlannerResend: ReturnType<typeof vi.fn> };

  beforeEach(async () => {
    session = { cancelPlannerResend: vi.fn().mockReturnValue(true) };
    const pool = { session: vi.fn().mockReturnValue(session) } as unknown as OrchestratorPool;
    const { plansRoute } = await import('../../routes/plans');
    app = new Hono();
    app.route('/api/plans', plansRoute(pool));
  });

  const cancel = () => app.request('/api/plans/s1/converse/resend/cancel', { method: 'POST' });

  it('keeps what waits on the planner\'s usage limit from going at the reset, and says whether anything waited', async () => {
    const res = await cancel();

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ cancelled: true });
    expect(session.cancelPlannerResend).toHaveBeenCalledOnce();

    session.cancelPlannerResend.mockReturnValue(false);
    expect(await (await cancel()).json()).toEqual({ cancelled: false });
  });

  it('404s when the session is gone', async () => {
    session.cancelPlannerResend.mockImplementation(() => { throw new SessionNotFoundError(); });

    expect((await cancel()).status).toBe(404);
  });
});
