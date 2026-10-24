import { describe, it, expect } from 'vitest';
import { initialState, reduce, type Action } from '../reducer';
import { decodeKey } from '../keys';
import { render } from '../render';
import { stripAnsi, style } from '../ansi';
import type { TuiState } from '../state';
import { chatOf, lastMessage, messagesOf } from './chat';

/** The planner's settled reply, as the session broadcasts it. */
const reply = (content: string, sessionId?: string): Action => ({
  type: 'sessionMessage',
  message: { type: 'planner_message', content, timestamp: '2026-09-27T10:00:00.000Z' },
  ...(sessionId ? { sessionId } : {}),
});

/** The chat pane as plain text, paint stripped. */
const painted = (state: TuiState): string => render(state).map(stripAnsi).join('\n');

const typing = (text: string) => ({
  ...initialState(),
  editor: { ...initialState().editor, text, cursor: text.length },
});

describe('reduce — typing', () => {
  it('routes printable keys into the editor', () => {
    const { state } = reduce(initialState(), { type: 'key', key: { name: 'char', char: 'h' } });
    expect(state.editor.text).toBe('h');
  });

  it('emits no effects for plain typing', () => {
    const { effects } = reduce(initialState(), { type: 'key', key: { name: 'char', char: 'h' } });
    expect(effects).toEqual([]);
  });

  it('does not type a control key the decoder could not name', () => {
    // Ctrl-B has no binding and is invisible once drawn; as text it would be
    // sent with the next goal and stored in the session.
    const { state } = reduce(initialState(), { type: 'key', key: decodeKey('\x02') });
    expect(state.editor.text).toBe('');
  });

  it('a paste with newlines lands in the editor without submitting', () => {
    const { state, effects } = reduce(typing('see: '), {
      type: 'key',
      key: { name: 'paste', text: 'line1\nline2' },
    });
    expect(effects).toEqual([]);
    expect(state.editor.text).toBe('see: line1\nline2');
    expect(messagesOf(state)).toEqual([]);
  });
});

describe('reduce — submitting a goal', () => {
  it('starts a planner conversation with the typed goal', () => {
    const { effects } = reduce(typing('add a login page'), { type: 'key', key: { name: 'enter' } });
    expect(effects).toEqual([{ type: 'startConversation', goal: 'add a login page' }]);
  });

  it('echoes the goal into the transcript and clears the input', () => {
    const { state } = reduce(typing('add a login page'), { type: 'key', key: { name: 'enter' } });
    expect(state.editor.text).toBe('');
    expect(lastMessage(state)).toMatchObject({ role: 'user', text: 'add a login page' });
  });

  it('marks the session busy while the planner works', () => {
    const { state } = reduce(typing('a goal'), { type: 'key', key: { name: 'enter' } });
    expect(state.planner).toBe('planning');
  });

  it('ignores an empty submit', () => {
    const { state, effects } = reduce(initialState(), { type: 'key', key: { name: 'enter' } });
    expect(effects).toEqual([]);
    expect(messagesOf(state)).toEqual([]);
  });

  it('answers the planner instead of restarting once a conversation is open', () => {
    const open = { ...typing('use bcrypt'), sessionId: 'session-1' };
    const { effects } = reduce(open, { type: 'key', key: { name: 'enter' } });
    expect(effects).toEqual([{ type: 'sendMessage', sessionId: 'session-1', message: 'use bcrypt' }]);
  });
});

describe('reduce — multi-line input navigation', () => {
  it('up moves cursor within multi-line input instead of scrolling transcript', () => {
    const state = initialState({
      editor: {
        ...initialState().editor,
        text: 'line1\nline2\nline3',
        cursor: 12,
      },
    });
    const { state: next } = reduce(state, { type: 'key', key: { name: 'up' } });
    expect('cursor' in next).toBe(false);
    expect(next.editor.cursor).toBeLessThan(12);
    expect(next.scroll).toBe(0);
  });

  it('down moves cursor within multi-line input instead of scrolling transcript', () => {
    const state = initialState({
      editor: {
        ...initialState().editor,
        text: 'line1\nline2\nline3',
        cursor: 0,
      },
    });
    const { state: next } = reduce(state, { type: 'key', key: { name: 'down' } });
    expect(next.editor.cursor).toBeGreaterThan(0);
    expect(next.scroll).toBe(0);
  });

  it('shift-enter inserts newline in multi-line input', () => {
    const { state } = reduce(typing('hello'), { type: 'key', key: { name: 'shift-enter' } });
    expect(state.editor.text).toBe('hello\n');
    expect(state.editor.cursor).toBe(6);
  });

  it('shift-enter in the middle of text inserts newline at cursor', () => {
    const s = initialState({
      editor: {
        ...initialState().editor,
        text: 'hello',
        cursor: 2,
      },
    });
    const { state } = reduce(s, { type: 'key', key: { name: 'shift-enter' } });
    expect(state.editor.text).toBe('he\nllo');
    expect(state.editor.cursor).toBe(3);
  });

  it('alt-enter also inserts a newline instead of submitting, for terminals that cannot report shift-enter', () => {
    const { state } = reduce(typing('hello'), { type: 'key', key: { name: 'alt-enter' } });
    expect(state.editor.text).toBe('hello\n');
    expect(messagesOf(state)).toHaveLength(0);
  });
});

describe('reduce — stale session results', () => {
  it('drops a plannerMessage that arrives after /new has moved on to a fresh session', () => {
    const afterNew = { ...initialState(), sessionId: 'session-2' };
    const { state } = reduce(afterNew, reply('stray follow-up from the old session', 'session-1'));
    expect(messagesOf(state)).toHaveLength(0);
    expect(state).toBe(afterNew);
  });

  it('drops a planUpdated for a session that is no longer current', () => {
    const afterNew = { ...initialState(), sessionId: 'session-2' };
    const { state } = reduce(afterNew, {
      type: 'planUpdated',
      plan: { tasks: [{ id: 'a', title: 'stale' }] },
      sessionId: 'session-1',
    });
    expect(state.tasks).toHaveLength(0);
  });

  it('still applies a planUpdated/planner reply carrying the current session id', () => {
    const s = { ...initialState(), sessionId: 'session-2' };
    const { state } = reduce(s, reply('hi', 'session-2'));
    expect(lastMessage(state)).toMatchObject({ role: 'planner', text: 'hi' });
  });

  it('applies an untagged result (no sessionId) as before, for call sites that do not scope it', () => {
    const s = initialState();
    const { state } = reduce(s, reply('hi'));
    expect(lastMessage(state)).toMatchObject({ text: 'hi' });
  });

  // Kept as it came — the turn matches it against what was sent — and made
  // safe to paint where it is drawn.
  describe('text from outside, drawn', () => {
    const plain = (state: TuiState) => {
      style.enabled = false;
      try {
        return painted(state);
      } finally {
        style.enabled = true;
      }
    };

    it('turns a tab in a planner turn into a space, the same as a pasted one', () => {
      const { state } = reduce(initialState(), reply('columns:\tname\tage'));
      expect(plain(state)).toContain('columns: name age');
      expect(plain(state)).not.toContain('\t');
    });

    it('strips the terminal control codes a coding agent`s output carries', () => {
      const { state } = reduce(initialState(), reply('build failed\x07 \x1b[2Kretry\r ok \x1b[10Cshifted \x1b]0;title\x07 \x1b[31mred'));
      const frame = render(state).join('\n');
      expect(plain(state)).toContain('build failed retry');
      expect(plain(state)).toContain('ok shifted  red');
      for (const code of ['\x07', '\x1b[2K', '\x1b[10C', '\x1b]0']) expect(frame).not.toContain(code);
    });

    it('strips them from an error turn too — a failing runner is where they come from', () => {
      const { state } = reduce(initialState(), { type: 'failed', message: 'exit 1\x07\x1b[1;31m' });
      expect(plain(state)).toContain('✗ exit 1');
      for (const code of ['\x07', '\x1b[1;31m']) expect(render(state).join('\n')).not.toContain(code);
    });

    it('strips them from streamed reasoning', () => {
      const { state } = reduce(initialState(), {
        type: 'sessionMessage',
        message: { type: 'planner_thinking_delta', text: 'weighing\x07 options\x1b[2J' },
      });
      expect(plain(state)).toContain('weighing options');
      for (const code of ['\x07', '\x1b[2J']) expect(render(state).join('\n')).not.toContain(code);
    });
  });
});

describe('reduce — a planner reply', () => {
  const spoken = (content: string) =>
    reduce({ ...initialState(), sessionId: 's1' }, reply(content, 's1')).state;

  // The inbound adapter drops the duplicate copies of one broadcast (see
  // `inbound.ts`); the reducer shows every turn it is handed.
  it('shows a repeated turn every time it arrives', () => {
    const s = { ...initialState(), sessionId: 's1' };
    const once = reduce(s, reply('a\tb', 's1')).state;
    const { state } = reduce(once, reply('a\tb', 's1'));
    expect(messagesOf(state).filter((m) => m.role === 'planner')).toHaveLength(2);
  });

  it('settles the busy status on planUpdated, whatever the reply before it', () => {
    const busy = { ...spoken('Which database?'), planner: 'condensing' as const };
    // `planUpdated` is the settle: the reply's text (this action) is dispatched
    // first, then the settle follows and ends the turn.
    const replied = reduce(busy, reply('Which database?', 's1')).state;
    const { state } = reduce(replied, { type: 'planUpdated', plan: { tasks: [] }, sessionId: 's1' });
    expect(state.planner).toBe('idle');
    expect(state.planner).toBe('idle');
  });
});

describe('reduce — scrolling the transcript', () => {
  /** A transcript several screens deep, so there is room to page through. */
  const longTranscript = (): TuiState => initialState({
    conversation: chatOf(...Array.from({ length: 40 }, (_, i): ['user', string] => ['user', `m${i}`])),
  });

  it('pageup scrolls back through the transcript', () => {
    const { state } = reduce(longTranscript(), { type: 'key', key: { name: 'pageup' } });
    expect(state.scroll).toBeGreaterThan(0);
  });

  it('a transcript shorter than the pane has nothing to scroll, so pageup is a no-op', () => {
    const { state } = reduce(initialState(), { type: 'key', key: { name: 'pageup' } });
    expect(state.scroll).toBe(0);
  });

  it('pagedown scrolls forward and stops at the live tail', () => {
    const back = reduce(longTranscript(), { type: 'key', key: { name: 'pageup' } }).state;
    const forward = reduce(back, { type: 'key', key: { name: 'pagedown' } }).state;
    expect(forward.scroll).toBe(0);
    expect(reduce(forward, { type: 'key', key: { name: 'pagedown' } }).state.scroll).toBe(0);
  });

  it('a new message snaps the view back to the tail', () => {
    const scrolled = { ...initialState(), scroll: 12 };
    const { state } = reduce(scrolled, { type: 'notice', message: 'done' });
    expect(state.scroll).toBe(0);
  });

  it('leaves the plan pane selection alone', () => {
    const s = { ...initialState(), focus: 'plan' as const };
    const { state } = reduce(s, { type: 'key', key: { name: 'pageup' } });
    expect(state.scroll).toBe(0);
  });

  it('the mouse wheel scrolls back and forward by a small notch', () => {
    const long = initialState({
      conversation: chatOf(...Array.from({ length: 40 }, (_, i): ['user', string] => ['user', `m${i}`])),
    });
    const back = reduce(long, { type: 'key', key: { name: 'scrollup' } }).state;
    expect(back.scroll).toBe(3);
    const forward = reduce(back, { type: 'key', key: { name: 'scrolldown' } }).state;
    expect(forward.scroll).toBe(0);
  });

  /**
   * The transcript is taller than the pane by a couple of lines, so there is
   * something to scroll — but far less than twenty notches' worth.
   */
  const shortTranscript = (): TuiState => {
    return initialState({ rows: 10, cols: 40, conversation: chatOf(['user', 'one'], ['user', 'two'], ['user', 'three']) });
  };

  const frame = (state: TuiState): string => render(state).join('\n');

  it('a wheel-down after twenty wheel-ups moves the view on the very first notch', () => {
    let state = shortTranscript();
    for (let i = 0; i < 20; i++) state = reduce(state, { type: 'key', key: { name: 'scrollup' } }).state;

    const back = frame(state);
    const forward = reduce(state, { type: 'key', key: { name: 'scrolldown' } }).state;

    expect(frame(forward)).not.toBe(back);
  });

  it('up/down recall chat history instead of scrolling the transcript when the draft is single-line', () => {
    const state = initialState({
      editor: {
        ...initialState().editor,
        history: ['previous message'],
        historyIndex: 1,
      },
    });

    const back = reduce(state, { type: 'key', key: { name: 'up' } }).state;
    expect(back.scroll).toBe(0);
    expect(back.editor.text).toBe('previous message');

    const forward = reduce(back, { type: 'key', key: { name: 'down' } }).state;
    expect(forward.scroll).toBe(0);
    expect(forward.editor.text).toBe('');
  });

});

describe('reduce — the wheel scrolls the pane under the pointer', () => {
  // 80 columns puts the plan pane at 36 wide, so the chat holds columns 1–43,
  // the divider sits at 44, and the plan runs 45–80.
  const CHAT_COLUMN = 10;
  const PLAN_COLUMN = 60;

  const bothPanes = (over: Partial<TuiState> = {}): TuiState => initialState({
    rows: 24,
    cols: 80,
    conversation: chatOf(...Array.from({ length: 40 }, (_, i): ['user', string] => ['user', `m${i}`])),
    tasks: Array.from({ length: 30 }, (_, i) => ({
      id: `t${i}`, order: i + 1, title: `Task ${i}`, type: 'ai' as const,
      status: 'pending', dependencies: [], assignedRunner: 'claude-code',
    })),
    ...over,
  });

  const wheel = (state: TuiState, name: string, col: number) =>
    reduce(state, { type: 'key', key: { name, col, row: 5 } }).state;

  it('scrolls the plan when the pointer is over it, even though the chat has focus', () => {
    const before = bothPanes({ focus: 'chat' });
    const after = wheel(before, 'scrollup', PLAN_COLUMN);

    expect(after.planScroll).not.toBe(before.planScroll);
    expect(after.scroll).toBe(0);
  });

  it('scrolls the chat when the pointer is over it, even though the plan has focus', () => {
    const after = wheel(bothPanes({ focus: 'plan' }), 'scrollup', CHAT_COLUMN);

    expect(after.scroll).toBe(3);
    expect(after.planScroll).toBeNull();
  });

  it('treats the divider column as the plan pane, so its edge is not a dead strip', () => {
    const after = wheel(bothPanes({ focus: 'chat' }), 'scrollup', 44);

    expect(after.planScroll).not.toBeNull();
    expect(after.scroll).toBe(0);
  });

  it('falls back to the focused pane for a report carrying no coordinates', () => {
    const after = reduce(bothPanes({ focus: 'plan' }), { type: 'key', key: { name: 'scrollup' } }).state;

    expect(after.planScroll).not.toBeNull();
    expect(after.scroll).toBe(0);
  });

  it('keeps pageup on the focused pane, wherever the pointer happens to rest', () => {
    const after = reduce(bothPanes({ focus: 'plan' }), { type: 'key', key: { name: 'pageup' } }).state;

    expect(after.planScroll).not.toBeNull();
    expect(after.scroll).toBe(0);
  });

  it('routes by focus when there is no plan pane to point at', () => {
    const noPlan = initialState({
      rows: 24,
      cols: 80,
      conversation: chatOf(...Array.from({ length: 40 }, (_, i): ['user', string] => ['user', `m${i}`])),
    });

    expect(wheel(noPlan, 'scrollup', PLAN_COLUMN).scroll).toBe(3);
  });

  it('ignores a sideways wheel notch instead of letting it reach the editor', () => {
    const before = bothPanes({ focus: 'chat' });
    const after = reduce(before, { type: 'key', key: { name: 'wheelignored', col: 10, row: 5 } }).state;

    expect(after).toEqual(before);
  });
});
