import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import { TaskOrchestrator } from '../TaskOrchestrator';
import { createTask, type Task } from '../../models/Task';
import { BufferedTaskOutputSource } from '../BufferedTaskOutputSource';
import { serializeTaskStatus } from '../SessionMessage';
import { RunnerRegistry } from '../../plugins/RunnerRegistry';
import { fakeConfig, FakeRunnerSession, flushMicrotasks } from '../../testing';
import { fakeNotification } from './sessionTestKit';
import type { IRunner, IRunnerSession } from '../../interfaces/IRunner';
import type { RunnerSpawnOptions } from '../AbstractRunner';

// Claude Code 2.1.296's wording (#84); the zone is UTC so the expected times
// do not depend on the machine's.
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
  });
  const waits: { taskId: string; runner: string; resumeAt: string | null }[] = [];
  orchestrator.subscribe({ onUsageLimitWait: (data) => waits.push(data) });
  const task = (id: string): Readonly<Task> => orchestrator.storeInstance.get(id)!;
  return { orchestrator, sessions, spawn: runner.spawn, notifications, waits, task };
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

describe('a task paused on a usage limit', () => {
  it('records the reason and the resume time, and says when it resumes', async () => {
    const { orchestrator, sessions, waits, task } = setup();
    orchestrator.loadPlan([createTask({ id: 't1', order: 1, title: 'Only', prompt: 'do it' })]);
    await orchestrator.forceStartTask('t1');

    hitLimitInTurn(sessions[0]);
    await until(() => task('t1').status === 'awaiting_user');

    expect(task('t1')).toMatchObject({ awaitingReason: 'usage-limit', resumeAt: RESUME_AT, runnerSessionId: 'native-1' });
    expect(waits).toEqual([{ taskId: 't1', runner: 'claude-code', resumeAt: RESUME_AT }]);
    expect(serializeTaskStatus(task('t1') as Task)).toMatchObject({ awaitingReason: 'usage-limit', resumeAt: RESUME_AT });
  });

  it('resumes at the reset, continuing its saved session, and releases the run it held', async () => {
    const { orchestrator, sessions, spawn, task } = setup({ maxParallelSessions: 1 });
    orchestrator.loadPlan([
      createTask({ id: 't1', order: 1, title: 'First', prompt: 'do first' }),
      createTask({ id: 't2', order: 2, title: 'Second', prompt: 'do second' }),
    ]);
    await orchestrator.approveReview();

    hitLimitInTurn(sessions[0]);
    await until(() => task('t1').status === 'awaiting_user');
    expect(orchestrator.status).toBe('approved');

    await vi.advanceTimersByTimeAsync(Date.parse(RESUME_AT) - Date.now() - 1000);
    expect(spawn).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1000);
    await until(() => spawn.mock.calls.length === 2);
    expect(spawn.mock.calls[1][0]).toMatchObject({ taskId: 't1', resumeSessionId: 'native-1' });
    expect(spawn.mock.calls[1][0].prompt).toContain('usage limit has reset');
    expect(task('t1').status).toBe('in_progress');
    expect(task('t1').resumeAt).toBeUndefined();
    expect(orchestrator.status).toBe('running');

    sessions[1].reportComplete({ status: 'done', summary: '' });
    await until(() => spawn.mock.calls.length === 3);
    expect(spawn.mock.calls[2][0].taskId).toBe('t2');
  });

  it('pauses the same way when the runner exits on the limit', async () => {
    const { orchestrator, sessions, spawn, task } = setup();
    orchestrator.loadPlan([createTask({ id: 't1', order: 1, title: 'Only', prompt: 'do it' })]);
    await orchestrator.forceStartTask('t1');

    sessions[0].emitOutput(LIMIT);
    sessions[0].emitExit(1);
    await until(() => task('t1').status === 'awaiting_user');
    expect(task('t1')).toMatchObject({ awaitingReason: 'usage-limit', resumeAt: RESUME_AT });

    await vi.advanceTimersByTimeAsync(Date.parse(RESUME_AT) - Date.now());
    await until(() => spawn.mock.calls.length === 2);
  });

  it('waits for a manual retry when the runner gave no reset time, as before', async () => {
    const { orchestrator, sessions, spawn, notifications, waits, task } = setup();
    orchestrator.loadPlan([createTask({ id: 't1', order: 1, title: 'Only', prompt: 'do it' })]);
    await orchestrator.forceStartTask('t1');

    hitLimitInTurn(sessions[0], 'Rate limit exceeded. Please try again later.');
    await until(() => task('t1').status === 'awaiting_user');

    expect(task('t1').awaitingReason).toBe('usage-limit');
    expect(task('t1').resumeAt).toBeUndefined();
    expect(waits).toEqual([{ taskId: 't1', runner: 'claude-code', resumeAt: null }]);
    expect(notifications.warn).toHaveBeenCalledWith('Task "Only" stopped before it reported completion: claude-code hit its usage limit. Retry it once the limit resets.');
    await vi.advanceTimersByTimeAsync(24 * 60 * 60_000);
    expect(spawn).toHaveBeenCalledTimes(1);
  });

  it('returns to the manual state when its resume is cancelled', async () => {
    const { orchestrator, sessions, spawn, waits, task } = setup();
    orchestrator.loadPlan([createTask({ id: 't1', order: 1, title: 'Only', prompt: 'do it' })]);
    await orchestrator.approveReview();
    hitLimitInTurn(sessions[0]);
    await until(() => task('t1').status === 'awaiting_user');

    expect(orchestrator.cancelScheduledResume('t1')).toBe(true);

    expect(task('t1')).toMatchObject({ status: 'awaiting_user', awaitingReason: 'usage-limit' });
    expect(task('t1').resumeAt).toBeUndefined();
    expect(waits.at(-1)).toEqual({ taskId: 't1', runner: 'claude-code', resumeAt: null, cancelled: true });
    expect(orchestrator.cancelScheduledResume('t1')).toBe(false);
    await vi.advanceTimersByTimeAsync(24 * 60 * 60_000);
    expect(spawn).toHaveBeenCalledTimes(1);

    await orchestrator.retryTask('t1');
    expect(spawn).toHaveBeenCalledTimes(2);
  });

  it('falls back to manual, and says so, when the resumed attempt hits the limit again at once', async () => {
    const { orchestrator, sessions, spawn, notifications, task } = setup();
    orchestrator.loadPlan([createTask({ id: 't1', order: 1, title: 'Only', prompt: 'do it' })]);
    await orchestrator.forceStartTask('t1');
    hitLimitInTurn(sessions[0]);
    await until(() => task('t1').status === 'awaiting_user');
    await vi.advanceTimersByTimeAsync(Date.parse(RESUME_AT) - Date.now());
    await until(() => spawn.mock.calls.length === 2);

    hitLimitInTurn(sessions[1], "You've hit your session limit · resets 1:10am (UTC)");
    await until(() => task('t1').status === 'awaiting_user');

    expect(task('t1').awaitingReason).toBe('usage-limit');
    expect(task('t1').resumeAt).toBeUndefined();
    expect(notifications.warn).toHaveBeenCalledWith(expect.stringContaining('hit its usage limit again right after it was resumed'));
    await vi.advanceTimersByTimeAsync(24 * 60 * 60_000);
    expect(spawn).toHaveBeenCalledTimes(2);
  });

  it('resumes again when a resumed attempt worked a while before the next limit', async () => {
    const { orchestrator, sessions, spawn, task } = setup();
    orchestrator.loadPlan([createTask({ id: 't1', order: 1, title: 'Only', prompt: 'do it' })]);
    await orchestrator.forceStartTask('t1');
    hitLimitInTurn(sessions[0]);
    await until(() => task('t1').status === 'awaiting_user');
    await vi.advanceTimersByTimeAsync(Date.parse(RESUME_AT) - Date.now());
    await until(() => spawn.mock.calls.length === 2);

    await vi.advanceTimersByTimeAsync(2 * 60 * 60_000);
    hitLimitInTurn(sessions[1], "You've hit your session limit · resets 3:10am (UTC)");
    await until(() => task('t1').status === 'awaiting_user');

    expect(task('t1').resumeAt).toBe('2026-10-12T03:11:00.000Z');
  });

  it('shares one wait per runner: tasks paused on it resume together, at the later reset', async () => {
    const { orchestrator, sessions, spawn, task } = setup();
    orchestrator.loadPlan([
      createTask({ id: 't1', order: 1, title: 'First', prompt: 'do first' }),
      createTask({ id: 't2', order: 2, title: 'Second', prompt: 'do second' }),
    ]);
    await orchestrator.approveReview();
    expect(spawn).toHaveBeenCalledTimes(2);

    hitLimitInTurn(sessions[0]);
    await until(() => task('t1').status === 'awaiting_user');
    hitLimitInTurn(sessions[1], "You've hit your weekly limit · resets 8:40pm (UTC)");
    await until(() => task('t2').status === 'awaiting_user');

    const shared = '2026-10-11T20:41:00.000Z';
    expect(task('t1').resumeAt).toBe(shared);
    expect(task('t2').resumeAt).toBe(shared);

    await vi.advanceTimersByTimeAsync(Date.parse(RESUME_AT) - Date.now());
    expect(spawn).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(Date.parse(shared) - Date.now());
    await until(() => spawn.mock.calls.length === 4);
    expect(spawn.mock.calls.slice(2).map(([o]) => [o.taskId, o.resumeSessionId])).toEqual([['t1', 'native-1'], ['t2', 'native-2']]);
  });

  it('a stop cancels the resume: the task waits for the user', async () => {
    const { orchestrator, sessions, spawn, task } = setup();
    orchestrator.loadPlan([createTask({ id: 't1', order: 1, title: 'Only', prompt: 'do it' })]);
    await orchestrator.approveReview();
    hitLimitInTurn(sessions[0]);
    await until(() => task('t1').status === 'awaiting_user');

    orchestrator.stop();

    expect(task('t1')).toMatchObject({ status: 'awaiting_user', awaitingReason: 'usage-limit' });
    expect(task('t1').resumeAt).toBeUndefined();
    await vi.advanceTimersByTimeAsync(24 * 60 * 60_000);
    expect(spawn).toHaveBeenCalledTimes(1);
  });

  it('awaits the resumed attempt\'s start when restarting the run throws, instead of leaving it unhandled', async () => {
    const sessions: FakeRunnerSession[] = [];
    let boom = false;
    const runner = {
      spawn: vi.fn(async (o: RunnerSpawnOptions): Promise<IRunnerSession> => {
        if (boom) throw new Error('spawn boom');
        const session = new FakeRunnerSession(`s${sessions.length + 1}`, o.taskId, `native-${sessions.length + 1}`);
        sessions.push(session);
        return session;
      }),
      stop: vi.fn(),
      stopAll: vi.fn(),
      activeCount: 0,
    } satisfies IRunner;
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown): void => { unhandled.push(reason); };
    process.on('unhandledRejection', onUnhandled);
    try {
      const orchestrator = TaskOrchestrator.compose({
        config: fakeConfig(),
        notifications: fakeNotification(),
        runner,
        output: new BufferedTaskOutputSource(),
        registry: new RunnerRegistry(),
        workspaceRoot: () => '/repo',
        workspaceEnv: async () => ({ env: {}, blockedEnvrc: null, refused: [], trackedEnvFile: null }),
        runSettings: () => { if (boom) throw new Error('settings boom'); return { mergeAtGatesAutomatically: false }; },
      });
      orchestrator.loadPlan([createTask({ id: 't1', order: 1, title: 'Only', prompt: 'do it' })]);
      await orchestrator.approveReview();
      hitLimitInTurn(sessions[0]);
      await until(() => orchestrator.storeInstance.get('t1')!.status === 'awaiting_user');
      expect(orchestrator.isHaltedByFailure).toBe(true);

      boom = true;
      await vi.advanceTimersByTimeAsync(Date.parse(RESUME_AT) - Date.now());
      await flushMicrotasks(50);
      expect(unhandled).toEqual([]);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });
});

describe('a plan loaded with a task still waiting on a usage limit', () => {
  const waiting = (resumeAt: string): Task => ({
    ...createTask({ id: 't1', order: 1, title: 'Only', prompt: 'do it' }),
    status: 'awaiting_user',
    awaitingReason: 'usage-limit',
    resumeAt,
    runnerSessionId: 'native-saved',
  });

  it('resumes at once when the reset passed while nothing was running', async () => {
    const { orchestrator, spawn, task } = setup();

    orchestrator.loadPlan([waiting('2026-10-11T09:00:00.000Z')]);
    await vi.advanceTimersByTimeAsync(0);
    await until(() => spawn.mock.calls.length === 1);

    expect(spawn.mock.calls[0][0]).toMatchObject({ taskId: 't1', resumeSessionId: 'native-saved' });
    expect(task('t1').status).toBe('in_progress');
  });

  it('waits again for a reset still to come', async () => {
    const { orchestrator, spawn } = setup();

    orchestrator.loadPlan([waiting(RESUME_AT)]);
    await vi.advanceTimersByTimeAsync(Date.parse(RESUME_AT) - Date.now() - 1000);
    expect(spawn).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1000);
    await until(() => spawn.mock.calls.length === 1);
  });

  it('does not resume one whose resume was cancelled', async () => {
    const { orchestrator, spawn } = setup();
    const manual = waiting(RESUME_AT);
    delete manual.resumeAt;

    orchestrator.loadPlan([manual]);
    await vi.advanceTimersByTimeAsync(24 * 60 * 60_000);

    expect(spawn).not.toHaveBeenCalled();
  });
});
