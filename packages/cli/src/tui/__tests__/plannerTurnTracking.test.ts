import { describe, it, expect, vi } from 'vitest';
import { runEffect, type EffectDeps, type OrdewellApi } from '../effects';
import { initialState, reduce, type Action, type Effect } from '../reducer';
import type { TuiState } from '../state';

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
