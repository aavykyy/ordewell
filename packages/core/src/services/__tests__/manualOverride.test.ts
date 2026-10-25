import { describe, it, expect, vi } from 'vitest';
import { makeSession, FakeRunnerSession, taskOf, fakeConfig, testWorkspace } from './sessionTestKit';
import { createTask, type LegacyPlanState, type Task } from '../../models/Task';
import { FakeWorktreeIsolation } from '../../testing';
import type { IRunner } from '../../interfaces/IRunner';
import type { ExecutionActor } from '../../models/Execution';
import type { ExecutionCommand } from '../ExecutionCommands';
import { hitLimit, until } from './supervisorTestKit';

/**
 * Mark complete and Mark not done on an AI or script task are a recovery
 * action (ADR-0029): refused while anything could still advance the task on
 * its own, and confirmed in both directions once the run is stopped. A manual
 * task's sign-off is the user's own work and is never held up by a run.
 */

const USER: ExecutionActor = { kind: 'user' };

function runner() {
  const sessions: FakeRunnerSession[] = [];
  const spawn = vi.fn(async (opts: Parameters<IRunner['spawn']>[0]) => {
    const session = new FakeRunnerSession(`s${sessions.length + 1}`, opts.taskId);
    sessions.push(session);
    return session;
  });
  return { sessions, spawn, runner: { spawn, stop: vi.fn(), stopAll: vi.fn(), activeCount: 0 } as IRunner };
}

const task = (id: string, order: number, over: Partial<Task> = {}) =>
  createTask({ id, order, title: `Task ${id}`, prompt: `do ${id}`, assignedRunner: 'claude-code', taskMode: 'acceptEdits', ...over });

function plan(tasks: Task[]): LegacyPlanState {
  const now = new Date().toISOString();
  return { tasks, generatedAt: now, status: 'approved', runners: ['claude-code'], lastUpdated: now };
}

function setup(opts: { isolation?: FakeWorktreeIsolation } = {}) {
  const r = runner();
  const session = makeSession({ runner: r.runner, scriptRunner: r.runner, isolation: opts.isolation, config: fakeConfig({ autonomousMode: true, maxParallelSessions: 3 }) });
  const latest = (taskId: string) => r.sessions.filter((s) => s.taskId === taskId).at(-1)!;
  const run = (command: ExecutionCommand, actor: ExecutionActor = USER) => session.execute(command, actor);
  const load = (tasks: Task[]) => session.loadPlan(plan(tasks), 'goal', testWorkspace, { persist: false });
  const status = (id: string) => taskOf(session, id)!.status;
  return { session, run, load, latest, status, ...r };
}

const complete = (taskRef: string, extra: Partial<Extract<ExecutionCommand, { command: 'mark_complete' }>> = {}): ExecutionCommand => ({ command: 'mark_complete', task: taskRef, ...extra });
const confirmed = (taskRef: string): ExecutionCommand => complete(taskRef, { confirmed: true });

describe('Mark complete while a run could advance the task', () => {
  it('refuses an AI task, whatever it is waiting on, and tells the user to Stop the run first', async () => {
    const env = setup();
    env.load([task('t1', 1), task('t2', 2, { dependencies: ['t1'] })]);
    await env.run({ command: 'run_plan' });

    for (const ref of ['t1', 't2']) {
      const outcome = await env.run(confirmed(ref));
      expect(outcome).toMatchObject({ ok: false, outcome: 'refused' });
      expect(outcome.message).toContain('Stop the run first');
    }
    expect(env.status('t1')).toBe('in_progress');
    expect(env.status('t2')).not.toBe('completed');
  });
});

const uncomplete = (taskRef: string, extra: Partial<Extract<ExecutionCommand, { command: 'mark_not_done' }>> = {}): ExecutionCommand => ({ command: 'mark_not_done', task: taskRef, ...extra });

describe('Mark complete once the run has stopped', () => {
  it('asks for the user\'s explicit yes and changes nothing without it', async () => {
    const env = setup();
    env.load([task('t1', 1), task('t2', 2, { dependencies: ['t1'] })]);

    const outcome = await env.run(complete('t1'));

    expect(outcome).toMatchObject({ ok: false, outcome: 'refused' });
    expect(outcome.message).toContain('Mark task #1 "Task t1" complete?');
    expect(outcome.message).toContain('"confirmed": true');
    expect(env.status('t1')).toBe('pending');
    expect(taskOf(env.session, 't1')!.verdict).toBeUndefined();
    expect(env.spawn).not.toHaveBeenCalled();
  });

  it('never reads an explicit false, or any other field, as a yes', async () => {
    const env = setup();
    env.load([task('t1', 1)]);

    expect(await env.run(complete('t1', { confirmed: false }))).toMatchObject({ ok: false });
    expect(env.status('t1')).toBe('pending');
  });

  it('vouches for the work when confirmed, and starts no dependent', async () => {
    const env = setup();
    env.load([task('t1', 1), task('t2', 2, { dependencies: ['t1'] })]);

    const outcome = await env.run(confirmed('t1'));

    expect(outcome).toEqual({ ok: true, message: 'Marked task #1 "Task t1" complete.' });
    expect(env.status('t1')).toBe('completed');
    expect(taskOf(env.session, 't1')!.verdict).toMatchObject({ outcome: 'pass' });
    expect(env.spawn).not.toHaveBeenCalled();
  });

  it('refuses a task that changed since the user was asked about it', async () => {
    const env = setup();
    env.load([task('t1', 1)]);

    const outcome = await env.run(complete('t1', { confirmed: true, seen: 'failed' }));

    expect(outcome).toMatchObject({ ok: false, outcome: 'refused' });
    expect(outcome.message).toContain('has changed since you were asked');
    expect(env.status('t1')).toBe('pending');
  });

  it('refuses a task that is no longer in the plan', async () => {
    const env = setup();
    env.load([task('t1', 1)]);

    expect(await env.run(confirmed('gone'))).toMatchObject({ ok: false, outcome: 'refused' });
    expect(env.status('t1')).toBe('pending');
  });

  it('overrides a script task the same way', async () => {
    const env = setup();
    env.load([task('s1', 1, { type: 'script', commands: [['node', '-e', '0']], assignedRunner: undefined, taskMode: undefined })]);

    expect(await env.run(complete('s1'))).toMatchObject({ ok: false });
    expect(await env.run(confirmed('s1'))).toMatchObject({ ok: true });
    expect(env.status('s1')).toBe('completed');
  });

  it('recovers a failed task, in a run that ended on its failure', async () => {
    const env = setup();
    env.load([task('t1', 1), task('t2', 2, { dependencies: ['t1'] })]);
    await env.run({ command: 'run_plan' });
    env.latest('t1').reportComplete({ status: 'failed', summary: 'nope' });
    await vi.waitFor(() => expect(env.status('t1')).toBe('failed'));
    await vi.waitFor(() => expect(env.session.activity.running).toBe(false));

    const outcome = await env.run(confirmed('t1'));

    expect(outcome).toMatchObject({ ok: true });
    expect(env.status('t1')).toBe('completed');
  });
});

describe('Mark not done', () => {
  async function completed() {
    const env = setup();
    env.load([task('t1', 1), task('t2', 2, { dependencies: ['t1'] })]);
    await env.run(confirmed('t1'));
    return env;
  }

  it('asks for a yes before it clears a completion, and changes nothing without one', async () => {
    const env = await completed();

    const outcome = await env.run(uncomplete('t1'));

    expect(outcome).toMatchObject({ ok: false, outcome: 'refused' });
    expect(outcome.message).toContain('Mark task #1 "Task t1" not done?');
    expect(outcome.message).toContain('not undone');
    expect(env.status('t1')).toBe('completed');
  });

  it('clears the completion when confirmed and holds the task', async () => {
    const env = await completed();

    const outcome = await env.run(uncomplete('t1', { confirmed: true, seen: 'completed' }));

    expect(outcome).toMatchObject({ ok: true });
    expect(env.status('t1')).toBe('pending');
    expect(env.spawn).not.toHaveBeenCalled();
  });
});

describe('while a run could advance the task', () => {
  it('refuses both directions on an already completed task', async () => {
    const env = setup();
    env.load([task('t1', 1), task('t2', 2)]);
    await env.run(confirmed('t1'));
    await env.run({ command: 'run_plan' });

    for (const command of [uncomplete('t1', { confirmed: true }), confirmed('t1')]) {
      const outcome = await env.run(command);
      expect(outcome).toMatchObject({ ok: false, outcome: 'refused' });
      expect(outcome.message).toContain('Stop the run first');
    }
    expect(env.status('t1')).toBe('completed');
  });

  it('refuses a mark made while the run is still starting', async () => {
    const env = setup();
    env.load([task('t1', 1)]);

    const run = env.run({ command: 'run_plan' });
    const outcome = await env.run(confirmed('t1'));
    await run;

    expect(outcome).toMatchObject({ ok: false, outcome: 'refused' });
    expect(outcome.message).toContain('Stop the run first');
  });

  it('refuses a mark whose confirmation was answered after a run began', async () => {
    const env = setup();
    env.load([task('t1', 1)]);
    const asked = await env.run(complete('t1'));
    expect(asked).toMatchObject({ ok: false });

    await env.run({ command: 'run_plan' });

    expect((await env.run(confirmed('t1'))).message).toContain('Stop the run first');
  });

  it('says a queued force start still advances on its own, though nothing is starting', async () => {
    const env = setup();
    env.load([task('t1', 1), task('t2', 2, { dependencies: ['t1'] })]);
    await env.run({ command: 'force_start', task: 't2' });

    expect(env.session.activity).toMatchObject({ starting: false, running: false, scheduled: false, resumable: false, advancesOnItsOwn: true });
    const outcome = await env.run(confirmed('t1'));
    expect(outcome).toMatchObject({ ok: false, outcome: 'refused' });
    expect(outcome.message).toContain('Stop the run first');
  });

  it('lets an ended-on-failure run be overridden: it no longer advances on its own', async () => {
    const env = setup();
    env.load([task('t1', 1), task('t2', 2, { dependencies: ['t1'] })]);
    await env.run({ command: 'run_plan' });
    env.latest('t1').reportComplete({ status: 'failed', summary: 'nope' });
    await vi.waitFor(() => expect(env.status('t1')).toBe('failed'));
    await vi.waitFor(() => expect(env.session.activity.running).toBe(false));

    expect(env.session.activity).toMatchObject({ advancesOnItsOwn: false });
    expect(await env.run(confirmed('t1'))).toMatchObject({ ok: true });
  });

  it('refuses a task paused on a usage limit that will resume on its own, until the run is stopped', async () => {
    vi.useFakeTimers({ now: new Date('2026-10-11T17:00:00Z') });
    try {
      const env = setup();
      env.load([task('t1', 1), task('t2', 2, { dependencies: ['t1'] })]);
      await env.run({ command: 'force_start', task: 't1' });
      hitLimit(env.latest('t1'));
      await until(() => !!taskOf(env.session, 't1')!.resumeAt);

      expect(env.session.activity).toMatchObject({ resumable: true, advancesOnItsOwn: true });
      const outcome = await env.run(confirmed('t1'));
      expect(outcome).toMatchObject({ ok: false, outcome: 'refused' });
      expect(outcome.message).toContain('Stop the run first');
      expect((await env.run(uncomplete('t1', { confirmed: true }))).message).toContain('Stop the run first');

      await env.run({ command: 'stop_run' });
      await until(() => !env.session.activity.running);
      expect(await env.run(confirmed('t1'))).toMatchObject({ ok: true });
    } finally {
      vi.useRealTimers();
    }
  });

  it('refuses an override of a task whose passed work is still landing', async () => {
    const isolation = new FakeWorktreeIsolation();
    const env = setup({ isolation });
    env.load([task('t1', 1)]);
    const openMerge = isolation.holdIntegration('t1');
    await env.run({ command: 'run_task', task: 't1' });
    env.latest('t1').reportComplete({ status: 'done', summary: '' });
    await vi.waitFor(() => expect(isolation.taskIdsFor('integrate')).toEqual(['t1']));

    const outcome = await env.run(confirmed('t1'));

    expect(outcome).toMatchObject({ ok: false, outcome: 'refused' });
    expect(outcome.message).toContain('Stop the run first');
    openMerge();
    await vi.waitFor(() => expect(env.status('t1')).toBe('completed'));
  });

  it('lets a Stop make the override possible once the attempt has settled', async () => {
    const env = setup();
    env.load([task('t1', 1)]);
    await env.run({ command: 'run_plan' });
    expect((await env.run(confirmed('t1'))).ok).toBe(false);

    await env.run({ command: 'stop_run' });
    await vi.waitFor(() => expect(env.session.activity).toMatchObject({ starting: false, running: false, scheduled: false }));

    expect(await env.run(confirmed('t1'))).toMatchObject({ ok: true });
    expect(env.status('t1')).toBe('completed');
  });
});

describe('a manual task during a run', () => {
  it('signs off without a confirmation and releases what waits on it', async () => {
    const env = setup();
    env.load([task('u1', 1, { type: 'user', assignedRunner: undefined, taskMode: undefined }), task('t2', 2, { dependencies: ['u1'] })]);
    await env.run({ command: 'run_plan' });
    expect(env.spawn).not.toHaveBeenCalled();

    const outcome = await env.run(complete('u1'));

    expect(outcome).toMatchObject({ ok: true });
    expect(env.status('u1')).toBe('completed');
    await vi.waitFor(() => expect(env.spawn).toHaveBeenCalledTimes(1));
  });

  it('takes its own sign-off back during a run, as it can be done', async () => {
    const env = setup();
    env.load([task('u1', 1, { type: 'user', assignedRunner: undefined, taskMode: undefined }), task('t2', 2)]);
    await env.run({ command: 'run_plan' });
    await env.run(complete('u1'));

    expect(await env.run(uncomplete('u1'))).toMatchObject({ ok: true });
    expect(env.status('u1')).toBe('pending');
  });
});

describe('a start a dirty checkout parked', () => {
  for (const command of ['run_task', 'force_start'] as const) {
    it(`refuses an override after ${command} until a Stop, so the parked start cannot replay over it`, async () => {
      const isolation = new FakeWorktreeIsolation();
      isolation.availability = { active: false, reason: 'dirty' };
      const env = setup({ isolation });
      env.load([task('t1', 1), task('t2', 2, { dependencies: ['t1'] })]);
      await env.run({ command, task: 't1' });
      expect(env.spawn).not.toHaveBeenCalled();

      const outcome = await env.run(confirmed('t1'));

      expect(outcome).toMatchObject({ ok: false, outcome: 'refused' });
      expect(outcome.message).toContain('Stop the run first');

      await env.run({ command: 'stop_run' });
      expect(await env.run(confirmed('t1'))).toMatchObject({ ok: true });
      isolation.availability = { active: true };
      await env.session.continueWithStash();
      expect(env.spawn.mock.calls.filter(([o]) => o.taskId === 't1')).toEqual([]);
      expect(env.status('t1')).toBe('completed');
    });
  }
});

describe('overrides that race each other and the run', () => {
  it('lands one override at a time: the second, made in the same moment, is refused', async () => {
    const env = setup();
    env.load([task('t1', 1), task('t2', 2)]);

    const [first, second] = await Promise.all([env.run(confirmed('t1')), env.run(confirmed('t2'))]);

    expect(first).toMatchObject({ ok: true });
    expect(second).toMatchObject({ ok: false, outcome: 'refused' });
    expect(second.message).toContain('Another manual override is landing');
    expect(env.status('t2')).toBe('pending');
  });

  it('starts no run while an override is landing, then runs once it has landed', async () => {
    const env = setup();
    env.load([task('t1', 1), task('t2', 2)]);

    const [marked, started] = await Promise.all([env.run(confirmed('t1')), env.run({ command: 'run_plan' })]);

    expect(marked).toMatchObject({ ok: true });
    expect(started).toMatchObject({ ok: false, outcome: 'refused' });
    expect(started.message).toContain('Another manual override is landing');
    expect(env.spawn).not.toHaveBeenCalled();
    expect(await env.run({ command: 'run_plan' })).toMatchObject({ ok: true });
  });
});

describe('what a landing override holds back besides starts', () => {
  /** t1 failed and is being marked complete with its integration held; returns what lands it. */
  async function landingOverrideOfT1(env: ReturnType<typeof setup>, isolation: FakeWorktreeIsolation) {
    await env.run({ command: 'run_plan' });
    env.latest('t1').reportComplete({ status: 'failed', summary: 'nope' });
    await vi.waitFor(() => expect(env.status('t1')).toBe('failed'));
    await vi.waitFor(() => expect(env.session.activity.running).toBe(false));
    const release = isolation.holdIntegration('t1');
    const landing = env.run(confirmed('t1'));
    await vi.waitFor(() => expect(isolation.taskIdsFor('integrate')).toEqual(['t1']));
    return { release, landing };
  }

  it('refuses a skip, which would start the failed run again under the landing override', async () => {
    const isolation = new FakeWorktreeIsolation();
    const env = setup({ isolation });
    env.load([task('t1', 1), task('t2', 2, { dependencies: ['t1'] }), task('t3', 3), task('t4', 4, { dependencies: ['t3'] })]);
    await env.run({ command: 'run_plan' });
    env.latest('t1').reportComplete({ status: 'failed', summary: 'nope' });
    env.latest('t3').reportComplete({ status: 'failed', summary: 'nope' });
    await vi.waitFor(() => expect(env.status('t3')).toBe('failed'));
    await vi.waitFor(() => expect(env.session.activity.running).toBe(false));
    const release = isolation.holdIntegration('t1');
    const landing = env.run(confirmed('t1'));
    await vi.waitFor(() => expect(isolation.taskIdsFor('integrate')).toEqual(['t1']));

    const skipped = await env.run({ command: 'skip_task', task: 't3' });

    expect(skipped).toMatchObject({ ok: false, outcome: 'refused' });
    expect(skipped.message).toContain('Another manual override is landing');
    expect(env.status('t3')).toBe('failed');
    expect(env.spawn.mock.calls.some(([o]) => o.taskId === 't4')).toBe(false);
    release();
    expect(await landing).toMatchObject({ ok: true });
  });

  it('refuses run_script, a start like any other', async () => {
    const isolation = new FakeWorktreeIsolation();
    const env = setup({ isolation });
    env.load([task('t1', 1)]);
    const { release, landing } = await landingOverrideOfT1(env, isolation);
    const spawned = env.spawn.mock.calls.length;

    const ran = await env.run({ command: 'run_script', title: 'Echo', commands: [['echo', 'hi']] }, { kind: 'supervisor', level: 'act' });

    expect(ran).toMatchObject({ ok: false, outcome: 'refused' });
    expect(ran.message).toContain('Another manual override is landing');
    expect(env.spawn.mock.calls.length).toBe(spawned);
    expect(env.session.planTasks.some((t) => t.type === 'script')).toBe(false);
    release();
    expect(await landing).toMatchObject({ ok: true });
  });
});

describe('the rest of the state matrix', () => {
  it('overrides a task a failed dependency blocks, in a run that ended on the failure', async () => {
    const env = setup();
    env.load([task('t1', 1), task('t2', 2, { dependencies: ['t1'] })]);
    await env.run({ command: 'run_plan' });
    env.latest('t1').reportComplete({ status: 'failed', summary: 'nope' });
    await vi.waitFor(() => expect(env.status('t1')).toBe('failed'));
    await vi.waitFor(() => expect(env.session.activity.running).toBe(false));

    expect(await env.run(confirmed('t2'))).toMatchObject({ ok: true });
    expect(env.status('t2')).toBe('completed');
  });

  it('lands the kept work of a skipped task, as it did, once the user confirms', async () => {
    const isolation = new FakeWorktreeIsolation();
    const env = setup({ isolation });
    env.load([task('t1', 1)]);
    await env.run({ command: 'run_task', task: 't1' });
    env.latest('t1').emitExit(1);
    await vi.waitFor(() => expect(env.status('t1')).toBe('failed'));
    await env.run({ command: 'skip_task', task: 't1' });
    expect(env.status('t1')).toBe('skipped');

    expect(await env.run(complete('t1'))).toMatchObject({ ok: false });
    expect(isolation.taskIdsFor('integrate')).toEqual([]);
    expect(await env.run(confirmed('t1'))).toMatchObject({ ok: true });

    expect(env.status('t1')).toBe('completed');
    expect(isolation.taskIdsFor('integrate')).toEqual(['t1']);
  });

  it('holds a task marked not done until it is retried: starting the plan does not run it', async () => {
    const env = setup();
    env.load([task('t1', 1)]);
    await env.run(confirmed('t1'));
    await env.run(uncomplete('t1', { confirmed: true }));

    await env.run({ command: 'run_plan' });

    expect(env.spawn).not.toHaveBeenCalled();
  });

  it('overrides a subtask by its dotted reference, and holds a parent to the same rules', async () => {
    const env = setup();
    const parent = task('p1', 1);
    parent.subtasks = [task('s1', 1)];
    env.load([parent]);

    expect(await env.run(complete('#1.1'))).toMatchObject({ ok: false });
    expect(await env.run(confirmed('#1.1'))).toMatchObject({ ok: true });
    expect(taskOf(env.session, 's1')!.status).toBe('completed');

    await env.run({ command: 'run_plan' });
    expect((await env.run(confirmed('#1'))).message).toContain('Stop the run first');
    expect((await env.run(uncomplete('#1.1', { confirmed: true }))).message).toContain('Stop the run first');
  });

  it.each([['a planner turn', { kind: 'planner-turn' }], ['the supervisor at Act', { kind: 'supervisor', level: 'act' }], ['autorun', { kind: 'autorun' }]] as const)(
    'is never %s\'s to give, a yes on the command or not',
    async (_who, actor) => {
      const env = setup();
      env.load([task('t1', 1)]);

      const outcome = await env.run(confirmed('t1'), actor);

      expect(outcome).toMatchObject({ ok: false, outcome: 'refused' });
      expect(env.status('t1')).toBe('pending');
    },
  );

  it('records a refusal in the timeline and no verdict, archive entry or dependent start', async () => {
    const env = setup();
    env.load([task('t1', 1), task('t2', 2, { dependencies: ['t1'] })]);

    await env.run(complete('t1'));

    expect(taskOf(env.session, 't1')!.verdict).toBeUndefined();
    expect(env.session.executionLog).toHaveLength(0);
    expect(env.spawn).not.toHaveBeenCalled();
  });
});
