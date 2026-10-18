import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionMessage } from '../SessionMessage';
import { HUNG_TURN_GRACE_MS, WAKE_UP_TURN_TIMEOUT_MS } from '../Supervisor';
import { prose, settled, until, wokenUp } from './supervisorTestKit';

beforeEach(() => {
  vi.useFakeTimers({ now: new Date('2026-10-11T18:00:00Z'), toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
});

afterEach(() => {
  vi.useRealTimers();
});

/**
 * Adversarial, round two, on the grace of a hung wake-up turn (ADR-0029):
 * the first round fixed the grace of a turn whose plan scope had gone. The
 * neighbouring cases: the call answers during its grace (the conversation is
 * still its own), and a reset takes the turn the same way startPlanning and
 * an adoption do.
 */

const turnStarts = (messages: ReadonlyArray<SessionMessage>) =>
  messages.flatMap((m) => (m.type === 'planner_turn_started' ? [m] : []));

describe('adversarial: the grace of a hung wake-up turn, beyond a plan-scope change', () => {
  it('lets a call that answers during its grace settle before the grace can ever fire', async () => {
    const env = await wokenUp();
    env.planner.state.ignoresStop = true;

    await vi.advanceTimersByTimeAsync(WAKE_UP_TURN_TIMEOUT_MS);
    await settled();
    expect(env.planner.calls).toHaveLength(1);

    // The hung call answers while its grace is still running: the supervisor
    // has not taken the conversation back, and the timeout's retry follows.
    env.planner.calls[0].finish(prose('Still looking at task 1.'));
    await until(() => env.planner.calls.length === 2);
    const retry = turnStarts(env.messages).at(-1)!.turnId as string;
    const before = env.messages.length;

    // The settled turn's grace was cleared with it: it never reaches the retry.
    await vi.advanceTimersByTimeAsync(HUNG_TURN_GRACE_MS);
    await settled();

    expect(env.messages.slice(before).filter((m) => m.type === 'planner_turn_ended' && m.turnId === retry)).toEqual([]);
    expect(env.session.isPlannerBusy).toBe(true);

    env.planner.calls[1].finish(prose('Task 1 needs an answer.'));
    await settled();
    const history = env.session.planState!.conversationHistory!;
    expect(history.at(-1)).toMatchObject({ kind: 'supervisor', content: 'Task 1 needs an answer.' });
  });

  it('discards a hung turn at a session reset, and the old grace never reaches the new plan\'s opening turn', async () => {
    const env = await wokenUp();
    env.planner.state.ignoresStop = true;
    await vi.advanceTimersByTimeAsync(WAKE_UP_TURN_TIMEOUT_MS);
    await settled();
    expect(env.planner.calls).toHaveLength(1);

    // The host's "new session": the turn belongs to the plan it was about.
    env.session.reset();
    const started = env.session.startPlanning('a different goal', ['claude-code']);
    await until(() => env.planner.calls.length === 2);
    const openingTurn = turnStarts(env.messages).at(-1)!.turnId as string;

    await vi.advanceTimersByTimeAsync(HUNG_TURN_GRACE_MS);
    await settled();

    expect(env.messages.filter((m) => m.type === 'planner_turn_ended' && m.turnId === openingTurn)).toEqual([]);
    expect(env.session.isPlannerBusy).toBe(true);

    env.planner.calls[1].finish(prose('Here is the new plan.'));
    await expect(started).resolves.toBeDefined();
    expect(env.session.planState!.conversationHistory!.at(-1)).toMatchObject({ content: 'Here is the new plan.' });
  });
});
