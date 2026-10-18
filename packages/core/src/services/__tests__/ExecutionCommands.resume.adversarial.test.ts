import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import { makeSession, taskOf, fakeConfig, testWorkspace } from './sessionTestKit';
import { createTask, type LegacyPlanState, type Task } from '../../models/Task';
import type { IRunner } from '../../interfaces/IRunner';
import { FakeRunnerSession } from '../../testing';
import type { ExecutionActor } from '../../models/Execution';

/**
 * Adversarial: a Resume now the command seam could not take must change
 * nothing. ADR-0018 U1: "A Resume now the asked task cannot take — every slot
 * taken, or the task not approved — is refused before anything changes, so
 * every resume at the reset stands."
 */

const ACT: ExecutionActor = { kind: 'supervisor', level: 'act' };
const NOW = new Date('2026-10-11T17:00:00Z');
const RESUME_AT = '2026-10-11T20:11:00.000Z';

function task(id: string, order: number, over: Partial<Task> = {}): Task {
  return createTask({ id, order, title: `Task ${id}`, prompt: `do ${id}`, assignedRunner: 'claude-code', ...over });
}

function plan(tasks: Task[]): LegacyPlanState {
  const now = new Date().toISOString();
  return { tasks, generatedAt: now, status: 'approved', runners: ['claude-code'], lastUpdated: now };
}

function setup(maxParallel = 1) {
  const sessions: FakeRunnerSession[] = [];
  const spawn = vi.fn(async (opts: Parameters<IRunner['spawn']>[0]) => {
    const session = new FakeRunnerSession(`s${sessions.length + 1}`, opts.taskId);
    sessions.push(session);
    return session;
  });
  const session = makeSession({
    runner: { spawn, stop: vi.fn(), stopAll: vi.fn(), activeCount: 0 } as IRunner,
    config: fakeConfig({ autonomousMode: true, maxParallelSessions: maxParallel }),
  });
  const spawned = (taskId: string) => spawn.mock.calls.map(([o]) => o).filter((o) => o.taskId === taskId);
  return { session, spawned, spawn };
}

const paused = (id: string, order: number): Task => ({
  ...task(id, order),
  status: 'awaiting_user',
  awaitingReason: 'usage-limit',
  resumeAt: RESUME_AT,
  runnerSessionId: `native-${id}`,
});

beforeEach(() => {
  vi.useFakeTimers({ now: NOW });
});

afterEach(() => {
  vi.useRealTimers();
});

describe('adversarial: a Resume now the seam cannot take changes nothing', () => {
  it('keeps every resume at the reset when the supervisor\'s retry_task finds every slot taken', async () => {
    const env = setup();
    env.session.loadPlan(plan([paused('t1', 1), paused('t2', 2), task('busy', 3)]), 'goal', testWorkspace, { persist: false });
    await env.session.forceStartTask('busy');

    const outcome = await env.session.execute({ command: 'retry_task', task: 't1', from: 'session' }, ACT);

    expect(outcome).toMatchObject({ ok: false, outcome: 'refused', message: expect.stringContaining('already running') });
    expect(taskOf(env.session, 't1')).toMatchObject({ status: 'awaiting_user', awaitingReason: 'usage-limit', resumeAt: RESUME_AT });
    expect(taskOf(env.session, 't2')).toMatchObject({ status: 'awaiting_user', awaitingReason: 'usage-limit', resumeAt: RESUME_AT });
    expect(env.spawned('t1')).toHaveLength(0);
  });

  it('keeps the resume at the reset when a message sent to a paused task cannot take a slot', async () => {
    const env = setup();
    env.session.loadPlan(plan([paused('t1', 1), paused('t2', 2), task('busy', 3)]), 'goal', testWorkspace, { persist: false });
    await env.session.forceStartTask('busy');

    const outcome = await env.session.execute({ command: 'message_task', task: 't1', text: 'limits reset, go on' }, { kind: 'user' });

    expect(outcome).toMatchObject({ ok: false, outcome: 'refused', message: expect.stringContaining('already running') });
    expect(taskOf(env.session, 't1')).toMatchObject({ status: 'awaiting_user', awaitingReason: 'usage-limit', resumeAt: RESUME_AT });
    expect(taskOf(env.session, 't2')!.resumeAt).toBe(RESUME_AT);
    expect(env.spawned('t1')).toHaveLength(0);
  });

  it('resumes both tasks of the runner at the reset after the refusal, once the slots are free', async () => {
    const env = setup(2);
    env.session.loadPlan(plan([paused('t1', 1), paused('t2', 2), task('busy', 3), task('busy2', 4)]), 'goal', testWorkspace, { persist: false });
    await env.session.forceStartTask('busy');
    await env.session.forceStartTask('busy2');

    const refused = await env.session.execute({ command: 'retry_task', task: 't1', from: 'session' }, ACT);
    expect(refused.ok).toBe(false);

    await env.session.markTaskComplete(taskOf(env.session, 'busy')!.id);
    await env.session.markTaskComplete(taskOf(env.session, 'busy2')!.id);

    await vi.advanceTimersByTimeAsync(Date.parse(RESUME_AT) - Date.now());
    await vi.waitFor(() => expect(env.spawned('t1')).toHaveLength(1));
    await vi.waitFor(() => expect(env.spawned('t2')).toHaveLength(1));
    expect(env.spawned('t1')[0]).toMatchObject({ resumeSessionId: 'native-t1' });
    expect(env.spawned('t2')[0]).toMatchObject({ resumeSessionId: 'native-t2' });  });
});
