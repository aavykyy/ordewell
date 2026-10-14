import { describe, it, expect } from 'vitest';
import { initialState, reduce } from '../reducer';
import type { SessionMessage } from '@ordewell/core';
import type { TuiState } from '../state';
import { lastMessage, messagesOf } from './chat';

/**
 * ESC during an in-flight planner turn: the first press arms a stop (or takes
 * back the newest queued prompt), the second press commits the stop. Esc when
 * idle does what it always did. See the precedence note on `handleKey`.
 */

function press(overrides: Partial<TuiState> = {}, editorText = '') {
  const base = initialState(overrides);
  const state = { ...base, editor: { ...base.editor, text: editorText, cursor: editorText.length } };
  return reduce(state, { type: 'key', key: { name: 'escape' } });
}

describe('ESC while planning', () => {
  it('arms on the first press and emits cancelPlanning on the second, keeping the draft throughout', () => {
    const base = initialState({ status: 'planning', sessionId: 'session-1' });
    const state = { ...base, editor: { ...base.editor, text: 'unsent draft', cursor: 12 } };
    const armed = reduce(state, { type: 'key', key: { name: 'escape' } });

    expect(armed.effects).toEqual([{ type: 'disarmStop', afterMs: 2000, arm: 1 }]);
    expect(armed.state.stopArmed).toBe(true);
    expect(armed.state.editor.text).toBe('unsent draft');

    const { state: stopped, effects } = reduce(armed.state, { type: 'key', key: { name: 'escape' } });
    expect(effects).toEqual([{ type: 'cancelPlanning', sessionId: 'session-1' }]);
    expect(stopped.editor.text).toBe('unsent draft');
  });

  it('also arms for a research turn (the other in-flight planner status)', () => {
    const { state, effects } = press({ status: 'planning', sessionId: 'session-1' }, 'while it looks things up');
    expect(effects).toEqual([{ type: 'disarmStop', afterMs: 2000, arm: 1 }]);
    expect(state.stopArmed).toBe(true);
  });

  it('does nothing special without a session, even mid-status', () => {
    // Can't happen in practice (no session, no turn), but the guard is what
    // makes that true rather than an accident.
    const { effects } = press({ status: 'planning', sessionId: null }, 'x');
    expect(effects).toEqual([]);
  });

  it('an open overlay still owns ESC — planning does not preempt it', () => {
    const { state, effects } = press({
      status: 'planning',
      sessionId: 'session-1',
      overlay: { kind: 'confirm', title: 'New session?', message: 'Discard the current plan?', action: { kind: 'new-session' } },
    }, undefined);

    expect(effects).toEqual([]);
    expect(state.overlay).toBeNull(); // confirm's own escape handling: cancels
  });

  it('esc from an open approval prompt arms instead of denying one call, and the second esc stops the whole turn', () => {
    const request = { id: 'ap-1', kind: 'shell_command' as const, subject: 'npm test', scope: 'npm test' };
    const base = initialState({
      status: 'planning',
      sessionId: 'session-1',
      overlay: { kind: 'approval', request },
      pendingApprovals: [{ id: 'ap-2', kind: 'shell_command' as const, subject: 'npm run build', scope: 'npm run build' }],
    });
    const armed = reduce(base, { type: 'key', key: { name: 'escape' } });
    expect(armed.state.overlay).toMatchObject({ kind: 'approval' });

    const { state, effects } = reduce(armed.state, { type: 'key', key: { name: 'escape' } });
    // One denial would just hand the planner its next tool call — a second ESC
    // wants the turn dead, so the whole queue goes with it.
    expect(effects).toEqual([{ type: 'cancelPlanning', sessionId: 'session-1' }]);
    expect(state.overlay).toBeNull();
    expect(state.pendingApprovals).toEqual([]);
  });

  it('a second ESC after planning has settled clears the chat draft as before', () => {
    const { state, effects } = press({ status: 'idle', sessionId: 'session-1' }, 'left in the box');

    expect(effects).toEqual([]);
    expect(state.editor.text).toBe('');
  });

  it('returns plan-pane focus to chat when idle, as before', () => {
    const { state, effects } = press({ status: 'idle', sessionId: 'session-1', focus: 'plan' });
    expect(effects).toEqual([]);
    expect(state.focus).toBe('chat');
  });

  it('ctrl-c keeps quitting/backing-out meaning during an in-flight turn — it is not cancelPlanning', () => {
    const base = initialState({ status: 'planning', sessionId: 'session-1' });
    const state = { ...base, editor: { ...base.editor, text: 'unsent draft', cursor: 12 } };
    const { state: next, effects } = reduce(state, { type: 'key', key: { name: 'ctrl-c' } });

    expect(effects).toEqual([]);
    expect(next.editor.text).toBe('');
  });
});

describe('a stopped turn on screen', () => {
  const turn = 't-1';
  const hear = (state: TuiState, message: SessionMessage) => reduce(state, { type: 'sessionMessage', message, sessionId: 'session-1' }).state;
  const escape = (state: TuiState) => reduce(state, { type: 'key', key: { name: 'escape' } }).state;

  function stoppedMidReply(): TuiState {
    let state = initialState({ status: 'planning', sessionId: 'session-1' });
    state = hear(state, { type: 'planner_turn_started', turnId: turn, prompt: 'add a parser' });
    state = hear(state, { type: 'planner_text_delta', turnId: turn, segmentId: 's1', text: 'Half a thou' });
    return escape(escape(state));
  }

  it('ends at the stop, the way VS Code ends it, rather than when the daemon answers', () => {
    expect(lastMessage(stoppedMidReply())).toMatchObject({ text: 'Half a thou', streaming: false });
  });

  it('drops what the stopped turn still streams while the daemon notices the abort', () => {
    let state = stoppedMidReply();
    state = hear(state, { type: 'planner_text_delta', turnId: turn, segmentId: 's1', text: 'ght, arriving late' });
    state = hear(state, { type: 'planner_message', content: 'Half a thought, arriving late', timestamp: '', turnId: turn });

    expect(messagesOf(state).map((m) => m.text)).toEqual(['add a parser', 'Half a thou']);
  });
});

describe('the stopped turn\'s own failure', () => {
  const escape = (state: TuiState) => reduce(state, { type: 'key', key: { name: 'escape' } }).state;
  const fail = (state: TuiState, message: string) => reduce(state, { type: 'failed', message }).state;

  it('is not reported as an error: the user asked for it, and the stop says so itself', () => {
    const stopped = escape(escape(initialState({ status: 'planning', sessionId: 'session-1' })));

    const after = fail(stopped, 'Request was aborted.');

    expect(after.status).toBe('idle');
    expect(messagesOf(after).filter((m) => m.role === 'error')).toEqual([]);
  });

  it('is only the stopped turn\'s: a later turn failing is still an error', () => {
    const stopped = escape(escape(initialState({ status: 'planning', sessionId: 'session-1' })));
    const settled = fail(stopped, 'Request was aborted.');

    const next = fail({ ...settled, status: 'planning' }, 'rate limited');

    expect(lastMessage(next)).toMatchObject({ role: 'error', text: 'rate limited' });
  });
  it('does not outlive its turn when nothing ended it on screen, such as a new session', () => {
    const base = initialState({ status: 'idle', sessionId: 'session-1', stopRequested: true });
    const typed = { ...base, editor: { ...base.editor, text: 'try again', cursor: 9 } };
    const sent = reduce(typed, { type: 'key', key: { name: 'enter' } }).state;

    expect(lastMessage(fail(sent, 'rate limited'))).toMatchObject({ role: 'error', text: 'rate limited' });
  });
});
