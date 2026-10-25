import { describe, it, expect, vi } from 'vitest';
import type { SessionMessage } from '@ordewell/core';
import { runEffect, type EffectDeps, type OrdewellApi } from '../effects';
import { initialState, reduce, type Action, type Effect } from '../reducer';
import { plannerInFlight, type TuiState } from '../state';

/**
 * What the TUI believes about the planner turn it has out: a plan refresh, a
 * loaded session and a repeated reply must each leave that belief alone or
 * correct it, never end the turn or send a prompt held for another session.
 */

const typed = (state: TuiState, text: string): TuiState => ({ ...state, editor: { ...state.editor, text, cursor: text.length } });
const enter = (state: TuiState, text: string): TuiState => reduce(typed(state, text), { type: 'key', key: { name: 'enter' } }).state;

/** A turn out in session s1, with one prompt held behind it. */
const midTurn = (): TuiState => enter(enter(initialState({ sessionId: 's1', rows: 30, cols: 100 }), 'build it'), 'and a README');

function deps(api: Partial<OrdewellApi>, actions: Action[]): EffectDeps {
  return {
    api: api as OrdewellApi,
    workspace: '/ws',
    port: 3742,
    dispatch: (action) => actions.push(action),
    newSessionId: () => 's1',
    setEnvVar: () => {},
    saveAutonomy: () => ({ overridden: false }),
    setMouseCapture: () => {},
    hasBin: () => true,
    pipeToClipboard: () => {},
    writeTerminal: () => {},
    reviveDaemon: () => Promise.resolve(false),
    exit: () => {},
  };
}

/** Folds the actions an effect dispatched into `state`, collecting every effect the reducer asked for. */
function fold(state: TuiState, actions: Action[]): { state: TuiState; effects: Effect[] } {
  const effects: Effect[] = [];
  let current = state;
  for (const action of actions) {
    const result = reduce(current, action);
    current = result.state;
    effects.push(...result.effects);
  }
  return { state: current, effects };
}

describe('a plan refresh during a planner turn', () => {
  it('shows the plan and leaves the turn, and the prompt held behind it, where they were', async () => {
    const actions: Action[] = [];
    const api: Partial<OrdewellApi> = {
      removeTask: vi.fn().mockResolvedValue({ ok: true }),
      getSession: vi.fn().mockResolvedValue({ meta: { id: 's1', goal: 'g' }, plan: { tasks: [] } }),
    };
    await runEffect({ type: 'removeTask', sessionId: 's1', taskId: 'task-1' } as Effect, deps(api, actions));

    const before = midTurn();
    const { state, effects } = fold(before, actions);

    expect(state.planner).toBe(before.planner);
    expect(state.queuedPrompts).toEqual(['and a README']);
    expect(effects.filter((e) => e.type === 'sendMessage')).toEqual([]);
  });
});

describe('loading another session during a planner turn', () => {
  it('does not send the old session\'s held prompt to the loaded one, nor keep its turn', async () => {
    const actions: Action[] = [];
    const api: Partial<OrdewellApi> = {
      followSession: () => ({ ready: Promise.resolve(true), ended: new Promise(() => {}), close: () => {} }),
      adoptSession: vi.fn().mockResolvedValue({ plan: { tasks: [] }, goal: 'Other goal' }),
    };
    await runEffect({ type: 'loadSession', sessionId: 's2' }, deps(api, actions));

    const { state, effects } = fold(midTurn(), actions);

    expect(state.sessionId).toBe('s2');
    expect(effects.filter((e) => e.type === 'sendMessage')).toEqual([]);
    expect(state.queuedPrompts).toEqual([]);
    expect(state.planner).toBe('idle');
    expect(state.stopArmed).toBe(false);
    expect(state.forceSendPending).toBeNull();
  });
});

describe('loading a session while the daemon runs a planner turn', () => {
  const compaction = (phase: 'started' | 'ended'): SessionMessage => ({
    type: 'planner_compaction',
    compaction: phase === 'started'
      ? { phase, id: 'c1', origin: 'ordewell', trigger: 'auto', at: '2026-01-02T00:00:00.000Z' }
      : { phase, id: 'c1', origin: 'ordewell', trigger: 'auto', outcome: 'condensed', at: '2026-01-02T00:00:05.000Z' },
  });
  const heard = (message: SessionMessage): Action => ({ type: 'sessionMessage', sessionId: 's2', message });
  const turnEnded = heard({ type: 'planner_turn_ended', turnId: 't1', outcome: 'message' });

  /** The session as `/load` leaves it when the daemon names turn `t1` as running. */
  async function loaded(): Promise<TuiState> {
    const actions: Action[] = [];
    const api: Partial<OrdewellApi> = {
      followSession: () => ({ ready: Promise.resolve(true), ended: new Promise(() => {}), close: () => {} }),
      adoptSession: vi.fn().mockResolvedValue({ plan: { tasks: [] }, goal: 'g', plannerTurnId: 't1' }),
    };
    await runEffect({ type: 'loadSession', sessionId: 's2' }, deps(api, actions));
    return fold(initialState({ rows: 30, cols: 100 }), actions).state;
  }

  it('leaves the planner free when that turn\'s end reached the socket while the load was answered', async () => {
    const actions: Action[] = [];
    let onEvent: ((event: SessionMessage) => void) | undefined;
    const api: Partial<OrdewellApi> = {
      followSession: (_id, handler) => {
        onEvent = handler as (event: SessionMessage) => void;
        return { ready: Promise.resolve(true), ended: new Promise(() => {}), close: () => {} };
      },
      adoptSession: vi.fn().mockImplementation(async () => {
        onEvent!({ type: 'planner_turn_ended', turnId: 't1', outcome: 'message' });
        return { plan: { tasks: [] }, goal: 'g', plannerTurnId: 't1' };
      }),
    };
    await runEffect({ type: 'loadSession', sessionId: 's2' }, deps(api, actions));
    const { state } = fold(initialState({ rows: 30, cols: 100 }), actions);

    expect(plannerInFlight(state)).toBe(false);
    expect(state.planner).toBe('idle');
    expect(state.turnGate.open).toBeNull();
    const sent = reduce(typed(state, 'and a README'), { type: 'key', key: { name: 'enter' } });
    expect(sent.effects.filter((e) => e.type === 'sendMessage')).toEqual([{ type: 'sendMessage', sessionId: 's2', message: 'and a README' }]);
  });

  it('keeps the planner busy through a compaction inside that turn, until the turn itself ends', async () => {
    const during = fold(await loaded(), [heard(compaction('started')), heard(compaction('ended'))]).state;

    expect(plannerInFlight(during)).toBe(true);
    expect(during.turnGate.open).toBe('t1');
    expect(fold(during, [turnEnded]).state.planner).toBe('idle');
  });

  it('holds a prompt typed during that compaction, and sends it once the turn ends', async () => {
    const typedDuring = enter(fold(await loaded(), [heard(compaction('started'))]).state, 'and a README');
    const compacted = fold(typedDuring, [heard(compaction('ended'))]);

    expect(compacted.state.queuedPrompts).toEqual(['and a README']);
    expect(compacted.effects.filter((e) => e.type === 'sendMessage')).toEqual([]);

    const ended = fold(compacted.state, [turnEnded]);
    expect(ended.effects.filter((e) => e.type === 'sendMessage')).toEqual([{ type: 'sendMessage', sessionId: 's2', message: 'and a README' }]);
    expect(ended.state.queuedPrompts).toEqual([]);
  });
});
