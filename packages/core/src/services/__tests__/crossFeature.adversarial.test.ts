import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { taskOf } from './sessionTestKit';
import { ctx, hitLimit, NOW, RESUME_AT, settled, supervised, until, type Env } from './supervisorTestKit';
import type { SessionMessage } from '../SessionMessage';
import type { ConversationTurn } from '../AiService';

/**
 * Adversarial: the whole change, end to end. A planner turn whose narration
 * streamed before its tool calls submits a plan, autorun starts it, a task
 * pauses on a usage limit, and the user's Resume now (the TUI's command, the
 * same seam every surface sends) carries the run to its end. Each of those
 * was a separate task's fix; this is the join between them.
 */

beforeEach(() => {
  vi.useFakeTimers({ now: NOW, toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
});

afterEach(() => {
  vi.useRealTimers();
});

const narration = { segmentId: 'seg-1', text: "I'll write the plan now.", startedAt: NOW.toISOString() };

/** One planner turn that submits a plan, with the narration that streamed before the tool call. */
async function submitWithNarration(env: Env): Promise<void> {
  void env.session.continueConversation('plan the work');
  await until(() => env.planner.calls.length === 1);
  const submitted = await env.planner.tools().submitPlan!({ tasks: [
    { id: 't1', title: 'First', description: 'd', prompt: 'do first', assignedRunner: 'claude-code', sliceType: 'AFK', autonomy: 'AFK' },
    { id: 't2', title: 'Second', description: 'd', prompt: 'do second', dependencies: ['t1'], assignedRunner: 'claude-code', sliceType: 'AFK', autonomy: 'AFK' },
  ] }, ctx);
  expect(submitted.isError).toBeFalsy();
  const turn: ConversationTurn = { kind: 'message', text: 'Plan is ready.', researchLog: [], runs: [narration] };
  env.planner.calls[0].finish(turn);
  await settled();
}

const replies = (env: Env): Extract<SessionMessage, { type: 'planner_message' }>[] =>
  env.messages.filter((m): m is Extract<SessionMessage, { type: 'planner_message' }> => m.type === 'planner_message');

describe('adversarial: narration, autorun, a usage-limit pause and Resume now', () => {
  it('keeps the narration, starts the plan, holds the run, and resumes it from the seam to one end', async () => {
    const env = await supervised([], {
      settings: { supervisorLevel: 'off', autorun: true },
      config: { autonomousMode: true, maxParallelSessions: 1 },
      plan: { status: 'draft', tasks: [], approved: false },
      execute: false,
    });

    await submitWithNarration(env);

    // The narration is what the reply carries, live and saved (ADR-0017 A1).
    const said = replies(env).at(-1)!;
    expect(said.runs).toEqual([expect.objectContaining({ segmentId: 'seg-1', text: narration.text })]);
    const saved = env.session.planState!.conversationHistory!.find((e) => e.content === 'Plan is ready.')!;
    expect(saved.runs).toEqual([expect.objectContaining({ segmentId: 'seg-1', text: narration.text })]);

    // Autorun started the plan; t1 runs and t2 waits behind it.
    await until(() => env.run.spawnedIds().includes('t1'));
    expect(env.run.spawnedIds()).toEqual(['t1']);

    hitLimit(env.run.of('t1'));
    await until(() => taskOf(env.session, 't1')!.resumeAt === RESUME_AT);
    expect(taskOf(env.session, 't1')!.awaitingReason).toBe('usage-limit');
    await settled();

    // A held run stays open: no end-of-run signal, no handoff, t2 not started.
    expect(env.messages.filter((m) => m.type === 'execution_complete')).toHaveLength(0);
    expect(env.run.spawnedIds()).toEqual(['t1']);

    // The TUI's Resume now, as the seam takes it.
    const resumed = await env.session.execute({ command: 'retry_task', task: 't1', from: 'session' }, { kind: 'user' });
    expect(resumed.ok).toBe(true);
    await until(() => env.run.spawnedIds().filter((id) => id === 't1').length === 2);
    expect(env.run.runner.spawn.mock.calls[1][0]).toMatchObject({ taskId: 't1', runner: 'claude-code', resumeSessionId: expect.any(String) });

    env.run.of('t1').reportComplete({ status: 'done', summary: 'done' });
    await until(() => env.run.spawnedIds().includes('t2'));
    env.run.of('t2').reportComplete({ status: 'done', summary: 'done' });
    await until(() => env.messages.some((m) => m.type === 'execution_complete'));

    // The run ended once, and the narration is still the saved reply.
    expect(env.messages.filter((m) => m.type === 'execution_complete')).toHaveLength(1);
    const after = env.session.planState!.conversationHistory!.at(-1)!;
    expect(after.runs).toBeUndefined();
    const firstReply = env.session.planState!.conversationHistory!.find((e) => e.runs?.some((r) => r.segmentId === 'seg-1'))!;
    expect(firstReply.content).toBe('Plan is ready.');
  });
});
