import { afterEach, describe, it, expect, vi } from 'vitest';
import { Hono } from 'hono';
import {
  createSession, createTask, ModelResolver, RunnerRegistry, TaskControlError, SessionNotFoundError,
  type IRunner, type LegacyPlanState, type Session,
} from '@ordewell/core';
import { fakeConfig, fakeFileSystem, FakeRunnerSession } from '@ordewell/core/testing';
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

function request(app: Hono, method: string, path: string, body?: unknown) {
  return app.request(`/api/plans/s1/tasks/t1${path}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
}

function send(app: Hono, body: unknown) {
  return app.request('/api/plans/s1/execute-command', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('talking to a structured task over the daemon (ADR-0018, M1)', () => {
  it('sends a message through the command seam as the user, answering its queued id', async () => {
    const execute = vi.fn().mockResolvedValue({ ok: true, message: 'Sent to task #1 "Build".', payload: { kind: 'message', id: 'msg-1' } });
    const res = await send(appFor({ execute }), { command: 'message_task', task: 't1', text: 'use Postgres' });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, message: 'Sent to task #1 "Build".', payload: { kind: 'message', id: 'msg-1' } });
    expect(execute).toHaveBeenCalledWith({ command: 'message_task', task: 't1', text: 'use Postgres' }, { kind: 'user' });
  });

  it('asks for the text rather than sending an empty message', async () => {
    const execute = vi.fn();
    const res = await send(appFor({ execute }), { command: 'message_task', task: 't1', text: '  ' });

    expect(res.status).toBe(400);
    expect(execute).not.toHaveBeenCalled();
  });

  it('runs the runner\'s own command on the task, with its arguments, answering its queued id (#66)', async () => {
    const invokeTaskCommand = vi.fn(() => 'msg-3');
    const res = await request(appFor({ invokeTaskCommand }), 'POST', '/commands', { name: 'compact', args: 'keep the API notes' });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ id: 'msg-3' });
    expect(invokeTaskCommand).toHaveBeenCalledWith('t1', 'compact', 'keep the API notes');
  });

  it('asks for the command\'s name, and refuses a task that cannot take one with the reason', async () => {
    const invokeTaskCommand = vi.fn(() => { throw new TaskControlError('Task "Build" is not running, so there is no turn to run a command in.'); });
    expect((await request(appFor({ invokeTaskCommand }), 'POST', '/commands', { name: ' ' })).status).toBe(400);

    const refused = await request(appFor({ invokeTaskCommand }), 'POST', '/commands', { name: 'compact' });
    expect(refused.status).toBeGreaterThanOrEqual(400);
    expect(await refused.json()).toMatchObject({ error: expect.stringContaining('is not running') });
    expect(invokeTaskCommand).toHaveBeenCalledWith('t1', 'compact', '');
  });

  it('takes back a queued message through the command seam as the user, answering its line', async () => {
    const execute = vi.fn().mockResolvedValue({ ok: true, message: 'Took back your queued message to task #1 "Build".' });
    const res = await send(appFor({ execute }), { command: 'remove_queued', task: 't1', id: 'msg-2' });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, message: 'Took back your queued message to task #1 "Build".' });
    expect(execute).toHaveBeenCalledWith({ command: 'remove_queued', task: 't1', id: 'msg-2' }, { kind: 'user' });
  });

  it('interrupts the running turn through the seam', async () => {
    const execute = vi.fn().mockResolvedValue({ ok: true, message: 'Interrupted task #1 "Build": it waits for your message.' });
    const res = await send(appFor({ execute }), { command: 'interrupt_task', task: 't1' });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, message: 'Interrupted task #1 "Build": it waits for your message.' });
    expect(execute).toHaveBeenCalledWith({ command: 'interrupt_task', task: 't1' }, { kind: 'user' });
  });

  it('force sends a new message through the seam and answers with its id (ADR-0023, F1)', async () => {
    const execute = vi.fn().mockResolvedValue({ ok: true, message: 'Sent now.', payload: { kind: 'message', id: 'msg-3' } });
    const res = await send(appFor({ execute }), { command: 'message_task', task: 't1', text: 'stop, use Postgres', force: true });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, message: 'Sent now.', payload: { kind: 'message', id: 'msg-3' } });
    expect(execute).toHaveBeenCalledWith({ command: 'message_task', task: 't1', text: 'stop, use Postgres', force: true }, { kind: 'user' });
  });

  it('asks for the text rather than force sending an empty message', async () => {
    const execute = vi.fn();
    const res = await send(appFor({ execute }), { command: 'message_task', task: 't1', force: true });

    expect(res.status).toBe(400);
    expect(execute).not.toHaveBeenCalled();
  });

  it('force sends a queued message by id through the seam', async () => {
    const execute = vi.fn().mockResolvedValue({ ok: true, message: 'Sent your queued message to task #1 "Build" now.' });
    const res = await send(appFor({ execute }), { command: 'force_send_queued', task: 't1', id: 'msg-2' });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, message: 'Sent your queued message to task #1 "Build" now.' });
    expect(execute).toHaveBeenCalledWith({ command: 'force_send_queued', task: 't1', id: 'msg-2' }, { kind: 'user' });
  });

  it('answers a refusal for a task that is not running with 400 and the reason', async () => {
    const refusal = new TaskControlError('Task "Only" is not running, so there is no turn to send a message to.');
    const app = appFor({ execute: async () => ({ ok: false, outcome: 'refused', message: refusal.message }) });

    for (const res of [
      await send(app, { command: 'message_task', task: 't1', text: 'hi' }),
      await send(app, { command: 'message_task', task: 't1', text: 'hi', force: true }),
      await send(app, { command: 'force_send_queued', task: 't1', id: 'msg-1' }),
      await send(app, { command: 'remove_queued', task: 't1', id: 'msg-1' }),
      await send(app, { command: 'interrupt_task', task: 't1' }),
    ]) {
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: refusal.message, code: 'refused' });
    }
  });

  it('answers 404 for a session the daemon does not have', async () => {
    const res = await send(appFor({}, false), { command: 'interrupt_task', task: 't1' });
    expect(res.status).toBe(404);
  });
});

describe('force sending a message the runner already has over the daemon (ADR-0023, F1)', () => {
  let session: Session | undefined;
  afterEach(() => { session?.destroy(); });

  async function running() {
    const task = new FakeRunnerSession('s1', 't1');
    const runner = { spawn: vi.fn(async () => task), stop: vi.fn(), stopAll: vi.fn(), activeCount: 0 } satisfies IRunner;
    const config = fakeConfig();
    const registry = new RunnerRegistry();
    session = createSession({
      config, registry, runner,
      notifications: { info() {}, warn() {}, error() {}, async confirm() { return undefined; } },
      workspaceRoot: () => process.cwd(),
      fsAdapter: fakeFileSystem(),
      broadcast: () => {},
      modelResolver: new ModelResolver(registry, config, { execImpl: async () => ({ stdout: '' }) }),
      settings: () => ({}),
      saveSession: () => {},
      openTaskLog: () => ({ attempt: 1, append() {} }),
    });
    const plan: LegacyPlanState = {
      tasks: [createTask({ id: 't1', order: 1, title: 'Build', prompt: 'build it', assignedRunner: 'claude-code' })],
      runners: ['claude-code'], status: 'approved', generatedAt: '2026-10-14T09:00:00Z', lastUpdated: '2026-10-14T09:00:00Z',
    };
    session.loadPlan(plan, 'build it', process.cwd());
    await session.execute({ command: 'run_plan' }, { kind: 'user' });
    await vi.waitFor(() => expect(runner.spawn).toHaveBeenCalled());
    const app = new Hono().route('/api/plans', plansRoute({ session: () => session } as unknown as OrchestratorPool));
    return { app, task };
  }

  it('accepts the id of a handed-over message, interrupting the turn, and refuses once nothing is left to send', async () => {
    const { app, task } = await running();
    task.messages.push({ id: 'msg-7', text: 'use Postgres', handedOver: true });

    const sent = await send(app, { command: 'force_send_queued', task: 't1', id: 'msg-7' });
    expect(sent.status).toBe(200);
    expect(await sent.json()).toMatchObject({ ok: true });
    expect(task.interrupts).toBe(1);
    expect(task.delivered).toEqual(['use Postgres']);

    const gone = await send(app, { command: 'force_send_queued', task: 't1', id: 'msg-7' });
    expect(gone.status).toBe(400);
    expect(await gone.json()).toEqual({ error: 'That message to task #1 "Build" was already delivered.', code: 'refused' });
  });
});

describe('continuing a finished structured task over the daemon (ADR-0018, K1)', () => {
  it('continues it with the message through the command seam as the user', async () => {
    const execute = vi.fn().mockResolvedValue({ ok: true, message: 'Continuing task #1 "Build" in its saved session with your message.' });
    const res = await send(appFor({ execute }), { command: 'retry_task', task: 't1', from: 'session', message: 'also handle arrays' });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, message: 'Continuing task #1 "Build" in its saved session with your message.' });
    expect(execute).toHaveBeenCalledWith({ command: 'retry_task', task: 't1', from: 'session', message: 'also handle arrays' }, { kind: 'user' });
  });

  it('refuses a continue whose message is not text, rather than continuing with it', async () => {
    const execute = vi.fn();
    const res = await send(appFor({ execute }), { command: 'retry_task', task: 't1', from: 'session', message: 7 });

    expect(res.status).toBe(400);
    expect(execute).not.toHaveBeenCalled();
  });

  it('answers a refusal — a conflict, say — with 400 and the reason', async () => {
    const refusal = 'Task "Only" cannot be continued: its work is waiting on a merge conflict. Resolve or repair the conflict instead.';
    const res = await send(appFor({ execute: async () => ({ ok: false, outcome: 'refused', message: refusal }) }), { command: 'retry_task', task: 't1', from: 'session', message: 'go on' });

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: refusal, code: 'refused' });
  });
});
