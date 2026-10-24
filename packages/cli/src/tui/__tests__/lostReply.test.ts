import { describe, it, expect, vi } from 'vitest';
import type { SurfacePlan } from '@ordewell/core';
import { DaemonError } from '../../apiClient';
import { runEffect, type EffectDeps, type OrdewellApi } from '../effects';
import { initialState, reduce, type Action, type Effect } from '../reducer';
import type { TuiState } from '../state';
import { messagesOf } from './chat';

/**
 * A planner turn whose reply was lost in transit is not a failed turn. The
 * daemon runs a turn to its end whether or not the client is still waiting, so
 * a timeout or a reset leaves the outcome unknown — and the session, the
 * queue and the message all belong to a turn that may still be running.
 */

const timedOut = () => new Error('Request timed out');
const sessionGone = () => new DaemonError('Session not found', 404, 'session_not_found');

const planWith = (...history: Array<{ role: 'user' | 'assistant'; content: string }>): SurfacePlan =>
  ({ tasks: [], conversationHistory: history } as unknown as SurfacePlan);

/** The effect runner and the reducer wired as the TUI wires them, so a test reads what the user would see. */
function tui(api: Partial<OrdewellApi>, start: Partial<TuiState> = {}) {
  let state = initialState(start);
  const sent: Effect[] = [];
  const unfollowed = vi.fn();
  const deps: EffectDeps = {
    api: {
      startConversation: vi.fn().mockResolvedValue({ tasks: [] }),
      sendConversationMessage: vi.fn().mockResolvedValue({ tasks: [] }),
      forceSendPlannerMessage: vi.fn().mockResolvedValue({ tasks: [] }),
      compactConversation: vi.fn().mockResolvedValue({ plan: { tasks: [] }, summary: '' }),
      adoptSession: vi.fn().mockResolvedValue({ plan: planWith(), goal: 'g' }),
      streamPlanning: vi.fn().mockReturnValue({ ready: Promise.resolve(), close: vi.fn() }),
      followSession: vi.fn().mockReturnValue({ ready: Promise.resolve(true), ended: new Promise(() => {}), close: unfollowed }),
      ...api,
    } as unknown as OrdewellApi,
    workspace: '/ws',
    port: 3742,
    dispatch: (action: Action) => apply(action),
    newSessionId: () => 'session-new',
    setEnvVar: () => {},
    saveAutonomy: () => ({ overridden: false }),
    setMouseCapture: () => {},
    hasBin: () => true,
    pipeToClipboard: () => {},
    writeTerminal: () => {},
    reviveDaemon: vi.fn().mockResolvedValue(true),
    exit: () => {},
  };
  const actions: Action[] = [];
  const pending: Promise<void>[] = [];
  function apply(action: Action): void {
    actions.push(action);
    const step = reduce(state, action);
    state = step.state;
    for (const effect of step.effects) {
      sent.push(effect);
      // Only the effects a lost reply is reconciled by run for real; the rest are recorded.
      if (effect.type === 'reconcileTurn') pending.push(runEffect(effect, deps));
    }
  }
  return {
    deps,
    actions,
    unfollowed,
    api: deps.api as { [K in keyof OrdewellApi]: ReturnType<typeof vi.fn> },
    get state() { return state; },
    sent,
    run: async (effect: Effect) => { await runEffect(effect, deps); await Promise.all(pending); },
    send: (action: Action) => apply(action),
    settle: () => Promise.all(pending),
    type(text: string) {
      state = { ...state, editor: { ...state.editor, text, cursor: text.length } };
      apply({ type: 'key', key: { name: 'enter' } });
    },
  };
}

const types = (actions: Action[]) => actions.map((a) => a.type);

describe('an opening turn whose reply was lost', () => {
  it('keeps the session, follows it, and reloads what the daemon holds', async () => {
    const t = tui({ startConversation: vi.fn().mockRejectedValue(timedOut()) });
    await t.run({ type: 'startConversation', goal: 'ship the 44-task plan' });

    expect(types(t.actions)).not.toContain('sessionCleared');
    expect(t.unfollowed).not.toHaveBeenCalled();
    expect(t.api.adoptSession).toHaveBeenCalledWith('session-new', '/ws');
    expect(t.state.sessionId).toBe('session-new');
  });

  it('answers the next reply on the same session instead of opening a new one', async () => {
    const t = tui({ startConversation: vi.fn().mockRejectedValue(timedOut()) });
    await t.run({ type: 'startConversation', goal: 'ship the 44-task plan' });
    t.sent.length = 0;

    t.type('ok looks good, output the plan and run it');

    expect(t.sent).toEqual([{ type: 'sendMessage', sessionId: 'session-new', message: 'ok looks good, output the plan and run it' }]);
  });

  it('says in one line that the reply was lost and the turn may still be going', async () => {
    const t = tui({ sendConversationMessage: vi.fn().mockRejectedValue(timedOut()) }, { sessionId: 's1', planner: 'planning' });
    t.send({ type: 'sessionMessage', sessionId: 's1', message: { type: 'planner_turn_started', turnId: 't1' } });
    await t.run({ type: 'sendMessage', sessionId: 's1', message: 'x' });

    const said = messagesOf(t.state).map((m) => m.text).filter((text) => /lost/i.test(text));
    expect(said).toHaveLength(1);
    expect(said[0]).toMatch(/still running|may have finished/i);
  });

  it('keeps saying the reply was lost once the daemon\'s state is redrawn', async () => {
    const t = tui({ startConversation: vi.fn().mockRejectedValue(timedOut()) });
    await t.run({ type: 'startConversation', goal: 'x' });

    expect(messagesOf(t.state).some((m) => /lost on the way/i.test(m.text))).toBe(true);
  });

  it.each([
    ['a reset', Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' })],
    ['a hang-up', new Error('socket hang up')],
  ])('treats %s as the same unknown outcome', async (_name, err) => {
    const t = tui({ startConversation: vi.fn().mockRejectedValue(err) });
    await t.run({ type: 'startConversation', goal: 'x' });

    expect(types(t.actions)).not.toContain('sessionCleared');
  });

  it('clears the session only when the daemon says it holds none', async () => {
    const t = tui({
      startConversation: vi.fn().mockRejectedValue(timedOut()),
      adoptSession: vi.fn().mockRejectedValue(sessionGone()),
    });
    await t.run({ type: 'startConversation', goal: 'x' });

    expect(types(t.actions)).toContain('sessionCleared');
    expect(t.unfollowed).toHaveBeenCalled();
    expect(t.state.sessionId).toBeNull();
    expect(t.state.planner).toBe('idle');
  });

  it('still clears the session when the daemon answered with a refusal', async () => {
    const t = tui({ startConversation: vi.fn().mockRejectedValue(new DaemonError('no key', 400)) });
    await t.run({ type: 'startConversation', goal: 'x' });

    expect(types(t.actions)).toContain('sessionCleared');
    expect(t.api.adoptSession).not.toHaveBeenCalled();
  });

  it('shows the conversation and plan the daemon finished', async () => {
    const t = tui({
      startConversation: vi.fn().mockRejectedValue(timedOut()),
      adoptSession: vi.fn().mockResolvedValue({
        plan: planWith({ role: 'user', content: 'x' }, { role: 'assistant', content: 'Plan committed: 44 tasks.' }),
        goal: 'x',
      }),
    });
    await t.run({ type: 'startConversation', goal: 'x' });

    expect(messagesOf(t.state).some((m) => m.text === 'Plan committed: 44 tasks.')).toBe(true);
    expect(t.state.planner).toBe('idle');
  });
});

describe('a later turn whose reply was lost', () => {
  const turnOpen = (sessionId: string): Partial<TuiState> => ({ sessionId, planner: 'planning', queuedPrompts: ['and the tests'] });

  /** The daemon's stream says turn `t1` is open, as it does for a turn awaiting exploration agents. */
  function runningTurn(api: Partial<OrdewellApi>) {
    const t = tui(api, turnOpen('s1'));
    t.send({ type: 'sessionMessage', sessionId: 's1', message: { type: 'planner_turn_started', turnId: 't1' } });
    return t;
  }

  it('does not drain the queue into a turn the daemon may still be running', async () => {
    const t = runningTurn({ sendConversationMessage: vi.fn().mockRejectedValue(timedOut()) });
    await t.run({ type: 'sendMessage', sessionId: 's1', message: 'first' });

    expect(t.state.queuedPrompts).toEqual(['and the tests']);
    expect(t.state.planner).toBe('awaiting');
    expect(t.sent.filter((e) => e.type === 'sendMessage')).toEqual([]);
    expect(t.api.sendConversationMessage).toHaveBeenCalledTimes(1);
    expect(types(t.actions)).not.toContain('failed');
  });

  it('settles and sends the queue once, when the stream says the turn ended', async () => {
    const t = runningTurn({ sendConversationMessage: vi.fn().mockRejectedValue(timedOut()) });
    await t.run({ type: 'sendMessage', sessionId: 's1', message: 'first' });

    t.send({ type: 'sessionMessage', sessionId: 's1', message: { type: 'planner_turn_ended', turnId: 't1', outcome: 'message' } });
    await t.settle();

    expect(t.sent.filter((e) => e.type === 'sendMessage')).toEqual([{ type: 'sendMessage', sessionId: 's1', message: 'and the tests' }]);
    expect(t.state.queuedPrompts).toEqual([]);
  });

  it('does not resend the message that was lost', async () => {
    const t = runningTurn({ sendConversationMessage: vi.fn().mockRejectedValue(timedOut()) });
    await t.run({ type: 'sendMessage', sessionId: 's1', message: 'first' });
    t.send({ type: 'sessionMessage', sessionId: 's1', message: { type: 'planner_turn_ended', turnId: 't1', outcome: 'message' } });
    await t.settle();

    expect(t.sent.filter((e) => e.type === 'sendMessage' && e.message === 'first')).toEqual([]);
  });

  it('keeps a lost send-now out of the composer, since the daemon may have taken it', async () => {
    const t = tui({ forceSendPlannerMessage: vi.fn().mockRejectedValue(timedOut()) }, { sessionId: 's1', planner: 'planning', forceSendPending: { text: 'now' } });
    await t.run({ type: 'forceSendPlannerMessage', sessionId: 's1', message: 'now' });

    expect(t.state.forceSendPending).toBeNull();
    expect(t.state.editor.text).toBe('');
  });

  it('reloads the conversation after a lost compaction rather than reporting it failed', async () => {
    const t = tui({ compactConversation: vi.fn().mockRejectedValue(timedOut()) }, { sessionId: 's1', planner: 'planning' });
    await t.run({ type: 'compactConversation', sessionId: 's1' });

    expect(t.api.adoptSession).toHaveBeenCalledWith('s1', '/ws');
    expect(types(t.actions)).not.toContain('failed');
  });

  it('reports a daemon refusal as a failed turn, as before', async () => {
    const t = tui({ sendConversationMessage: vi.fn().mockRejectedValue(new DaemonError('planner down', 500)) }, turnOpen('s1'));
    await t.run({ type: 'sendMessage', sessionId: 's1', message: 'first' });

    expect(types(t.actions)).toContain('failed');
    expect(t.api.adoptSession).not.toHaveBeenCalled();
  });
});

describe('a turn end that went with the follow socket', () => {
  it('reads the session back when the follow reconnects', () => {
    const awaiting = initialState({ sessionId: 's1', planner: 'awaiting' });
    expect(reduce(awaiting, { type: 'followRestored', sessionId: 's1' }).effects)
      .toEqual([{ type: 'reconcileTurn', sessionId: 's1' }]);
  });

  it('does nothing when no reply is waiting on it', () => {
    const idle = initialState({ sessionId: 's1' });
    expect(reduce(idle, { type: 'followRestored', sessionId: 's1' }).effects).toEqual([]);
  });
});
