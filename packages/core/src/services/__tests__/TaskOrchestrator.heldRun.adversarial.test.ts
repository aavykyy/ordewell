import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import { TaskOrchestrator } from '../TaskOrchestrator';
import { createTask, type Task } from '../../models/Task';
import { BufferedTaskOutputSource } from '../BufferedTaskOutputSource';
import { RunnerRegistry } from '../../plugins/RunnerRegistry';
import { fakeConfig, FakeRunnerSession, flushMicrotasks } from '../../testing';
import { fakeNotification } from './sessionTestKit';
import type { IRunner, IRunnerSession } from '../../interfaces/IRunner';
import type { RunnerSpawnOptions } from '../AbstractRunner';

/**
 * Adversarial: a run the scheduler holds on a usage limit whose pause goes
 * away by another route than the reset. The hold is documented as released
 * "once nothing waits on a reset" (CONTEXT.md, ADR-0018 U1), so a run whose
 * last paused task stops waiting must go on (or finish), not sit held.
 */

const LIMIT = "You've hit your session limit · resets 8:10pm (UTC)";
const NOW = new Date('2026-10-11T17:00:00Z');
const RESUME_AT = '2026-10-11T20:11:00.000Z';

function setup(opts: { maxParallelSessions?: number } = {}) {
  const sessions: FakeRunnerSession[] = [];
  const runner = {
    spawn: vi.fn(async (o: RunnerSpawnOptions): Promise<IRunnerSession> => {
      const session = new FakeRunnerSession(`s${sessions.length + 1}`, o.taskId, `native-${sessions.length + 1}`);
      sessions.push(session);
      return session;
    }),
    stop: vi.fn(),
    stopAll: vi.fn(),
    activeCount: 0,
  } satisfies IRunner;
  const notifications = fakeNotification();
  const orchestrator = TaskOrchestrator.compose({
    config: fakeConfig({ maxParallelSessions: opts.maxParallelSessions ?? 3 }),
    notifications,
    runner,
    output: new BufferedTaskOutputSource(),
    registry: new RunnerRegistry(),
    workspaceRoot: () => '/repo',
    workspaceEnv: async () => ({ env: {}, blockedEnvrc: null, refused: [], trackedEnvFile: null }),
    runSettings: () => ({ mergeAtGatesAutomatically: false }),
  });
  const task = (id: string): Readonly<Task> => orchestrator.storeInstance.get(id)!;
  return { orchestrator, sessions, spawn: runner.spawn, notifications, task };
}

/** The limit as the structured transport delivers it: the turn's error event, then a failed turn. */
function hitLimitInTurn(session: FakeRunnerSession, message = LIMIT): void {
  session.emitEvent({ type: 'error', message });
  session.emitOutput(`${message}\n`);
  session.emitTurnEnd('failed');
}

async function until(condition: () => boolean): Promise<void> {
  for (let i = 0; i < 50 && !condition(); i += 1) await flushMicrotasks();
  expect(condition()).toBe(true);
}

beforeEach(() => {
  vi.useFakeTimers({ now: NOW });
});

afterEach(() => {
  vi.useRealTimers();
});

describe('adversarial: a held run whose last pause goes away', () => {
  // ADVERSARIAL FINDING (run state): a held run is released only from inside `resumeTask`; Mark complete of the last task paused on a usage limit leaves nothing waiting on a reset, but `settleRun`'s `held` branch returns before any release, so the run stays held and the rest of the plan never starts (TaskOrchestrator.ts:2063). Expected: the hold is released once nothing waits on a reset, and the run goes on.
  it.skip('goes on when the paused task is marked complete', async () => {
    const { orchestrator, sessions, spawn, task } = setup({ maxParallelSessions: 1 });
    orchestrator.loadPlan([
      createTask({ id: 't1', order: 1, title: 'Paused', prompt: 'do first' }),
      createTask({ id: 't2', order: 2, title: 'Next', prompt: 'do second' }),
    ]);
    await orchestrator.approveReview();
    hitLimitInTurn(sessions[0]);
    await until(() => task('t1').status === 'awaiting_user');
    expect(orchestrator.awaitsResume).toBe(true);

    await orchestrator.markTaskComplete('t1');

    expect(task('t1').status).toBe('completed');
    expect(orchestrator.awaitsResume).toBe(false);
    await until(() => spawn.mock.calls.length === 2);
    expect(spawn.mock.calls[1][0].taskId).toBe('t2');
  });

  // ADVERSARIAL FINDING (run state): cancelling the last resume on a runner disarms its wait but leaves the run `held`; nothing is waiting on a reset, yet the scheduler never resumes and the run never closes (TaskOrchestrator.ts:1599, 2063). Expected: the hold is released once nothing waits on a reset, and the run goes on.
  it.skip('goes on when the paused task\'s resume is cancelled', async () => {
    const { orchestrator, sessions, spawn, task } = setup({ maxParallelSessions: 1 });
    orchestrator.loadPlan([
      createTask({ id: 't1', order: 1, title: 'Paused', prompt: 'do first' }),
      createTask({ id: 't2', order: 2, title: 'Next', prompt: 'do second' }),
    ]);
    await orchestrator.approveReview();
    hitLimitInTurn(sessions[0]);
    await until(() => task('t1').status === 'awaiting_user');

    orchestrator.cancelScheduledResume('t1');
    await orchestrator.tick();

    expect(orchestrator.awaitsResume).toBe(false);
    await until(() => spawn.mock.calls.length === 2);
    expect(spawn.mock.calls[1][0].taskId).toBe('t2');
  });

  it('stays held, and nothing starts, until its reset when only the last task at work pauses', async () => {
    const { orchestrator, sessions, spawn, task } = setup({ maxParallelSessions: 1 });
    const events: string[] = [];
    orchestrator.subscribe({
      onIsolationHandoff: () => events.push('handoff'),
      onExecutionComplete: () => events.push('complete'),
    });
    orchestrator.loadPlan([
      createTask({ id: 't1', order: 1, title: 'Paused', prompt: 'do first' }),
      createTask({ id: 't2', order: 2, title: 'Next', prompt: 'do second' }),
    ]);
    await orchestrator.approveReview();
    hitLimitInTurn(sessions[0]);
    await until(() => task('t1').status === 'awaiting_user');
    await flushMicrotasks();

    expect(orchestrator.awaitsResume).toBe(true);
    expect(orchestrator.isScheduling).toBe(false);
    expect(events).toEqual([]);
    expect(spawn).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(Date.parse(RESUME_AT) - Date.now());
    await until(() => spawn.mock.calls.length === 2);
    expect(spawn.mock.calls[1][0]).toMatchObject({ taskId: 't1', resumeSessionId: 'native-1' });
    expect(orchestrator.isScheduling).toBe(true);

    sessions[1].reportComplete({ status: 'done', summary: '' });
    await until(() => spawn.mock.calls.length === 3);
    expect(spawn.mock.calls[2][0].taskId).toBe('t2');
  });

  it('a Stop while held cancels every resume and withdraws a queued force start', async () => {
    const { orchestrator, sessions, spawn, task } = setup({ maxParallelSessions: 1 });
    orchestrator.loadPlan([
      createTask({ id: 't1', order: 1, title: 'Paused', prompt: 'do first' }),
      createTask({ id: 't2', order: 2, title: 'Queued', prompt: 'do second', dependencies: ['t1'] }),
    ]);
    await orchestrator.approveReview();
    hitLimitInTurn(sessions[0]);
    await until(() => task('t1').status === 'awaiting_user');
    // Forced behind the paused t1: queued, with nothing that may start it meanwhile.
    await orchestrator.forceStartTask('t2');
    expect(orchestrator.startsPending).toBe(true);

    orchestrator.stop();

    expect(orchestrator.awaitsResume).toBe(false);
    expect(orchestrator.startsPending).toBe(false);
    expect(task('t1').resumeAt).toBeUndefined();
    await vi.advanceTimersByTimeAsync(24 * 60 * 60_000);
    expect(spawn).toHaveBeenCalledTimes(1);
    await orchestrator.tick();
    expect(spawn).toHaveBeenCalledTimes(1);
  });

  it('the reset resumes every task paused on one runner, past a failure while held, and the run goes on', async () => {
    const { orchestrator, sessions, spawn, task } = setup({ maxParallelSessions: 3 });
    orchestrator.loadPlan([
      createTask({ id: 't1', order: 1, title: 'First', prompt: 'do first' }),
      createTask({ id: 't2', order: 2, title: 'Second', prompt: 'do second' }),
      createTask({ id: 'f', order: 3, title: 'Fails', prompt: 'do it' }),
    ]);
    await orchestrator.approveReview();
    expect(spawn).toHaveBeenCalledTimes(3);

    hitLimitInTurn(sessions[0]);
    await until(() => task('t1').status === 'awaiting_user');
    hitLimitInTurn(sessions[1]);
    await until(() => task('t2').status === 'awaiting_user');
    expect(orchestrator.awaitsResume).toBe(true);
    expect(task('t1').resumeAt).toBe(task('t2').resumeAt);

    sessions[2].reportComplete({ status: 'failed', summary: '', reason: 'broke' });
    await until(() => task('f').status === 'failed');
    await flushMicrotasks();
    expect(orchestrator.awaitsResume).toBe(true);

    await vi.advanceTimersByTimeAsync(Date.parse(RESUME_AT) - Date.now());
    await until(() => spawn.mock.calls.length === 5);
    expect(spawn.mock.calls.slice(3).map(([o]) => o.taskId).sort()).toEqual(['t1', 't2']);
    expect(orchestrator.isScheduling).toBe(true);

    sessions[3].reportComplete({ status: 'done', summary: '' });
    sessions[4].reportComplete({ status: 'done', summary: '' });
    await until(() => task('t1').status === 'completed' && task('t2').status === 'completed');
  });

  it('a plan loaded after the reset resumes only the paused task, and leaves the rest for Execute', async () => {
    const { orchestrator, spawn, task } = setup({ maxParallelSessions: 2 });
    const paused: Task = {
      ...createTask({ id: 't1', order: 1, title: 'Paused', prompt: 'do first' }),
      status: 'awaiting_user',
      awaitingReason: 'usage-limit',
      resumeAt: '2026-10-11T09:00:00.000Z',
      runnerSessionId: 'native-saved',
    };
    orchestrator.loadPlan([paused, createTask({ id: 't2', order: 2, title: 'Next', prompt: 'do second' })]);

    await vi.advanceTimersByTimeAsync(0);
    await until(() => spawn.mock.calls.length === 1);
    expect(spawn.mock.calls[0][0]).toMatchObject({ taskId: 't1', resumeSessionId: 'native-saved' });
    await flushMicrotasks();

    expect(orchestrator.isScheduling).toBe(false);
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(task('t2').status).toBe('pending');
  });
});
