import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';
import { approvalsRoute } from '../approvals';
import type { OrchestratorPool } from '../../pool/orchestratorPool';

function fakePool(overrides: Partial<OrchestratorPool> = {}): OrchestratorPool {
  return {
    hasSession: vi.fn().mockReturnValue(true),
    resolveApproval: vi.fn().mockReturnValue(true),
    outstandingApprovals: vi.fn().mockReturnValue([]),
    approvedScopes: vi.fn().mockReturnValue([]),
    ...overrides,
  } as unknown as OrchestratorPool;
}

describe('POST /api/approvals/:sessionId/:approvalId', () => {
  let app: Hono;
  let pool: OrchestratorPool;

  beforeEach(() => {
    pool = fakePool();
    app = new Hono();
    app.route('/api/approvals', approvalsRoute(pool));
  });

  it('grants the request the planner is blocked on', async () => {
    const res = await app.request('/api/approvals/s1/ap-1', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ granted: true }),
    });

    expect(res.status).toBe(200);
    expect(pool.resolveApproval).toHaveBeenCalledWith('s1', 'ap-1', true);
  });

  it('denies when the body says so', async () => {
    await app.request('/api/approvals/s1/ap-1', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ granted: false }),
    });

    expect(pool.resolveApproval).toHaveBeenCalledWith('s1', 'ap-1', false);
  });

  // A missing or malformed body must not read as consent.
  it('treats an absent granted flag as a denial', async () => {
    await app.request('/api/approvals/s1/ap-1', { method: 'POST' });

    expect(pool.resolveApproval).toHaveBeenCalledWith('s1', 'ap-1', false);
  });

  // T5: absent is denial everywhere. A wrong type, a truthy non-boolean, a
  // wrong field name, or malformed JSON all collapse to a denial rather than
  // hanging the prompt or accidentally consenting.
  it.each([
    ['malformed JSON body', 'application/json', 'not-json'],
    ['string "true"', 'application/json', JSON.stringify({ granted: 'true' })],
    ['number 1', 'application/json', JSON.stringify({ granted: 1 })],
    ['null', 'application/json', JSON.stringify({ granted: null })],
    ['wrong field name', 'application/json', JSON.stringify({ allow: true })],
  ])('treats %s as a denial', async (_label, type, body) => {
    await app.request('/api/approvals/s1/ap-1', {
      method: 'POST',
      headers: { 'content-type': type },
      body,
    });

    expect(pool.resolveApproval).toHaveBeenCalledWith('s1', 'ap-1', false);
  });

  it.each([
    [{ decision: 'allow' }, { decision: 'allow' }],
    [{ decision: 'allowForTask' }, { decision: 'allowForTask' }],
    [{ decision: 'deny', note: '  write it under notes/  ' }, { decision: 'deny', note: 'write it under notes/' }],
    [{ decision: 'deny', note: '   ' }, { decision: 'deny' }],
  ])('carries a runner request\'s whole answer %o', async (body, expected) => {
    const res = await app.request('/api/approvals/s1/ap-1', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    expect(pool.resolveApproval).toHaveBeenCalledWith('s1', 'ap-1', expected);
    expect(await res.json()).toEqual({ ok: true, granted: expected.decision !== 'deny', decision: expected.decision });
  });

  it.each([
    ['an unknown decision', { decision: 'always' }],
    ['a decision beside a grant', { decision: 'maybe', granted: true }],
  ])('treats %s as a denial', async (_label, body) => {
    await app.request('/api/approvals/s1/ap-1', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    expect(pool.resolveApproval).toHaveBeenCalledWith('s1', 'ap-1', { decision: 'deny' });
  });

  it('routes a runner request the user denies through the command seam, keeping it in the timeline', async () => {
    const execute = vi.fn().mockResolvedValue({ ok: true, message: 'Denied task #1 "Build"\'s request.' });
    pool = fakePool({
      outstandingApprovals: vi.fn().mockReturnValue([
        { id: 'ap-1', createdAt: '2026-10-11T18:00:00Z', request: { kind: 'runner_tool', subject: 'Bash(npm test)', scope: 'Bash(npm test)', taskId: 't1' } },
      ]),
      session: vi.fn().mockReturnValue({ execute }),
    });
    app = new Hono();
    app.route('/api/approvals', approvalsRoute(pool));

    const res = await app.request('/api/approvals/s1/ap-1', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ decision: 'deny', note: 'not now' }),
    });

    expect(res.status).toBe(200);
    expect(execute).toHaveBeenCalledWith({ command: 'answer_approval', task: 't1', approval: 'ap-1', answer: 'deny', note: 'not now' }, { kind: 'user' });
    expect(pool.resolveApproval).not.toHaveBeenCalled();
  });

  it('keeps an allow on the approval path: the seam never allows', async () => {
    const execute = vi.fn();
    pool = fakePool({
      outstandingApprovals: vi.fn().mockReturnValue([
        { id: 'ap-1', createdAt: '2026-10-11T18:00:00Z', request: { kind: 'runner_tool', subject: 'Bash(npm test)', scope: 'Bash(npm test)', taskId: 't1' } },
      ]),
      session: vi.fn().mockReturnValue({ execute }),
    });
    app = new Hono();
    app.route('/api/approvals', approvalsRoute(pool));

    const res = await app.request('/api/approvals/s1/ap-1', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ decision: 'allow' }),
    });

    expect(res.status).toBe(200);
    expect(pool.resolveApproval).toHaveBeenCalledWith('s1', 'ap-1', { decision: 'allow' });
    expect(execute).not.toHaveBeenCalled();
  });

  it('404s for an unknown session', async () => {
    pool = fakePool({ hasSession: vi.fn().mockReturnValue(false) });
    app = new Hono();
    app.route('/api/approvals', approvalsRoute(pool));

    const res = await app.request('/api/approvals/nope/ap-1', { method: 'POST' });

    expect(res.status).toBe(404);
    expect(pool.resolveApproval).not.toHaveBeenCalled();
  });

  // The prompt may have timed out or been answered from another surface.
  it('409s when the approval is no longer outstanding', async () => {
    pool = fakePool({ resolveApproval: vi.fn().mockReturnValue(false) });
    app = new Hono();
    app.route('/api/approvals', approvalsRoute(pool));

    const res = await app.request('/api/approvals/s1/stale', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ granted: true }),
    });

    expect(res.status).toBe(409);
  });
});

describe('GET /api/approvals/:sessionId', () => {
  it('lists what is still pending, so a client that connects mid-prompt can render it', async () => {
    const pool = fakePool({
      outstandingApprovals: vi.fn().mockReturnValue([
        { id: 'ap-1', createdAt: '2026-07-25T00:00:00Z', request: { kind: 'shell_command', subject: 'npm test', scope: 'npm test' } },
      ]),
      approvedScopes: vi.fn().mockReturnValue(['az group']),
    });
    const app = new Hono();
    app.route('/api/approvals', approvalsRoute(pool));

    const res = await app.request('/api/approvals/s1');
    const body = await res.json() as { pending: unknown[]; approvedScopes: string[] };

    expect(res.status).toBe(200);
    expect(body.pending).toHaveLength(1);
    expect(body.approvedScopes).toEqual(['az group']);
  });

  it('404s for an unknown session', async () => {
    const pool = fakePool({ hasSession: vi.fn().mockReturnValue(false) });
    const app = new Hono();
    app.route('/api/approvals', approvalsRoute(pool));

    expect((await app.request('/api/approvals/nope')).status).toBe(404);
  });
});
