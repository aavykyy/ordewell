import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';
import { PlanEditError, SessionNotFoundError } from '@ordewell/core';
import type { OrchestratorPool } from '../../pool/orchestratorPool';

describe('task editing routes', () => {
  let app: Hono;
  let session: {
    updateTask: ReturnType<typeof vi.fn>;
    addTask: ReturnType<typeof vi.fn>;
    removeTask: ReturnType<typeof vi.fn>;
    execute: ReturnType<typeof vi.fn>;
  };

  beforeEach(async () => {
    session = {
      updateTask: vi.fn().mockReturnValue({ tasks: [] }),
      addTask: vi.fn().mockResolvedValue({ tasks: [] }),
      removeTask: vi.fn().mockReturnValue({ tasks: [] }),
      execute: vi.fn().mockResolvedValue({ ok: true, message: 'Done.' }),
    };
    const pool = { session: vi.fn().mockReturnValue(session) } as unknown as OrchestratorPool;
    const { plansRoute } = await import('../../routes/plans');
    app = new Hono();
    app.route('/api/plans', plansRoute(pool));
  });

  const put = (body: unknown) => app.request('/api/plans/s1/tasks/t1', {
    method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  const post = (body: unknown) => app.request('/api/plans/s1/tasks', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });

  describe('PUT with dependencies', () => {
    // The session checks the list against the whole plan, with the rest of the patch, in one edit.
    it('hands the list to updateTask with the rest of the patch', async () => {
      const res = await put({ dependencies: ['a'], prompt: 'rewritten' });

      expect(res.status).toBe(200);
      expect(session.updateTask).toHaveBeenCalledWith('t1', { dependencies: ['a'], prompt: 'rewritten' });
    });

    it('hands a cleared list over too, rather than reading it as an absent field', async () => {
      await put({ dependencies: [] });

      expect(session.updateTask).toHaveBeenCalledWith('t1', { dependencies: [] });
    });

    it('reports a refused edit as a client error, with the reason', async () => {
      session.updateTask.mockRejectedValue(new PlanEditError('"Setup" cannot depend on "Test", which comes after it in the plan'));

      const res = await put({ dependencies: ['t3'] });

      expect(res.status).toBe(400);
      expect((await res.json() as { error: string }).error).toMatch(/comes after it/);
    });

    it('404s when the task does not exist', async () => {
      session.updateTask.mockReturnValue(null);

      expect((await put({ dependencies: [] })).status).toBe(404);
    });
  });

  describe('PUT with a model cleared', () => {
    // JSON has no undefined; a null is how a client clears it, and core's lock reads the clear.
    it('hands updateTask a cleared model, not a null one', async () => {
      const res = await put({ assignedModel: null });

      expect(res.status).toBe(200);
      const [, changes] = session.updateTask.mock.calls[0] as [string, Record<string, unknown>];
      expect('assignedModel' in changes).toBe(true);
      expect(changes.assignedModel).toBeUndefined();
    });
  });

  describe('POST /tasks', () => {
    it('awaits addTask, which derives the new task assignment from a runner catalog', async () => {
      const res = await post({ title: 'Docs', dependencies: ['a'] });

      expect(res.status).toBe(200);
      expect(session.addTask).toHaveBeenCalledWith({ title: 'Docs', dependencies: ['a'] });
    });

    it('404s when there is no session to add to', async () => {
      session.addTask.mockResolvedValue(null);

      expect((await post({ title: 'Docs' })).status).toBe(404);
    });

    it('reports a rejected add rather than resolving as success', async () => {
      session.addTask.mockRejectedValue(new Error('boom'));

      const res = await post({ title: 'Docs' });

      expect(res.status).toBe(500);
      expect((await res.json() as { error: string }).error).toBe('boom');
    });
  });

  describe('the retired reorder endpoint', () => {
    // Display order is not execution order, so no surface offers reordering any
    // more. A stale client must get a visible 404, not a silent partial write:
    // `/tasks/reorder` now falls through to PUT /tasks/:taskId as a task id.
    it('no longer reorders, and reports the miss', async () => {
      session.updateTask.mockReturnValue(null);

      const res = await app.request('/api/plans/s1/tasks/reorder', {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ taskIds: ['b', 'a'] }),
      });

      expect(res.status).toBe(404);
      expect(session.updateTask).toHaveBeenCalledWith('reorder', { taskIds: ['b', 'a'] });
    });
  });

  describe('POST /execute-command', () => {
    const send = (body: unknown) => app.request('/api/plans/s1/execute-command', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });

    it('runs the command through the seam as the user, answering its line', async () => {
      const res = await send({ command: 'mark_not_done', task: 't1' });

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ ok: true, message: 'Done.' });
      expect(session.execute).toHaveBeenCalledWith({ command: 'mark_not_done', task: 't1' }, { kind: 'user' });
    });

    it('refuses, with the reason, what the seam refuses', async () => {
      session.execute.mockResolvedValue({ ok: false, outcome: 'refused', message: 'Task #1 "Fix" has no resume scheduled.' });

      const res = await send({ command: 'cancel_resume', task: 't1' });

      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: 'Task #1 "Fix" has no resume scheduled.', code: 'refused' });
    });

    it('404s when the session is gone', async () => {
      session.execute.mockRejectedValue(new SessionNotFoundError());

      expect((await send({ command: 'cancel_resume', task: 't1' })).status).toBe(404);
    });

    it('survives a non-Error throw rather than crashing the route', async () => {
      session.execute.mockRejectedValue('boom');

      const res = await send({ command: 'mark_not_done', task: 't1' });

      expect(res.status).toBe(500);
      expect((await res.json() as { error: string }).error).toBe('Internal error');
    });

    it.each([
      ['an unknown command', { command: 'format_disk' }],
      ['a command with no name', {}],
      ['a task reference that is not text', { command: 'stop_task', task: 7 }],
      ['a command missing its task', { command: 'stop_task' }],
      ['a retry from neither kind of start', { command: 'retry_task', task: 't1', from: 'later' }],
      ['an empty message', { command: 'message_task', task: 't1', text: '  ' }],
    ])('refuses %s before it reaches the seam', async (_label, body) => {
      const res = await send(body);

      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({ code: 'refused' });
      expect(session.execute).not.toHaveBeenCalled();
    });

    it('refuses a body that is not an object', async () => {
      const res = await send([]);

      expect(res.status).toBe(400);
      expect(session.execute).not.toHaveBeenCalled();
    });
  });

  describe('DELETE /tasks/:taskId', () => {
    it('removes the task', async () => {
      const res = await app.request('/api/plans/s1/tasks/t1', { method: 'DELETE' });

      expect(res.status).toBe(200);
      expect(session.removeTask).toHaveBeenCalledWith('t1');
    });

    it('404s when there is no plan to remove from', async () => {
      session.removeTask.mockReturnValue(null);

      expect((await app.request('/api/plans/s1/tasks/t1', { method: 'DELETE' })).status).toBe(404);
    });

    // The removal cancels a live runner first, so it can throw. An unhandled
    // throw here answered with no body at all, which every surface read as the
    // delete having silently done nothing.
    it('404s when the session is gone rather than throwing out of the route', async () => {
      session.removeTask.mockRejectedValue(new SessionNotFoundError());

      const res = await app.request('/api/plans/s1/tasks/t1', { method: 'DELETE' });

      expect(res.status).toBe(404);
      expect((await res.json() as { error: string }).error).toBe('Session not found');
    });

    it('reports a refused removal as a client error, with the reason', async () => {
      session.removeTask.mockRejectedValue(new PlanEditError('"Build" cannot be removed'));

      const res = await app.request('/api/plans/s1/tasks/t1', { method: 'DELETE' });

      expect(res.status).toBe(400);
      expect((await res.json() as { error: string }).error).toMatch(/cannot be removed/);
    });
  });

  // A refusal and a fault are different answers. Collapsing them into 500 left
  // the TUI and VS Code with nothing to show but "Internal error".
  describe('refusals are told apart from faults', () => {
    it('reports a refused field patch as a client error', async () => {
      session.updateTask.mockRejectedValue(new PlanEditError('Unknown dependency "ghost"'));

      const res = await put({ prompt: 'x' });

      expect(res.status).toBe(400);
      expect((await res.json() as { error: string }).error).toMatch(/Unknown dependency/);
    });

    it('reports a refused add as a client error', async () => {
      session.addTask.mockRejectedValue(new PlanEditError('Task needs a title'));

      const res = await post({ prompt: 'x' });

      expect(res.status).toBe(400);
      expect((await res.json() as { error: string }).error).toMatch(/needs a title/);
    });

    it('still reports a genuine fault as a fault', async () => {
      session.updateTask.mockRejectedValue(new Error('disk on fire'));

      const res = await put({ prompt: 'x' });

      expect(res.status).toBe(500);
      expect((await res.json() as { error: string }).error).toBe('disk on fire');
    });
  });
});
