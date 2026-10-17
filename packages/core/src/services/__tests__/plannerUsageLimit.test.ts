import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LegacyPlanState } from '../../models/Task';
import type { SessionMessage, SessionNotice } from '../SessionMessage';
import { fakeConfig, makeSession, testWorkspace } from './sessionTestKit';
import { heldPlanner, LIMIT, NOW, plan, prose, RESUME_AT, settled, supervised, task, until, wokenUp } from './supervisorTestKit';

beforeEach(() => {
  vi.useFakeTimers({ now: NOW, toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
});

afterEach(() => {
  vi.useRealTimers();
});

const limited = (text = LIMIT) => ({ kind: 'message' as const, text, researchLog: [], failed: true as const });

/** A session with a Claude Code planner, its plan loaded, nothing running and no supervisor. */
async function idle() {
  return supervised([task('t1', 1)], { settings: { supervisorLevel: 'off' }, config: { aiProvider: 'claude-code' }, execute: false });
}

describe('a planner turn that ends on a usage limit', () => {
  it('is kept as an error entry, out of the dialogue, and its message waits for the reset', async () => {
    const env = await idle();
    const before = env.session.planState!.conversationHistory!.length;

    const sent = env.session.continueConversation('rename task 1');
    await until(() => env.planner.calls.length === 1);
    env.planner.calls[0].finish(limited());
    await sent;

    const history = env.session.planState!.conversationHistory!;
    expect(history.slice(before)).toEqual([expect.objectContaining({ kind: 'error', content: expect.stringMatching(/^claude-code usage limit, resets /) })]);
    expect(env.session.planState!.pendingTurns!.map((t) => t.text)).toEqual(['rename task 1']);
    expect(env.session.planState!.plannerResend).toEqual({ runner: 'claude-code', at: RESUME_AT });
  });

  it('is sent again at the reset, with what was sent meanwhile, in order, as one turn', async () => {
    const env = await idle();
    const sent = env.session.continueConversation('rename task 1');
    await until(() => env.planner.calls.length === 1);
    env.planner.calls[0].finish(limited());
    await sent;

    // Answered at once: its turn is the resend's, hours off.
    await env.session.continueConversation('and make it shorter');
    await vi.advanceTimersByTimeAsync(Date.parse(RESUME_AT) - Date.now() - 1000);
    expect(env.planner.calls).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(1000);
    await until(() => env.planner.calls.length === 2);
    expect(env.planner.calls[1].message).toMatch(/rename task 1\n\nand make it shorter$/);
    expect(env.session.planState!.plannerResend).toBeUndefined();
    env.planner.calls[1].finish(prose('Renamed it.'));
    await settled();

    const history = env.session.planState!.conversationHistory!;
    expect(history.slice(-2).map((e) => [e.role, e.content])).toEqual([['user', 'rename task 1\n\nand make it shorter'], ['assistant', 'Renamed it.']]);
    expect(env.session.planState!.pendingTurns).toEqual([]);
  });

  it('never reaches the planner: the resend replays the dialogue without it', async () => {
    const env = await idle();
    const sent = env.session.continueConversation('rename task 1');
    await until(() => env.planner.calls.length === 1);
    env.planner.calls[0].finish(limited());
    await sent;
    // Its process gone, as after a restart: the resend replays the transcript.
    env.planner.state.live = false;

    await vi.advanceTimersByTimeAsync(Date.parse(RESUME_AT) - Date.now());
    await until(() => env.planner.calls.length === 2);

    const replayed = env.planner.aiService.startConversation.mock.calls[1][0].priorHistory ?? [];
    expect(replayed.map((e) => e.content)).toEqual(['build it', 'Plan generated with 1 tasks.']);
  });

  it('stops resending on its own when the resend hits the limit again, and goes with the next message', async () => {
    const env = await idle();
    const sent = env.session.continueConversation('rename task 1');
    await until(() => env.planner.calls.length === 1);
    env.planner.calls[0].finish(limited());
    await sent;
    await vi.advanceTimersByTimeAsync(Date.parse(RESUME_AT) - Date.now());
    await until(() => env.planner.calls.length === 2);

    // The account's clock said 8:10, but the limit is still on.
    env.planner.calls[1].finish(limited("You've hit your session limit · resets 11:10pm (UTC)"));
    await settled();

    expect(env.session.planState!.plannerResend).toEqual({ runner: 'claude-code' });
    expect(env.session.planState!.conversationHistory!.at(-1)).toMatchObject({ kind: 'error', content: expect.stringMatching(/again right after the resend/) });
    await vi.advanceTimersByTimeAsync(6 * 60 * 60_000);
    expect(env.planner.calls).toHaveLength(2);

    void env.session.continueConversation('try now');
    await until(() => env.planner.calls.length === 3);
    expect(env.planner.calls[2].message).toMatch(/rename task 1\n\ntry now$/);
  });

  it('waits for the next message when the limit names no reset', async () => {
    const env = await idle();
    const sent = env.session.continueConversation('rename task 1');
    await until(() => env.planner.calls.length === 1);
    env.planner.calls[0].finish(limited('Usage limit reached.'));
    await sent;

    expect(env.session.planState!.plannerResend).toEqual({ runner: 'claude-code' });
    expect(env.session.planState!.conversationHistory!.at(-1)).toMatchObject({
      kind: 'error', content: 'claude-code usage limit; it did not say when it resets. Send a message once it has reset: what waits goes with it.',
    });

    void env.session.continueConversation('go on');
    await until(() => env.planner.calls.length === 2);
    expect(env.planner.calls[1].message).toMatch(/rename task 1\n\ngo on$/);
  });

  it('can be cancelled: nothing goes at the reset, and what waits goes with the next message', async () => {
    const env = await idle();
    const sent = env.session.continueConversation('rename task 1');
    await until(() => env.planner.calls.length === 1);
    env.planner.calls[0].finish(limited());
    await sent;

    expect(env.session.cancelPlannerResend()).toBe(true);
    expect(env.session.cancelPlannerResend()).toBe(false);
    await vi.advanceTimersByTimeAsync(Date.parse(RESUME_AT) - Date.now() + 60_000);
    expect(env.planner.calls).toHaveLength(1);
    expect(env.session.planState!.plannerResend).toEqual({ runner: 'claude-code' });

    void env.session.continueConversation('go on');
    await until(() => env.planner.calls.length === 2);
    expect(env.planner.calls[1].message).toMatch(/rename task 1\n\ngo on$/);
  });

  it('is cancelled by a switch to another planner, whose account the limit is not', async () => {
    const config = fakeConfig({ aiProvider: 'claude-code' });
    const planner = heldPlanner();
    const notices: SessionNotice[] = [];
    const session = makeSession({ config, aiService: planner.aiService, onNotice: (n) => notices.push(n) });
    session.loadPlan(plan([task('t1', 1)]), 'build it', testWorkspace);
    const sent = session.continueConversation('rename task 1');
    await until(() => planner.calls.length === 1);
    planner.calls[0].finish(limited());
    await sent;

    config.aiProvider = 'codex';
    await vi.advanceTimersByTimeAsync(Date.parse(RESUME_AT) - Date.now());
    expect(planner.calls).toHaveLength(1);
    expect(notices).toContainEqual(expect.objectContaining({ message: expect.stringMatching(/no longer runs on claude-code/) }));

    void session.continueConversation('go on');
    await until(() => planner.calls.length === 2);
    expect(planner.calls[1].message).toMatch(/rename task 1\n\ngo on$/);
  });
});

describe('a wake-up turn that ends on the planner\'s usage limit', () => {
  it('sends the wake-up again at the reset, in one turn with the user\'s message sent meanwhile', async () => {
    const env = await wokenUp({ config: { aiProvider: 'claude-code' } });
    env.planner.calls[0].finish(limited());
    await settled();
    expect(env.session.planState!.runSettings!.unsupervised).toBeUndefined();

    await env.session.continueConversation('what needs me?');
    await vi.advanceTimersByTimeAsync(Date.parse(RESUME_AT) - Date.now());
    await until(() => env.planner.calls.length === 2);

    expect(env.planner.calls[1].message).toMatch(/- task #1 "Task t1" is waiting for input[\s\S]*what needs me\?$/);
  });
});

describe('what surfaces are told of the wait', () => {
  const lastResend = (messages: SessionMessage[]) => {
    const plans = messages.filter((m): m is Extract<SessionMessage, { type: 'plan_generated' }> => m.type === 'plan_generated');
    return plans.at(-1)?.plan.plannerResend ?? null;
  };

  it('announces the wait as it is armed, cancelled, and over', async () => {
    const env = await idle();
    const sent = env.session.continueConversation('rename task 1');
    await until(() => env.planner.calls.length === 1);
    env.planner.calls[0].finish(limited());
    await sent;
    expect(lastResend(env.messages)).toEqual({ runner: 'claude-code', at: RESUME_AT });

    env.session.cancelPlannerResend();
    expect(lastResend(env.messages)).toEqual({ runner: 'claude-code' });

    void env.session.continueConversation('go on');
    await until(() => env.planner.calls.length === 2);
    expect(lastResend(env.messages)).toBeNull();
  });
});

describe('a wait on the planner\'s usage limit across a reload', () => {
  const pending = [{ id: 'turn-1', source: 'user' as const, text: 'rename task 1', timestamp: NOW.toISOString() }];

  function reopened(over: Partial<LegacyPlanState>) {
    const planner = heldPlanner();
    const session = makeSession({ config: fakeConfig({ aiProvider: 'claude-code' }), aiService: planner.aiService });
    session.loadPlan(plan([task('t1', 1)], { pendingTurns: pending, ...over }), 'build it', testWorkspace);
    return { session, planner };
  }

  it('resends at the saved time', async () => {
    const { planner } = reopened({ plannerResend: { runner: 'claude-code', at: RESUME_AT } });
    await settled();
    expect(planner.calls).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(Date.parse(RESUME_AT) - Date.now());
    await until(() => planner.calls.length === 1);
    expect(planner.calls[0].message).toMatch(/rename task 1$/);
  });

  it('resends at once when its time passed while the session was closed', async () => {
    const { planner } = reopened({ plannerResend: { runner: 'claude-code', at: '2026-10-11T17:00:00.000Z' } });
    await until(() => planner.calls.length === 1);
  });

  it('keeps holding what waits for the next message when it had no time', async () => {
    const { session, planner } = reopened({ plannerResend: { runner: 'claude-code' } });
    await vi.advanceTimersByTimeAsync(60 * 60_000);
    expect(planner.calls).toHaveLength(0);

    void session.continueConversation('go on');
    await until(() => planner.calls.length === 1);
    expect(planner.calls[0].message).toMatch(/rename task 1\n\ngo on$/);
  });
});

describe('an opening that ends on the planner\'s usage limit', () => {
  it('keeps the goal waiting, out of the dialogue, and sends it at the reset', async () => {
    const planner = heldPlanner();
    const session = makeSession({ config: fakeConfig({ aiProvider: 'claude-code' }), aiService: planner.aiService });

    const opened = session.startPlanning('build a parser');
    await until(() => planner.calls.length === 1);
    planner.calls[0].finish(limited());
    await opened;

    expect(session.planState!.conversationHistory).toEqual([expect.objectContaining({ kind: 'error' })]);
    expect(session.planState!.pendingTurns!.map((t) => t.text)).toEqual(['build a parser']);
    expect(session.planState!.plannerResend).toEqual({ runner: 'claude-code', at: RESUME_AT });

    await vi.advanceTimersByTimeAsync(Date.parse(RESUME_AT) - Date.now());
    await until(() => planner.calls.length === 2);
    expect(planner.calls[1].message).toMatch(/build a parser$/);
    planner.calls[1].finish(prose('What should it parse?'));
    await settled();
    expect(session.planState!.conversationHistory!.slice(1).map((e) => e.content)).toEqual(['build a parser', 'What should it parse?']);
    expect(session.rewindTargets()).toEqual([]);
  });
});
