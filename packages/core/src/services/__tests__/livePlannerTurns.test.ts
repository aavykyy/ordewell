import { describe, it, expect, vi } from 'vitest';
import { createTask, type LegacyPlanState, type Task } from '../../models/Task';
import type { IRunner } from '../../interfaces/IRunner';
import type { ConversationTurn } from '../AiService';
import { PlannerTurnDiscardedError } from '../PlannerConversation';
import { FakeRunnerSession, makeSession, saves, taskOf, testWorkspace } from './sessionTestKit';
import { fromTranscript } from '../../conversation/transcript';

/** A live planner whose replies the test hands back one at a time. */
function heldPlanner() {
  const calls: { message: string; finish: (turn: ConversationTurn) => void; fail: (err: unknown) => void }[] = [];
  const aiService = {
    startConversation: vi.fn(),
    hasActiveConversation: () => true,
    continueConversation: vi.fn((message: string) => new Promise<ConversationTurn>((resolve, reject) => {
      calls.push({ message, finish: resolve, fail: reject });
    })),
    reset: vi.fn(),
  };
  return { aiService, calls };
}

function recordingRunner() {
  const sessions = new Map<string, FakeRunnerSession>();
  const runner = {
    spawn: vi.fn(async ({ taskId }: { taskId: string; prompt: string }) => {
      const s = new FakeRunnerSession(`s-${taskId}-${sessions.size + 1}`, taskId);
      sessions.set(taskId, s);
      return s;
    }),
    stop: vi.fn(),
    stopAll: vi.fn(),
    activeCount: 0,
  } satisfies IRunner;
  const spawnedIds = () => runner.spawn.mock.calls.map(([opts]) => opts.taskId);
  const promptOf = (taskId: string) => runner.spawn.mock.calls.find(([opts]) => opts.taskId === taskId)?.[0].prompt;
  const finish = (taskId: string) => {
    const s = sessions.get(taskId)!;
    s.reportComplete({ status: 'done', summary: '' });
    s.emitExit(0);
  };
  return { runner, spawnedIds, promptOf, finish };
}

function runPlan(tasks: Task[]): LegacyPlanState {
  const now = new Date().toISOString();
  return {
    tasks,
    generatedAt: now,
    status: 'approved',
    runners: ['claude-code'],
    lastUpdated: now,
    conversationHistory: [
      { role: 'user', content: 'build it', timestamp: '2026-10-11T00:00:00Z' },
      { role: 'assistant', content: `Plan generated with ${tasks.length} tasks.`, timestamp: '2026-10-11T00:00:01Z', kind: 'plan_generated' },
    ],
  };
}

const first = () => createTask({ id: 't1', order: 1, title: 'First', prompt: 'do first', assignedRunner: 'claude-code' });
const second = () => createTask({ id: 't2', order: 2, title: 'Second', prompt: 'do second', dependencies: ['t1'], assignedRunner: 'claude-code' });

const prose = (text: string): ConversationTurn => ({ kind: 'message', text, researchLog: [] });
const ops = (...taskOps: Extract<ConversationTurn, { kind: 'task_ops' }>['ops']): ConversationTurn => ({ kind: 'task_ops', ops: taskOps, text: '', researchLog: [] });

/** A run with task 1 executing and task 2 waiting on it. */
async function liveRun() {
  const planner = heldPlanner();
  const run = recordingRunner();
  const session = makeSession({ aiService: planner.aiService, runner: run.runner });
  session.loadPlan(runPlan([first(), second()]), 'build it', testWorkspace);
  await session.executePlan();
  expect(run.spawnedIds()).toEqual(['t1']);
  return { session, ...planner, ...run };
}

describe('live planner turns during a run', () => {
  it('drops a failed turn from the rebuilt view and lets the user resend it', async () => {
    const { session, calls } = await liveRun();
    const snapshots: LegacyPlanState[] = [];
    saves(session).mockImplementation((plan) => { snapshots.push(structuredClone(plan)); });
    const rebuilt = () => {
      const plan = session.planState!;
      return fromTranscript(plan.conversationHistory, plan.researchLog, plan.plannerUsage, plan.pendingTurns).blocks
        .flatMap((b) => b.type === 'message' && b.role === 'user' ? [b.text] : []);
    };
    const answered = session.continueConversation('check the tests');
    expect(rebuilt()).toEqual(['build it', 'check the tests']);
    calls[0].fail(new Error('planner down'));
    await expect(answered).rejects.toThrow('planner down');
    expect(rebuilt()).toEqual(['build it']);
    const saved = snapshots.at(-1)!;
    expect(fromTranscript(saved.conversationHistory, saved.researchLog, saved.plannerUsage, saved.pendingTurns).blocks
      .flatMap((b) => b.type === 'message' && b.role === 'user' ? [b.text] : [])).toEqual(['build it']);

    const resent = session.continueConversation('check the tests');
    calls[1].finish(prose('Tests passed.'));
    await resent;
    expect(rebuilt()).toEqual(['build it', 'check the tests']);
  });

  it('answers a message at once while the running task carries on', async () => {
    const { session, calls } = await liveRun();

    const answered = session.continueConversation('why is task 1 slow?');

    expect(calls).toHaveLength(1);
    expect(calls[0].message).toMatch(/why is task 1 slow\?$/);
    expect(session.isExecuting).toBe(true);
    calls[0].finish(prose('It is installing dependencies.'));
    await answered;
    expect(taskOf(session, 't1')!.status).toBe('in_progress');
  });

  it('starts no new task while the turn is in flight, and starts it when the turn ends', async () => {
    const { session, calls, spawnedIds, finish } = await liveRun();
    const answered = session.continueConversation('how is it going?');

    finish('t1');
    await vi.waitFor(() => expect(taskOf(session, 't1')!.status).toBe('completed'));
    expect(spawnedIds()).toEqual(['t1']);

    calls[0].finish(prose('Task 1 is done.'));
    await answered;
    expect(spawnedIds()).toEqual(['t1', 't2']);
  });

  it('lets new starts go when the turn fails', async () => {
    const { session, calls, spawnedIds, finish } = await liveRun();
    const answered = session.continueConversation('how is it going?');
    finish('t1');
    await vi.waitFor(() => expect(taskOf(session, 't1')!.status).toBe('completed'));

    calls[0].fail(new Error('planner down'));

    await expect(answered).rejects.toThrow('planner down');
    await vi.waitFor(() => expect(spawnedIds()).toEqual(['t1', 't2']));
  });

  it('keeps a run a failure halted through an edit to the failed task, so its retry resumes the run', async () => {
    const { session, calls, runner, spawnedIds, finish } = await liveRun();
    runner.spawn.mock.results[0].value.then((s: FakeRunnerSession) => s.reportComplete({ status: 'failed', summary: '', reason: 'wrong import' }));
    await vi.waitFor(() => expect(taskOf(session, 't1')!.status).toBe('failed'));

    const answered = session.continueConversation('fix the import in task 1');
    calls[0].finish(ops({ op: 'update', taskId: 't1', changes: { prompt: 'do first, importing from ./lib' } }));
    await answered;
    expect(taskOf(session, 't1')).toMatchObject({ prompt: 'do first, importing from ./lib', status: 'failed' });

    await session.retryTask('t1');
    await vi.waitFor(() => expect(spawnedIds()).toEqual(['t1', 't1']));
    finish('t1');
    await vi.waitFor(() => expect(spawnedIds()).toEqual(['t1', 't1', 't2']));
  });

  it('applies an edit to a task that has not started before it starts', async () => {
    const { session, calls, spawnedIds, promptOf, finish } = await liveRun();
    const answered = session.continueConversation('make task 2 add tests too');
    finish('t1');
    await vi.waitFor(() => expect(taskOf(session, 't1')!.status).toBe('completed'));

    calls[0].finish(ops({ op: 'update', taskId: '#2', changes: { prompt: 'do second, with tests' } }));
    await answered;

    expect(spawnedIds()).toEqual(['t1', 't2']);
    expect(promptOf('t2')).toContain('do second, with tests');
  });

  it.each([
    ['running', () => [first(), second()], '#1', /"First" is running and cannot be modified now: the user can stop it first, or change it after it finishes/],
    ['completed', () => [createTask({ ...first(), status: 'completed' }), createTask({ ...second(), dependencies: [] })], '#1', /"First" is completed and cannot be modified: rearm it to run it again, or add a new task for further work/],
  ] as const)('refuses an edit aimed at a %s task with a note the planner can act on', async (_status, tasks, ref, note) => {
    const { aiService, calls } = heldPlanner();
    const run = recordingRunner();
    const session = makeSession({ aiService, runner: run.runner });
    session.loadPlan(runPlan(tasks()), 'build it', testWorkspace);
    await session.executePlan();
    expect(session.isExecuting).toBe(true);

    const answered = session.continueConversation('rename task 1');
    calls[0].finish(ops({ op: 'update', taskId: ref, changes: { title: 'Renamed' } }));
    await vi.waitFor(() => expect(calls).toHaveLength(2));
    expect(calls[1].message).toMatch(note);
    calls[1].finish(prose('Task 1 cannot be renamed now; stop it first or wait for it to finish.'));
    await answered;

    expect(taskOf(session, 't1')!.title).toBe('First');
  });

  it('refuses the whole batch when one of its ops reaches a running task', async () => {
    const { session, calls } = await liveRun();
    const answered = session.continueConversation('rename both');
    calls[0].finish(ops(
      { op: 'update', taskId: '#2', changes: { title: 'Second, renamed' } },
      { op: 'update', taskId: '#1', changes: { title: 'First, renamed' } },
    ));
    await vi.waitFor(() => expect(calls).toHaveLength(2));
    calls[1].finish(prose('Only task 2 can change now.'));
    await answered;

    expect(taskOf(session, 't1')!.title).toBe('First');
    expect(taskOf(session, 't2')!.title).toBe('Second');
  });

  it('refuses a whole new plan while tasks run, asking for task edits instead', async () => {
    const { session, calls } = await liveRun();
    const answered = session.continueConversation('start over');
    calls[0].finish({ kind: 'plan', tasks: [createTask({ id: 'n1', order: 1, title: 'New', prompt: 'new' })], text: '', researchLog: [] });
    await vi.waitFor(() => expect(calls).toHaveLength(2));
    expect(calls[1].message).toMatch(/Tasks are running, so a whole new plan cannot replace this one now/);
    calls[1].finish(prose('I will edit the pending tasks instead.'));
    await answered;

    expect(session.planTasks.map((t) => t.id)).toEqual(['t1', 't2']);
    expect(taskOf(session, 't1')!.status).toBe('in_progress');
  });

  it('takes messages sent during a turn together in the next one', async () => {
    const { session, calls } = await liveRun();
    const one = session.continueConversation('one');
    const two = session.continueConversation('two');
    const three = session.continueConversation('three');
    expect(calls).toHaveLength(1);

    calls[0].finish(prose('Noted one.'));
    await one;
    await vi.waitFor(() => expect(calls).toHaveLength(2));
    expect(calls[1].message).toMatch(/two\n\nthree$/);
    calls[1].finish(prose('Noted two and three.'));
    await Promise.all([two, three]);
    expect(calls).toHaveLength(2);
  });

  it('saves a message until the change it made is saved, in that same save', async () => {
    const { session, calls } = await liveRun();
    const snapshots: LegacyPlanState[] = [];
    saves(session).mockImplementation((plan) => { snapshots.push(structuredClone(plan)); });

    const answered = session.continueConversation('rename task 2');
    expect(snapshots.at(-1)!.pendingTurns?.map((t) => t.text)).toEqual(['rename task 2']);
    calls[0].finish(ops({ op: 'update', taskId: '#2', changes: { title: 'Second, renamed' } }));
    await answered;

    const renamed = (p: LegacyPlanState) => p.tasks.some((t) => t.title === 'Second, renamed');
    const pending = (p: LegacyPlanState) => (p.pendingTurns ?? []).length > 0;
    expect(snapshots.some((p) => renamed(p) && pending(p))).toBe(false);
    expect(snapshots.some((p) => !renamed(p) && !pending(p))).toBe(false);
    expect(snapshots.at(-1)!.pendingTurns).toEqual([]);
  });

  it('replays a message a background save caught mid-turn exactly once', async () => {
    const { session, calls, finish } = await liveRun();

    const answered = session.continueConversation('rename task 2');
    // A task settles while the turn is in flight, so the daemon saves the plan
    // with the message still un-answered.
    finish('t1');
    await vi.waitFor(() => expect(taskOf(session, 't1')!.status).toBe('completed'));
    const savedMidTurn = structuredClone(saves(session).mock.calls.at(-1)![0]);
    expect(savedMidTurn.pendingTurns?.map((t) => t.text)).toEqual(['rename task 2']);

    session.loadPlan(savedMidTurn, 'build it', testWorkspace);
    await expect(answered).rejects.toBeInstanceOf(PlannerTurnDiscardedError);
    expect(calls).toHaveLength(2);
    calls[1].finish(prose('Noted.'));
    await vi.waitFor(() => expect(session.isPlannerBusy).toBe(false));

    const said = (session.planState!.conversationHistory ?? []).filter((e) => e.content === 'rename task 2');
    expect(said).toHaveLength(1);
  });

  it('replays a message no turn answered once, after a reload', async () => {
    const { aiService, calls } = heldPlanner();
    const session = makeSession({ aiService });
    const saved = runPlan([createTask({ ...first(), status: 'completed' }), second()]);
    saved.pendingTurns = [{ id: 'turn-1', source: 'user', text: 'rename task 2', timestamp: '2026-10-11T00:00:02Z' }];
    const snapshots: LegacyPlanState[] = [];
    saves(session).mockImplementation((plan) => { snapshots.push(structuredClone(plan)); });

    session.loadPlan(saved, 'build it', testWorkspace);
    expect(calls).toHaveLength(1);
    expect(calls[0].message).toMatch(/rename task 2$/);
    calls[0].finish(ops({ op: 'update', taskId: '#2', changes: { title: 'Second, renamed' } }));
    await vi.waitFor(() => expect(taskOf(session, 't2')!.title).toBe('Second, renamed'));
    await vi.waitFor(() => expect(session.isPlannerBusy).toBe(false));

    session.loadPlan(structuredClone(snapshots.at(-1)!), 'build it', testWorkspace);
    expect(calls).toHaveLength(1);
  });

  it('carries a mid-run edit an older build queued over as a turn', () => {
    const { aiService, calls } = heldPlanner();
    const session = makeSession({ aiService });
    const saved = runPlan([first(), second()]);
    saved.queuedMessages = [{ id: 'q-1', text: 'rename task 2', timestamp: '2026-10-11T00:00:02Z' }];

    session.loadPlan(saved, 'build it', testWorkspace);

    expect(calls).toHaveLength(1);
    expect(calls[0].message).toMatch(/rename task 2$/);
    expect(session.planState!.queuedMessages).toBeUndefined();
    expect(session.planState!.pendingTurns?.map((t) => t.source)).toEqual(['user']);
  });

  it('on a plan swap mid-turn lets the hold go and lands nothing of the turn', async () => {
    const { session, calls, spawnedIds } = await liveRun();
    const answered = session.continueConversation('rename task 2');
    const other = runPlan([createTask({ id: 'o1', order: 1, title: 'Other', prompt: 'other', assignedRunner: 'claude-code' })]);

    session.loadPlan(other, 'other', testWorkspace);
    await expect(answered).rejects.toBeInstanceOf(PlannerTurnDiscardedError);
    calls[0].finish(ops({ op: 'update', taskId: '#1', changes: { title: 'Renamed in the old plan' } }));

    await session.executePlan();
    expect(spawnedIds()).toEqual(['t1', 'o1']);
    expect(taskOf(session, 'o1')!.title).toBe('Other');
    expect(other.conversationHistory).toHaveLength(2);
  });
});
