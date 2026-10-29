import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import { TaskOrchestrator } from '../TaskOrchestrator';
import { createTask, type Task } from '../../models/Task';
import { BufferedTaskOutputSource } from '../BufferedTaskOutputSource';
import { StructuredRunner } from '../StructuredRunner';
import { RunnerRegistry } from '../../plugins/RunnerRegistry';
import { fakeConfig, FakeWorktreeIsolation, flushMicrotasks } from '../../testing';
import { fakeNotification } from './sessionTestKit';
import { claudeTurnEndQueue, fakeSpawn, type ScriptedReply } from './harnessTestKit';
import type { SpawnFn } from '../harness/AgentAdapter';
import type { OrdewellMcpServer, TaskToolHandler } from '../mcp';

/**
 * A Claude Code task stopped by its account's usage limit, driven through the
 * real Claude Code adapter, the task's attempt and its pause (ADR-0018, U1):
 * the limit arrives as the failed result of the turn Ordewell started, and the
 * task resumes on its own, in its saved session and worktree, at the reset.
 */

// The words task #31 failed its turn with; the date is after Rome left
// summer time (25 Oct), so 3:50pm there is 14:50 UTC.
const LIMIT = "You've hit your 5-hour limit · resets 3:50pm (Europe/Rome)";
const NOW = new Date('2026-10-29T13:00:00Z');
const RESUME_AT = '2026-10-29T14:51:00.000Z';
const SESSION = 'sess-5h-limit';

function init(): string {
  return `${JSON.stringify({ type: 'system', subtype: 'init', session_id: SESSION, cwd: '/repo', model: 'claude-sonnet-5', permissionMode: 'acceptEdits', claude_code_version: '2.1.296' })}\n`;
}

/** The turn Claude Code ends on the limit: it says so, then fails the turn's result with the same words. */
function limitTurn(message = LIMIT): ScriptedReply {
  return [
    init(),
    { type: 'assistant', session_id: SESSION, message: { id: 'msg_limit', role: 'assistant', content: [{ type: 'text', text: message }] } },
    { type: 'result', subtype: 'success', session_id: SESSION, is_error: true, result: message },
  ].map((line) => (typeof line === 'string' ? line : `${JSON.stringify(line)}\n`)).join('');
}

/** A turn that answers and stays open for its `task_complete` call. */
function workingTurn(): ScriptedReply {
  return `${init()}${JSON.stringify({ type: 'assistant', session_id: SESSION, message: { id: 'msg_go', role: 'assistant', content: [{ type: 'text', text: 'Carrying on.' }] } })}\n`;
}

const runners: StructuredRunner[] = [];

function setup(replies: ScriptedReply[]) {
  const spawned = fakeSpawn(replies);
  const spawns: { args: string[]; cwd: string }[] = [];
  const spawn: SpawnFn = (command, args, options) => {
    spawns.push({ args: [...args], cwd: String(options.cwd) });
    return spawned.spawn(command, args, options);
  };
  const handlers: TaskToolHandler[] = [];
  const mcp = {
    issueTaskToken: async (_scope: unknown, handler: TaskToolHandler) => {
      handlers.push(handler);
      return { url: 'http://127.0.0.1:1/mcp', token: `tok-${handlers.length}`, headers: {} };
    },
    revoke: () => undefined,
  } as unknown as OrdewellMcpServer;
  const runner = new StructuredRunner({
    process: { spawn, resolvePath: async () => '/usr/bin', platform: 'linux', isDirectory: () => true, exists: () => true },
    createAdapter: claudeTurnEndQueue,
    mcp,
    interruptGraceMs: 20,
  });
  runners.push(runner);
  const isolation = new FakeWorktreeIsolation();
  const notifications = fakeNotification();
  const orchestrator = TaskOrchestrator.compose({
    config: fakeConfig({ maxParallelSessions: 1 }),
    notifications,
    runner,
    output: new BufferedTaskOutputSource(),
    registry: new RunnerRegistry(),
    workspaceRoot: () => '/repo',
    workspaceEnv: async () => ({ env: {}, blockedEnvrc: null, refused: [], trackedEnvFile: null }),
    isolation,
    runSettings: () => ({ mergeAtGatesAutomatically: false }),
  });
  const waits: { taskId: string; resumeAt: string | null; cancelled?: true }[] = [];
  orchestrator.subscribe({ onUsageLimitWait: ({ taskId, resumeAt, cancelled }) => waits.push({ taskId, resumeAt, ...(cancelled ? { cancelled } : {}) }) });
  orchestrator.loadPlan([createTask({ id: 't1', order: 1, title: 'Fix the vscode audit findings', prompt: 'do it', taskMode: 'acceptEdits' })]);
  const task = (): Readonly<Task> => orchestrator.storeInstance.get('t1')!;
  const prompts = (i: number): string[] => (spawned.processes[i]?.written ?? [])
    .map((line) => JSON.parse(line) as { type: string; message?: { content: Array<{ text: string }> } })
    .filter((msg) => msg.type === 'user')
    .map((msg) => msg.message!.content[0].text);
  return { orchestrator, spawns, spawned, handlers, notifications, waits, task, prompts };
}

/** Time passes in steps, so the fake process's own timers and the reset's both run. */
async function until(condition: () => boolean): Promise<void> {
  for (let i = 0; i < 200 && !condition(); i++) {
    await vi.advanceTimersByTimeAsync(5);
    await flushMicrotasks(5);
  }
  expect(condition()).toBe(true);
}

beforeEach(() => {
  // setImmediate stays real: the fake process and the first prompt are sent on it.
  vi.useFakeTimers({ now: NOW, toFake: ['Date', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
});

afterEach(() => {
  for (const runner of runners.splice(0)) runner.stopAll();
  vi.useRealTimers();
});

describe('a Claude Code task that hits its 5-hour limit', () => {
  it('pauses on the failed turn and resumes its own session in its own worktree at the reset, with no one asking', async () => {
    const env = setup([limitTurn(), workingTurn()]);
    await env.orchestrator.approveReview();

    await until(() => env.task().status === 'awaiting_user');
    expect(env.task()).toMatchObject({ awaitingReason: 'usage-limit', resumeAt: RESUME_AT, runnerSessionId: SESSION });
    expect(env.task().verdict).toBeUndefined();
    expect(env.waits).toEqual([{ taskId: 't1', resumeAt: RESUME_AT }]);
    expect(env.notifications.info).toHaveBeenCalledWith(expect.stringContaining('It resumes on its own'));
    const worktree = env.spawns[0].cwd;
    expect(worktree).toMatch(/^\/fake-worktrees\//);

    await vi.advanceTimersByTimeAsync(Date.parse(RESUME_AT) - Date.now() - 1000);
    expect(env.spawns).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(1000);
    await until(() => env.prompts(1).length > 0);
    expect(env.spawns[1].cwd).toBe(worktree);
    expect(env.spawns[1].args).toEqual(expect.arrayContaining(['--resume', SESSION]));
    expect(env.prompts(1)[0]).toContain('usage limit has reset');
    expect(env.task()).toMatchObject({ status: 'in_progress' });
    expect(env.task().resumeAt).toBeUndefined();

    await env.handlers.at(-1)!.taskComplete!({ status: 'done', summary: 'Finished after the reset.' }, { signal: new AbortController().signal });
    await until(() => env.task().status === 'completed');
  });

  // Each as Claude Code 2.1.296 words it; expected times worked out by hand
  // from the zone's offset on that date, plus the minute's margin.
  it.each([
    ['a reset later the same day', LIMIT, NOW, RESUME_AT],
    ['a reset over an hour past today, which is tomorrow\'s', LIMIT, new Date('2026-10-29T16:00:00Z'), '2026-10-30T14:51:00.000Z'],
    ['a dated reset', "You've hit your 5-hour limit · resets Oct 30, 3:50pm (Europe/Rome)", NOW, '2026-10-30T14:51:00.000Z'],
    ['a reset in another zone', "You've hit your 5-hour limit · resets 11am (America/New_York)", NOW, '2026-10-29T15:01:00.000Z'],
    ['a typographic apostrophe', "You’ve hit your 5-hour limit · resets 3:50pm (Europe/Rome)", NOW, RESUME_AT],
  ])('reads %s and resumes then', async (_what, message, now, resumeAt) => {
    vi.setSystemTime(now);
    const env = setup([limitTurn(message), workingTurn()]);
    await env.orchestrator.approveReview();

    await until(() => env.task().status === 'awaiting_user');
    expect(env.task()).toMatchObject({ awaitingReason: 'usage-limit', resumeAt });

    await vi.advanceTimersByTimeAsync(Date.parse(resumeAt) - Date.now());
    await until(() => env.prompts(1).length > 0);
    expect(env.spawns[1].args).toEqual(expect.arrayContaining(['--resume', SESSION]));
  });

  it('waits for a retry when its limit says no reset time', async () => {
    const env = setup([limitTurn("You've hit your 5-hour limit."), workingTurn()]);
    await env.orchestrator.approveReview();

    await until(() => env.task().status === 'awaiting_user');
    expect(env.task().awaitingReason).toBe('usage-limit');
    expect(env.task().resumeAt).toBeUndefined();
    expect(env.notifications.warn).toHaveBeenCalledWith(expect.stringContaining('Retry it once the limit resets'));
  });

  it('waits for the user, with no resume, when the turn failed on something else', async () => {
    const env = setup([limitTurn("You've hit your stride, but the build failed: 5-hour limit on CI jobs exceeded the queue."), workingTurn()]);
    await env.orchestrator.approveReview();

    await until(() => env.task().status === 'awaiting_user');
    expect(env.task().awaitingReason).toBe('input');
    expect(env.task().resumeAt).toBeUndefined();
    expect(env.waits).toEqual([]);
  });

  it.each([
    ['its resume is cancelled', async (orchestrator: TaskOrchestrator) => { expect(await orchestrator.cancelScheduledResume('t1')).toBe(true); }],
    ['the run is stopped', async (orchestrator: TaskOrchestrator) => { orchestrator.stop(); }],
  ])('does not resume at the reset when %s: the task waits for the user', async (_how, end) => {
    const env = setup([limitTurn(), workingTurn()]);
    await env.orchestrator.approveReview();
    await until(() => env.task().resumeAt === RESUME_AT);

    await end(env.orchestrator);
    await vi.advanceTimersByTimeAsync(Date.parse(RESUME_AT) - Date.now() + 60 * 60_000);

    expect(env.spawns).toHaveLength(1);
    expect(env.task()).toMatchObject({ status: 'awaiting_user', awaitingReason: 'usage-limit' });
    expect(env.task().resumeAt).toBeUndefined();
  });

  it('starts again when retried by hand after its resume was cancelled', async () => {
    const env = setup([limitTurn(), workingTurn()]);
    await env.orchestrator.approveReview();
    await until(() => env.task().resumeAt === RESUME_AT);
    await env.orchestrator.cancelScheduledResume('t1');

    await env.orchestrator.retryTask('t1');

    await until(() => env.prompts(1).length > 0);
    expect(env.prompts(1)[0]).not.toContain('usage limit has reset');
    expect(env.task().status).toBe('in_progress');
  });

  it('is not resumed on its own again when the resumed turn hits the limit at once', async () => {
    const env = setup([limitTurn(), limitTurn("You've hit your 5-hour limit · resets 8:50pm (Europe/Rome)")]);
    await env.orchestrator.approveReview();
    await until(() => env.task().resumeAt === RESUME_AT);

    await vi.advanceTimersByTimeAsync(Date.parse(RESUME_AT) - Date.now());
    await until(() => env.spawns.length === 2 && env.task().status === 'awaiting_user');

    expect(env.task().awaitingReason).toBe('usage-limit');
    expect(env.task().resumeAt).toBeUndefined();
    expect(env.notifications.warn).toHaveBeenCalledWith(expect.stringContaining('hit its usage limit again right after it was resumed'));
  });
});
