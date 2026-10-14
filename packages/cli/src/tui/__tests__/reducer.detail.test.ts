import { describe, it, expect } from 'vitest';
import { initialState, reduce } from '../reducer';
import type { Key } from '../keys';
import type { TaskView, TuiState } from '../state';
import { chatScrollMax, footerHints } from '../layout';
import type { SessionMessage } from '@ordewell/core';

/**
 * ctrl+o is one switch for the whole conversation: every thinking, command and
 * subagent block draws expanded, and pressing it again draws everything
 * collapsed. These tests hold the toggle itself — its key, its flag, the
 * footer's hint, and the scroll position surviving the height change.
 */

const task = (over: Partial<TaskView> = {}): TaskView => ({
  id: 'task-1', order: 1, title: 'Do the thing', type: 'ai', status: 'pending', dependencies: [], ...over,
});

const LINES = Array.from({ length: 10 }, (_, i) => `entry ${i + 1}`).join('\n');

// Five commands, each printing ten lines. Collapsed each block paints a
// header, a three-line preview, a count line and the blank row — 6 lines.
// Expanded it is the header, its argument, all ten lines, the collapse note
// and the blank row — 14. So one toggle moves the transcript by 8 lines per
// block, 40 across the five.
const commands: SessionMessage[] = [0, 1, 2, 3, 4].flatMap((i) => [
  { type: 'research_step', tool: 'bash', args: '{"command":"ls"}', toolCallId: `c${i}` },
  {
    type: 'research_step_done',
    step: { id: `r${i}`, tool: 'bash', args: '{"command":"ls"}', result: LINES, success: true, outcome: 'success', toolCallId: `c${i}`, timestamp: '' },
  },
]) as SessionMessage[];

function chatty(overrides: Partial<TuiState> = {}): TuiState {
  let state = initialState({ rows: 20, cols: 80, tasks: [task()], ...overrides });
  for (const message of commands) state = reduce(state, { type: 'sessionMessage', message }).state;
  return state;
}

const press = (state: TuiState, key: Key): TuiState => reduce(state, { type: 'key', key }).state;

describe('ctrl-o toggles full detail', () => {
  it('turns every block’s detail on, then off again', () => {
    const state = chatty();

    const on = press(state, { name: 'ctrl-o' });
    expect(on.detailAll).toBe(true);

    const off = press(on, { name: 'ctrl-o' });
    expect(off.detailAll).toBe(false);
  });

  it('works while a planner turn is running', () => {
    const state = chatty({ planner: 'planning', sessionId: 'session-1', goal: 'g' });

    expect(press(state, { name: 'ctrl-o' }).detailAll).toBe(true);
  });

  it('does nothing on the plan pane, which has no detail to toggle', () => {
    const state = press(chatty({ focus: 'plan' }), { name: 'ctrl-o' });

    expect(state.detailAll).toBe(false);
  });

  it('flips the footer hint between the direction it will go', () => {
    const off = chatty();
    expect(footerHints(off)).toContain('ctrl-o expand all');

    const on = press(off, { name: 'ctrl-o' });
    expect(footerHints(on)).toContain('ctrl-o collapse all');
    expect(footerHints(on)).not.toContain('ctrl-o expand all');
  });

  it('stays pinned to the tail when the view was following live output', () => {
    const pinned = chatty();
    expect(pinned.scroll).toBe(0);

    expect(press(pinned, { name: 'ctrl-o' }).scroll).toBe(0);
    expect(press(press(pinned, { name: 'ctrl-o' }), { name: 'ctrl-o' }).scroll).toBe(0);
  });

  it('keeps the top visible line anchored when scrolled back', () => {
    const scrolled = { ...chatty(), scroll: 3 };

    const expanded = press(scrolled, { name: 'ctrl-o' });

    // 8 extra lines per block, five blocks: the transcript grew by 40 lines
    // above the viewport, and the offset takes those on to hold the same line
    // at the top.
    expect(expanded.scroll).toBe(43);
    expect(expanded.scroll).toBeLessThanOrEqual(chatScrollMax(expanded));

    expect(press(expanded, { name: 'ctrl-o' }).scroll).toBe(3);
  });
});

describe('ctrl-o leaves the queued-prompt machinery alone', () => {
  it('keeps the editor draft and the queued bubbles', () => {
    const state = { ...chatty(), queuedPrompts: ['follow-up'] };
    const drafted = { ...state, editor: { ...state.editor, text: 'a draft', cursor: 7 } };

    const after = press(drafted, { name: 'ctrl-o' });

    expect(after.detailAll).toBe(true);
    expect(after.editor.text).toBe('a draft');
    expect(after.queuedPrompts).toEqual(['follow-up']);
  });

  it('never arms the stop itself, and esc still arms after it', () => {
    const state = chatty({ planner: 'planning', sessionId: 'session-1' });

    const after = press(state, { name: 'ctrl-o' });
    expect(after.stopArmed).toBe(false);

    expect(press(after, { name: 'escape' }).stopArmed).toBe(true);
  });

  it('does not disturb editor history recall on the arrow keys', () => {
    const state = chatty({
      editor: { text: 'current', cursor: 7, history: ['an older line'], historyIndex: 1, draft: '' },
    });

    const after = press(state, { name: 'ctrl-o' });
    expect(after.editor.text).toBe('current');

    expect(press(after, { name: 'up' }).editor.text).toBe('an older line');
  });
});
