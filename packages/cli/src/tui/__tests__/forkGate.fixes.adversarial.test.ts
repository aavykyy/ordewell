import { describe, expect, it } from 'vitest';
import { initialState, reduce } from '../reducer';
import type { TuiState } from '../state';

/**
 * Adversarial, round two: the first round reset the turn gate on a fork. The
 * other ways the session on screen changes — a deleted session starting fresh,
 * a load — must close it too, or ctrl-s force-sends a turn that is not the new
 * session's.
 */

const enter = { type: 'key' as const, key: { name: 'enter' } };
const ctrlS = { type: 'key' as const, key: { name: 'ctrl-s' } };

/** A turn another client opened, as the socket announces it: the gate is open. */
const midTurn = (over: Partial<TuiState> = {}): TuiState =>
  reduce(initialState({ sessionId: 's1', planner: 'idle', ...over }), {
    type: 'sessionMessage',
    sessionId: 's1',
    message: { type: 'planner_turn_started', turnId: 't1', prompt: 'Research the repository' },
  }).state;

const withDraft = (state: TuiState, text: string): TuiState => ({
  ...state,
  editor: { ...state.editor, text, cursor: text.length },
});

describe('adversarial: a session change around the turn gate beyond the fork', () => {
  it('a deleted session starts fresh with no turn in its gate', () => {
    const deleted = reduce(midTurn(), { type: 'sessionDeleted', sessionId: 's1' }).state;

    expect(deleted.sessionId).toBeNull();
    expect(deleted.turnGate.open).toBeNull();

    const sent = reduce(withDraft(deleted, 'start over'), ctrlS);
    expect(sent.effects).toEqual([{ type: 'startConversation', goal: 'start over' }]);
  });

  it('loading another session closes the gate the old turn held, with the TUI\'s own turn running', () => {
    const own = midTurn({ planner: 'planning' as const });
    const loaded = reduce(own, { type: 'sessionLoaded', sessionId: 's2', goal: 'g' }).state;

    expect(loaded.turnGate.open).toBeNull();
    expect(loaded.planner).toBe('idle');

    const sent = reduce(withDraft(loaded, 'hello s2'), ctrlS);
    expect(sent.effects).toEqual([{ type: 'sendMessage', sessionId: 's2', message: 'hello s2' }]);
  });

  it('a message that arrives for the old session after a load is stale, and opens nothing', () => {
    const loaded = reduce(midTurn(), { type: 'sessionLoaded', sessionId: 's2', goal: 'g' }).state;

    const stale = reduce(loaded, {
      type: 'sessionMessage',
      sessionId: 's1',
      message: { type: 'planner_turn_started', turnId: 't9', prompt: 'old' },
    }).state;

    expect(stale.turnGate.open).toBeNull();
  });

  it('a draft parked on the old session is not carried into the new one\'s gate', () => {
    const queued = reduce(withDraft(midTurn({ planner: 'planning' as const }), 'second prompt'), enter).state;
    expect(queued.queuedPrompts).toHaveLength(1);

    const deleted = reduce(queued, { type: 'sessionDeleted', sessionId: 's1' }).state;
    expect(deleted.turnGate.open).toBeNull();
    expect(deleted.queuedPrompts).toHaveLength(0);
  });
});
