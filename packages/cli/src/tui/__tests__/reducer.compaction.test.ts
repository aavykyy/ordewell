import { describe, it, expect } from 'vitest';
import type { SessionMessage } from '@ordewell/core';
import { initialState, reduce, type Action } from '../reducer';
import type { TuiState } from '../state';
import { chatActivity } from '../layout';
import { chatOf, messagesOf } from './chat';

/*
 * A compaction this surface did not ask for — the planner's own, another
 * surface's, one already running at adoption — has no call here to settle it:
 * the events alone mark the planner busy and free (ADR-0017).
 */

type Compaction = Extract<SessionMessage, { type: 'planner_compaction' }>;

const started = (id = 'c1', trigger: 'manual' | 'auto' = 'auto'): Compaction => ({
  type: 'planner_compaction', compaction: { phase: 'started', id, origin: 'ordewell', trigger, at: '2026-01-02T00:00:00.000Z' },
});
const ended = (outcome: 'condensed' | 'pruned' | 'unchanged' | 'stopped' | 'failed' | 'paused', id = 'c1', origin: 'ordewell' | 'native' = 'ordewell'): Compaction => ({
  type: 'planner_compaction', compaction: { phase: 'ended', id, origin, trigger: 'auto', outcome, at: '2026-01-02T00:00:05.000Z' },
});

const heard = (message: SessionMessage): Action => ({ type: 'sessionMessage', message, sessionId: 'session-1' });
const idle = (over: Partial<TuiState> = {}): TuiState => initialState({
  sessionId: 'session-1',
  conversation: chatOf(['user', 'build me a parser'], ['planner', 'Which formats?']),
  ...over,
});
const play = (from: TuiState, ...actions: Action[]) => actions.reduce((step, action) => reduce(step.state, action), { state: from, effects: [] as ReturnType<typeof reduce>['effects'] });
const compactions = (state: TuiState) => state.conversation.blocks.filter((b) => b.type === 'compaction');
const type = (state: TuiState, text: string) => ({ ...state, editor: { ...state.editor, text, cursor: text.length } });
const press = (state: TuiState, name: string) => reduce(state, { type: 'key', key: { name } });

describe('a compaction another party runs', () => {
  it('marks the planner busy from its start and says so on the status row', () => {
    const { state } = play(idle(), heard(started()));

    expect(state.planner).toBe('compacting');
    expect(chatActivity(state)).toEqual({ label: 'Compacting…', busy: true });
    expect(compactions(state)).toEqual([expect.objectContaining({ compactionId: 'c1', status: 'running', trigger: 'auto' })]);
  });

  it('frees the planner at its end and leaves one settled block', () => {
    const { state } = play(idle(), heard(started()), heard(ended('condensed')));

    expect(state.planner).toBe('idle');
    expect(chatActivity(state)).toBeNull();
    expect(compactions(state)).toEqual([expect.objectContaining({ status: 'condensed' })]);
  });

  it('holds what the user types meanwhile, then sends it once, after the end', () => {
    const busy = play(idle(), heard(started())).state;
    const queued = press(type(busy, 'and JSON too'), 'enter');

    expect(queued.effects).toEqual([]);
    expect(queued.state.queuedPrompts).not.toBe(busy.queuedPrompts);

    const freed = reduce(queued.state, heard(ended('condensed')));
    expect(freed.effects).toEqual([{ type: 'sendMessage', sessionId: 'session-1', message: 'and JSON too' }]);
    expect(freed.state.planner).toBe('planning');
  });

  it('stops with a second Esc: the daemon is asked to cancel, and what was typed is not lost', () => {
    const busy = play(idle(), heard(started())).state;

    const armed = press(busy, 'escape');
    expect(armed.state.stopArmed).toBe(true);
    const stopped = reduce(armed.state, { type: 'key', key: { name: 'escape' } });

    expect(stopped.effects).toEqual([{ type: 'cancelPlanning', sessionId: 'session-1' }]);
  });

  it('after a stop, the daemon\'s end settles the block as stopped and the planner is free', () => {
    const busy = play(idle(), heard(started())).state;
    const cancelled = play(busy, { type: 'key', key: { name: 'escape' } }, { type: 'key', key: { name: 'escape' } }).state;

    const { state } = reduce(cancelled, heard(ended('stopped')));

    expect(state.planner).toBe('idle');
    expect(compactions(state)).toEqual([expect.objectContaining({ status: 'stopped' })]);
  });

  it('is not undone by a start heard again after its end: the planner stays free', () => {
    const { state } = play(idle(), heard(started()), heard(ended('condensed')), heard(started()));

    expect(state.planner).toBe('idle');
    expect(compactions(state)).toHaveLength(1);
  });

  it('draws one block however often a phase repeats', () => {
    const { state } = play(idle(), heard(started()), heard(started()), heard(ended('condensed')), heard(ended('condensed')));

    expect(compactions(state)).toHaveLength(1);
  });

  it('a compaction with nothing to do leaves no block and no busy planner', () => {
    const { state } = play(idle(), heard(started()), heard(ended('unchanged')));

    expect(state.planner).toBe('idle');
    expect(compactions(state)).toEqual([]);
  });

  it('inside a planner turn adds its block without changing the turn\'s status', () => {
    const { state } = play(idle({ planner: 'planning' }), heard(started('c1', 'auto')), heard(ended('pruned')));

    expect(state.planner).toBe('planning');
    expect(compactions(state)).toEqual([expect.objectContaining({ status: 'pruned' })]);
  });

  it('keeps earlier messages and the draft untouched', () => {
    const before = type(idle(), 'half a thought');
    const { state } = play(before, heard(started()), heard(ended('condensed')));

    expect(messagesOf(state)).toEqual(messagesOf(before));
    expect(state.editor.text).toBe('half a thought');
  });

  it('shows a native planner compaction from its end alone, with no busy planner', () => {
    const { state } = play(idle(), heard(ended('condensed', 'n1', 'native')));

    expect(state.planner).toBe('idle');
    expect(compactions(state)).toEqual([expect.objectContaining({ origin: 'native', status: 'condensed' })]);
  });
});

describe('/compact asked for here', () => {
  it('is refused while a compaction runs, like any planner call', () => {
    const busy = play(idle(), heard(started())).state;

    const { effects } = press(type(busy, '/compact'), 'enter');

    expect(effects).toEqual([]);
  });
});
