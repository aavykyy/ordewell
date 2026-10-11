import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTask, type LegacyPlanState, type Task } from '../../models/Task';
import type { IRunner } from '../../interfaces/IRunner';
import type { IConfig } from '../../interfaces/IConfig';
import type { IWorktreeIsolation } from '../../interfaces/IWorktreeIsolation';
import type { ConversationRequest, ConversationTurn } from '../AiService';
import type { SessionMessage, SessionNotice } from '../SessionMessage';
import type { PlannerToolHandler } from '../mcp';
import { HUNG_TURN_GRACE_MS, WAKE_DEBOUNCE_MS, WAKE_UP_TURN_TIMEOUT_MS } from '../Supervisor';
import { IDLE_TIMEOUT_MS } from '../VerdictEngine';
import { EMPTY_CONVERSATION, fromTranscript, reduceConversation } from '../../conversation';
import { FakeWorktreeIsolation, flushMicrotasks } from '../../testing';
import { fakeConfig, FakeRunnerSession, makeSession, saves, taskOf, testWorkspace } from './sessionTestKit';

const NOW = new Date('2026-10-11T18:00:00Z');
// Claude Code's wording (#84), in UTC so the times do not depend on the machine's.
const LIMIT = "You've hit your session limit · resets 8:10pm (UTC)";
const RESUME_AT = '2026-10-11T20:11:00.000Z';
const ctx = { signal: new AbortController().signal };

interface PlannerCall {
  message: string;
  signal?: AbortSignal;
  finish(turn: ConversationTurn): void;
  fail(err: unknown): void;
}

/**
 * A planner whose turns the test answers by hand. A stopped call settles as a
 * backend's does, with what it had, unless `ignoresStop` makes it hang.
 */
function heldPlanner() {
  const calls: PlannerCall[] = [];
  const state = { live: false, ignoresStop: false, tools: undefined as PlannerToolHandler | undefined };
  const take = (message: string, signal?: AbortSignal) => new Promise<ConversationTurn>((resolve, reject) => {
    calls.push({ message, signal, finish: resolve, fail: reject });
    signal?.addEventListener('abort', () => {
      if (!state.ignoresStop) resolve({ kind: 'message', text: 'Looking at task 1', researchLog: [], aborted: true });
    }, { once: true });
  });
  const aiService = {
    startConversation: vi.fn((req: ConversationRequest) => {
      state.live = true;
      state.tools = req.plannerTools?.handler;
      return take(req.initialMessage ?? req.goal, req.signal);
    }),
    continueConversation: vi.fn((message: string, _progress: unknown, signal?: AbortSignal) => take(message, signal)),
    hasActiveConversation: () => state.live,
    reset: vi.fn(() => { state.live = false; }),
    restart: vi.fn(),
  };
  return { aiService, calls, state, tools: () => state.tools! };
}

function recordingRunner() {
  const sessions = new Map<string, FakeRunnerSession>();
  const runner = {
    spawn: vi.fn(async ({ taskId }: Parameters<IRunner['spawn']>[0]) => {
      const session = new FakeRunnerSession(`s-${taskId}-${sessions.size + 1}`, taskId);
      sessions.set(taskId, session);
      return session;
    }),
    stop: vi.fn(),
    stopAll: vi.fn(),
    activeCount: 0,
  } satisfies IRunner;
  return { runner, of: (taskId: string) => sessions.get(taskId)!, spawnedIds: () => runner.spawn.mock.calls.map(([o]) => o.taskId) };
}

const task = (id: string, order: number, over: Partial<Task> = {}): Task =>
  createTask({ id, order, title: `Task ${id}`, prompt: `do ${id}`, assignedRunner: 'claude-code', ...over });

function plan(tasks: Task[], over: Partial<LegacyPlanState> = {}): LegacyPlanState {
  return {
    tasks,
    generatedAt: '2026-10-11T17:00:00Z',
    lastUpdated: '2026-10-11T17:00:00Z',
    status: 'approved',
    runners: ['claude-code'],
    supervisorLevel: 'watch',
    conversationHistory: [
      { role: 'user', content: 'build it', timestamp: '2026-10-11T16:00:00Z' },
      { role: 'assistant', content: `Plan generated with ${tasks.length} tasks.`, timestamp: '2026-10-11T16:00:01Z', kind: 'plan_generated' },
    ],
    ...over,
  };
}

interface Options {
  plan?: Partial<LegacyPlanState>;
  config?: Partial<IConfig>;
  isolation?: IWorktreeIsolation;
}

/** A session running `tasks` under the plan's supervisor level, Watch unless the options say otherwise. */
async function supervised(tasks: Task[] = [task('t1', 1), task('t2', 2)], options: Options = {}) {
  const planner = heldPlanner();
  const run = recordingRunner();
  const messages: SessionMessage[] = [];
  const notices: SessionNotice[] = [];
  const session = makeSession({
    aiService: planner.aiService,
    runner: run.runner,
    isolation: options.isolation,
    broadcast: (m) => messages.push(m),
    onNotice: (n) => notices.push(n),
    config: fakeConfig(options.config),
    ...(options.isolation ? { workspaceRoot: () => '/repo' } : {}),
  });
  session.loadPlan(plan(tasks, options.plan), 'build it', options.isolation ? '/repo' : testWorkspace);
  await session.executePlan();
  return { session, planner, run, messages, notices };
}

const prose = (text: string): ConversationTurn => ({ kind: 'message', text, researchLog: [] });

/**
 * Run what is due now without moving the clock: microtasks, zero-delay timers,
 * and the real I/O a spawn waits on, which only a real turn of the event loop
 * lets through.
 */
async function settled(): Promise<void> {
  await vi.advanceTimersByTimeAsync(0);
  await new Promise((resolve) => setImmediate(resolve));
  await flushMicrotasks();
}

/** Settle until `condition` holds; a spawn reads the workspace's environment from a real subprocess, so this waits in real time. */
async function until(condition: () => boolean): Promise<void> {
  const deadline = performance.now() + 2_000;
  while (!condition() && performance.now() < deadline) await settled();
  expect(condition()).toBe(true);
}

const waitForInput = (s: FakeRunnerSession) => s.emitTurnEnd('completed');

function hitLimit(s: FakeRunnerSession): void {
  s.emitEvent({ type: 'error', message: LIMIT });
  s.emitOutput(`${LIMIT}\n`);
  s.emitTurnEnd('failed');
}

beforeEach(() => {
  vi.useFakeTimers({ now: NOW, toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
});

afterEach(() => {
  vi.useRealTimers();
});

describe('the supervisor at Watch: what wakes it', () => {
  it.each([
    ['task_failed', (env: Env) => env.run.of('t1').reportComplete({ status: 'failed', summary: '', reason: 'the tests fail' }), /- task #1 "Task t1" failed: .*the tests fail/],
    ['waiting_input', (env: Env) => waitForInput(env.run.of('t1')), /- task #1 "Task t1" is waiting for input/],
    ['waiting_approval', (env: Env) => env.run.of('t1').requestPermission('p1', 'Bash', { command: 'npm publish' }), /- task #1 "Task t1" is waiting for approval: .*npm publish/],
    ['usage_limit', (env: Env) => hitLimit(env.run.of('t1')), new RegExp(`- task #1 "Task t1" paused on claude-code's usage limit; it resumes on its own at ${RESUME_AT}`)],
  ] as const)('wakes on %s once the debounce window has passed', async (_kind, trigger, line) => {
    const env = await supervised();

    trigger(env);
    await settled();
    await vi.advanceTimersByTimeAsync(WAKE_DEBOUNCE_MS - 1);
    expect(env.planner.calls).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(1);
    await until(() => env.planner.calls.length === 1);
    expect(env.planner.calls[0].message).toMatch(/Run update:\n/);
    expect(env.planner.calls[0].message).toMatch(line);
  });

  it('wakes when a task goes quiet, and says since when', async () => {
    const env = await supervised([task('t1', 1)]);

    env.run.of('t1').emitOutput('installing dependencies\n');
    await vi.advanceTimersByTimeAsync(IDLE_TIMEOUT_MS + WAKE_DEBOUNCE_MS);

    await until(() => env.planner.calls.length === 1);
    expect(env.planner.calls[0].message).toMatch(/- task #1 "Task t1" has gone quiet \(no output since 2026-10-11T18:05:00\.000Z\)/);
  });

  it('wakes at once when the run finishes, with the passes since the last wake-up', async () => {
    const env = await supervised();

    env.run.of('t1').reportComplete({ status: 'done', summary: '' });
    env.run.of('t2').reportComplete({ status: 'done', summary: '' });

    await until(() => env.planner.calls.length === 1);
    expect(env.planner.calls[0].message).toContain([
      'Run update:',
      '- the run finished: 2 of 2 tasks completed',
      'Since the last update: tasks #1 "Task t1" and #2 "Task t2" passed.',
    ].join('\n'));
  });

  it('wakes on a landing conflict', async () => {
    const isolation = new FakeWorktreeIsolation();
    isolation.outcomes.set('t1', 'conflict');
    const env = await supervised([task('t1', 1), task('t2', 2)], { isolation, config: { worktreeIsolation: true } });

    env.run.of('t1').reportComplete({ status: 'done', summary: '' });
    await until(() => taskOf(env.session, 't1')!.status === 'awaiting_user');
    await vi.advanceTimersByTimeAsync(WAKE_DEBOUNCE_MS);

    await until(() => env.planner.calls.length === 1);
    expect(env.planner.calls[0].message).toMatch(/- task #1 "Task t1" finished, but its work conflicts and could not land/);
  });

  it('wakes when Merge all at a merge gate stops', async () => {
    const isolation = new FakeWorktreeIsolation();
    isolation.mergeResult = { outcome: 'conflict', repo: '.', files: ['src/a.ts'] };
    const deploy = task('o2', 2, { title: 'Deploy', ops: true, dependencies: ['t1'] });
    const env = await supervised([task('t1', 1), deploy], { isolation, config: { worktreeIsolation: true }, plan: { mergeAtGatesAutomatically: true } });

    env.run.of('t1').reportComplete({ status: 'done', summary: '' });
    await until(() => isolation.calls.some((c) => c.op === 'mergeIntoCheckedOut'));
    await vi.advanceTimersByTimeAsync(WAKE_DEBOUNCE_MS);

    await until(() => env.planner.calls.length === 1);
    expect(env.planner.calls[0].message).toMatch(/- automatic Merge all at the merge gate of task #2 "Deploy" stopped: it conflicts in \.: src\/a\.ts; the gate waits for the user/);
  });

  it('never wakes for a pass: passes ride along as context with the next wake-up', async () => {
    const env = await supervised();

    env.run.of('t1').reportComplete({ status: 'done', summary: '' });
    await settled();
    await vi.advanceTimersByTimeAsync(WAKE_DEBOUNCE_MS * 20);
    expect(env.planner.calls).toHaveLength(0);

    waitForInput(env.run.of('t2'));
    await settled();
    await vi.advanceTimersByTimeAsync(WAKE_DEBOUNCE_MS);

    await until(() => env.planner.calls.length === 1);
    expect(env.planner.calls[0].message).toContain([
      'Run update:',
      '- task #2 "Task t2" is waiting for input',
    ].join('\n'));
    expect(env.planner.calls[0].message).toContain('Since the last update: task #1 "Task t1" passed.');
  });

  it('merges events close together into one wake-up', async () => {
    const env = await supervised([task('t1', 1), task('t2', 2), task('t3', 3)]);

    waitForInput(env.run.of('t1'));
    await settled();
    await vi.advanceTimersByTimeAsync(WAKE_DEBOUNCE_MS / 2);
    env.run.of('t2').requestPermission('p1', 'Bash', { command: 'rm -rf build' });
    await settled();
    await vi.advanceTimersByTimeAsync(WAKE_DEBOUNCE_MS / 2);

    await until(() => env.planner.calls.length === 1);
    await vi.advanceTimersByTimeAsync(WAKE_DEBOUNCE_MS * 4);
    expect(env.planner.calls).toHaveLength(1);
    expect(env.planner.calls[0].message).toMatch(/- task #1 "Task t1" is waiting for input[^\n]*\n- task #2 "Task t2" is waiting for approval/);
  });

  it('coalesces the tasks one runner\'s usage limit paused into one entry', async () => {
    const env = await supervised();

    hitLimit(env.run.of('t1'));
    hitLimit(env.run.of('t2'));
    await settled();
    await vi.advanceTimersByTimeAsync(WAKE_DEBOUNCE_MS);

    await until(() => env.planner.calls.length === 1);
    const lines = env.planner.calls[0].message.split('\n').filter((l) => l.includes('usage limit'));
    expect(lines).toEqual([`- tasks #1 "Task t1" and #2 "Task t2" paused on claude-code's usage limit; they resume on their own at ${RESUME_AT}`]);
  });

  it('does not wake when the user cancels a scheduled resume', async () => {
    const env = await supervised([task('t1', 1)]);
    hitLimit(env.run.of('t1'));
    await settled();
    await vi.advanceTimersByTimeAsync(WAKE_DEBOUNCE_MS);
    await until(() => env.planner.calls.length === 1);
    env.planner.calls[0].finish(prose('Task 1 waits for the reset.'));
    await settled();

    expect(env.session.cancelScheduledResume('t1')).toBe(true);
    await vi.advanceTimersByTimeAsync(WAKE_DEBOUNCE_MS * 4);

    expect(env.planner.calls).toHaveLength(1);
  });

  it('stays asleep with the supervisor Off, and saves the level on the run as it starts', async () => {
    const env = await supervised([task('t1', 1)], { plan: { supervisorLevel: undefined } });

    expect(env.session.planState!.runSettings).toMatchObject({ supervisorLevel: 'off' });
    env.run.of('t1').reportComplete({ status: 'failed', summary: '', reason: 'broke' });
    await settled();
    await vi.advanceTimersByTimeAsync(WAKE_DEBOUNCE_MS * 4);

    expect(env.planner.calls).toHaveLength(0);
  });

  it('keeps the level the run started with when the plan setting changes mid-run', async () => {
    const env = await supervised([task('t1', 1)]);

    env.session.setSupervisorLevel('off');
    expect(env.session.planState!.supervisorLevel).toBe('off');
    expect(env.session.planState!.runSettings).toMatchObject({ supervisorLevel: 'watch' });
    waitForInput(env.run.of('t1'));
    await settled();
    await vi.advanceTimersByTimeAsync(WAKE_DEBOUNCE_MS);

    await until(() => env.planner.calls.length === 1);
  });
});

type Env = Awaited<ReturnType<typeof supervised>>;

/** A run whose supervisor is in its first wake-up turn, on task 1 waiting for input. */
async function wokenUp(options: Options = {}, tasks: Task[] = [task('t1', 1), task('t2', 2)]): Promise<Env> {
  const env = await supervised(tasks, options);
  waitForInput(env.run.of('t1'));
  await settled();
  await vi.advanceTimersByTimeAsync(WAKE_DEBOUNCE_MS);
  await until(() => env.planner.calls.length === 1);
  return env;
}

describe('a wake-up turn', () => {
  it('is the supervisor\'s: the update and its reply are kept with their own kinds, and every surface draws them apart', async () => {
    const env = await wokenUp();
    env.planner.calls[0].finish(prose('Task 1 asks which database to use. I suggest Postgres; reply "yes" to tell it.'));
    await settled();

    const history = env.session.planState!.conversationHistory!;
    const update = history.at(-2)!;
    expect(update).toMatchObject({ role: 'user', kind: 'wake_up' });
    expect(update.content).toMatch(/^Run update:\n- task #1 "Task t1" is waiting for input/);
    // The turn's brief goes to the model, never into the transcript.
    expect(update.content).not.toMatch(/supervisor/);
    expect(history.at(-1)).toMatchObject({ role: 'assistant', kind: 'supervisor', content: expect.stringMatching(/^Task 1 asks/) });
    expect(env.session.rewindTargets().map((t) => t.content)).not.toContain(update.content);
    expect(env.session.planState!.pendingTurns).toEqual([]);

    expect(env.messages).toContainEqual(expect.objectContaining({ type: 'planner_turn_started', prompt: '', wakeUps: [update.content], supervisor: true }));
    expect(env.messages).toContainEqual(expect.objectContaining({ type: 'planner_message', supervisor: true }));
    const roles = (view: typeof EMPTY_CONVERSATION) => view.blocks.flatMap((b) => (b.type === 'message' ? [b.role] : []));
    const live = env.messages.reduce((view, m) => reduceConversation(view, m), EMPTY_CONVERSATION);
    expect(roles(live)).toEqual(['wake_up', 'supervisor']);
    expect(roles(fromTranscript(history, []))).toEqual(['user', 'wake_up', 'supervisor']);
  });

  it('refuses every execution tool at Watch, telling the supervisor to suggest it to the user', async () => {
    const env = await wokenUp();
    const tools = env.planner.tools();

    const replies = await Promise.all([
      tools.stopTask!({ task: '2' }, ctx),
      tools.runPlan!({}, ctx),
      tools.retryTask!({ task: '1', from: 'fresh' }, ctx),
      tools.messageTask!({ task: '1', text: 'use Postgres' }, ctx),
      tools.stopRun!({}, ctx),
    ]);

    for (const reply of replies) {
      expect(reply.isError).toBe(true);
      expect(JSON.parse(reply.text)).toMatchObject({ ok: false, outcome: 'refused', reason: expect.stringMatching(/at Watch.*Suggest it to the user instead/) });
    }
    expect(taskOf(env.session, 't2')!.status).toBe('in_progress');
    expect(env.run.of('t1').delivered).not.toContain('use Postgres');
    const records = env.session.planState!.conversationHistory!.flatMap((e) => (e.execution ? [e.execution] : []));
    expect(records.map((r) => [r.actor, r.level, r.outcome])).toEqual(Array(5).fill(['supervisor', 'watch', 'refused']));
  });

  it('refuses a plan edit made through the tools, and nothing is saved', async () => {
    const env = await wokenUp();
    const before = saves(env.session).mock.calls.length;

    const edit = await env.planner.tools().editPlan!({ ops: [{ op: 'update', taskId: '#2', changes: { prompt: 'do t2 better' } }] }, ctx);
    const submit = await env.planner.tools().submitPlan!({ tasks: [] }, ctx);

    expect(edit.isError).toBe(true);
    expect(JSON.parse(edit.text).errors[0].message).toMatch(/^Plan edits are refused in a wake-up turn/);
    expect(submit.isError).toBe(true);
    expect(JSON.parse(submit.text).errors[0].message).toMatch(/^Plan edits are refused in a wake-up turn/);
    env.planner.calls[0].finish(prose('I would rewrite task 2; reply "yes" and I will.'));
    await settled();
    expect(taskOf(env.session, 't2')!.prompt).toBe('do t2');
    const saved = saves(env.session).mock.calls.slice(before).map(([p]) => p.tasks.find((t) => t.id === 't2')!.prompt);
    expect(saved.every((p) => p === 'do t2')).toBe(true);
  });

  it('refuses a plan edit in its reply, sends the refusal back, and lands its prose instead', async () => {
    const env = await wokenUp();

    env.planner.calls[0].finish({ kind: 'task_ops', ops: [{ op: 'update', taskId: '#2', changes: { prompt: 'do t2 better' } }], text: '', researchLog: [] });
    await until(() => env.planner.calls.length === 2);
    expect(env.planner.calls[1].message).toMatch(/^Plan edits are refused in a wake-up turn/);
    env.planner.calls[1].finish(prose('I suggest rewriting task 2; reply "yes" to apply it.'));
    await settled();

    expect(taskOf(env.session, 't2')!.prompt).toBe('do t2');
    expect(env.session.planState!.conversationHistory!.at(-1)).toMatchObject({ kind: 'supervisor', content: expect.stringMatching(/^I suggest rewriting/) });
  });

  it('applies the change once the user says yes, as an ordinary turn of theirs', async () => {
    const env = await wokenUp({}, [task('t1', 1), task('t2', 2, { dependencies: ['t1'] })]);
    env.planner.calls[0].finish(prose('I suggest rewriting task 2; reply "yes".'));
    await settled();

    const answered = env.session.continueConversation('yes');
    await until(() => env.planner.calls.length === 2);
    expect(env.planner.calls[1].message).not.toMatch(/Run update/);
    env.planner.calls[1].finish({ kind: 'task_ops', ops: [{ op: 'update', taskId: '#2', changes: { prompt: 'do t2 better' } }], text: '', researchLog: [] });
    await answered;

    expect(taskOf(env.session, 't2')!.prompt).toBe('do t2 better');
  });

  it('spends the plan\'s read budget in place of a user message\'s caps', async () => {
    const env = await wokenUp({ plan: { wakeUpReadBudget: 2 } });
    const read = (ref: string) => env.planner.tools().taskQuery!({ tasks: [ref] }, ctx);

    const first = await read('1');
    const second = await read('2');
    const third = await read('1');

    expect(first.isError).toBeFalsy();
    expect(JSON.parse(first.text).note).toBeUndefined();
    expect(JSON.parse(second.text).note).toMatch(/Do not read again this turn/);
    expect(third.isError).toBe(true);
    expect(env.planner.calls[0].message).toMatch(/up to 2 reads this turn/);
  });

  it('keeps a user turn\'s caps: three reads before it is told to land', async () => {
    const env = await supervised([task('t1', 1)], { plan: { wakeUpReadBudget: 1 } });
    void env.session.continueConversation('how is task 1 going?');
    await until(() => env.planner.calls.length === 1);
    const read = () => env.planner.tools().taskQuery!({ tasks: ['1'], fields: ['description'] }, ctx);
    const notes = [];
    for (let i = 0; i < 4; i++) notes.push(JSON.parse((await read()).text).note);

    expect(notes.slice(0, 1)).toEqual([undefined]);
    expect(notes.slice(1).every((n) => typeof n === 'string')).toBe(true);
    expect(env.planner.calls[0].message).not.toMatch(/reads this turn/);
  });
});

describe('when the supervisor fails, the run does not depend on it', () => {
  it('retries a crashed wake-up turn once with the planner restarted', async () => {
    const env = await wokenUp();

    env.planner.calls[0].fail(new Error('Claude Code exited with code 1'));
    await until(() => env.planner.calls.length === 2);

    expect(env.planner.aiService.restart).toHaveBeenCalledTimes(1);
    expect(env.planner.calls[1].message).toMatch(/- task #1 "Task t1" is waiting for input/);
    expect(env.notices).toContainEqual(expect.objectContaining({ level: 'warn', message: expect.stringMatching(/Retrying once with the planner restarted/) }));
    env.planner.calls[1].finish(prose('Task 1 needs an answer.'));
    await settled();
    expect(env.session.planState!.runSettings!.unsupervised).toBeUndefined();
    expect(env.session.planState!.pendingTurns).toEqual([]);
  });

  it('counts a planner that ends its turn without a reply as a crash, and shows nothing of it', async () => {
    const env = await wokenUp();

    env.planner.calls[0].finish({ kind: 'message', text: 'Claude Code exited with code 1: not logged in', researchLog: [], failed: true });
    await until(() => env.planner.calls.length === 2);

    expect(env.session.planState!.conversationHistory!.some((e) => e.content.includes('not logged in'))).toBe(false);
  });

  it('goes unsupervised after the retry fails: the run carries on as Off, with a notice, and nothing is lost', async () => {
    const env = await wokenUp();
    env.planner.calls[0].fail(new Error('agent died'));
    await until(() => env.planner.calls.length === 2);
    env.planner.calls[1].fail(new Error('agent died again'));
    await settled();

    const settings = env.session.planState!.runSettings!;
    expect(settings.supervisorLevel).toBe('watch');
    expect(settings.unsupervised).toMatch(/failed twice \(agent died again\)/);
    expect(env.notices).toContainEqual(expect.objectContaining({ level: 'warn', message: expect.stringMatching(/^The supervisor stopped: .*The run carries on unsupervised/) }));
    expect(env.session.planState!.conversationHistory!.at(-1)).toMatchObject({ kind: 'system', content: expect.stringMatching(/^The supervisor stopped/) });
    expect(env.session.planState!.pendingTurns!.map((t) => t.source)).toEqual(['supervisor']);
    expect(saves(env.session).mock.calls.at(-1)![0].pendingTurns!.map((t) => t.source)).toEqual(['supervisor']);

    // Off from here: a new event does not wake it.
    waitForInput(env.run.of('t2'));
    await settled();
    await vi.advanceTimersByTimeAsync(WAKE_DEBOUNCE_MS * 4);
    expect(env.planner.calls).toHaveLength(2);

    // What it was not told reaches the planner, whole, with the user's next message.
    const answered = env.session.continueConversation('what happened?');
    await until(() => env.planner.calls.length === 3);
    expect(env.planner.calls[2].message).toMatch(/Run update:\n- task #1 "Task t1" is waiting for input[\s\S]*what happened\?$/);
    expect(env.planner.calls[2].message).not.toMatch(/You are this plan's supervisor/);
    env.planner.calls[2].finish(prose('Task 1 asked for input; the supervisor failed.'));
    await answered;
    expect(env.session.planState!.pendingTurns).toEqual([]);
    const tail = env.session.planState!.conversationHistory!.slice(-3);
    expect(tail.map((e) => [e.role, e.kind])).toEqual([['user', 'wake_up'], ['user', undefined], ['assistant', undefined]]);
  });

  it('times a hung wake-up turn out, stops it, and retries it once', async () => {
    const env = await wokenUp();

    await vi.advanceTimersByTimeAsync(WAKE_UP_TURN_TIMEOUT_MS);
    await until(() => env.planner.calls.length === 2);

    expect(env.planner.calls[0].signal!.aborted).toBe(true);
    expect(env.planner.aiService.restart).toHaveBeenCalledTimes(1);
    // A stopped wake-up lands nothing of what the planner had said.
    expect(env.session.planState!.conversationHistory!.some((e) => e.content === 'Looking at task 1')).toBe(false);

    await vi.advanceTimersByTimeAsync(WAKE_UP_TURN_TIMEOUT_MS);
    await settled();
    expect(env.session.planState!.runSettings!.unsupervised).toMatch(/did not finish within 600s/);
    expect(env.planner.calls).toHaveLength(2);
  });

  it('takes the conversation back from a turn that ignores its stop', async () => {
    const env = await wokenUp();
    env.planner.state.ignoresStop = true;

    await vi.advanceTimersByTimeAsync(WAKE_UP_TURN_TIMEOUT_MS);
    await settled();
    expect(env.planner.calls).toHaveLength(1);
    expect(env.session.isPlannerBusy).toBe(true);

    await vi.advanceTimersByTimeAsync(HUNG_TURN_GRACE_MS);
    await until(() => env.planner.calls.length === 2);
    const hung = env.messages.flatMap((m) => (m.type === 'planner_turn_started' ? [m.turnId] : []))[0];
    expect(env.messages).toContainEqual({ type: 'planner_turn_ended', turnId: hung, outcome: 'error' });
    env.planner.calls[1].finish(prose('Task 1 needs an answer.'));
    await settled();
    // What the hung turn wrote went back with it: the update is in the transcript once.
    const history = env.session.planState!.conversationHistory!;
    expect(history.filter((e) => e.kind === 'wake_up')).toHaveLength(1);
    expect(history.at(-1)).toMatchObject({ kind: 'supervisor' });
  });

  it('always lets the run\'s new starts go when a wake-up turn fails, the last one included', async () => {
    const env = await wokenUp({}, [
      task('t1', 1), task('t2', 2), task('t3', 3, { dependencies: ['t2'] }), task('t4', 4, { dependencies: ['t3'] }),
    ]);
    env.run.of('t2').reportComplete({ status: 'done', summary: '' });
    await until(() => taskOf(env.session, 't2')!.status === 'completed');
    expect(env.run.spawnedIds()).not.toContain('t3');

    env.planner.calls[0].fail(new Error('agent died'));
    await until(() => env.run.spawnedIds().includes('t3') && env.planner.calls.length === 2);

    env.run.of('t3').reportComplete({ status: 'done', summary: '' });
    await until(() => taskOf(env.session, 't3')!.status === 'completed');
    expect(env.run.spawnedIds()).not.toContain('t4');
    env.planner.calls[1].fail(new Error('agent died again'));

    await until(() => env.run.spawnedIds().includes('t4'));
    expect(env.session.planState!.runSettings!.unsupervised).toBeDefined();
    expect(env.session.isPlannerBusy).toBe(false);
  });

  it('waits out the planner\'s usage limit, then delivers the wake-up', async () => {
    const env = await wokenUp({ config: { aiProvider: 'claude-code' } });

    env.planner.calls[0].finish({ kind: 'message', text: LIMIT, researchLog: [], failed: true });
    await settled();
    expect(env.notices).toContainEqual(expect.objectContaining({ level: 'info', message: expect.stringMatching(new RegExp(`wait until ${RESUME_AT}`)) }));

    await vi.advanceTimersByTimeAsync(Date.parse(RESUME_AT) - Date.now() - 1000);
    expect(env.planner.calls).toHaveLength(1);
    expect(env.planner.aiService.restart).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1000);
    await until(() => env.planner.calls.length === 2);
    expect(env.planner.calls[1].message).toMatch(/- task #1 "Task t1" is waiting for input/);
    env.planner.calls[1].finish(prose('Task 1 needs an answer.'));
    await settled();
    expect(env.session.planState!.runSettings!.unsupervised).toBeUndefined();
  });

  it('goes unsupervised when the planner\'s limit says no reset time', async () => {
    const env = await wokenUp();

    env.planner.calls[0].finish({ kind: 'message', text: 'Rate limit exceeded', researchLog: [], failed: true });
    await settled();

    expect(env.session.planState!.runSettings!.unsupervised).toMatch(/usage limit and did not say when it resets/);
  });
});

describe('undelivered wake-ups across a daemon restart', () => {
  it('reloads a wake-up no turn answered, and delivers it once the session is adopted', async () => {
    const env = await wokenUp();
    const saved = structuredClone(saves(env.session).mock.calls.at(-1)![0]);
    expect(saved.pendingTurns!.map((t) => t.source)).toEqual(['supervisor']);
    env.session.destroy();

    const planner = heldPlanner();
    const restarted = makeSession({ aiService: planner.aiService, runner: recordingRunner().runner });
    restarted.loadPlan(saved, 'build it', testWorkspace, { sessionId: env.session.sessionId });

    await until(() => planner.calls.length === 1);
    expect(planner.calls[0].message).toMatch(/- task #1 "Task t1" is waiting for input/);
    planner.calls[0].finish(prose('Task 1 was waiting for input when Ordewell restarted.'));
    await settled();
    expect(restarted.planState!.pendingTurns).toEqual([]);
    expect(restarted.planState!.conversationHistory!.at(-1)).toMatchObject({ kind: 'supervisor' });
  });

  it('keeps an unsupervised run\'s wake-ups for the user\'s next message after a restart', async () => {
    const env = await wokenUp();
    env.planner.calls[0].fail(new Error('agent died'));
    await until(() => env.planner.calls.length === 2);
    env.planner.calls[1].fail(new Error('agent died again'));
    await settled();
    const saved = structuredClone(saves(env.session).mock.calls.at(-1)![0]);
    env.session.destroy();

    const planner = heldPlanner();
    const restarted = makeSession({ aiService: planner.aiService, runner: recordingRunner().runner });
    restarted.loadPlan(saved, 'build it', testWorkspace);
    await settled();
    expect(planner.calls).toHaveLength(0);

    void restarted.continueConversation('anything new?');
    await until(() => planner.calls.length === 1);
    expect(planner.calls[0].message).toMatch(/Run update:[\s\S]*anything new\?$/);
  });
});
