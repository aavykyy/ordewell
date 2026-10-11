import { afterEach, describe, expect, it, vi } from 'vitest';
import type { LegacyPlanState } from '../../models/Task';
import { PlanTurns, turnPrompt, type PlanTurnsHost } from '../PlanTurns';
import { ConversationBusyError, PlannerTurnDiscardedError, PlannerTurnStoppedError } from '../PlannerConversation';
import type { SkillInvocation } from '../skillInvocation';
import { flushMicrotasks } from '../../testing';

function plan(): LegacyPlanState {
  const now = '2026-10-11T00:00:00Z';
  return { tasks: [], generatedAt: now, status: 'approved', runners: ['claude-code'], lastUpdated: now };
}

interface HeldTurn {
  prompt: SkillInvocation;
  signal?: AbortSignal;
  /** Land the turn: its commit runs `taken`, as the conversation's mutation does. */
  land(): void;
  fail(err: unknown): void;
}

/** A host whose turns the test ends by hand, recording the hold and every save. */
function fakeHost(current: { plan: LegacyPlanState | null } = { plan: plan() }) {
  const turns: HeldTurn[] = [];
  const saved: string[][] = [];
  let holds = 0;
  const host = {
    plan: () => current.plan,
    conversationBusy: vi.fn(() => false),
    persist: vi.fn(() => { saved.push((current.plan?.pendingTurns ?? []).map((t) => t.text)); }),
    holdStarts: vi.fn(() => {
      holds++;
      let held = true;
      return () => { if (held) { held = false; holds--; } };
    }),
    resumeStarts: vi.fn(async () => {}),
    run: vi.fn((prompt: SkillInvocation, { taken, signal }: { taken: () => void; signal?: AbortSignal }) => new Promise<LegacyPlanState>((resolve, reject) => {
      turns.push({
        prompt,
        signal,
        land: () => {
          taken();
          host.persist();
          resolve(current.plan!);
        },
        fail: reject,
      });
    })),
    notice: vi.fn(),
  } satisfies PlanTurnsHost;
  return { host, turns, saved, current, held: () => holds };
}

afterEach(() => { vi.useRealTimers(); });

describe('PlanTurns', () => {
  it('starts a turn at once and holds new starts until it lands', async () => {
    const { host, turns, held } = fakeHost();
    const turnsRunner = new PlanTurns(host);

    const answered = turnsRunner.enqueue({ source: 'user', text: 'why did task 5 fail?' });

    expect(turns).toHaveLength(1);
    expect(turns[0].prompt.text).toBe('why did task 5 fail?');
    expect(held()).toBe(1);
    turns[0].land();
    await answered;
    expect(held()).toBe(0);
    expect(host.resumeStarts).toHaveBeenCalledTimes(1);
  });

  it('releases the hold when the turn fails, and rejects its caller', async () => {
    const { host, turns, held } = fakeHost();
    const runner = new PlanTurns(host);

    const answered = runner.enqueue({ source: 'user', text: 'rename task 2' });
    turns[0].fail(new Error('planner down'));

    await expect(answered).rejects.toThrow('planner down');
    expect(held()).toBe(0);
    expect(host.resumeStarts).toHaveBeenCalled();
  });

  it('lets new starts go once the hold times out, while the turn itself goes on', async () => {
    vi.useFakeTimers();
    const { host, turns, held } = fakeHost();
    const runner = new PlanTurns(host, 1_000);

    const answered = runner.enqueue({ source: 'user', text: 'a long question' });
    expect(held()).toBe(1);
    await vi.advanceTimersByTimeAsync(1_000);

    expect(held()).toBe(0);
    expect(host.resumeStarts).toHaveBeenCalledTimes(1);
    expect(runner.busy).toBe(true);
    turns[0].land();
    await answered;
    expect(held()).toBe(0);
  });

  it('runs one turn at a time and takes what arrived meanwhile together, in order', async () => {
    const { host, turns } = fakeHost();
    const runner = new PlanTurns(host);

    const first = runner.enqueue({ source: 'user', text: 'one' });
    const second = runner.enqueue({ source: 'user', text: 'two' });
    const third = runner.enqueue({ source: 'supervisor', text: 'three' });
    expect(turns).toHaveLength(1);

    turns[0].land();
    await first;
    await vi.waitFor(() => expect(turns).toHaveLength(2));
    expect(turns[1].prompt.text).toBe('two\n\nthree');
    turns[1].land();
    await expect(Promise.all([second, third])).resolves.toHaveLength(2);
  });

  it('saves an input as it arrives and drops it in the save that lands its turn', async () => {
    const { host, turns, saved } = fakeHost();
    const runner = new PlanTurns(host);

    const answered = runner.enqueue({ source: 'user', text: 'add a docs task' });
    expect(saved).toEqual([['add a docs task']]);
    turns[0].land();
    await answered;

    // One save after the arrival: the turn's own, without the input. Nothing
    // was saved between the change landing and the input leaving.
    expect(saved).toEqual([['add a docs task'], []]);
  });

  it('drops the inputs of a turn that ended without landing anything', async () => {
    const { host, turns, current } = fakeHost();
    const runner = new PlanTurns(host);

    const answered = runner.enqueue({ source: 'user', text: 'x' });
    turns[0].fail(new PlannerTurnStoppedError());
    await expect(answered).rejects.toBeInstanceOf(PlannerTurnStoppedError);

    expect(current.plan!.pendingTurns).toEqual([]);
    expect(host.persist).toHaveBeenCalledTimes(2);
  });

  it('replays what a saved plan still holds, once, and tells the user if it fails', async () => {
    const saved = plan();
    saved.pendingTurns = [{ id: 'turn-1', source: 'user', text: 'sent before the restart', timestamp: '2026-10-11T00:00:00Z' }];
    const { host, turns, current } = fakeHost({ plan: saved });
    const runner = new PlanTurns(host);

    runner.pump();
    runner.pump();

    expect(turns).toHaveLength(1);
    expect(turns[0].prompt.text).toBe('sent before the restart');
    turns[0].fail(new Error('planner down'));
    await vi.waitFor(() => expect(host.notice).toHaveBeenCalledWith(expect.stringContaining('planner down')));
    expect(current.plan!.pendingTurns).toEqual([]);
    runner.pump();
    expect(turns).toHaveLength(1);
  });

  it('refuses an input while a turn of another kind holds the conversation', async () => {
    const { host, turns } = fakeHost();
    host.conversationBusy.mockReturnValue(true);
    const runner = new PlanTurns(host);

    await expect(runner.enqueue({ source: 'user', text: 'and CSV' })).rejects.toBeInstanceOf(ConversationBusyError);
    expect(turns).toHaveLength(0);
  });

  it('waits for the conversation when another turn took it between two of its own', async () => {
    const { host, turns } = fakeHost();
    const runner = new PlanTurns(host);
    const first = runner.enqueue({ source: 'user', text: 'one' });
    const second = runner.enqueue({ source: 'user', text: 'two' });

    host.conversationBusy.mockReturnValue(true);
    turns[0].land();
    await first;
    await flushMicrotasks();
    expect(turns).toHaveLength(1);

    host.conversationBusy.mockReturnValue(false);
    runner.pump();
    expect(turns[1].prompt.text).toBe('two');
    turns[1].land();
    await second;
  });

  it('on a plan swap lets the hold go at once and discards every waiting caller', async () => {
    const { host, turns, held, current } = fakeHost();
    const runner = new PlanTurns(host);
    const inFlight = runner.enqueue({ source: 'user', text: 'one' });
    const waiting = runner.enqueue({ source: 'user', text: 'two' });
    const old = current.plan!;

    current.plan = plan();
    runner.abandon();

    expect(held()).toBe(0);
    await expect(inFlight).rejects.toBeInstanceOf(PlannerTurnDiscardedError);
    await expect(waiting).rejects.toBeInstanceOf(PlannerTurnDiscardedError);
    turns[0].fail(new PlannerTurnDiscardedError());
    await flushMicrotasks();
    expect(turns).toHaveLength(1);
    expect(current.plan.pendingTurns).toBeUndefined();
    expect(old.pendingTurns?.map((t) => t.text)).toEqual(['one', 'two']);
    expect(host.notice).not.toHaveBeenCalled();
  });

  it('relays a caller\'s stop into its turn, and drops an input stopped before its turn began', async () => {
    const { host, turns } = fakeHost();
    const runner = new PlanTurns(host);
    const first = new AbortController();
    const second = new AbortController();
    const one = runner.enqueue({ source: 'user', text: 'one', signal: first.signal });
    const two = runner.enqueue({ source: 'user', text: 'two', signal: second.signal });

    first.abort();
    expect(turns[0].signal?.aborted).toBe(true);
    second.abort();
    turns[0].fail(new PlannerTurnStoppedError());

    await expect(one).rejects.toBeInstanceOf(PlannerTurnStoppedError);
    await expect(two).rejects.toBeInstanceOf(PlannerTurnStoppedError);
    expect(turns).toHaveLength(1);
  });
});

describe('turnPrompt', () => {
  it('joins a batch in order and keeps every skill it loaded', () => {
    const skill = { name: 'tdd', source: 'global' as const, path: '/s/tdd/SKILL.md', content: 'body', invokedBy: 'user' as const };
    const prompt = turnPrompt([
      { id: '1', source: 'user', text: '/tdd one', timestamp: 't', skills: [skill] },
      { id: '2', source: 'user', text: 'two', timestamp: 't' },
    ]);
    expect(prompt).toEqual({ text: '/tdd one\n\ntwo', skills: [skill] });
  });
});
