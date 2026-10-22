import { describe, it, expect, vi } from 'vitest';
import { TaskOrchestrator } from '../TaskOrchestrator';
import { applyTaskOps } from '../TaskOps';
import { createTask, type Task } from '../../models/Task';
import type { TaskLoop } from '../../models/Loop';
import type { IRunner, ScriptExit } from '../../interfaces/IRunner';
import type { TaskCompleteArgs } from '../mcp/tools';
import { fakeConfig, FakeRunnerSession, FakeWorktreeIsolation } from '../../testing';
import { fakeNotification } from './sessionTestKit';
import { BufferedTaskOutputSource } from '../BufferedTaskOutputSource';
import { waitOf } from '../readiness';

/**
 * A loop in the scheduler (ADR-0045): a check that repeats with its fix
 * until it passes, with no planner turn between the rounds.
 */

function recording() {
  const sessions: FakeRunnerSession[] = [];
  const spawn = vi.fn(async (opts: Parameters<IRunner['spawn']>[0]) => {
    const session = new FakeRunnerSession(`s${sessions.length + 1}`, opts.taskId);
    sessions.push(session);
    return session;
  });
  return { runner: { spawn, stop: vi.fn(async () => {}), stopAll: vi.fn(), activeCount: 0 } satisfies IRunner, sessions, spawn };
}

function setup(tasks: Task[], opts: { isolation?: FakeWorktreeIsolation } = {}) {
  const agents = recording();
  const scripts = recording();
  const notifications = fakeNotification();
  const orchestrator = TaskOrchestrator.compose({
    config: fakeConfig({ worktreeIsolation: !!opts.isolation }),
    notifications,
    runner: agents.runner,
    scriptRunner: scripts.runner,
    output: new BufferedTaskOutputSource(),
    ...(opts.isolation ? { isolation: opts.isolation } : {}),
    workspaceRoot: () => '/repo',
    workspaceEnv: async () => ({ env: {}, blockedEnvrc: null, refused: [], trackedEnvFile: null }),
  });
  const executionComplete = vi.fn();
  const settled: string[] = [];
  orchestrator.subscribe({ onExecutionComplete: executionComplete, onTaskSettled: ({ taskId }) => settled.push(taskId) });
  orchestrator.loadPlan(tasks);
  const all = () => [...agents.spawn.mock.calls, ...scripts.spawn.mock.calls].map(([o]) => o);
  const spawns = (taskId: string) => all().filter((o) => o.taskId === taskId);
  const latest = (taskId: string) => [...agents.sessions, ...scripts.sessions].filter((s) => s.taskId === taskId).at(-1)!;
  const get = (taskId: string) => orchestrator.storeInstance.get(taskId)!;
  /** The task's `n`th attempt reports through `task_complete`, and its verdict lands. */
  const report = async (taskId: string, n: number, args: TaskCompleteArgs, settles: Task['status']) => {
    await vi.waitFor(() => expect(spawns(taskId)).toHaveLength(n));
    latest(taskId).reportComplete(args);
    await vi.waitFor(() => expect(get(taskId).status).toBe(settles));
  };
  const pass = (taskId: string, n = 1) => report(taskId, n, { status: 'done', summary: `${taskId} done` }, 'completed');
  const fail = (taskId: string, n = 1, summary = `${taskId} found problems`) => report(taskId, n, { status: 'failed', summary, reason: summary }, 'failed');
  const exit = async (taskId: string, n: number, result: ScriptExit, settles: Task['status']) => {
    await vi.waitFor(() => expect(spawns(taskId)).toHaveLength(n));
    latest(taskId).reportScriptExit(result);
    latest(taskId).emitExit(result.outcome === 'passed' ? 0 : 1);
    await vi.waitFor(() => expect(get(taskId).status).toBe(settles));
  };
  return { orchestrator, notifications, executionComplete, settled, spawns, latest, get, pass, fail, report, exit };
}

const task = (id: string, order: number, dependencies: string[] = [], over: Partial<Task> = {}): Task =>
  createTask({ id, order, title: `Task ${id}`, prompt: `do ${id}`, dependencies, ...over });

const loop = (body: string[], maxRounds = 3): TaskLoop => ({ body, maxRounds });

/** build → review (the check, its body: fix) → ship. */
const reviewed = (maxRounds = 3, check: Partial<Task> = {}): Task[] => [
  task('build', 1),
  task('review', 2, ['build'], { loop: loop(['fix'], maxRounds), ...check }),
  task('fix', 3, ['review']),
  task('ship', 4, ['review']),
];

describe('a loop: a check that repeats with its fix until it passes (ADR-0045)', () => {
  it('skips the body as not needed when the check passes in round 1, and its dependents go on', async () => {
    const h = setup(reviewed());
    await h.orchestrator.approveReview();

    await h.pass('build');
    expect(waitOf(h.orchestrator.startWaits(h.get('fix')), 'loop-check')).toEqual({ kind: 'loop-check', check: 'review' });
    await h.pass('review');
    await h.pass('ship');

    await vi.waitFor(() => expect(h.executionComplete).toHaveBeenCalled());
    expect(h.spawns('fix')).toHaveLength(0);
    expect(h.get('fix')).toMatchObject({ status: 'skipped', skipReason: 'not needed: its check passed' });
  });

  it('queues a force start of a body task behind its check, as behind any dependency under way', async () => {
    const h = setup(reviewed());
    await h.orchestrator.approveReview();
    await vi.waitFor(() => expect(h.spawns('build')).toHaveLength(1));

    const queued = await h.orchestrator.forceStartTask('fix');

    expect(queued).toContain('starts once task "Task review" finishes');
    expect(h.spawns('fix')).toHaveLength(0);
  });

  it('runs the body with the check\'s report when it fails, then runs the check again as round 2', async () => {
    const h = setup(reviewed());
    await h.orchestrator.approveReview();
    await h.pass('build');

    await h.fail('review', 1, 'The parser drops trailing commas.');

    // Between rounds the check is no failure: its dependent waits for it, unblocked.
    expect(h.orchestrator.getBlockedBy('ship')).toEqual([]);
    expect(waitOf(h.orchestrator.startWaits(h.get('review')), 'repeating')).toEqual({ kind: 'repeating', round: 2, maxRounds: 3, waiting: ['fix'] });
    expect(h.settled).toContain('review');
    await vi.waitFor(() => expect(h.spawns('fix')).toHaveLength(1));
    expect(h.spawns('fix')[0].prompt).toContain('The parser drops trailing commas.');
    expect(h.spawns('fix')[0].prompt).toContain('it failed round 1 of 3');

    await h.pass('fix');
    await vi.waitFor(() => expect(h.spawns('review')).toHaveLength(2));
    expect(h.get('review')).toMatchObject({ status: 'in_progress', loopRound: 2 });
    expect(h.get('review').verdict).toBeUndefined();
    expect(h.spawns('ship')).toHaveLength(0);

    await h.pass('review', 2);
    await h.pass('ship');
    await vi.waitFor(() => expect(h.executionComplete).toHaveBeenCalled());
    expect(h.get('fix').status).toBe('completed');
  });

  it('gives each round\'s body the check\'s latest report', async () => {
    const h = setup(reviewed());
    await h.orchestrator.approveReview();
    await h.pass('build');
    await h.fail('review', 1, 'First finding.');
    await h.pass('fix');

    await h.fail('review', 2, 'Second finding.');

    await vi.waitFor(() => expect(h.spawns('fix')).toHaveLength(2));
    expect(h.spawns('fix')[1].prompt).toContain('Second finding.');
    expect(h.spawns('fix')[1].prompt).not.toContain('First finding.');
    expect(h.spawns('fix')[1].prompt).toContain('it failed round 2 of 3');
  });

  it('fails the check once it is out of rounds, blocks its dependents and says how many rounds it ran', async () => {
    const h = setup(reviewed(2));
    await h.orchestrator.approveReview();
    await h.pass('build');
    await h.fail('review', 1);
    await h.pass('fix');

    await h.fail('review', 2, 'Still broken.');

    await vi.waitFor(() => expect(h.executionComplete).toHaveBeenCalled());
    expect(h.get('review')).toMatchObject({ status: 'failed', loopRound: 2 });
    expect(h.orchestrator.getBlockedBy('ship')).toEqual(['review']);
    expect(h.spawns('fix')).toHaveLength(1);
    expect(h.notifications.error).toHaveBeenCalledWith(expect.stringContaining('failed in all 2 rounds of its loop'));
  });

  it('skips the body that never ran once the loop is out of rounds', async () => {
    const h = setup(reviewed(1));
    await h.orchestrator.approveReview();
    await h.pass('build');

    await h.fail('review');

    await vi.waitFor(() => expect(h.executionComplete).toHaveBeenCalled());
    expect(h.spawns('fix')).toHaveLength(0);
    expect(h.get('fix')).toMatchObject({ status: 'skipped', skipReason: 'not run: the loop ran out of rounds' });
    expect(h.orchestrator.getBlockedBy('ship')).toEqual(['review']);
  });

  it('closes a loop an edit leaves out of rounds, and settles its check once more', async () => {
    const h = setup(reviewed());
    await h.orchestrator.approveReview();
    await h.pass('build');
    await h.fail('review', 1, 'Found it.');
    await vi.waitFor(() => expect(h.spawns('fix')).toHaveLength(1));

    // An edit adds a body task and lowers maxRounds to the round in progress:
    // the check is now out of rounds with its body still unrun (L6).
    const edited = applyTaskOps(h.orchestrator.storeInstance.snapshot(), [
      { op: 'add', task: { title: 'Fix again', description: 'again', prompt: 'again', dependencies: ['review'], sliceType: 'AFK', autonomy: 'AFK' }, handle: 'f2' },
      { op: 'update', taskId: 'review', changes: { loop: { body: ['fix', 'f2'], maxRounds: 1 } } as Partial<Task> },
    ], ['claude-code']);
    expect(edited.ok).toBe(true);
    const again = edited.handles!.get('f2')!;
    h.orchestrator.reconcilePlan(edited.tasks, ['claude-code']);

    expect(h.get(again)).toMatchObject({ status: 'skipped', skipReason: 'not run: the loop ran out of rounds' });
    // The round-1 settle, and the one that says the loop ended.
    expect(h.settled.filter((id) => id === 'review')).toHaveLength(2);

    await h.pass('fix');
    await vi.waitFor(() => expect(h.executionComplete).toHaveBeenCalled());
    expect(h.spawns('review')).toHaveLength(1);
    expect(h.get('fix').status).toBe('completed');
    expect(h.orchestrator.getBlockedBy('ship')).toEqual(['review']);
  });

  it('starts no round on a check that reports blocked: it could not run, and it fails as any task does', async () => {
    const h = setup(reviewed());
    await h.orchestrator.approveReview();
    await h.pass('build');

    await h.report('review', 1, { status: 'blocked', summary: '', reason: 'no test database' }, 'failed');

    await vi.waitFor(() => expect(h.executionComplete).toHaveBeenCalled());
    expect(h.get('review').verdict?.reported).toBe('blocked');
    expect(h.spawns('fix')).toHaveLength(0);
    expect(h.orchestrator.getBlockedBy('fix')).toEqual(['review']);
    expect(h.orchestrator.getBlockedBy('ship')).toEqual(['review']);
  });

  it('starts no round on a runner that exits without reporting', async () => {
    const h = setup(reviewed());
    await h.orchestrator.approveReview();
    await h.pass('build');
    await vi.waitFor(() => expect(h.spawns('review')).toHaveLength(1));

    h.latest('review').emitExit(0);

    await vi.waitFor(() => expect(h.get('review').status).toBe('failed'));
    expect(h.get('review').verdict?.reported).toBeUndefined();
    expect(h.spawns('fix')).toHaveLength(0);
    expect(h.orchestrator.getBlockedBy('ship')).toEqual(['review']);
  });

  it('stops the loop on a failing body task, and resumes it where it stopped when that task is retried and passes', async () => {
    const h = setup(reviewed());
    await h.orchestrator.approveReview();
    await h.pass('build');
    await h.fail('review', 1);

    await h.fail('fix');

    await vi.waitFor(() => expect(h.executionComplete).toHaveBeenCalled());
    expect(h.get('review').status).toBe('failed');
    expect(h.orchestrator.getBlockedBy('ship')).toEqual(['review']);
    expect(h.spawns('review')).toHaveLength(1);

    await h.orchestrator.retryTask('fix');
    await h.pass('fix', 2);

    await vi.waitFor(() => expect(h.spawns('review')).toHaveLength(2));
    expect(h.get('review').loopRound).toBe(2);
    await h.pass('review', 2);
    await h.pass('ship');
  });

  it('stops the loop when the user skips a body task, while the rest of the round finishes', async () => {
    const h = setup([
      task('review', 1, [], { loop: loop(['fix', 'retest']) }),
      task('fix', 2, ['review']),
      task('retest', 3, ['review', 'fix']),
      task('ship', 4, ['review']),
    ]);
    await h.orchestrator.approveReview();
    await h.fail('review');
    await vi.waitFor(() => expect(h.spawns('fix')).toHaveLength(1));

    await h.orchestrator.skipTask('retest', 'not worth it');
    await h.pass('fix');

    await vi.waitFor(() => expect(h.executionComplete).toHaveBeenCalled());
    expect(h.spawns('review')).toHaveLength(1);
    expect(h.orchestrator.getBlockedBy('ship')).toEqual(['review']);
  });

  it('runs a script task as the check, a failing exit starting a round and a step that never started starting none', async () => {
    const commands = [['npm', 'test']];
    const h = setup([
      task('tests', 1, [], { type: 'script', commands, prompt: undefined, taskMode: undefined, loop: loop(['fix']) }),
      task('fix', 2, ['tests']),
    ]);
    await h.orchestrator.approveReview();

    await h.exit('tests', 1, { outcome: 'failed', command: 'npm test', status: { code: 1, signal: null }, errorTail: '2 failing: parser' }, 'failed');

    await vi.waitFor(() => expect(h.spawns('fix')).toHaveLength(1));
    expect(h.get('tests').verdict?.reported).toBe('failed');
    expect(h.spawns('fix')[0].prompt).toContain('2 failing: parser');
    await h.pass('fix');

    await h.exit('tests', 2, { outcome: 'failed', command: 'npm test', status: { code: null, signal: null, error: 'spawn npm ENOENT' }, errorTail: '' }, 'failed');

    await vi.waitFor(() => expect(h.executionComplete).toHaveBeenCalled());
    expect(h.get('tests').verdict?.reported).toBe('blocked');
    expect(h.spawns('fix')).toHaveLength(1);
  });

  it('counts a script check that runs out of time as a failed round', async () => {
    const h = setup([
      task('tests', 1, [], { type: 'script', commands: [['npm', 'test']], prompt: undefined, taskMode: undefined, loop: loop(['fix']) }),
      task('fix', 2, ['tests']),
    ]);
    await h.orchestrator.approveReview();

    await h.exit('tests', 1, { outcome: 'timed-out', command: 'npm test', timeoutMs: 600_000, errorTail: '' }, 'failed');

    await vi.waitFor(() => expect(h.spawns('fix')).toHaveLength(1));
    await h.pass('fix');
    await h.exit('tests', 2, { outcome: 'passed' }, 'completed');
    expect(h.get('tests').loopRound).toBe(2);
  });

  it('resumes a reloaded plan mid-round at the same round: the body runs, then the check, never the check first', async () => {
    const first = setup(reviewed());
    await first.orchestrator.approveReview();
    await first.pass('build');
    await first.fail('review', 1, 'Found it.');
    await vi.waitFor(() => expect(first.spawns('fix')).toHaveLength(1));
    const saved = first.orchestrator.storeInstance.snapshot();
    first.orchestrator.stop();

    const h = setup(saved);
    expect(h.get('review')).toMatchObject({ status: 'failed' });
    await h.orchestrator.approveReview();

    await h.pass('fix');
    expect(h.spawns('fix')[0].prompt).toContain('Found it.');
    await vi.waitFor(() => expect(h.spawns('review')).toHaveLength(1));
    expect(h.get('review').loopRound).toBe(2);
  });

  it('counts the rounds on from where a reloaded check was when it was stopped mid-run', async () => {
    const first = setup(reviewed(2));
    await first.orchestrator.approveReview();
    await first.pass('build');
    await first.fail('review', 1);
    await first.pass('fix');
    await vi.waitFor(() => expect(first.spawns('review')).toHaveLength(2));
    const saved = first.orchestrator.storeInstance.snapshot();
    first.orchestrator.stop();

    const h = setup(saved);
    await h.orchestrator.approveReview();
    await h.fail('review', 1);

    // Round 2 of 2 failed: out of rounds, with no fix run for it.
    await vi.waitFor(() => expect(h.executionComplete).toHaveBeenCalled());
    expect(h.get('review')).toMatchObject({ status: 'failed', loopRound: 2 });
    expect(h.spawns('fix')).toHaveLength(0);
  });

  it('starts a new set of rounds when a check that ran out of rounds is retried', async () => {
    const h = setup(reviewed(1));
    await h.orchestrator.approveReview();
    await h.pass('build');
    await h.fail('review');
    await vi.waitFor(() => expect(h.executionComplete).toHaveBeenCalled());

    await h.orchestrator.retryTask('review');
    expect(h.get('review').loopRound).toBeUndefined();
    await h.pass('review', 2);
    await h.pass('ship');
  });

  it('queues a force start of a check\'s dependent between rounds behind the check, as behind work under way', async () => {
    const h = setup(reviewed());
    await h.orchestrator.approveReview();
    await h.pass('build');
    await h.fail('review', 1);
    await vi.waitFor(() => expect(h.spawns('fix')).toHaveLength(1));

    const queued = await h.orchestrator.forceStartTask('ship');

    expect(queued).toContain('starts once task "Task review" finishes');
    expect(h.spawns('ship')).toHaveLength(0);
    await h.pass('fix');
    await h.pass('review', 2);
    await h.pass('ship');
  });

  it('keeps the user\'s skip of a body task made before the check fails: the loop is stopped, and the fix does not run', async () => {
    const h = setup(reviewed());
    await h.orchestrator.approveReview();
    await h.pass('build');
    await vi.waitFor(() => expect(h.spawns('review')).toHaveLength(1));
    await h.orchestrator.skipTask('fix', 'not needed');

    await h.fail('review', 1);

    await vi.waitFor(() => expect(h.executionComplete).toHaveBeenCalled());
    expect(h.spawns('fix')).toHaveLength(0);
    expect(h.get('fix')).toMatchObject({ status: 'skipped', skipReason: 'not needed' });
    expect(h.orchestrator.getBlockedBy('ship')).toEqual(['review']);
    expect(h.notifications.error).toHaveBeenCalledWith(expect.stringContaining('Task "Task review" failed verification'));
  });

  it('runs the body skipped by a loop that closed again when a retried check fails', async () => {
    const h = setup(reviewed());
    await h.orchestrator.approveReview();
    await h.pass('build');
    await h.pass('review');
    expect(h.get('fix')).toMatchObject({ status: 'skipped', skipReason: 'not needed: its check passed' });
    await h.pass('ship');
    await vi.waitFor(() => expect(h.executionComplete).toHaveBeenCalled());

    await h.orchestrator.retryTask('review');
    await h.orchestrator.start();
    await h.fail('review', 2);

    await vi.waitFor(() => expect(h.spawns('fix')).toHaveLength(1));
  });

  it.each([
    ['retried', (h: ReturnType<typeof setup>) => h.orchestrator.retryTask('review')],
    ['force-started', (h: ReturnType<typeof setup>) => h.orchestrator.forceStartTask('review')],
  ])('runs a check %s mid-round only once the body at work has finished and landed', async (_, restart) => {
    const h = setup(reviewed());
    await h.orchestrator.approveReview();
    await h.pass('build');
    await h.fail('review', 1);
    await vi.waitFor(() => expect(h.spawns('fix')).toHaveLength(1));

    await restart(h);
    await new Promise((resolve) => setImmediate(resolve));
    expect(h.spawns('review')).toHaveLength(1);

    await h.pass('fix');
    await vi.waitFor(() => expect(h.spawns('review')).toHaveLength(2));
    // Its rounds start over (L7): this is round 1 of a new set, not the loop's round 2.
    expect(h.get('review').loopRound).toBeUndefined();
    await h.pass('review', 2);
    await h.pass('ship');
    await vi.waitFor(() => expect(h.executionComplete).toHaveBeenCalled());
    expect(h.spawns('fix')).toHaveLength(1);
  });

  it('runs the check again only once its body has landed on the integration branch', async () => {
    const isolation = new FakeWorktreeIsolation();
    const h = setup(reviewed(), { isolation });
    await h.orchestrator.approveReview();
    await h.pass('build');
    await h.fail('review');
    const release = isolation.holdIntegration('fix');
    await vi.waitFor(() => expect(h.spawns('fix')).toHaveLength(1));

    h.latest('fix').reportComplete({ status: 'done', summary: 'fixed' });
    await vi.waitFor(() => expect(isolation.taskIdsFor('integrate')).toContain('fix'));
    await new Promise((resolve) => setImmediate(resolve));
    expect(h.spawns('review')).toHaveLength(1);

    release();
    await vi.waitFor(() => expect(h.spawns('review')).toHaveLength(2));
    expect(h.orchestrator.runs.openRecord('fix')?.status).toBe('merged');
  });
});
