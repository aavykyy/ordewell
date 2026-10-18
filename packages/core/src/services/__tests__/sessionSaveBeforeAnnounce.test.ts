import { describe, it, expect, vi } from 'vitest';
import { makeSession, FakeRunnerSession, type SessionOverrides } from './sessionTestKit';
import { fakeConfig, FakeWorktreeIsolation } from '../../testing';
import { createTask, flattenTasks, type LegacyPlanState, type Task } from '../../models/Task';
import type { IRunner, IRunnerSession } from '../../interfaces/IRunner';
import type { IConfig } from '../../interfaces/IConfig';
import type { ConversationTurn } from '../AiService';
import type { Session } from '../createSession';
import type { SessionMessage } from '../SessionMessage';

const task = (id: string, order: number, over: Partial<Task> = {}) =>
  createTask({ id, order, title: `Task ${id}`, prompt: `do ${id}`, ...over });

function plan(tasks: Task[]): LegacyPlanState {
  const now = new Date().toISOString();
  return { tasks, generatedAt: now, status: 'approved', runners: ['claude-code'], lastUpdated: now };
}

const statuses = (tasks: ReadonlyArray<{ id: string; status: string }>) =>
  tasks.map((t) => `${t.id}:${t.status}`).sort().join(' ');

/**
 * A Session whose every save and status announcement is recorded in order,
 * each with the task statuses it carried.
 */
function setup(tasks: Task[], opts: {
  isolation?: FakeWorktreeIsolation;
  config?: IConfig;
  aiService?: SessionOverrides['aiService'];
} = {}) {
  const runnerSessions: FakeRunnerSession[] = [];
  const runner = {
    spawn: vi.fn(async (spawn: { taskId: string }) => {
      const id = `s${runnerSessions.length + 1}`;
      const t = new FakeRunnerSession(id, spawn.taskId);
      runnerSessions.push(t);
      return t;
    }),
    stop: vi.fn(),
    stopAll: vi.fn(),
    activeCount: 0,
  } satisfies IRunner;
  const seen: { kind: 'save' | 'status'; statuses: string }[] = [];
  const messages: SessionMessage[] = [];
  /** Every save and every message, in order. */
  const events: string[] = [];
  // How many timeline records the disk held as each one was announced.
  let savedRecords = 0;
  const recordsAtAnnounce: number[] = [];
  const session = makeSession({
    runner,
    isolation: opts.isolation ?? new FakeWorktreeIsolation(),
    config: opts.config,
    aiService: opts.aiService,
    saveSession: (p) => {
      events.push('save');
      seen.push({ kind: 'save', statuses: statuses(flattenTasks(p.tasks)) });
      savedRecords = (p.conversationHistory ?? []).filter((e) => e.kind === 'execution').length;
    },
    broadcast: (m) => {
      events.push(m.type);
      messages.push(m);
      if (m.type === 'execution_action') recordsAtAnnounce.push(savedRecords);
      if (m.type === 'status_update') seen.push({ kind: 'status', statuses: statuses(m.tasks) });
    },
  });
  session.loadPlan(plan(tasks), 'goal', '/repo', { persist: false });
  const runnerSession = (taskId: string) => runnerSessions.find((t) => t.taskId === taskId)!;
  return { session, seen, messages, events, runnerSession, recordsAtAnnounce };
}

/**
 * Run one user control and check that no surface was told a task status the
 * disk did not have yet, and that the disk ends up with what the control left.
 */
async function expectSavedBeforeAnnounced(env: ReturnType<typeof setup>, control: (session: Session) => unknown): Promise<void> {
  env.seen.length = 0;
  await control(env.session);

  let disk: string | undefined;
  for (const { kind, statuses: s } of env.seen) {
    if (kind === 'save') disk = s;
    else expect(s).toBe(disk);
  }
  expect(disk).toBe(statuses(flattenTasks(env.session.planTasks)));
}

describe('every user control saves before it announces', () => {
  it('announces a checkpoint status with its question after saving the waiting task', async () => {
    const env = setup([task('t1', 1)]);
    await env.session.executePlan();
    env.seen.length = 0;
    env.messages.length = 0;

    const answered = env.runnerSession('t1').callCheckpoint('Shall I proceed?');

    expect(env.messages).toContainEqual(expect.objectContaining({
      type: 'status_update',
      tasks: [expect.objectContaining({
        id: 't1', status: 'awaiting_user', awaitingReason: 'checkpoint', checkpoint: 'Shall I proceed?',
      })],
    }));
    expect(env.seen).toEqual([
      { kind: 'save', statuses: 't1:awaiting_user' },
      { kind: 'status', statuses: 't1:awaiting_user' },
    ]);
    env.session.approveCheckpoint('t1');
    await expect(answered).resolves.toEqual({ kind: 'continue' });
    env.session.destroy();
  });

  it('retry', async () => {
    const env = setup([task('t1', 1)]);
    await env.session.executePlan();
    env.runnerSession('t1').emitExit(1);
    await vi.waitFor(() => expect(env.session.planTasks[0].status).toBe('failed'));

    await expectSavedBeforeAnnounced(env, (s) => s.retryTask('t1'));
    expect(env.session.planTasks[0].status).toBe('in_progress');
  });

  it('cancel', async () => {
    const env = setup([task('t1', 1)]);
    await env.session.executePlan();

    await expectSavedBeforeAnnounced(env, (s) => s.cancelTask('t1'));
    expect(env.session.planTasks[0].status).toBe('pending');
  });

  it('mark complete, which starts the dependent', async () => {
    const env = setup([task('t1', 1), task('t2', 2, { dependencies: ['t1'] })]);
    await env.session.executePlan();

    await expectSavedBeforeAnnounced(env, (s) => s.markTaskComplete('t1'));
    expect(env.session.planTasks.map((t) => t.status)).toEqual(['completed', 'in_progress']);
  });

  it('mark not done', async () => {
    const env = setup([task('t1', 1)]);
    await env.session.executePlan();
    await env.session.markTaskComplete('t1');

    await expectSavedBeforeAnnounced(env, (s) => s.markTaskIncomplete('t1'));
    expect(env.session.planTasks[0].status).not.toBe('completed');
  });

  it('force start', async () => {
    const env = setup([task('t1', 1), task('t2', 2, { dependencies: ['t1'] })]);
    await env.session.executePlan();
    // Forced past its failed dependency: one still running would only queue it.
    env.runnerSession('t1').reportComplete({ status: 'failed', summary: 'broke' });
    await vi.waitFor(() => expect(env.session.planTasks[0].status).toBe('failed'));

    await expectSavedBeforeAnnounced(env, (s) => s.forceStartTask('t2'));
    expect(env.session.planTasks[1].status).toBe('in_progress');
  });

  it('run one task', async () => {
    const env = setup([task('t1', 1)]);

    await expectSavedBeforeAnnounced(env, (s) => s.runTask('t1'));
    expect(env.session.planTasks[0].status).toBe('in_progress');
  });

  it('execute', async () => {
    const env = setup([task('t1', 1)]);

    await expectSavedBeforeAnnounced(env, (s) => s.executePlan());
    expect(env.session.planTasks[0].status).toBe('in_progress');
  });

  it('the run finishing, which saves the run as it ends before it says so', async () => {
    const env = setup([task('t1', 1)]);
    await env.session.executePlan();

    env.runnerSession('t1').reportComplete({ status: 'done', summary: '' });
    await vi.waitFor(() => expect(env.events).toContain('execution_complete'));

    expect(env.events.lastIndexOf('save')).toBeLessThan(env.events.indexOf('execution_complete'));
    env.session.destroy();
  });

  it('stop', async () => {
    const env = setup([task('t1', 1)]);
    await env.session.executePlan();

    await expectSavedBeforeAnnounced(env, (s) => s.stopExecution());
    expect(env.session.planTasks[0].status).toBe('pending');
  });

  it.each(['continueWithStash', 'continueWithoutIsolation'] as const)('%s on a dirty tree', async (control) => {
    const isolation = new FakeWorktreeIsolation();
    isolation.availability = { active: false, reason: 'dirty' };
    const env = setup([task('t1', 1)], { isolation });
    await env.session.executePlan();

    await expectSavedBeforeAnnounced(env, (s) => s[control]());
    expect(env.session.planTasks[0].status).toBe('in_progress');
  });

  it.each(['cleanupRun', 'discardRun'] as const)('%s of a settled run', async (control) => {
    const env = setup([task('t1', 1)]);
    await env.session.executePlan();
    env.runnerSession('t1').reportComplete({ status: 'done', summary: '' });
    await vi.waitFor(() => expect(env.messages.map((m) => m.type)).toContain('execution_complete'));

    await expectSavedBeforeAnnounced(env, (s) => s[control]());
  });

  it('approve the review, which starts the run', async () => {
    const env = setup([task('t1', 1)]);

    await expectSavedBeforeAnnounced(env, (s) => s.approveReview());
    expect(env.session.planTasks[0].status).toBe('in_progress');
  });

  it('reschedule after the parallel limit was raised', async () => {
    const config = fakeConfig({ maxParallelSessions: 1 });
    const env = setup([task('t1', 1), task('t2', 2)], { config });
    await env.session.executePlan();
    config.maxParallelSessions = 2;

    await expectSavedBeforeAnnounced(env, (s) => s.reschedule());
    expect(env.session.planTasks.map((t) => t.status)).toEqual(['in_progress', 'in_progress']);
  });

  it('interrupt a structured turn', async () => {
    const env = setup([task('t1', 1)]);
    await env.session.executePlan();

    await expectSavedBeforeAnnounced(env, (s) => s.interruptTask('t1'));
    expect(env.session.planTasks[0].status).toBe('awaiting_user');
  });

  it.each(['forceSendQueuedTaskMessage', 'removeQueuedTaskMessage'] as const)('%s', async (control) => {
    const env = setup([task('t1', 1)]);
    await env.session.executePlan();
    const id = env.session.sendTaskMessage('t1', 'later');

    await expectSavedBeforeAnnounced(env, (s) => expect(s[control]('t1', id)).toBe(true));
  });

  it.each<[string, (s: Session, id: string) => Promise<unknown>]>([
    ['force send a queued message', (s, id) => s.execute({ command: 'force_send_queued', task: 't1', id }, { kind: 'user' })],
    ['take back a queued message', (s, id) => s.execute({ command: 'remove_queued', task: 't1', id }, { kind: 'user' })],
    ['force send a message', (s) => s.execute({ command: 'message_task', task: 't1', text: 'now', force: true }, { kind: 'user' })],
  ])('%s through the command seam, its record kept before it is told', async (_name, control) => {
    const env = setup([task('t1', 1)]);
    await env.session.executePlan();
    const id = env.session.sendTaskMessage('t1', 'later');

    await expectSavedBeforeAnnounced(env, async (s) => expect(await control(s, id)).toMatchObject({ ok: true }));
    expect(env.recordsAtAnnounce).toEqual([1]);
  });

  it('answer a checkpoint through the command seam', async () => {
    const env = setup([task('t1', 1)]);
    await env.session.executePlan();
    const answered = env.runnerSession('t1').callCheckpoint('Shall I proceed?');
    await vi.waitFor(() => expect(env.session.awaitsCheckpoint('t1')).toBe(true));

    await expectSavedBeforeAnnounced(env, async (s) => expect(await s.execute({ command: 'answer_checkpoint', task: 't1', answer: 'approve' }, { kind: 'user' })).toMatchObject({ ok: true }));
    await expect(answered).resolves.toEqual({ kind: 'continue' });
    expect(env.recordsAtAnnounce).toEqual([1]);
  });

  it('merge all mid-run, which starts the ops task waiting at its gate', async () => {
    const env = setup([task('t1', 1), task('o1', 2, { ops: true, dependencies: ['t1'] })]);
    await env.session.executePlan();
    env.runnerSession('t1').reportComplete({ status: 'done', summary: '' });
    await vi.waitFor(() => expect(env.session.mergeGate('o1')).toEqual(['t1']));

    await expectSavedBeforeAnnounced(env, (s) => s.mergeRun());
    expect(env.session.planTasks.map((t) => t.status)).toEqual(['completed', 'in_progress']);
  });

  it('the run going on after a planner turn held its starts', async () => {
    let finish!: (turn: ConversationTurn) => void;
    const env = setup([task('t1', 1), task('t2', 2, { dependencies: ['t1'] })], {
      aiService: {
        hasActiveConversation: () => true,
        continueConversation: vi.fn(() => new Promise<ConversationTurn>((resolve) => { finish = resolve; })),
      },
    });
    await env.session.executePlan();
    const answered = env.session.continueConversation('how is it going?');
    env.runnerSession('t1').reportComplete({ status: 'done', summary: '' });
    await vi.waitFor(() => expect(env.session.planTasks[0].status).toBe('completed'));
    expect(env.session.planTasks[1].status).not.toBe('in_progress');

    await expectSavedBeforeAnnounced(env, async () => {
      finish({ kind: 'message', text: 'Task 1 is done.', researchLog: [] });
      await answered;
      expect(env.session.planTasks[1].status).toBe('in_progress');
    });
  });
});

describe("a user control's saves while it runs", () => {
  it('are background saves, so a planner turn that fails meanwhile still rolls back', async () => {
    let fail!: (err: Error) => void;
    const spawns: Array<(session: IRunnerSession) => void> = [];
    const runner = {
      spawn: vi.fn(() => new Promise<IRunnerSession>((resolve) => { spawns.push(resolve); })),
      stop: vi.fn(),
      stopAll: vi.fn(),
      activeCount: 0,
    } satisfies IRunner;
    const session = makeSession({
      runner,
      isolation: new FakeWorktreeIsolation(),
      aiService: {
        hasActiveConversation: () => true,
        continueConversation: vi.fn(() => new Promise<ConversationTurn>((_resolve, reject) => { fail = reject; })),
      },
    });
    const dialogue = plan([task('t1', 1)]);
    dialogue.conversationHistory = [
      { role: 'user', content: 'goal', timestamp: '2026-01-01T00:00:00Z' },
      { role: 'assistant', content: 'Plan generated with 1 task.', timestamp: '2026-01-01T00:00:01Z', kind: 'plan_generated' },
    ];
    session.loadPlan(dialogue, 'goal', '/repo', { persist: false });

    const turn = session.continueConversation('and docs');
    const starting = session.runTask('t1');
    await vi.waitFor(() => expect(spawns).toHaveLength(1));
    fail(new Error('planner transport failed'));
    await expect(turn).rejects.toThrow('planner transport failed');

    expect(session.planState!.conversationHistory!.map((m) => m.content)).toEqual(['goal', 'Plan generated with 1 task.']);
    spawns[0](new FakeRunnerSession('s1', 't1'));
    await starting;
  });
});
