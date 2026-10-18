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
 * Adversarial, round two: the hold a usage-limit pause puts on a run is
 * released "once nothing waits on a reset" (CONTEXT.md, ADR-0018 U1) however
 * the last wait goes — the fix for the first round covered Mark complete,
 * Don't resume and a direct removal. The neighbouring ways a wait can go:
 * a planner edit removing the task (which lands through `reconcilePlan`, not
 * `releaseTask`), a move to another runner, a skip, a Stop, and one of two
 * paused tasks going away while the other still waits.
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

describe('adversarial: a held run released by the ways a wait goes besides Mark complete and Don\'t resume', () => {
  // ADVERSARIAL FINDING (held-run): a planner edit that removes the last task paused on a usage limit
  // releases nothing — `reconcilePlan` (TaskOrchestrator.ts:986) adopts the edited list without
  // `dropResume`/`releaseHold`, and the planner turn's end only ticks when the scheduler is running or a
  // start is pending (`resumeStarts`, createSession.ts:597), which a held run is not. The run sits held
  // with nothing waiting on a reset, contradicting ADR-0018 U1: "the hold on the run is released once
  // nothing else waits on a reset … the task marked complete, its resume cancelled, or the task leaving
  // the plan". The direct editor path (`releaseTask`) is fixed; the planner path is not.
  // Expected: `awaitsResume` false and the rest of the plan starts once the edit lands.
  it.skip('goes on when a planner edit removes the last paused task, as reconcilePlan lands it', async () => {
    const { orchestrator, sessions, spawn, task } = setup({ maxParallelSessions: 1 });
    orchestrator.loadPlan([
      createTask({ id: 't1', order: 1, title: 'Paused', prompt: 'do first' }),
      createTask({ id: 't2', order: 2, title: 'Next', prompt: 'do second' }),
    ]);
    await orchestrator.approveReview();
    hitLimitInTurn(sessions[0]);
    await until(() => task('t1').status === 'awaiting_user');
    expect(orchestrator.awaitsResume).toBe(true);

    // What a planner remove op does: the edited task list is reconciled over
    // the running plan (`adoptPlannerTasks`), which never calls `releaseTask`.
    orchestrator.reconcilePlan([{ ...task('t2') }]);
    await orchestrator.tick();

    expect(orchestrator.awaitsResume).toBe(false);
    await until(() => spawn.mock.calls.length === 2);
    expect(spawn.mock.calls[1][0].taskId).toBe('t2');
  });

  it('goes on when an edit moves the paused task to another runner', async () => {
    const { orchestrator, sessions, spawn, task } = setup({ maxParallelSessions: 1 });
    orchestrator.loadPlan([
      createTask({ id: 't1', order: 1, title: 'Paused', prompt: 'do first' }),
      createTask({ id: 't2', order: 2, title: 'Next', prompt: 'do second', assignedRunner: 'codex' }),
    ], ['claude-code', 'codex']);
    await orchestrator.approveReview();
    hitLimitInTurn(sessions[0]);
    await until(() => task('t1').status === 'awaiting_user');

    // What PlanEditor.updateTask does around the store write: the move routes
    // the task around the limit, so the paused task itself carries on (U1).
    const released = orchestrator.releaseMovedResume('t1', { assignedRunner: 'codex' });
    orchestrator.storeInstance.update('t1', released);

    await orchestrator.tick();

    expect(orchestrator.awaitsResume).toBe(false);
    await until(() => spawn.mock.calls.length === 2);
    // The move routes the paused task around the limit; its carry-over starts on the new runner.
    expect(spawn.mock.calls[1][0].taskId).toBe('t1');
  });

  it('goes on when the last paused task is skipped', async () => {
    const { orchestrator, sessions, spawn, task } = setup({ maxParallelSessions: 1 });
    orchestrator.loadPlan([
      createTask({ id: 't1', order: 1, title: 'Paused', prompt: 'do first' }),
      createTask({ id: 't2', order: 2, title: 'Next', prompt: 'do second' }),
    ]);
    await orchestrator.approveReview();
    hitLimitInTurn(sessions[0]);
    await until(() => task('t1').status === 'awaiting_user');

    await orchestrator.skipTask('t1');

    expect(orchestrator.awaitsResume).toBe(false);
    await until(() => spawn.mock.calls.length === 2);
    expect(spawn.mock.calls[1][0].taskId).toBe('t2');
  });

  it('stays held while a second task on the same runner still waits, and goes on once it goes too', async () => {
    const { orchestrator, sessions, spawn, task } = setup({ maxParallelSessions: 2 });
    orchestrator.loadPlan([
      createTask({ id: 't1', order: 1, title: 'Paused one', prompt: 'do first' }),
      createTask({ id: 't2', order: 2, title: 'Paused two', prompt: 'do second' }),
      createTask({ id: 't3', order: 3, title: 'Next', prompt: 'do third', assignedRunner: 'codex' }),
    ], ['claude-code', 'codex']);
    await orchestrator.approveReview();
    hitLimitInTurn(sessions[0]);
    hitLimitInTurn(sessions[1]);
    await until(() => task('t1').status === 'awaiting_user' && task('t2').status === 'awaiting_user');
    expect(task('t1').resumeAt).toBe(task('t2').resumeAt);

    const first = await orchestrator.cancelScheduledResume('t1');

    expect(first).toBe(true);
    expect(orchestrator.awaitsResume).toBe(true);
    await flushMicrotasks();
    expect(spawn).toHaveBeenCalledTimes(2);

    await orchestrator.cancelScheduledResume('t2');

    expect(orchestrator.awaitsResume).toBe(false);
    await until(() => spawn.mock.calls.length === 3);
    expect(spawn.mock.calls[2][0].taskId).toBe('t3');
  });

  it('a Stop while held cancels every resume, and nothing resumes at the old reset time', async () => {
    const { orchestrator, sessions, spawn, task } = setup({ maxParallelSessions: 1 });
    orchestrator.loadPlan([
      createTask({ id: 't1', order: 1, title: 'Paused', prompt: 'do first' }),
      createTask({ id: 't2', order: 2, title: 'Next', prompt: 'do second' }),
    ]);
    await orchestrator.approveReview();
    hitLimitInTurn(sessions[0]);
    await until(() => task('t1').status === 'awaiting_user');

    orchestrator.stop();
    expect(orchestrator.awaitsResume).toBe(false);
    expect(task('t1').resumeAt).toBeUndefined();

    await vi.advanceTimersByTimeAsync(Date.parse(RESUME_AT) - Date.now());
    await orchestrator.tick();
    expect(spawn).toHaveBeenCalledTimes(1);
  });
});
