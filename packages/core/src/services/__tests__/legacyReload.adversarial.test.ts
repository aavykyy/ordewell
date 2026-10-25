import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { createTask, type LegacyPlanState, type Task } from '../../models/Task';
import type { TaskLogEvent } from '../../models/TaskLog';
import { replayTaskLog } from '../../conversation/taskLog';
import { fromTranscript } from '../../conversation/transcript';
import { loadSession, saveSession } from '../../utils/sessionStore';
import { openTaskLog } from '../../utils/taskLogStore';
import { FakeRunnerSession, makeSession, taskOf } from './sessionTestKit';
import type { IRunner } from '../../interfaces/IRunner';

/**
 * Adversarial: a session saved before this plan's changes reloads whole — a
 * transcript reply with no runs, a task whose status is the since-removed
 * `blocked`, and a task log written before runs carried an id — and then runs.
 */

const stored = (id: string, order: number, over: Partial<Task> = {}): Task =>
  ({ ...createTask({ id, order, title: `Task ${id}`, prompt: `do ${id}`, assignedRunner: 'claude-code', ...over }) } as Task);

/** A plan file an older build wrote: the reply has no runs, and t2's status is the stored `blocked`. */
function legacyPlan(): LegacyPlanState {
  return {
    tasks: [
      stored('t1', 1),
      { ...stored('t2', 2, { dependencies: ['t1'] }), status: 'blocked' } as unknown as Task,
    ],
    generatedAt: '2026-10-01T00:00:00Z',
    lastUpdated: '2026-10-01T00:00:00Z',
    status: 'approved',
    runners: ['claude-code'],
    conversationHistory: [
      { role: 'user', content: 'build it', timestamp: '2026-10-01T00:00:00Z' },
      { role: 'assistant', content: 'Plan generated with 2 tasks.', timestamp: '2026-10-01T00:00:01Z' },
    ],
  };
}

const LEGACY_LOG: TaskLogEvent[] = [
  { type: 'turn_start', message: 'do t1' },
  { type: 'text_delta', text: 'On it.' },
  { type: 'text_delta', text: ' Nearly done.' },
  { type: 'tool_call', id: 'c1', name: 'Bash', args: '{"command":"npm test"}' },
  { type: 'tool_result', id: 'c1', output: 'ok', success: true },
  { type: 'text_delta', text: ' Done.' },
  { type: 'turn_end', reason: 'completed' },
];

describe('adversarial: a session saved before the change reloads and runs', () => {
  let workspace: string;
  beforeEach(() => {
    workspace = mkdtempSync(join(tmpdir(), 'ordewell-legacy-'));
    vi.useFakeTimers({ now: new Date('2026-10-18T10:00:00Z') });
  });
  afterEach(() => {
    vi.useRealTimers();
    rmSync(workspace, { recursive: true, force: true });
  });

  it('reads the stored blocked task as pending, replays the run-less transcript and the un-ided log, then runs both tasks', async () => {
    saveSession(legacyPlan(), 'build it', workspace, 'legacy-1');
    // The attempt's file, written before runs carried ids.
    const dir = join(workspace, '.ordewell', 'sessions', 'legacy-1', 'tasks', 't1');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, '1.jsonl'), LEGACY_LOG.map((e) => `${JSON.stringify(e)}\n`).join(''));

    const loaded = loadSession('legacy-1', workspace);
    expect(loaded).not.toBeNull();
    const { plan } = loaded!;
    expect(plan.tasks[1].status).toBe('blocked'); // still on disk; load normalizes the store's copy

    // The transcript reply without runs is one message, where its timestamp puts it.
    const view = fromTranscript(plan.conversationHistory, []);
    expect(view.blocks.flatMap((b) => (b.type === 'message' && b.role === 'planner' ? [b.text] : [])))
      .toEqual(['Plan generated with 2 tasks.']);

    const session = makeSession({ workspaceRoot: () => workspace, sessionId: 'legacy-1', openTaskLog });
    session.loadPlan(plan, 'build it', workspace, { sessionId: 'legacy-1' });
    expect(taskOf(session, 't2')!.status).toBe('pending');
    // Its saved log is the attempt the upgraded plan did not carry a mark for.
    expect(taskOf(session, 't1')!.attempted).toBe(true);
    expect(taskOf(session, 't2')!.attempted).toBeUndefined();

    // The legacy log replays: runs joined with the paragraph break, as before runs carried ids.
    expect(session.taskLogAttempts('t1')).toEqual([1]);
    const replayed = replayTaskLog(session.taskLog('t1', 1));
    const text = replayed.blocks.filter((b) => b.type === 'message').map((b) => b.text).join('');
    expect(text).toContain('On it.');
    expect(text).toContain('Done.');
    expect(replayed.blocks.some((b) => b.type === 'tool')).toBe(true);

    // And the reloaded session runs: the once-blocked task starts after its dependency.
    const sessions: FakeRunnerSession[] = [];
    const runner: IRunner = {
      spawn: vi.fn(async ({ taskId }: Parameters<IRunner['spawn']>[0]) => {
        const started = new FakeRunnerSession(`s${sessions.length + 1}`, taskId);
        sessions.push(started);
        return started;
      }),
      stop: vi.fn(), stopAll: vi.fn(), activeCount: 0,
    };
    const running = makeSession({ workspaceRoot: () => workspace, sessionId: 'legacy-1', openTaskLog, runner });
    running.loadPlan(plan, 'build it', workspace, { sessionId: 'legacy-1' });
    await running.execute({ command: 'run_plan' }, { kind: 'user' });
    await vi.waitFor(() => expect(sessions).toHaveLength(1));
    expect(sessions[0].taskId).toBe('t1');
    sessions[0].reportComplete({ status: 'done', summary: 'done' });
    await vi.waitFor(() => expect(sessions).toHaveLength(2));
    expect(sessions[1].taskId).toBe('t2');
    sessions[1].reportComplete({ status: 'done', summary: 'done' });
    await vi.waitFor(() => expect(taskOf(running, 't2')!.status).toBe('completed'));
  });
});
