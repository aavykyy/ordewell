import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Task } from '@ordewell/core';
import { daemonHarness, task } from './daemonHarness';

/**
 * Adversarial: the routes are thin wrappers over the command seam (ADR-0029),
 * so a control that arrives looking like one thing and lands as another (a
 * message to a paused task is the resume it becomes), a reference the CLI
 * encodes, and a second answer to a settled request all have to behave at the
 * HTTP boundary exactly as the seam words them.
 */

type Harness = ReturnType<typeof daemonHarness>;

let harness: Harness;
afterEach(() => harness?.session.destroy());

function start(tasks: Task[], over?: Parameters<Harness['load']>[1]): Harness {
  harness = daemonHarness();
  harness.load(tasks, over);
  return harness;
}

async function json(res: Response): Promise<Record<string, unknown>> {
  return (await res.json()) as Record<string, unknown>;
}

const paused = (id: string, order: number): Task => ({
  ...task(id, order),
  status: 'awaiting_user',
  awaitingReason: 'usage-limit',
  resumeAt: new Date(Date.now() + 3_600_000).toISOString(),
  runnerSessionId: `native-${id}`,
});

describe('adversarial: a message to a paused task becomes the resume it is', () => {
  it('lands one line worded as the resume, with the message as its detail, and no message line', async () => {
    const h = start([paused('t1', 1)]);

    const res = await h.command({ command: 'message_task', task: 't1', text: 'the limit has reset, go on' });

    expect(res.status).toBe(200);
    // A resume starts no queued message, so there is no id for a surface's button.
    const body = await json(res);
    expect(body).toMatchObject({ ok: true, message: expect.stringContaining('saved session') });
    expect(body).not.toHaveProperty('payload');
    expect(h.timeline().map((m) => [m.record.command, m.record.outcome])).toEqual([['retry_task', 'done']]);
    expect(h.timeline()[0]?.text).toContain('resumed task #1 "Task t1" in its saved session');
    expect(h.timeline()[0]?.record.detail).toBe('the limit has reset, go on');
    await vi.waitFor(() => expect(h.session.planTasks[0].status).toBe('in_progress'));
  });

  it('a paused task whose saved session cannot go on is refused in the resume\'s words, once', async () => {
    const h = start([{ ...paused('t1', 1), runnerSessionId: undefined }]);

    const res = await h.command({ command: 'message_task', task: 't1', text: 'go on' });

    expect(res.status).toBe(400);
    const body = await json(res);
    expect(body).toMatchObject({ code: 'refused' });
    expect(String(body.error)).toMatch(/cannot be continued|saved session/);
    expect(h.timeline().map((m) => [m.record.command, m.record.outcome])).toEqual([['retry_task', 'refused']]);
  });
});

describe('adversarial: a reference the CLI URL-encodes', () => {
  it('a control naming a task by its exact title, spaces and a hash, resolves as typed', async () => {
    const h = start([task('t1', 1), task('t2', 2, { title: 'Deploy the #2 parser' })]);

    const res = await h.command({ command: 'mark_complete', task: 'Deploy the #2 parser', confirmed: true });

    expect(res.status).toBe(200);
    expect(await json(res)).toEqual({ ok: true, message: 'Marked task #2 "Deploy the #2 parser" complete.' });
    expect(h.timeline().map((m) => m.record.command)).toEqual(['mark_complete']);
  });
});

describe('adversarial: a runner request answered twice', () => {
  it('the second answer is refused, the runner decides once, and the timeline keeps the first only', async () => {
    const h = start([task('t1', 1)]);
    await h.session.execute({ command: 'run_plan' }, { kind: 'user' });
    h.forgetTimeline();
    h.latest('t1').requestPermission('p1', 'Bash', { command: 'git push --force' });
    await vi.waitFor(() => expect(h.session.outstandingApprovals()).toHaveLength(1));

    const first = await h.app.request('/api/approvals/s1/p1', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ decision: 'allow' }),
    });
    expect(first.status).toBe(200);

    const second = await h.app.request('/api/approvals/s1/p1', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ decision: 'allow' }),
    });

    expect(second.status).toBe(409);
    const body = await json(second);
    expect(body).toMatchObject({ code: 'approval_not_outstanding' });
    expect(h.timeline().map((m) => [m.record.command, m.record.outcome])).toEqual([['answer_approval', 'done']]);
  });
});
