import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import { TaskOrchestrator } from '../TaskOrchestrator';
import { applyTaskOps } from '../TaskOps';
import { createTask, type Task } from '../../models/Task';
import { BufferedTaskOutputSource } from '../BufferedTaskOutputSource';
import { RunnerRegistry } from '../../plugins/RunnerRegistry';
import { fakeConfig, FakeRunnerSession, flushMicrotasks } from '../../testing';
import { fakeNotification } from './sessionTestKit';
import type { IRunner, IRunnerSession } from '../../interfaces/IRunner';
import type { RunnerSpawnOptions } from '../AbstractRunner';

/**
 * Adversarial: the run's state is one value, and a usage-limit hold is one of
 * its values. ADR-0018 U1 and CONTEXT.md's *Usage-limit resume*: the hold is
 * released once nothing waits on a reset, however the last wait went, and a
 * task paused without a reset time keeps only its own runner's tasks from
 * starting. The run must never stay held with nothing waiting on it.
 */

const LIMIT = "You've hit your session limit · resets 8:10pm (UTC)";
const LIMIT_NO_RESET = "You've hit your usage limit.";
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
  const spawned = () => runner.spawn.mock.calls.map(([o]) => o.taskId);
  return { orchestrator, sessions, spawn: runner.spawn, notifications, task, spawned };
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

describe('a pause with a known reset holds the run until it', () => {
  it('starts nothing, even on another runner, and resumes at the reset', async () => {
    const { orchestrator, sessions, spawned, task } = setup({ maxParallelSessions: 1 });
    orchestrator.loadPlan([
      createTask({ id: 't1', order: 1, title: 'Paused', prompt: 'do first' }),
      createTask({ id: 't2', order: 2, title: 'Next', prompt: 'do second', assignedRunner: 'codex' }),
    ], ['claude-code', 'codex']);
    await orchestrator.approveReview();
    hitLimitInTurn(sessions[0]);
    await until(() => task('t1').status === 'awaiting_user');
    await flushMicrotasks();

    expect(orchestrator.awaitsResume).toBe(true);
    expect(spawned()).toEqual(['t1']);

    await vi.advanceTimersByTimeAsync(Date.parse(RESUME_AT) - Date.now());
    await until(() => spawned().length === 2);
    expect(spawned()[1]).toBe('t1');
    expect(sessions[1].taskId).toBe('t1');
  });
});

describe('a task started on its own that pauses on a usage limit', () => {
  it('keeps its run open and sends no execution_complete or handoff', async () => {
    const events: string[] = [];
    const { orchestrator, sessions, task } = setup({ maxParallelSessions: 1 });
    orchestrator.subscribe({
      onExecutionComplete: () => events.push('complete'),
      onIsolationHandoff: () => events.push('handoff'),
    });
    orchestrator.loadPlan([createTask({ id: 't1', order: 1, title: 'Paused', prompt: 'do first' })]);
    await orchestrator.forceStartTask('t1');
    hitLimitInTurn(sessions[0]);
    await until(() => task('t1').status === 'awaiting_user');
    await flushMicrotasks();

    expect(task('t1').resumeAt).toBe(RESUME_AT);
    expect(orchestrator.runs.isOpen).toBe(true);
    expect(events).toEqual([]);
  });
});

describe('a pause with no reset time', () => {
  it('releases the hold, and another runner\'s task starts', async () => {
    const { orchestrator, sessions, spawned, task } = setup({ maxParallelSessions: 1 });
    orchestrator.loadPlan([
      createTask({ id: 't1', order: 1, title: 'Paused', prompt: 'do first' }),
      createTask({ id: 't2', order: 2, title: 'Next', prompt: 'do second', assignedRunner: 'codex' }),
    ], ['claude-code', 'codex']);
    await orchestrator.approveReview();
    hitLimitInTurn(sessions[0], LIMIT_NO_RESET);
    await until(() => task('t1').status === 'awaiting_user');
    await flushMicrotasks();

    expect(task('t1').resumeAt).toBeUndefined();
    expect(orchestrator.awaitsResume).toBe(false);
    expect(spawned()).toEqual(['t1', 't2']);
  });
});

describe('a hold another paused task still owes', () => {
  it('is not released by skipping a different paused task', async () => {
    const { orchestrator, sessions, spawned, task } = setup({ maxParallelSessions: 2 });
    orchestrator.loadPlan([
      createTask({ id: 't1', order: 1, title: 'Paused A', prompt: 'do first' }),
      createTask({ id: 't2', order: 2, title: 'Paused B', prompt: 'do second', assignedRunner: 'codex' }),
      createTask({ id: 't3', order: 3, title: 'Next', prompt: 'do third', assignedRunner: 'codex' }),
    ], ['claude-code', 'codex']);
    await orchestrator.approveReview();
    hitLimitInTurn(sessions[0]);
    await until(() => task('t1').status === 'awaiting_user');
    hitLimitInTurn(sessions[1]);
    await until(() => task('t2').status === 'awaiting_user');
    await flushMicrotasks();
    expect(orchestrator.awaitsResume).toBe(true);

    await orchestrator.skipTask('t2', 'not needed');

    expect(task('t1').resumeAt).toBe(RESUME_AT);
    expect(orchestrator.awaitsResume).toBe(true);
    expect(spawned()).toEqual(['t1', 't2']);
  });
});

describe('force-starting a paused task', () => {
  it('releases the hold once the task finishes', async () => {
    const { orchestrator, sessions, spawned, task } = setup({ maxParallelSessions: 1 });
    orchestrator.loadPlan([
      createTask({ id: 't1', order: 1, title: 'Paused', prompt: 'do first' }),
      createTask({ id: 't2', order: 2, title: 'Next', prompt: 'do second' }),
    ]);
    await orchestrator.approveReview();
    hitLimitInTurn(sessions[0]);
    await until(() => task('t1').status === 'awaiting_user');

    await orchestrator.forceStartTask('t1');
    await flushMicrotasks();
    expect(task('t1').status).toBe('in_progress');

    sessions.at(-1)!.reportComplete({ status: 'done', summary: '' });
    await until(() => task('t1').status === 'completed');
    await flushMicrotasks();

    expect(orchestrator.awaitsResume).toBe(false);
    expect(spawned()).toEqual(['t1', 't1', 't2']);
  });
});

describe('a planner edit that ends the last pause', () => {
  it('releases the hold when the paused task is removed', async () => {
    const { orchestrator, sessions, spawned, task } = setup({ maxParallelSessions: 1 });
    orchestrator.loadPlan([
      createTask({ id: 't1', order: 1, title: 'Paused', prompt: 'do first' }),
      createTask({ id: 't2', order: 2, title: 'Next', prompt: 'do second', assignedRunner: 'codex' }),
    ], ['claude-code', 'codex']);
    await orchestrator.approveReview();
    hitLimitInTurn(sessions[0]);
    await until(() => task('t1').status === 'awaiting_user');

    // What an edit_plan removing t1 lands through Session.
    orchestrator.reconcilePlan([
      createTask({ id: 't2', order: 1, title: 'Next', prompt: 'do second', assignedRunner: 'codex' }),
    ], ['claude-code', 'codex']);
    await orchestrator.tick();
    await flushMicrotasks();

    expect(orchestrator.awaitsResume).toBe(false);
    expect(spawned()).toEqual(['t1', 't2']);
  });

  it('releases the hold when the paused task is re-armed', async () => {
    const { orchestrator, sessions, spawned, task } = setup({ maxParallelSessions: 1 });
    orchestrator.loadPlan([
      createTask({ id: 't1', order: 1, title: 'Paused', prompt: 'do first' }),
      createTask({ id: 't2', order: 2, title: 'Next', prompt: 'do second' }),
    ]);
    await orchestrator.approveReview();
    hitLimitInTurn(sessions[0]);
    await until(() => task('t1').status === 'awaiting_user');

    const rearmed = applyTaskOps(orchestrator.storeInstance.snapshot(), [
      { op: 'rearm', taskId: 't1', changes: { prompt: 'do first, again' } },
    ], ['claude-code']);
    expect(rearmed.ok).toBe(true);
    if (!rearmed.ok) return;
    orchestrator.reconcilePlan([...rearmed.tasks], ['claude-code']);
    await orchestrator.tick();
    await flushMicrotasks();

    expect(task('t1').status).toBe('in_progress');
    expect(orchestrator.awaitsResume).toBe(false);
    expect(spawned()).toEqual(['t1', 't1']);
  });
});
