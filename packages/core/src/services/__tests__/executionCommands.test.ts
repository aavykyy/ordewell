import { describe, it, expect, vi } from 'vitest';
import { makeSession, FakeRunnerSession, taskOf, fakeConfig, testWorkspace, type SessionOverrides } from './sessionTestKit';
import { FakeWorktreeIsolation } from '../../testing';
import { createTask, type LegacyPlanState, type Task } from '../../models/Task';
import type { IRunner } from '../../interfaces/IRunner';
import type { SessionMessage } from '../SessionMessage';
import type { ExecutionActor } from '../../models/Execution';
import type { ConversationRequest, ConversationTurn } from '../AiService';
import { ExecutionCommands, type ExecutionCommand, type ExecutionHost } from '../ExecutionCommands';
import { STOPPED_BEFORE_START } from '../TaskOrchestrator';
import { EMPTY_CONVERSATION, fromTranscript, reduceConversation } from '../../conversation';

const PLANNER: ExecutionActor = { kind: 'planner-turn' };

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

function plan(tasks: Task[], over: Partial<LegacyPlanState> = {}): LegacyPlanState {
  const now = new Date().toISOString();
  return { tasks, generatedAt: now, status: 'approved', runners: ['claude-code'], lastUpdated: now, ...over };
}

function setup(opts: { autonomous?: boolean; isolation?: FakeWorktreeIsolation; maxParallel?: number; aiService?: SessionOverrides['aiService'] } = {}) {
  const messages: SessionMessage[] = [];
  const r = runner();
  const session = makeSession({
    runner: r.runner,
    isolation: opts.isolation,
    aiService: opts.aiService,
    config: fakeConfig({ autonomousMode: opts.autonomous ?? true, maxParallelSessions: opts.maxParallel ?? 3 }),
    broadcast: (m) => messages.push(m),
  });
  const latest = (taskId: string) => r.sessions.filter((s) => s.taskId === taskId).at(-1)!;
  const spawned = (taskId: string) => r.spawn.mock.calls.map(([o]) => o).filter((o) => o.taskId === taskId);
  const timeline = () => messages.flatMap((m) => (m.type === 'execution_action' ? [m] : []));
  const cards = () => messages.flatMap((m) => (m.type === 'approval_request' && m.kind === 'task_start' ? [m] : []));
  const run = (command: ExecutionCommand, actor: ExecutionActor = PLANNER) => session.execute(command, actor);
  return { session, messages, timeline, cards, latest, spawned, run, ...r };
}

/** A run with task 1 started by the user's Execute plan, and task 2 waiting on it. */
async function running(opts: Parameters<typeof setup>[0] = {}) {
  const env = setup(opts);
  env.session.loadPlan(plan([task('t1', 1), task('t2', 2, { dependencies: ['t1'] })]), 'goal', testWorkspace, { persist: false });
  await env.session.executePlan();
  return env;
}

describe('the command seam: run_task', () => {
  it('starts a ready task the user approved, as the force-start button does, and records who asked', async () => {
    const byTool = setup();
    byTool.session.loadPlan(plan([task('t1', 1)]), 'goal', testWorkspace, { persist: false });
    const byButton = setup();
    byButton.session.loadPlan(plan([task('t1', 1)]), 'goal', testWorkspace, { persist: false });

    // Each attempt's usage carries its start time, which would otherwise differ between the two runs.
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-11T12:00:00Z'));
    const outcome = await byTool.run({ command: 'run_task', task: '1' });
    await byButton.session.forceStartTask('t1');
    vi.useRealTimers();

    expect(outcome).toEqual({ ok: true, message: 'Started task #1 "Task t1".' });
    expect(byTool.spawned('t1')).toHaveLength(1);
    // The plan pane and the task log are fed the same messages either way.
    const shown = (messages: SessionMessage[]) => messages.filter((m) => m.type === 'status_update' || m.type === 'task_started' || m.type === 'task_log');
    expect(shown(byTool.messages)).toEqual(shown(byButton.messages));
    expect(byTool.timeline()).toEqual([expect.objectContaining({
      record: expect.objectContaining({ command: 'run_task', actor: 'planner-turn', outcome: 'done', task: { id: 't1', ref: '#1', title: 'Task t1' } }),
      text: 'The planner started task #1 "Task t1".',
    })]);
  });

  it('refuses a task whose dependency has not finished, naming the dependency and its state', async () => {
    const env = setup();
    env.session.loadPlan(plan([task('t1', 1), task('t2', 2, { dependencies: ['t1'] })]), 'goal', testWorkspace, { persist: false });

    const outcome = await env.run({ command: 'run_task', task: 't2' });

    expect(outcome).toEqual({ ok: false, outcome: 'refused', message: 'Task #2 "Task t2" depends on task #1 "Task t1" (not started), which has not finished. It can start once it has.' });
    expect(env.spawn).not.toHaveBeenCalled();
    expect(env.timeline().at(-1)!.text).toBe(`The planner asked to start task #2 "Task t2"; refused: ${outcome.message}`);
  });

  it('refuses a task a failure blocks through its dependencies, naming the failed task to retry (ADR-0034)', async () => {
    const env = setup();
    env.session.loadPlan(plan([task('t1', 1), task('t2', 2, { dependencies: ['t1'] }), task('t3', 3, { dependencies: ['t2'] })]), 'goal', testWorkspace, { persist: false });
    await env.session.executePlan();
    env.latest('t1').reportComplete({ status: 'failed', summary: '', reason: 'broke' });
    await vi.waitFor(() => expect(taskOf(env.session, 't1')!.status).toBe('failed'));

    const outcome = await env.run({ command: 'run_task', task: 't3' });

    expect(outcome).toEqual({ ok: false, outcome: 'refused', message: 'Task #3 "Task t3" is blocked: task #1 "Task t1" failed. Retry it first.' });
  });

  it('refuses a task waiting at its merge gate, and says the merge is the user\'s', async () => {
    const env = setup({ isolation: new FakeWorktreeIsolation() });
    env.session.loadPlan(plan([task('t1', 1), task('o2', 2, { ops: true, dependencies: ['t1'] })]), 'goal', testWorkspace, { persist: false });
    await env.session.executePlan();
    env.latest('t1').reportComplete({ status: 'done', summary: '' });
    await vi.waitFor(() => expect(env.session.mergeGate('o2')).toEqual(['t1']));

    const outcome = await env.run({ command: 'run_task', task: 'o2' });

    expect(outcome).toMatchObject({ ok: false, outcome: 'refused' });
    expect(outcome.message).toBe('Task #2 "Task o2" waits for Merge all: the work of task #1 "Task t1" is not merged into the user\'s branch yet. Ask the user to merge (Merge all), or to force start it.');
    expect(env.spawned('o2')).toHaveLength(0);
  });

  it('refuses a start or a retry of an ops task whose work waits behind a dependency\'s own dependency', async () => {
    const isolation = new FakeWorktreeIsolation();
    // The verification landed nothing of its own, so git finds it in the user's branch already; the fix it verified is not.
    isolation.mergedByHand.add('v2');
    const env = setup({ isolation });
    env.session.loadPlan(plan([task('t1', 1), task('v2', 2, { dependencies: ['t1'] }), task('o3', 3, { ops: true, dependencies: ['v2'] })]), 'goal', testWorkspace, { persist: false });
    await env.session.executePlan();
    env.latest('t1').reportComplete({ status: 'done', summary: '' });
    await vi.waitFor(() => expect(env.spawned('v2')).toHaveLength(1));
    env.latest('v2').reportComplete({ status: 'done', summary: '' });
    await vi.waitFor(() => expect(isolation.taskIdsFor('integrate')).toEqual(['t1', 'v2']));
    await vi.waitFor(() => expect(taskOf(env.session, 'v2')!.status).toBe('completed'));
    expect(env.session.mergeGate('o3')).toEqual(['t1']);

    const reason = 'waits for Merge all: the work of task #1 "Task t1" is not merged into the user\'s branch yet. Ask the user to merge (Merge all), or to force start it.';
    expect(await env.run({ command: 'run_task', task: 'o3' })).toEqual({ ok: false, outcome: 'refused', message: `Task #3 "Task o3" ${reason}` });
    expect(await env.run({ command: 'retry_task', task: 'o3', from: 'fresh' })).toEqual({ ok: false, outcome: 'refused', message: `Task #3 "Task o3" ${reason}` });
    expect(env.spawned('o3')).toHaveLength(0);

    expect(await env.run({ command: 'merge_all' }, { kind: 'supervisor', level: 'act' })).toMatchObject({ ok: true });
    await vi.waitFor(() => expect(env.spawned('o3')).toHaveLength(1));
  });

  it('refuses a retry of a failed ops task whose ancestors\' work is still not merged', async () => {
    const env = setup({ isolation: new FakeWorktreeIsolation() });
    env.session.loadPlan(plan([task('t1', 1), task('o2', 2, { ops: true, dependencies: ['t1'] })]), 'goal', testWorkspace, { persist: false });
    await env.session.executePlan();
    env.latest('t1').reportComplete({ status: 'done', summary: '' });
    await vi.waitFor(() => expect(env.session.mergeGate('o2')).toEqual(['t1']));
    await env.session.forceStartTask('o2');
    env.latest('o2').reportComplete({ status: 'failed', summary: '', reason: 'broke' });
    await vi.waitFor(() => expect(taskOf(env.session, 'o2')!.status).toBe('failed'));

    expect(await env.run({ command: 'retry_task', task: 'o2', from: 'fresh' })).toEqual({
      ok: false, outcome: 'refused',
      message: 'Task #2 "Task o2" waits for Merge all: the work of task #1 "Task t1" is not merged into the user\'s branch yet. Ask the user to merge (Merge all), or to force start it.',
    });
    expect(env.spawned('o2')).toHaveLength(1);
  });

  it('refuses a user task, a running task, and a failed one with what to do instead', async () => {
    const env = await running();
    env.session.loadPlan(plan([task('t1', 1), task('u2', 2, { type: 'user', prompt: undefined })]), 'goal', testWorkspace, { persist: false });
    await env.session.executePlan();

    expect((await env.run({ command: 'run_task', task: 'u2' })).message).toBe('Task #2 "Task u2" is a user task: the user does it by hand, and no runner starts it.');
    expect((await env.run({ command: 'run_task', task: 't1' })).message).toBe('Task #1 "Task t1" is already running.');

    env.latest('t1').reportComplete({ status: 'failed', summary: '', reason: 'broke' });
    await vi.waitFor(() => expect(taskOf(env.session, 't1')!.status).toBe('failed'));
    expect((await env.run({ command: 'run_task', task: 't1' })).message).toBe('Task #1 "Task t1" failed. Start a new attempt with retry_task.');
  });

  it('names an unknown task and records the refusal', async () => {
    const env = setup();
    env.session.loadPlan(plan([task('t1', 1)]), 'goal', testWorkspace, { persist: false });

    expect(await env.run({ command: 'run_task', task: '#9' })).toMatchObject({ ok: false, message: expect.stringContaining('No task matches "#9"') });
    expect(env.timeline()).toHaveLength(1);
    // Seen live as "The planner asked to start ; refused: …".
    expect(env.timeline()[0].text).toMatch(/^The planner asked to start "#9"; refused: No task matches "#9"/);
  });

  it('refuses to start past the parallel limit', async () => {
    const env = setup({ maxParallel: 1 });
    env.session.loadPlan(plan([task('t1', 1), task('t2', 2)]), 'goal', testWorkspace, { persist: false });
    await env.run({ command: 'run_task', task: 't1' });

    expect((await env.run({ command: 'run_task', task: 't2' })).message).toBe('1 tasks are already running, the most this session runs at once. Wait for one to finish, or stop one first.');
  });
});

describe('the command seam: an unapproved plan or task never starts', () => {
  it.each([true, false])('refuses every start of a plan the user never executed (Full: %s), and asks nobody', async (autonomous) => {
    const env = setup({ autonomous });
    env.session.loadPlan(plan([task('t1', 1)], { status: 'draft' }), 'goal', testWorkspace, { persist: false });

    const results = [
      await env.run({ command: 'run_plan' }),
      await env.run({ command: 'run_task', task: 't1' }),
      await env.run({ command: 'retry_task', task: 't1', from: 'fresh' }),
    ];

    for (const result of results) expect(result).toMatchObject({ ok: false, outcome: 'refused', message: expect.stringMatching(/not approved/) });
    expect(results[0].message).toBe('The user has not approved this plan yet: they approve it by executing it themselves (Execute plan). Ask them to.');
    expect(env.spawn).not.toHaveBeenCalled();
    expect(env.cards()).toHaveLength(0);
  });

  it('refuses a task added after the user approved the plan, until the user starts it themselves', async () => {
    const env = setup();
    env.session.loadPlan(plan([task('t1', 1), task('t2', 2)], { approvedTasks: ['t1'] }), 'goal', testWorkspace, { persist: false });

    expect((await env.run({ command: 'run_task', task: 't2' })).message)
      .toBe('Task #2 "Task t2" was added after the user approved the plan, so it is not approved to run. Ask the user to start it, or to execute the plan, which approves it.');
    expect((await env.run({ command: 'run_plan' })).message)
      .toBe('Task #2 "Task t2" was added after the user approved the plan, so it is not approved to run. Ask the user to execute the plan themselves, which approves it.');
    expect(env.spawn).not.toHaveBeenCalled();

    await env.session.forceStartTask('t2');
    expect(env.session.planState!.approvedTasks).toEqual(['t1', 't2']);
  });

  it('counts every task of a plan saved as executed, before approval was kept, as approved', () => {
    const env = setup();
    env.session.loadPlan(plan([task('t1', 1, { subtasks: [task('t1a', 1)] })]), 'goal', testWorkspace, { persist: false });

    expect(env.session.planState!.approvedTasks).toEqual(['t1', 't1a']);
  });

  it('approves every task when the user executes the plan', async () => {
    const env = setup();
    env.session.loadPlan(plan([task('t1', 1), task('t2', 2)], { status: 'draft' }), 'goal', testWorkspace, { persist: false });

    await env.session.executePlan();

    expect(env.session.planState!.approvedTasks).toEqual(['t1', 't2']);
  });

  it('approves every task when the user signs off a review, so the planner may start them', async () => {
    const env = setup();
    // The shape the review route sees: an approved plan whose approval ledger was never filled.
    env.session.loadPlan(
      plan([task('u1', 1, { type: 'user', prompt: undefined }), task('t2', 2, { dependencies: ['u1'] })], { status: 'approved', approvedTasks: [] }),
      'goal', testWorkspace, { persist: false },
    );

    await env.session.approveReview();

    expect(env.session.planState!.approvedTasks).toEqual(['u1', 't2']);
    // The planner's start of t2 is refused for its unmet dependency, not for approval:
    // the approval check comes first in the seam.
    const outcome = await env.run({ command: 'run_task', task: 't2' });
    expect(outcome.message).toContain('depends on');
    expect(outcome.message).not.toContain('not approved');
  });
});

describe('the command seam: consent in a user-started planner turn', () => {
  it('asks the user before a start in Guarded, on the planner\'s approval card, and starts once allowed', async () => {
    const env = setup({ autonomous: false });
    env.session.loadPlan(plan([task('t1', 1)]), 'goal', testWorkspace, { persist: false });

    const pending = env.run({ command: 'run_task', task: 't1' });
    await vi.waitFor(() => expect(env.cards()).toHaveLength(1));
    expect(env.cards()[0]).toMatchObject({ subject: 'Start task #1 "Task t1"', detail: 'The planner wants to start work. It runs on claude-code in acceptEdits mode, as the plan set it.' });
    expect(env.spawn).not.toHaveBeenCalled();
    env.session.resolveApproval(env.cards()[0].id, true);

    expect(await pending).toMatchObject({ ok: true });
    expect(env.spawned('t1')).toHaveLength(1);
  });

  it('starts nothing when the user declines, and records the declined call', async () => {
    const env = setup({ autonomous: false });
    env.session.loadPlan(plan([task('t1', 1)]), 'goal', testWorkspace, { persist: false });

    const pending = env.run({ command: 'run_plan' });
    await vi.waitFor(() => expect(env.cards()).toHaveLength(1));
    env.session.resolveApproval(env.cards()[0].id, false);

    expect(await pending).toEqual({ ok: false, outcome: 'declined', message: 'The user did not approve: run the plan. Do not ask again unless they say so.' });
    expect(env.spawn).not.toHaveBeenCalled();
    expect(env.timeline().at(-1)!.text).toBe('The planner asked to run the plan; you declined.');
  });

  it('starts without asking in Full', async () => {
    const env = setup({ autonomous: true });
    env.session.loadPlan(plan([task('t1', 1)]), 'goal', testWorkspace, { persist: false });

    expect(await env.run({ command: 'run_plan' })).toEqual({ ok: true, message: 'The plan is running: task #1 "Task t1" started, and the rest start as their dependencies finish.' });
    expect(env.cards()).toHaveLength(0);
  });

  it('stops, messages and denies in Guarded without asking anyone', async () => {
    const env = await running({ autonomous: false });
    env.latest('t1').requestPermission('p1', 'Bash', { command: 'rm -rf build' });
    await vi.waitFor(() => expect(env.session.outstandingApprovals()).toHaveLength(1));

    expect(await env.run({ command: 'message_task', task: 't1', text: 'use the cache' })).toMatchObject({ ok: true });
    expect(await env.run({ command: 'answer_approval', task: 't1', answer: 'deny', note: 'keep build' })).toMatchObject({ ok: true });
    expect(await env.run({ command: 'stop_task', task: 't1' })).toMatchObject({ ok: true });
    expect(env.cards()).toHaveLength(0);
  });
});

describe('the command seam: stop_task and stop_run', () => {
  it('stops one running task, denying its open approvals as a stop does, and keeps it to retry', async () => {
    const env = await running();
    const t1 = env.latest('t1');
    t1.requestPermission('p1', 'Bash', { command: 'make' });
    await vi.waitFor(() => expect(env.session.outstandingApprovals()).toHaveLength(1));

    const outcome = await env.run({ command: 'stop_task', task: 't1' });

    expect(outcome).toEqual({ ok: true, message: 'Stopped task #1 "Task t1": it is back to not started and held until it is retried, and its open approvals were denied.' });
    expect(t1.answers).toEqual([{ id: 'p1', decision: { decision: 'deny' } }]);
    expect(env.session.outstandingApprovals()).toHaveLength(0);
    expect(taskOf(env.session, 't1')!.status).toBe('pending');
    expect(env.timeline().at(-1)!.text).toBe('The planner stopped task #1 "Task t1".');
  });

  it('refuses to stop a task that is not running', async () => {
    const env = await running();

    expect(await env.run({ command: 'stop_task', task: 't2' })).toEqual({
      ok: false, outcome: 'refused', message: 'Task #2 "Task t2" is not running (it has not started): there is nothing to stop.',
    });
  });

  it('keeps an ops task\'s retry context when it is stopped midway (ADR-0020)', async () => {
    const env = setup();
    env.session.loadPlan(plan([task('o1', 1, { ops: true })]), 'goal', testWorkspace, { persist: false });
    await env.session.executePlan();
    env.latest('o1').emitOutput('created resource group rg-dev\n');

    expect((await env.run({ command: 'stop_task', task: 'o1' })).message).toContain('A retry is told what this attempt did.');
    expect(await env.run({ command: 'retry_task', task: 'o1', from: 'fresh' })).toMatchObject({ ok: true });

    expect(env.spawned('o1')).toHaveLength(2);
    expect(env.spawned('o1')[1].prompt).toContain('## Previous attempt');
    expect(env.spawned('o1')[1].prompt).toContain('created resource group rg-dev');
  });

  it('stops every running task and keeps the plan, as the stop button does', async () => {
    const env = setup();
    env.session.loadPlan(plan([task('t1', 1), task('t2', 2)]), 'goal', testWorkspace, { persist: false });
    await env.session.executePlan();

    const outcome = await env.run({ command: 'stop_run' });

    expect(outcome).toEqual({ ok: true, message: 'Stopped the run: task #1 "Task t1" and task #2 "Task t2" are back to not started, and the plan is kept. Start again with run_plan or run_task.' });
    expect(env.messages.map((m) => m.type)).toContain('execution_stopped');
    expect(env.session.planTasks.map((t) => [t.id, t.status])).toEqual([['t1', 'pending'], ['t2', 'pending']]);
    expect(env.session.isExecuting).toBe(false);
  });

  it('refuses to stop a run when nothing runs', async () => {
    const env = setup();
    env.session.loadPlan(plan([task('t1', 1)]), 'goal', testWorkspace, { persist: false });

    expect((await env.run({ command: 'stop_run' })).message).toBe('Nothing is running: there is no run to stop.');
  });
});

describe('the command seam: retry_task', () => {
  it('starts a fresh attempt of a failed task, even with no run to hand it to', async () => {
    const env = setup();
    env.session.loadPlan(plan([task('t1', 1)]), 'goal', testWorkspace, { persist: false });
    await env.session.executePlan();
    env.latest('t1').reportComplete({ status: 'failed', summary: '', reason: 'broke' });
    await vi.waitFor(() => expect(taskOf(env.session, 't1')!.status).toBe('failed'));
    env.session.stopExecution();

    expect(await env.run({ command: 'retry_task', task: 't1', from: 'fresh' })).toEqual({ ok: true, message: 'Retrying task #1 "Task t1".' });
    expect(env.spawned('t1')).toHaveLength(2);
    expect(env.timeline().at(-1)!.text).toBe('The planner retried task #1 "Task t1".');
  });

  it('continues a finished task in its saved session with the message', async () => {
    const env = setup();
    env.session.loadPlan(plan([task('t1', 1)]), 'goal', testWorkspace, { persist: false });
    await env.session.executePlan();
    env.latest('t1').reportComplete({ status: 'failed', summary: '', reason: 'broke' });
    await vi.waitFor(() => expect(taskOf(env.session, 't1')!.status).toBe('failed'));

    const outcome = await env.run({ command: 'retry_task', task: 't1', from: 'session', message: 'fix the import and finish' });

    expect(outcome).toEqual({ ok: true, message: 'Continuing task #1 "Task t1" in its saved session with your message.' });
    expect(env.spawned('t1')).toHaveLength(2);
    expect(env.spawned('t1')[1].resumeSessionId).toBe('native-1');
    expect(env.timeline().at(-1)!.text).toBe('The planner continued task #1 "Task t1" in its saved session: "fix the import and finish"');
  });

  it('refuses a continue without a message, and one of a task that never finished', async () => {
    const env = setup();
    env.session.loadPlan(plan([task('t1', 1), task('t2', 2)]), 'goal', testWorkspace, { persist: false });
    await env.run({ command: 'run_task', task: 't1' });
    env.latest('t1').reportComplete({ status: 'failed', summary: '', reason: 'broke' });
    await vi.waitFor(() => expect(taskOf(env.session, 't1')!.status).toBe('failed'));

    expect((await env.run({ command: 'retry_task', task: 't1', from: 'session' })).message)
      .toBe('Continuing task #1 "Task t1" in its saved session needs a message: what the runner should do next.');
    expect((await env.run({ command: 'retry_task', task: 't2', from: 'session', message: 'go on' })).message)
      .toBe('Task "Task t2" cannot be continued: only a completed, failed or skipped task, or one paused on a usage limit, can be. A fresh retry (from "fresh") starts it over from its prompt.');
    expect(env.spawned('t1')).toHaveLength(1);
    expect(env.spawned('t2')).toHaveLength(0);
  });

  it('refuses a running or completed task with what would be accepted', async () => {
    const env = await running();

    expect((await env.run({ command: 'retry_task', task: 't1', from: 'fresh' })).message)
      .toBe('Task #1 "Task t1" is running: stop it first with stop_task, or steer it with message_task.');
    env.latest('t1').reportComplete({ status: 'done', summary: '' });
    await vi.waitFor(() => expect(taskOf(env.session, 't1')!.status).toBe('completed'));
    expect((await env.run({ command: 'retry_task', task: 't1', from: 'fresh' })).message)
      .toBe('Task #1 "Task t1" has already completed. Continue it with retry_task from "session" and a message, or ask the user to mark it not done.');
  });

  it('asks the user first in Guarded', async () => {
    const env = setup({ autonomous: false });
    env.session.loadPlan(plan([task('t1', 1)]), 'goal', testWorkspace, { persist: false });

    const pending = env.run({ command: 'retry_task', task: 't1', from: 'fresh' });
    await vi.waitFor(() => expect(env.cards()).toHaveLength(1));
    expect(env.cards()[0].subject).toBe('Retry task #1 "Task t1"');
    env.session.resolveApproval(env.cards()[0].id, true);

    expect(await pending).toMatchObject({ ok: true });
  });
});

describe('the command seam: a task paused on a usage limit', () => {
  const ACT: ExecutionActor = { kind: 'supervisor', level: 'act' };
  const LIMIT = "You've hit your session limit · resets 8:10pm (UTC)";

  function hitLimit(session: FakeRunnerSession): void {
    session.emitEvent({ type: 'error', message: LIMIT });
    session.emitOutput(`${LIMIT}\n`);
    session.emitTurnEnd('failed');
  }

  /** Task 1 paused on its runner's usage limit after the user's Execute plan, task 2 waiting on it. */
  async function paused(opts: Parameters<typeof setup>[0] = {}) {
    const env = await running(opts);
    hitLimit(env.latest('t1'));
    await vi.waitFor(() => expect(taskOf(env.session, 't1')!.awaitingReason).toBe('usage-limit'));
    return env;
  }

  it('resumes it in its saved session from "session", with no message needed', async () => {
    const env = await paused();

    const outcome = await env.run({ command: 'retry_task', task: 't1', from: 'session' });

    expect(outcome).toEqual({ ok: true, message: 'Resumed task #1 "Task t1" in its saved session.' });
    expect(env.spawned('t1')).toHaveLength(2);
    expect(env.spawned('t1')[1]).toMatchObject({ resumeSessionId: 'native-1', prompt: expect.stringContaining('Your usage limit has reset.') });
    expect(taskOf(env.session, 't1')!.status).toBe('in_progress');
    expect(env.timeline().at(-1)!.text).toBe('The planner resumed task #1 "Task t1" in its saved session.');
  });

  it('sends a message after the reset notice in the same continuation', async () => {
    const env = await paused();

    const outcome = await env.run({ command: 'retry_task', task: 't1', from: 'session', message: 'limits reset, go on' });

    expect(outcome).toEqual({ ok: true, message: 'Resumed task #1 "Task t1" in its saved session with your message.' });
    const { prompt } = env.spawned('t1')[1];
    expect(prompt.indexOf('limits reset, go on')).toBeGreaterThan(prompt.indexOf('Your usage limit has reset.'));
    expect(env.timeline().at(-1)!.text).toBe('The planner resumed task #1 "Task t1" in its saved session: "limits reset, go on"');
  });

  it('resumes it on a message sent to it, as the user types one into its box', async () => {
    const env = await paused();

    const outcome = await env.run({ command: 'message_task', task: 't1', text: 'limits reset, go on' }, { kind: 'user' });

    expect(outcome).toEqual({ ok: true, message: 'Resumed task #1 "Task t1" in its saved session with your message.' });
    expect(env.spawned('t1')).toHaveLength(2);
    expect(env.spawned('t1')[1]).toMatchObject({ resumeSessionId: 'native-1', prompt: expect.stringContaining('limits reset, go on') });
    expect(env.timeline().at(-1)!.text).toBe('You resumed task #1 "Task t1" in its saved session: "limits reset, go on"');
  });

  it('refuses one with no saved session', async () => {
    const env = await running();
    env.latest('t1').sessionId = null;
    hitLimit(env.latest('t1'));
    await vi.waitFor(() => expect(taskOf(env.session, 't1')!.awaitingReason).toBe('usage-limit'));

    expect((await env.run({ command: 'retry_task', task: 't1', from: 'session' })).message)
      .toBe('Task "Task t1" cannot be continued: its runner left no saved session to resume. Use Retry instead. A fresh retry (from "fresh") starts it over from its prompt.');
    expect(env.spawned('t1')).toHaveLength(1);
  });

  it('refuses run_task, pointing at the resume', async () => {
    const env = await paused();

    expect((await env.run({ command: 'run_task', task: 't1' })).message)
      .toBe('Task #1 "Task t1" is paused on its runner\'s usage limit. Resume it in its saved session with retry_task from "session".');
  });

  it('lets a supervisor at Act resume it unchanged after an earlier failure, counting each resume against the retry limit', async () => {
    const env = await running({ autonomous: false });
    env.latest('t1').reportComplete({ status: 'failed', summary: '', reason: 'broke' });
    await vi.waitFor(() => expect(taskOf(env.session, 't1')!.status).toBe('failed'));
    await env.session.retryTask('t1');
    await vi.waitFor(() => expect(env.spawned('t1')).toHaveLength(2));

    for (const n of [3, 4]) {
      hitLimit(env.latest('t1'));
      await vi.waitFor(() => expect(taskOf(env.session, 't1')!.awaitingReason).toBe('usage-limit'));
      expect(await env.run({ command: 'retry_task', task: 't1', from: 'session' }, ACT)).toMatchObject({ ok: true });
      await vi.waitFor(() => expect(env.spawned('t1')).toHaveLength(n));
    }
    hitLimit(env.latest('t1'));
    await vi.waitFor(() => expect(taskOf(env.session, 't1')!.awaitingReason).toBe('usage-limit'));

    expect(await env.run({ command: 'message_task', task: 't1', text: 'go on' }, ACT)).toMatchObject({ ok: false, message: expect.stringMatching(/^Refused by the retry limit/) });
    expect(env.spawned('t1')).toHaveLength(4);
  });
});

describe('the command seam: message_task', () => {
  it('sends a running task a message through the task message path', async () => {
    const env = await running();

    expect(await env.run({ command: 'message_task', task: 't1', text: 'also update the docs' })).toEqual({
      ok: true, message: 'Sent to task #1 "Task t1". The runner reads it at its next step, or when its turn ends.', id: 'msg-1',
    });
    expect(env.latest('t1').queued()).toEqual([{ id: 'msg-1', text: 'also update the docs' }]);
    expect(env.timeline().at(-1)!.text).toBe('The planner sent task #1 "Task t1" a message: "also update the docs"');
  });

  it('answers a task waiting for input', async () => {
    const env = await running();
    env.latest('t1').waitForInput();
    await vi.waitFor(() => expect(taskOf(env.session, 't1')!.awaitingReason).toBe('input'));

    await env.run({ command: 'message_task', task: 't1', text: 'yes, the second option' });

    expect(env.latest('t1').delivered.at(-1)).toBe('yes, the second option');
    expect(taskOf(env.session, 't1')!.status).toBe('in_progress');
  });

  it('refuses a task that is not running, with the reason', async () => {
    const env = await running();

    expect(await env.run({ command: 'message_task', task: 't2', text: 'hi' })).toEqual({
      ok: false, outcome: 'refused', message: 'Task "Task t2" is not running, so there is no turn to send a message to.',
    });
  });
});

describe('the command seam: answer_approval never allows', () => {
  async function asking() {
    const env = await running();
    env.latest('t1').requestPermission('p1', 'Bash', { command: 'git push --force' });
    await vi.waitFor(() => expect(env.session.outstandingApprovals()).toHaveLength(1));
    return env;
  }

  it.each(['allow', 'Allow', 'allowForTask'])('refuses "%s" with the reason, and leaves the request to the user', async (answer) => {
    const env = await asking();

    const outcome = await env.run({ command: 'answer_approval', task: 't1', answer });

    expect(outcome).toEqual({ ok: false, outcome: 'refused', message: expect.stringContaining('answer_approval never allows') });
    expect(outcome.message).toContain('would widen the mode the plan gave the task');
    expect(env.latest('t1').answers).toEqual([]);
    expect(env.session.outstandingApprovals()).toHaveLength(1);
  });

  it('denies with the note the runner reads', async () => {
    const env = await asking();

    const outcome = await env.run({ command: 'answer_approval', task: 't1', answer: 'deny', note: 'push without --force' });

    expect(outcome).toMatchObject({ ok: true, message: expect.stringContaining('The runner is given your note.') });
    expect(env.latest('t1').answers).toEqual([{ id: 'p1', decision: { decision: 'deny', note: 'push without --force' } }]);
    expect(env.timeline().at(-1)!.text).toBe('The planner denied a request of task #1 "Task t1" with the note "push without --force".');
  });

  it('escalates by leaving the request for the user, and says so in the timeline', async () => {
    const env = await asking();

    expect(await env.run({ command: 'answer_approval', task: 't1', answer: 'escalate' })).toMatchObject({ ok: true });
    expect(env.session.outstandingApprovals()).toHaveLength(1);
    expect(env.timeline().at(-1)!.text).toBe('The planner left a request of task #1 "Task t1" for you to answer.');
  });

  it('refuses a task with no request waiting, and an id that is not one of its requests', async () => {
    const env = await asking();

    expect((await env.run({ command: 'answer_approval', task: 't2', answer: 'deny' })).message).toBe('Task #2 "Task t2" has no request waiting for an answer.');
    expect((await env.run({ command: 'answer_approval', task: 't1', approval: 'nope', answer: 'deny' })).message)
      .toMatch(/^No request "nope" waits on task #1 "Task t1"\. Its requests: p1 \(/);
  });
});

describe('the command seam: who asked', () => {
  it.each(['run_plan', 'run_task', 'stop_task', 'stop_run', 'retry_task', 'message_task', 'answer_approval'] as const)(
    'refuses %s from a supervisor at Watch, telling it to suggest the action to the user',
    async (name) => {
      const env = await running();
      const command: ExecutionCommand = {
        run_plan: { command: 'run_plan' },
        run_task: { command: 'run_task', task: 't1' },
        stop_task: { command: 'stop_task', task: 't1' },
        stop_run: { command: 'stop_run' },
        retry_task: { command: 'retry_task', task: 't1', from: 'fresh' },
        message_task: { command: 'message_task', task: 't1', text: 'hi' },
        answer_approval: { command: 'answer_approval', task: 't1', answer: 'deny' },
      }[name] as ExecutionCommand;

      const outcome = await env.run(command, { kind: 'supervisor', level: 'watch' });

      expect(outcome).toMatchObject({ ok: false, outcome: 'refused', message: expect.stringMatching(/at Watch.*Suggest it to the user instead/) });
      expect(env.session.isExecuting).toBe(true);
      expect(env.timeline().at(-1)!.record).toMatchObject({ actor: 'supervisor', level: 'watch', outcome: 'refused' });
    },
  );

  it('refuses a supervisor that is off for the run', async () => {
    const env = await running();

    const outcome = await env.run({ command: 'stop_task', task: 't1' }, { kind: 'supervisor', level: 'off' });

    expect(outcome).toMatchObject({ ok: false, outcome: 'refused', message: expect.stringMatching(/supervisor is off for this run/) });
    expect(taskOf(env.session, 't1')!.status).toBe('in_progress');
  });

  it('keeps each call in the transcript with who asked, which a reload shows as it was shown live', async () => {
    const env = await running();
    await env.run({ command: 'stop_task', task: 't1' }, { kind: 'user' });
    await env.run({ command: 'run_task', task: 't1' });

    const entries = env.session.planState!.conversationHistory!.filter((e) => e.kind === 'execution');
    expect(entries.map((e) => [e.execution!.actor, e.content])).toEqual([
      ['user', 'You stopped task #1 "Task t1".'],
      ['planner-turn', 'The planner started task #1 "Task t1".'],
    ]);
    const live = env.timeline().reduce((view, message) => reduceConversation(view, message), EMPTY_CONVERSATION);
    const reloaded = fromTranscript(env.session.planState!.conversationHistory, []);
    const lines = (view: typeof live) => view.blocks.flatMap((b) => (b.type === 'message' ? [[b.role, b.text]] : []));
    expect(lines(reloaded)).toEqual(lines(live));
    expect(lines(live)).toEqual([['system', 'You stopped task #1 "Task t1".'], ['system', 'The planner started task #1 "Task t1".']]);
  });

  it('records the user\'s own start as "You started ...", the same wording the button press gets', async () => {
    const env = setup();
    env.session.loadPlan(plan([task('t4', 4)]), 'goal', testWorkspace, { persist: false });

    await env.run({ command: 'run_task', task: 't4' }, { kind: 'user' });

    expect(env.timeline().at(-1)).toMatchObject({
      record: { command: 'run_task', actor: 'user', outcome: 'done', task: { id: 't4', ref: '#4' } },
      text: 'You started task #4 "Task t4".',
    });
  });

  it('reaches the seam from a planner turn through the session\'s own planner tools', async () => {
    const startConversation = vi.fn(async (req: ConversationRequest): Promise<ConversationTurn> => {
      const reply = await req.plannerTools!.handler.stopTask!({ task: '1' }, { signal: new AbortController().signal });
      return { kind: 'message', text: reply.text, researchLog: [] };
    });
    const env = await running({ aiService: { startConversation, hasActiveConversation: () => false } });

    await env.session.continueConversation('stop task 1');

    expect(startConversation).toHaveBeenCalledOnce();
    expect(taskOf(env.session, 't1')!.status).toBe('pending');
    expect(env.timeline().at(-1)!.record).toMatchObject({ command: 'stop_task', actor: 'planner-turn', outcome: 'done' });
  });
});

describe('the command seam: a supervisor at Act', () => {
  const ACT: ExecutionActor = { kind: 'supervisor', level: 'act' };

  /** Task 1 running in Guarded, where a planner turn's starts would ask the user. */
  async function guarded() {
    return running({ autonomous: false });
  }

  async function failed() {
    const env = await guarded();
    env.latest('t1').reportComplete({ status: 'failed', summary: '', reason: 'broke' });
    await vi.waitFor(() => expect(taskOf(env.session, 't1')!.status).toBe('failed'));
    return env;
  }

  async function asking() {
    const env = await guarded();
    env.latest('t1').requestPermission('p1', 'Bash', { command: 'git push --force' });
    await vi.waitFor(() => expect(env.session.outstandingApprovals()).toHaveLength(1));
    return env;
  }

  async function idle() {
    const env = setup({ autonomous: false });
    env.session.loadPlan(plan([task('t1', 1), task('t2', 2)]), 'goal', testWorkspace, { persist: false });
    return env;
  }

  it.each([
    ['run_plan', idle, { command: 'run_plan' }, 'Started the plan — by supervisor.'],
    ['run_task', idle, { command: 'run_task', task: 't2' }, 'Started task #2 "Task t2" — by supervisor.'],
    ['stop_task', guarded, { command: 'stop_task', task: 't1' }, 'Stopped task #1 "Task t1" — by supervisor.'],
    ['stop_run', guarded, { command: 'stop_run' }, 'Stopped the run — by supervisor.'],
    ['retry_task', failed, { command: 'retry_task', task: 't1', from: 'session', message: 'fix the import' }, 'Continued task #1 "Task t1" in its saved session — by supervisor: "fix the import"'],
    ['message_task', guarded, { command: 'message_task', task: 't1', text: 'use the cache' }, 'Sent task #1 "Task t1" a message — by supervisor: "use the cache"'],
    ['answer_approval (deny)', asking, { command: 'answer_approval', task: 't1', answer: 'deny', note: 'push without --force' }, 'Denied a request of task #1 "Task t1" — by supervisor, with the note "push without --force".'],
    ['answer_approval (escalate)', asking, { command: 'answer_approval', task: 't1', answer: 'escalate' }, 'Left a request of task #1 "Task t1" for you to answer — by supervisor.'],
  ] as const)('runs %s without asking anyone, even in Guarded, and the timeline reads like the button press, by supervisor', async (_name, arrange, command, line) => {
    const env = await arrange();

    const outcome = await env.run(command as ExecutionCommand, ACT);

    expect(outcome).toMatchObject({ ok: true });
    expect(env.cards()).toHaveLength(0);
    expect(env.timeline().at(-1)).toMatchObject({ record: { actor: 'supervisor', level: 'act', outcome: 'done' }, text: line });
  });

  it('still never allows an approval', async () => {
    const env = await asking();

    expect(await env.run({ command: 'answer_approval', task: 't1', answer: 'allow' }, ACT)).toMatchObject({ ok: false, message: expect.stringContaining('answer_approval never allows') });
    expect(env.session.outstandingApprovals()).toHaveLength(1);
  });

  it('still starts no task the user did not approve, unless the supervisor added it', async () => {
    const env = await guarded();
    env.session.loadPlan(plan([task('t1', 1), task('t9', 2)], { approvedTasks: ['t1'] }), 'goal', testWorkspace, { persist: false });

    expect(await env.run({ command: 'run_task', task: 't9' }, ACT)).toMatchObject({ ok: false, message: expect.stringMatching(/added after the user approved the plan/) });
    expect(env.spawned('t9')).toHaveLength(0);
  });
});

describe('the command seam: skip_task', () => {
  const ACT: ExecutionActor = { kind: 'supervisor', level: 'act' };

  /** Task 1 failed, so task 2, which depends on it, is blocked. */
  async function failed() {
    const env = await running({ autonomous: false });
    env.latest('t1').reportComplete({ status: 'failed', summary: '', reason: 'broke' });
    await vi.waitFor(() => expect(taskOf(env.session, 't1')!.status).toBe('failed'));
    return env;
  }

  it('skips a failed task for a supervisor at Act, without asking, and the dependents go ahead', async () => {
    const env = await failed();

    const outcome = await env.run({ command: 'skip_task', task: '1', reason: 'the host cannot run it' }, ACT);

    expect(outcome).toEqual({ ok: true, message: 'Skipped task #1 "Task t1": none of its work lands, and the tasks that depend on it go ahead without it, told why.' });
    expect(taskOf(env.session, 't1')!.status).toBe('skipped');
    expect(env.cards()).toHaveLength(0);
    await vi.waitFor(() => expect(env.spawned('t2')).toHaveLength(1));
    expect(env.timeline().at(-1)).toMatchObject({
      record: { command: 'skip_task', actor: 'supervisor', level: 'act', outcome: 'done', detail: 'the host cannot run it' },
      text: 'Skipped task #1 "Task t1" — by supervisor: "the host cannot run it"',
    });
  });

  it('skips a blocked task and one waiting for input for a supervisor at Act', async () => {
    const env = setup();
    env.session.loadPlan(plan([task('t1', 1), task('t2', 2, { dependencies: ['t1'] }), task('t3', 3)]), 'goal', testWorkspace, { persist: false });
    await env.session.executePlan();
    env.latest('t1').reportComplete({ status: 'failed', summary: '', reason: 'broke' });
    env.latest('t3').waitForInput();
    await vi.waitFor(() => expect(taskOf(env.session, 't3')!.status).toBe('awaiting_user'));

    expect(await env.run({ command: 'skip_task', task: '2', reason: 'not needed now' }, ACT)).toMatchObject({ ok: true });
    expect(await env.run({ command: 'skip_task', task: '3', reason: 'it asks what nobody can answer' }, ACT)).toMatchObject({ ok: true });
    expect(taskOf(env.session, 't2')!.status).toBe('skipped');
    expect(taskOf(env.session, 't3')!.status).toBe('skipped');
  });

  it.each<[string, ExecutionActor, RegExp]>([
    ['a supervisor at Watch', { kind: 'supervisor', level: 'watch' }, /at Watch.*Suggest it to the user instead/],
    ['a supervisor that is off', { kind: 'supervisor', level: 'off' }, /supervisor is off for this run/],
    ['a planner turn the user started', PLANNER, /^Skipping a task is the user's in their own turn/],
  ])('is refused to %s, and skips nothing', async (_who, actor, reason) => {
    const env = await failed();

    expect(await env.run({ command: 'skip_task', task: '1', reason: 'not needed' }, actor)).toMatchObject({ ok: false, outcome: 'refused', message: expect.stringMatching(reason) });
    expect(taskOf(env.session, 't1')!.status).toBe('failed');
  });

  it('refuses the supervisor a skip without a reason: the dependents are told it', async () => {
    const env = await failed();

    const outcome = await env.run({ command: 'skip_task', task: '1', reason: '  ' }, ACT);

    expect(outcome).toEqual({ ok: false, outcome: 'refused', message: 'Skipping task #1 "Task t1" needs a reason: it is shown to the user and told to the tasks that depend on it.' });
    expect(taskOf(env.session, 't1')!.status).toBe('failed');
  });

  it('refuses the supervisor a running task, a completed one and one that waits on nothing', async () => {
    const env = await running();

    expect((await env.run({ command: 'skip_task', task: '1', reason: 'slow' }, ACT)).message).toBe('Task #1 "Task t1" is running: stop it first with stop_task, or let it finish.');
    expect((await env.run({ command: 'skip_task', task: '2', reason: 'later' }, ACT)).message).toBe('Task #2 "Task t2" has not started and nothing blocks it: the supervisor skips only a task that failed, is blocked or is waiting for input.');
    env.latest('t1').reportComplete({ status: 'done', summary: '' });
    await vi.waitFor(() => expect(taskOf(env.session, 't1')!.status).toBe('completed'));
    expect((await env.run({ command: 'skip_task', task: '1', reason: 'done' }, ACT)).message).toBe('Task #1 "Task t1" has completed: its work landed, so there is nothing to skip.');
  });

  it('skips for the user without a reason, as their Skip button does', async () => {
    const env = await failed();

    expect(await env.run({ command: 'skip_task', task: 't1' }, { kind: 'user' })).toMatchObject({ ok: true });
    expect(taskOf(env.session, 't1')!.status).toBe('skipped');
    expect(env.timeline().at(-1)!.text).toBe('You skipped task #1 "Task t1".');
  });
});

describe('the command seam: merge_all', () => {
  /** A run whose change task landed, so its ops task waits for Merge all at its gate. */
  async function landed(mergeResult?: FakeWorktreeIsolation['mergeResult']) {
    const isolation = new FakeWorktreeIsolation();
    if (mergeResult) isolation.mergeResult = mergeResult;
    const env = setup({ isolation });
    env.session.loadPlan(plan([task('t1', 1), task('o2', 2, { ops: true, dependencies: ['t1'] })]), 'goal', testWorkspace, { persist: false });
    await env.session.executePlan();
    env.latest('t1').reportComplete({ status: 'done', summary: '' });
    await vi.waitFor(() => expect(env.session.mergeGate('o2')).toEqual(['t1']));
    return { ...env, merges: () => isolation.calls.filter((c) => c.op === 'mergeIntoCheckedOut').length };
  }

  it.each<[string, ExecutionActor, RegExp]>([
    ['a planner turn the user started', PLANNER, /^Merge all is the user's: they are in this conversation/],
    ['a supervisor at Watch', { kind: 'supervisor', level: 'watch' }, /at Watch/],
    ['a supervisor that is off', { kind: 'supervisor', level: 'off' }, /supervisor is off for this run/],
  ])('is refused to %s, and merges nothing', async (_who, actor, reason) => {
    const env = await landed();

    expect(await env.run({ command: 'merge_all' }, actor)).toMatchObject({ ok: false, outcome: 'refused', message: expect.stringMatching(reason) });
    expect(env.merges()).toBe(0);
    expect(env.session.mergeGate('o2')).toEqual(['t1']);
  });

  it('merges for a supervisor at Act, without asking, and the timeline says so', async () => {
    const env = await landed();

    expect(await env.run({ command: 'merge_all' }, { kind: 'supervisor', level: 'act' })).toEqual({ ok: true, message: 'Merged the run\'s landed work into the user\'s branch. Tasks waiting at a merge gate for it can start.' });
    expect(env.merges()).toBe(1);
    expect(env.session.mergeGate('o2')).toEqual([]);
    expect(env.timeline().at(-1)!.text).toBe('Merged the run\'s work into your branch — by supervisor.');
  });

  it('refuses with the reason when the merge stops, and the gate keeps waiting', async () => {
    const env = await landed({ outcome: 'conflict', repo: '.', files: ['src/a.ts'] });

    expect(await env.run({ command: 'merge_all' }, { kind: 'supervisor', level: 'act' })).toEqual({
      ok: false, outcome: 'refused', message: 'Merge all stopped: it conflicts in .: src/a.ts. Nothing was merged; tell the user, who resolves it.',
    });
    expect(env.session.mergeGate('o2')).toEqual(['t1']);
  });

});

describe('the command seam\'s extension points', () => {
  const admission = () => ({ current: () => true, release: vi.fn() });

  function stubHost(): ExecutionHost {
    const tasks = [task('t1', 1)];
    return {
      tasks: () => tasks, planApproved: () => true, taskApproved: () => true, approve: vi.fn(), autonomous: () => true, autorun: () => false,
      scheduling: () => false, startsHeld: () => false, hasLiveWork: () => true, startsPending: () => false, admitStart: admission,
      running: () => true, maxParallel: () => 3, runBlocked: () => false,
      dependencyMet: () => true, mergeGate: () => [], blockedBy: () => [], waitingRequests: () => [],
      runPlan: vi.fn(), startTask: vi.fn(), stopTask: vi.fn(async () => {}), stopRun: vi.fn(), retryTask: vi.fn(), skipTask: vi.fn(), continueTask: vi.fn(), resumeNow: vi.fn(),
      messageTask: vi.fn(), denyRequest: vi.fn(), mergeAll: vi.fn(), record: vi.fn(), guardTripped: vi.fn(), heldEdit: () => false, editedTasks: () => tasks, deferUntilLanded: vi.fn(), queuedNotRun: vi.fn(),
    };
  }

  it('asks the supervisor policy, given the level and the command', async () => {
    const host = stubHost();
    const supervisor = vi.fn(() => ({ kind: 'allow' as const }));
    const commands = new ExecutionCommands({ host, consent: { request: vi.fn() }, supervisor });

    expect(await commands.run({ command: 'stop_task', task: 't1' }, { kind: 'supervisor', level: 'act' })).toMatchObject({ ok: true });
    expect(supervisor).toHaveBeenCalledWith('act', 'stop_task');
    expect(host.stopTask).toHaveBeenCalledWith('t1');
  });

  it('refuses a call a loop guard trips, with its note, tells the user, and runs nothing', async () => {
    const host = stubHost();
    const trip = { key: 'retry-limit:t1', refusal: 'Retried twice already: change the prompt or the model first.', escalation: 'I retried task 1 twice.' };
    const guard = vi.fn(() => trip);
    const commands = new ExecutionCommands({ host, consent: { request: vi.fn() }, guards: [guard] });

    expect(await commands.run({ command: 'stop_task', task: 't1' }, PLANNER)).toEqual({
      ok: false, outcome: 'refused', message: 'Retried twice already: change the prompt or the model first.',
    });
    expect(guard).toHaveBeenCalledWith(PLANNER, { command: 'stop_task', task: 't1' }, { task: expect.objectContaining({ id: 't1' }), ref: '#1', paused: false });
    expect(host.guardTripped).toHaveBeenCalledWith(trip);
    expect(host.stopTask).not.toHaveBeenCalled();
  });

  it('holds a start the turn\'s own edit changes until the edit lands, and starts nothing now', async () => {
    const host = { ...stubHost(), running: () => false, hasLiveWork: () => false, heldEdit: vi.fn(() => true) };
    const commands = new ExecutionCommands({ host, consent: { request: vi.fn() } });
    const retry: ExecutionCommand = { command: 'retry_task', task: 't1', from: 'fresh' };

    expect(await commands.run(retry, PLANNER)).toMatchObject({ ok: true, message: expect.stringMatching(/^Queued: retry task #1 "Task t1" happens once your edit lands/) });
    expect(host.heldEdit).toHaveBeenCalledWith('t1');
    expect(host.deferUntilLanded).toHaveBeenCalledWith(retry, PLANNER, 'retry task #1 "Task t1"', expect.objectContaining({ current: expect.any(Function) }));
    expect(host.startTask).not.toHaveBeenCalled();
    expect(host.retryTask).not.toHaveBeenCalled();
  });

  // Seen live: the planner added a task and started it in the same turn, and was told only that no task matched.
  it('says why a task the turn\'s own edit adds cannot start yet', async () => {
    const host = { ...stubHost(), running: () => false, hasLiveWork: () => false, heldEdit: vi.fn(() => true) };
    const commands = new ExecutionCommands({ host, consent: { request: vi.fn() } });

    const outcome = await commands.run({ command: 'run_task', task: 'Add divide' }, PLANNER);

    expect(outcome).toMatchObject({ ok: false, outcome: 'refused', message: expect.stringContaining('lands as this reply ends') });
    expect(outcome.message).toMatch(/^No task matches "Add divide" in the current plan\./);
    expect(host.heldEdit).toHaveBeenCalledWith();
    expect(host.startTask).not.toHaveBeenCalled();
  });

  it('with autorun on and Full, holds a start of a task the turn\'s own edit adds until the edit lands', async () => {
    const edited = [task('t1', 1), task('t2', 2, { title: 'Add divide' })];
    const host = { ...stubHost(), autorun: () => true, running: () => false, hasLiveWork: () => false, heldEdit: vi.fn(() => true), editedTasks: () => edited };
    const commands = new ExecutionCommands({ host, consent: { request: vi.fn() } });
    const start: ExecutionCommand = { command: 'run_task', task: 'Add divide' };

    expect(await commands.run(start, PLANNER)).toMatchObject({ ok: true, message: expect.stringMatching(/^Queued: start task #2 "Add divide" happens once your edit lands/) });
    expect(host.deferUntilLanded).toHaveBeenCalledWith(start, PLANNER, 'start task #2 "Add divide"', expect.objectContaining({ current: expect.any(Function) }));
    expect(host.record).not.toHaveBeenCalled();
  });

  it('with autorun on and Full, starts an unapproved task the planner asks for, and approves it with its subtasks', async () => {
    const host = { ...stubHost(), autorun: () => true, running: () => false, hasLiveWork: () => false, taskApproved: () => false };
    const commands = new ExecutionCommands({ host, consent: { request: vi.fn() } });

    expect(await commands.run({ command: 'run_task', task: 't1' }, PLANNER)).toMatchObject({ ok: true });
    expect(host.startTask).toHaveBeenCalledWith('t1', PLANNER);
    expect(host.approve).toHaveBeenCalledWith(['t1']);
  });

  it('never lets the supervisor start an unapproved task on the autorun exception', async () => {
    const host = { ...stubHost(), autorun: () => true, running: () => false, hasLiveWork: () => false, taskApproved: () => false };
    const commands = new ExecutionCommands({ host, consent: { request: vi.fn() } });

    expect(await commands.run({ command: 'run_task', task: 't1' }, { kind: 'supervisor', level: 'act' })).toMatchObject({ ok: false, outcome: 'refused' });
    expect(host.startTask).not.toHaveBeenCalled();
  });

  it('in Guarded, refuses the supervisor\'s start of a task the user has not approved, without asking', async () => {
    const host = { ...stubHost(), autonomous: () => false, running: () => false, hasLiveWork: () => false, taskApproved: () => false };
    const request = vi.fn(async () => true);
    const commands = new ExecutionCommands({ host, consent: { request }, supervisor: () => ({ kind: 'ask' }) });

    expect(await commands.run({ command: 'run_task', task: 't1' }, { kind: 'supervisor', level: 'act' })).toEqual({
      ok: false, outcome: 'refused', message: 'Task #1 "Task t1" was added after the user approved the plan, so it is not approved to run. Ask the user to start it, or to execute the plan, which approves it.',
    });
    expect(request).not.toHaveBeenCalled();
  });

  // Seen live: run_plan behind an edit adding tasks answered Queued, and was refused only after the reply ended.
  it('refuses at once a run of the plan behind the turn\'s own edit that adds tasks it may not start', async () => {
    const edited = [task('t1', 1), task('t2', 2, { title: 'Add divide' })];
    const host = { ...stubHost(), running: () => false, hasLiveWork: () => false, heldEdit: () => true, editedTasks: () => edited, taskApproved: (id: string) => id === 't1' };
    const commands = new ExecutionCommands({ host, consent: { request: vi.fn() } });

    expect(await commands.run({ command: 'run_plan' }, PLANNER)).toEqual({
      ok: false, outcome: 'refused', message: 'Task #2 "Add divide" was added after the user approved the plan, so it is not approved to run. Ask the user to execute the plan themselves, which approves it.',
    });
    expect(host.deferUntilLanded).not.toHaveBeenCalled();
  });

  it('refuses at once a start of a task the turn\'s own edit removes, rather than queueing it', async () => {
    const host = { ...stubHost(), running: () => false, hasLiveWork: () => false, heldEdit: () => true, editedTasks: () => [] };
    const commands = new ExecutionCommands({ host, consent: { request: vi.fn() } });

    expect(await commands.run({ command: 'run_task', task: 't1' }, PLANNER)).toEqual({
      ok: false, outcome: 'refused', message: 'Task #1 "Task t1" is removed by your edit, so it cannot start.',
    });
    expect(host.deferUntilLanded).not.toHaveBeenCalled();
  });

  it('keeps a replayed start that throws as refused, and says it did not run', async () => {
    const host = { ...stubHost(), autonomous: () => false, running: () => false, hasLiveWork: () => false };
    const commands = new ExecutionCommands({ host, consent: { request: vi.fn(async () => { throw new Error('the approval card was closed'); }) } });

    await commands.replay({ command: 'run_task', task: 't1' }, PLANNER, admission());

    expect(host.record).toHaveBeenCalledWith(expect.objectContaining({ command: 'run_task', outcome: 'refused', detail: 'the approval card was closed' }), expect.any(String));
    expect(host.queuedNotRun).toHaveBeenCalledWith('The queued start of task #1 "Task t1" did not run: the approval card was closed');
    expect(host.startTask).not.toHaveBeenCalled();
  });

  it('says nothing more of a replayed start that ran', async () => {
    const host = { ...stubHost(), running: () => false, hasLiveWork: () => false };
    const commands = new ExecutionCommands({ host, consent: { request: vi.fn() } });

    await commands.replay({ command: 'retry_task', task: 't1', from: 'fresh' }, PLANNER, admission());

    expect(host.startTask).toHaveBeenCalledWith('t1', PLANNER);
    expect(host.queuedNotRun).not.toHaveBeenCalled();
  });

  it('refuses a replayed start a Stop withdrew while it was queued, before judging it again, and says it was stopped', async () => {
    const host = { ...stubHost(), running: () => false, hasLiveWork: () => false };
    const commands = new ExecutionCommands({ host, consent: { request: vi.fn() } });

    await commands.replay({ command: 'run_task', task: 't1' }, PLANNER, { current: () => false, release: vi.fn() });

    expect(host.record).toHaveBeenCalledWith(expect.objectContaining({ command: 'run_task', outcome: 'refused', detail: STOPPED_BEFORE_START }), expect.any(String));
    expect(host.queuedNotRun).toHaveBeenCalledWith('Not done: the queued start of task #1 "Task t1" was stopped before it could start.');
    expect(host.startTask).not.toHaveBeenCalled();
  });

  it('names no held edit when there is none', async () => {
    const commands = new ExecutionCommands({ host: stubHost(), consent: { request: vi.fn() } });

    expect((await commands.run({ command: 'run_task', task: 'Add divide' }, PLANNER)).message).not.toContain('reply ends');
  });

});
