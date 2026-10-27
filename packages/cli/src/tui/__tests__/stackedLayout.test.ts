import { describe, it, expect, beforeAll } from 'vitest';
import { initialState, reduce, type Effect, type Step } from '../reducer';
import { render } from '../render';
import { style, stripAnsi, width } from '../ansi';
import { stackRows, taskEditorRoom } from '../geometry';
import { bodyPanes, bodyRows, chatScrollMax } from '../layout';
import { cursorPosition } from '../editor';
import type { TaskView, TuiState } from '../state';
import { EMPTY_TASK_LOG } from '@ordewell/core';
import { chatOf } from './chat';

beforeAll(() => {
  style.enabled = false;
});

/**
 * Below 70 columns the plan moves under the chat instead of disappearing. These
 * tests drive it through `reduce` and `render` together, the way the terminal
 * does: a frame that looks right but whose reducers measure another height would
 * pass a render test and still lose the selection off the pane.
 */

const task = (i: number, title = `Task number ${i + 1}`): TaskView => ({
  id: `t${i}`, order: i + 1, title, type: 'ai', status: 'pending', dependencies: [], attempted: true,
});
const tasksOf = (n: number): TaskView[] => Array.from({ length: n }, (_, i) => task(i));

const talk = (lines: number): TuiState['conversation'] =>
  chatOf(...Array.from({ length: lines }, (_, i): ['user' | 'planner', string] => [i % 2 ? 'planner' : 'user', `CHATLINE ${i} of the planner conversation`]));

const screen = (cols: number, rows: number, over: Partial<TuiState> = {}): TuiState =>
  initialState({ sessionId: 's1', rows, cols, tasks: tasksOf(3), conversation: talk(12), focus: 'chat', ...over });

const press = (state: TuiState, name: string, extra: { char?: string; col?: number; row?: number } = {}): Step =>
  reduce(state, { type: 'key', key: { name, ...extra } });
const typed = (state: TuiState, char: string): TuiState => press(state, 'char', { char }).state;
const resize = (state: TuiState, cols: number, rows: number): TuiState => reduce(state, { type: 'resize', rows, cols }).state;

/** Press, drag and release across the given [col, row] cells. */
function drag(state: TuiState, from: [number, number], to: [number, number]): Step {
  const down = press(state, 'mousedown', { col: from[0], row: from[1] }).state;
  const moved = press(down, 'mousedrag', { col: to[0], row: to[1] }).state;
  return press(moved, 'mouseup', { col: to[0], row: to[1] });
}
const copied = (effects: Effect[]): string => {
  const effect = effects.find((e): e is Extract<Effect, { type: 'copyText' }> => e.type === 'copyText');
  if (!effect) throw new Error('the release emitted no copyText effect');
  return effect.text;
};

/** A screen whose body is exactly `body` rows tall: the terminal height that gives it, found rather than hand-counted. */
function withBody(body: number, cols: number, over: Partial<TuiState> = {}): TuiState {
  for (let rows = 5; rows < 60; rows++) {
    const state = screen(cols, rows, over);
    if (bodyRows(state) === body) return state;
  }
  throw new Error(`no height gives a body of ${body} rows`);
}

/** The frame row (1-based) whose text satisfies `match`, or -1. */
const rowOf = (frame: string[], match: string): number => frame.findIndex((line) => line.includes(match)) + 1;

describe('stackRows', () => {
  const needs = (chat: number, plan: number) => ({ chat, chatMin: 3, plan, planMin: 3 });

  it('gives each pane what its content needs while both fit, the spare going to the chat', () => {
    expect(stackRows(20, needs(5, 8), 'chat')).toEqual({ chat: 12, plan: 8 });
  });

  it('splits evenly under contention, the chat taking the odd row', () => {
    expect(stackRows(19, needs(40, 40), 'chat')).toEqual({ chat: 10, plan: 9 });
    expect(stackRows(18, needs(40, 40), 'plan')).toEqual({ chat: 9, plan: 9 });
  });

  it('hands a short plan\'s unused half to the chat, and a short chat\'s to the plan', () => {
    expect(stackRows(20, needs(40, 6), 'chat')).toEqual({ chat: 14, plan: 6 });
    expect(stackRows(20, needs(4, 40), 'chat')).toEqual({ chat: 4, plan: 16 });
  });

  it('never takes either pane below its minimum while the body can hold both', () => {
    expect(stackRows(6, needs(40, 40), 'chat')).toEqual({ chat: 3, plan: 3 });
    expect(stackRows(8, needs(40, 3), 'chat')).toEqual({ chat: 5, plan: 3 });
    expect(stackRows(8, needs(3, 40), 'chat')).toEqual({ chat: 3, plan: 5 });
  });

  it('lets the focused pane keep the body when it cannot hold both minimums, the other left one row at most', () => {
    expect(stackRows(5, needs(40, 40), 'chat')).toEqual({ chat: 4, plan: 1 });
    expect(stackRows(5, needs(40, 40), 'plan')).toEqual({ chat: 1, plan: 4 });
    expect(stackRows(4, needs(40, 40), 'chat')).toEqual({ chat: 3, plan: 1 });
    expect(stackRows(2, needs(40, 40), 'plan')).toEqual({ chat: 1, plan: 1 });
    expect(stackRows(1, needs(40, 40), 'plan')).toEqual({ chat: 0, plan: 1 });
    expect(stackRows(1, needs(40, 40), 'chat')).toEqual({ chat: 1, plan: 0 });
    expect(stackRows(0, needs(40, 40), 'chat')).toEqual({ chat: 0, plan: 0 });
  });
});

describe('the frame, side by side and stacked', () => {
  it('keeps the plan beside the chat at 70 columns', () => {
    const frame = render(screen(70, 28));

    expect(frame.some((line) => line.includes('│'))).toBe(true);
    expect(frame.find((line) => line.includes('Plan 0/3'))!.indexOf('Plan')).toBeGreaterThan(30);
  });

  it('puts the plan under the transcript and above the composer at 69 columns', () => {
    const state = screen(69, 28);
    const frame = render(state);
    const header = rowOf(frame, 'Plan 0/3');
    const composer = frame.findIndex((line, i) => i > header && line.startsWith('❯')) + 1;

    expect(frame.some((line) => line.includes('│'))).toBe(false);
    expect(header).toBeGreaterThan(rowOf(frame, 'CHATLINE 11'));
    expect(composer).toBeGreaterThan(rowOf(frame, 'Task number 3'));
    expect(header).toBe(bodyPanes(state).plan!.row);
  });

  it.each([69, 60, 40, 20])('fits the frame exactly at %i columns, header and tasks visible', (cols) => {
    const state = screen(cols, 30);
    const frame = render(state);

    expect(frame).toHaveLength(30);
    expect(Math.max(...frame.map(width))).toBeLessThanOrEqual(cols);
    expect(rowOf(frame, 'Plan 0/3')).toBeGreaterThan(0);
    // a title wraps at 20 columns, so look for its first word
    expect(rowOf(frame, 'Task')).toBeGreaterThan(rowOf(frame, 'Plan 0/3'));
    const { chat, plan } = bodyPanes(state);
    expect(chat.rows + plan!.rows).toBe(bodyRows(state));
  });

  it('stays chat-only at any width while there is no plan', () => {
    for (const cols of [20, 40, 60, 69]) {
      const frame = render(screen(cols, 24, { tasks: [] }));
      expect(rowOf(frame, 'Plan 0')).toBe(0);
    }
  });

  it('gives a short plan only its own height and the rest to the transcript', () => {
    const { chat, plan } = bodyPanes(screen(60, 40, { tasks: tasksOf(1), conversation: talk(60) }));

    // header, usage line, then one task of two lines
    expect(plan!.rows).toBe(4);
    expect(chat.rows).toBe(bodyRows(screen(60, 40)) - 4);
  });

  it('gives a long plan about half the body, the transcript keeping the other half', () => {
    const state = screen(60, 40, { tasks: tasksOf(40), conversation: talk(60) });
    const { chat, plan } = bodyPanes(state);

    expect(Math.abs(chat.rows - plan!.rows)).toBeLessThanOrEqual(1);
    expect(chat.rows).toBeGreaterThanOrEqual(plan!.rows);
  });

  it('keeps the wide and emoji titles inside the width', () => {
    const state = screen(40, 30, {
      tasks: [task(0, '👨‍👩‍👧 家族の計画を立てて実行する長いタイトルです'), task(1, 'Ünïcödé — wide 🚀 rocket launch title that wraps')],
    });
    const frame = render(state);

    expect(Math.max(...frame.map(width))).toBeLessThanOrEqual(40);
    expect(frame).toHaveLength(30);
    expect(rowOf(frame, 'rocket')).toBeGreaterThan(rowOf(frame, 'Plan 0/2'));
  });

  it('moves the run hint to the status row only when the body has no room for the plan header', () => {
    const waiting: TaskView[] = [{ ...task(0), status: 'awaiting_user' }];
    const hint = '1 task waits for you';
    const count = (state: TuiState): number => render(state).filter((line) => line.includes(hint)).length;

    const roomy = withBody(6, 40, { tasks: waiting });
    const cramped = withBody(1, 40, { tasks: waiting });
    expect(bodyPanes(roomy).plan!.rows).toBeGreaterThan(0);
    expect(rowOf(render(roomy), `Plan 0/1 · ${hint}`)).toBe(bodyPanes(roomy).plan!.row);
    expect(count(roomy)).toBe(1);

    expect(bodyPanes(cramped).plan!.rows).toBe(0);
    expect(count(cramped)).toBe(1);
    expect(rowOf(render(cramped), 'Plan 0/1')).toBe(0);
  });
});

describe('degrading in a short terminal', () => {
  it('keeps the composer on the last rows and the plan header visible for every height that has room', () => {
    for (let rows = 12; rows <= 30; rows++) {
      const state = screen(50, rows, { focus: 'plan' });
      const frame = render(state);
      expect(frame, `rows=${rows}`).toHaveLength(rows);
      expect(rowOf(frame, 'Plan 0/3'), `rows=${rows}`).toBeGreaterThan(0);
      expect(frame.map((line) => line.startsWith('❯')).lastIndexOf(true), `rows=${rows}`).toBeGreaterThan(rowOf(frame, 'Plan 0/3') - 1);
    }
  });

  it('shows the focused pane when the body is too short for both', () => {
    const chatFocused = withBody(4, 50, { focus: 'chat' });
    // the plan's footer hints wrap differently, so its own 4-row body is found separately
    const planFocused = withBody(4, 50, { focus: 'plan' });

    expect(bodyPanes(chatFocused).chat.rows).toBe(3);
    expect(bodyPanes(chatFocused).plan!.rows).toBe(1);
    // the plan is still announced by its header, so it never just vanishes
    expect(rowOf(render(chatFocused), 'Plan 0/3')).toBe(bodyPanes(chatFocused).plan!.row);
    expect(bodyPanes(planFocused).plan!.rows).toBe(3);
    expect(bodyPanes(planFocused).chat.rows).toBe(1);
  });
});

describe('moving through a plan that needs scrolling', () => {
  const long = (over: Partial<TuiState> = {}): TuiState => screen(50, 24, { tasks: tasksOf(30), focus: 'plan', ...over });
  const selectedVisible = (state: TuiState): boolean => {
    const frame = render(state);
    const { plan } = bodyPanes(state);
    return frame.slice(plan!.row - 1, plan!.row - 1 + plan!.rows).some((line) => line.includes(`❯ ·`) && line.includes(`Task number ${state.selectedTask + 1}`));
  };

  it('keeps the selected task on screen walking down and back up', () => {
    let state = long();
    for (let i = 0; i < 29; i++) {
      state = press(state, 'down').state;
      expect(selectedVisible(state), `down to ${state.selectedTask}`).toBe(true);
    }
    for (let i = 0; i < 29; i++) {
      state = press(state, 'up').state;
      expect(selectedVisible(state), `up to ${state.selectedTask}`).toBe(true);
    }
    expect(state.selectedTask).toBe(0);
  });

  it('pages by the stacked pane\'s own height, with a line of overlap', () => {
    const state = long();
    const { plan } = bodyPanes(state);
    const paged = press(state, 'pagedown').state;

    expect(paged.planScroll).toBe(plan!.rows - 1);
    expect(selectedVisible(paged)).toBe(true);
  });

  it('bounds the plan scroll at its real extent, with no dead notches', () => {
    let state = long();
    for (let i = 0; i < 80; i++) state = press(state, 'pagedown').state;
    const atEnd = state.planScroll!;
    const back = press(state, 'pageup').state;

    expect(back.planScroll).toBeLessThan(atEnd);
    expect(selectedVisible(state)).toBe(true);
  });

  it('aims the wheel by the row the pointer is over', () => {
    const state = long({ focus: 'chat', conversation: talk(60) });
    const { chat, plan } = bodyPanes(state);

    const overChat = press(state, 'scrollup', { col: 10, row: chat.row + 1 }).state;
    expect(overChat.scroll).toBe(3);
    expect(overChat.planScroll).toBe(state.planScroll);

    const overPlan = press(state, 'scrolldown', { col: 10, row: plan!.row + 2 }).state;
    expect(overPlan.planScroll).not.toBeNull();
    expect(overPlan.scroll).toBe(0);

    // the same column in the chrome under the body follows focus
    const overComposer = press(state, 'scrollup', { col: 10, row: state.rows - 3 }).state;
    expect(overComposer.scroll).toBe(3);
  });

  it('scrolls the chat by its own stacked height', () => {
    let state = long({ focus: 'chat', conversation: talk(60) });
    const { chat } = bodyPanes(state);
    state = press(state, 'pageup').state;

    expect(state.scroll).toBe(chat.rows - 1);
  });
});

describe('selecting in a stacked body', () => {
  const stacked = (): TuiState => screen(50, 30, {
    conversation: chatOf(...Array.from({ length: 40 }, (_, i): ['user', string] => ['user', `PANECHAT row ${i}`])),
    tasks: Array.from({ length: 20 }, (_, i) => task(i, `PANEPLAN task ${i}`)),
  });

  it('copies transcript rows only when a chat drag runs on down into the plan', () => {
    const state = stacked();
    const { chat, plan } = bodyPanes(state);
    const result = drag(state, [1, chat.row + 1], [50, plan!.row + 4]);
    const text = copied(result.effects);

    expect(text).toContain('PANECHAT');
    expect(text).not.toContain('PANEPLAN');
    expect(text).not.toContain('Plan ');
    expect(text.split('\n')).toHaveLength(chat.rows - 1);
  });

  it('copies tasks only when a plan drag runs up into the transcript', () => {
    const state = stacked();
    const { chat, plan } = bodyPanes(state);
    const text = copied(drag(state, [3, plan!.row + 5], [1, chat.row]).effects);

    expect(text).toContain('PANEPLAN');
    expect(text).not.toContain('PANECHAT');
    expect(text.split('\n')[0]).toContain('Plan');
  });

  it('pins the head to the pane\'s rows as well as its columns', () => {
    const state = stacked();
    const { chat, plan } = bodyPanes(state);
    const down = press(state, 'mousedown', { col: 5, row: chat.row + 2 }).state;
    const dragged = press(down, 'mousedrag', { col: 99, row: state.rows }).state;

    expect(dragged.selection).toEqual({
      anchor: { col: 5, row: chat.row + 2 },
      head: { col: 50, row: chat.rows },
      pane: 'chat',
    });
    const up = press(press(state, 'mousedown', { col: 5, row: plan!.row + 1 }).state, 'mousedrag', { col: 1, row: 1 }).state;
    expect(up.selection).toMatchObject({ head: { col: 1, row: plan!.row }, pane: 'plan' });
  });

  it('paints the highlight on the selected pane\'s rows alone', () => {
    style.enabled = true;
    try {
      const state = stacked();
      const { chat, plan } = bodyPanes(state);
      const down = press(state, 'mousedown', { col: 1, row: chat.row }).state;
      const dragged = press(down, 'mousedrag', { col: 40, row: plan!.row + 3 }).state;
      const frame = render(dragged);

      for (let row = 1; row <= chat.rows; row++) expect(frame[row - 1], `row ${row}`).toContain('\x1b[7m');
      for (let row = plan!.row; row < plan!.row + plan!.rows; row++) expect(frame[row - 1], `row ${row}`).not.toContain('\x1b[7m');
    } finally {
      style.enabled = false;
    }
  });

  it('selects the whole composer line from a drag that stays on it', () => {
    const state = screen(50, 30, { editor: { ...initialState().editor, text: 'STACKED DRAFT', cursor: 0 } });
    const frame = render(state);
    const row = frame.findIndex((line) => stripAnsi(line).includes('STACKED DRAFT')) + 1;

    const text = copied(drag(state, [1, row], [state.cols, row]).effects);

    expect(text).toBe(stripAnsi(frame[row - 1]).trimEnd());
  });

  it('copies wide and emoji titles by cluster', () => {
    const state = screen(50, 30, { tasks: [task(0, '🚀 launch 日本語 title')] });
    const frame = render(state);
    const row = rowOf(frame, 'launch');
    const text = copied(drag(state, [1, row], [50, row]).effects);

    expect(text).toContain('🚀 launch 日本語 title');
  });

  it('drops the selection on resize, then selects fresh in the new layout', () => {
    const state = stacked();
    const { chat } = bodyPanes(state);
    const mid = press(press(state, 'mousedown', { col: 5, row: chat.row }).state, 'mousedrag', { col: 20, row: 3 }).state;
    expect(mid.selection).not.toBeNull();

    const wide = resize(mid, 100, 30);
    expect(wide.selection).toBeNull();
    expect(bodyPanes(wide).mode).toBe('side');
    const text = copied(drag(wide, [1, 2], [bodyPanes(wide).chat.cols, 4]).effects);
    expect(text).toContain('PANECHAT');
    expect(text).not.toContain('PANEPLAN');
  });
});

describe('focus and the keyboard', () => {
  it('tabs between the panes without disturbing the stacked layout while both have room', () => {
    const state = screen(50, 30);
    const tabbed = press(state, 'tab').state;

    expect(tabbed.focus).toBe('plan');
    expect(bodyPanes(tabbed).mode).toBe('stacked');
    expect(bodyPanes(tabbed).plan!.rows).toBeGreaterThanOrEqual(3);
    expect(bodyPanes(tabbed).chat.rows).toBeGreaterThanOrEqual(3);
    expect(press(tabbed, 'tab').state.focus).toBe('chat');
  });

  it('brings the plan into view when tab focuses it in a body too short to show it', () => {
    const hidden = withBody(4, 50, { tasks: tasksOf(8) });
    expect(bodyPanes(hidden).plan!.rows).toBe(1);

    const tabbed = press(hidden, 'tab').state;
    const frame = render(tabbed);
    expect(rowOf(frame, '❯ ·')).toBeGreaterThan(0);
    expect(rowOf(frame, 'Task number 1')).toBeGreaterThan(0);

    // and the selection is still in view after walking down it
    let walking = tabbed;
    for (let i = 0; i < 7; i++) walking = press(walking, 'down').state;
    expect(rowOf(render(walking), 'Task number 8')).toBeGreaterThan(0);
  });

  it('re-clamps the chat\'s scroll when tab hands it more rows', () => {
    // Plan-focused in a body this short the chat is one row; focusing it makes it three.
    const small = withBody(4, 50, { tasks: tasksOf(8), conversation: talk(40), focus: 'plan' });
    const pinned = { ...small, scroll: chatScrollMax(small) };
    expect(pinned.scroll).toBeGreaterThan(0);

    const tabbed = press(pinned, 'tab').state;

    expect(bodyPanes(tabbed).chat.rows).toBeGreaterThan(bodyPanes(pinned).chat.rows);
    expect(tabbed.scroll).toBe(chatScrollMax(tabbed));
    expect(tabbed.scroll).toBeLessThan(pinned.scroll);
  });

  it('opens the selected task\'s log into the chat with the plan still beneath it, then returns', () => {
    const state = screen(50, 30, { focus: 'plan' });
    const opened = press(state, 'enter');
    expect(opened.effects).toEqual([expect.objectContaining({ type: 'openTaskLog', taskId: 't0' })]);

    const frame = render(opened.state);
    expect(rowOf(frame, '→ Task 1')).toBe(1);
    expect(rowOf(frame, 'Plan 0/3')).toBeGreaterThan(rowOf(frame, '→ Task 1'));
    expect(opened.state.focus).toBe('chat');

    const back = press(opened.state, 'escape').state;
    expect(back.taskView).toBeNull();
    expect(back.focus).toBe('plan');
  });

  it('keeps the open task log\'s pinned header and a few log rows in a short stacked chat', () => {
    const log = { ...EMPTY_TASK_LOG, blocks: talk(30).blocks };
    const opened = press(withBody(8, 50, { focus: 'plan' }), 'enter').state;
    const viewing: TuiState = { ...opened, taskView: { ...opened.taskView!, view: log, loaded: true } };
    const { chat, plan } = bodyPanes(viewing);
    const frame = render(viewing);

    expect(chat.rows + plan!.rows).toBe(bodyRows(viewing));
    // the header takes two rows; the log keeps at least two under it
    expect(chat.rows).toBeGreaterThanOrEqual(4);
    expect(rowOf(frame, '→ Task 1')).toBe(1);
    expect(rowOf(frame, 'esc back')).toBe(2);
    expect(rowOf(frame, 'CHATLINE 29')).toBeGreaterThan(2);
    expect(rowOf(frame, 'CHATLINE 29')).toBeLessThan(plan!.row);

    // an empty log asks for no more than its header, and the plan has the rest
    const empty = bodyPanes(opened);
    expect(empty.chat.rows).toBeLessThan(chat.rows);
  });

  it('edits a task prompt inside the stacked pane and moves the caret by its width', () => {
    const prompt = 'one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen';
    let state = screen(40, 30, { tasks: [{ ...task(0), prompt }], focus: 'plan' });
    state = press(state, 'right').state;

    const room = taskEditorRoom(state);
    expect(room).toBe(36);
    const before = cursorPosition(state.taskEditor!.text, state.taskEditor!.cursor, room);
    expect(before.line).toBeGreaterThan(0);

    const up = press(state, 'up').state;
    expect(cursorPosition(up.taskEditor!.text, up.taskEditor!.cursor, room).line).toBe(before.line - 1);

    const frame = render(typed(up, 'X'));
    expect(frame).toHaveLength(30);
    expect(Math.max(...frame.map(width))).toBeLessThanOrEqual(40);
    expect(rowOf(frame, 'Task number 1')).toBeGreaterThan(rowOf(frame, 'Plan 0/1'));

    const edited = press(typed(state, '!'), 'enter');
    expect(edited.effects).toEqual([expect.objectContaining({ type: 'updateTask', changes: { prompt: `${prompt}!` } })]);
  });

  it('keeps the open prompt\'s caret on screen when the plan pane is short', () => {
    const prompt = Array.from({ length: 12 }, (_, i) => `sentence ${i} of a long prompt`).join(' ');
    const state = press(screen(40, 20, { tasks: [{ ...task(0), prompt }], focus: 'plan' }), 'right').state;
    const { plan } = bodyPanes(state);
    const frame = render(state).slice(plan!.row - 1, plan!.row - 1 + plan!.rows);

    expect(frame.some((line) => line.includes('sentence 11'))).toBe(true);
  });
});

describe('resizing back and forth', () => {
  it('keeps the selected task and the frame valid across wide, narrow, wide', () => {
    let state = screen(100, 24, { tasks: tasksOf(25), focus: 'plan', selectedTask: 17 });
    state = resize(state, 100, 24);

    for (const [cols, rows, mode] of [[69, 24, 'stacked'], [40, 18, 'stacked'], [20, 30, 'stacked'], [70, 24, 'side'], [100, 24, 'side']] as const) {
      state = resize(state, cols, rows);
      const frame = render(state);
      expect(bodyPanes(state).mode).toBe(mode);
      expect(frame, `${cols}x${rows}`).toHaveLength(rows);
      expect(Math.max(...frame.map(width)), `${cols}x${rows}`).toBeLessThanOrEqual(cols);
      expect(rowOf(frame, '❯ ·'), `${cols}x${rows}`).toBeGreaterThan(0);
      expect(state.selectedTask).toBe(17);
    }
  });

  it('clamps a scrolled-back transcript when the stacked chat grows', () => {
    let state = screen(50, 20, { tasks: tasksOf(10), conversation: talk(60) });
    state = { ...state, scroll: chatScrollMax(state) };
    const big = resize(state, 50, 60);

    expect(bodyPanes(big).chat.rows).toBeGreaterThan(bodyPanes(state).chat.rows);
    expect(big.scroll).toBe(chatScrollMax(big));
    expect(big.scroll).toBeLessThan(state.scroll);
    expect(render(big)).toHaveLength(60);
  });
});

describe('overlays and the composer', () => {
  it('draws an overlay over the whole stacked body, and the frame keeps its height', () => {
    const open = reduce(screen(40, 24, { focus: 'plan' }), { type: 'key', key: { name: 'char', char: '?' } }).state;
    expect(open.overlay).not.toBeNull();
    const frame = render(open);

    expect(frame).toHaveLength(24);
    expect(rowOf(frame, 'Plan 0/3')).toBe(0);
  });

  it('shrinks the stacked panes to make room for a growing draft, never overflowing the frame', () => {
    const state = screen(40, 24);
    const text = 'line one\nline two\nline three';
    const draft = { ...state, editor: { ...state.editor, text, cursor: text.length } };
    const frame = render(draft);
    const { chat, plan } = bodyPanes(draft);

    expect(bodyRows(draft)).toBe(bodyRows(state) - 2);
    expect(chat.rows + plan!.rows).toBe(bodyRows(draft));
    expect(frame).toHaveLength(24);
    expect(rowOf(frame, 'line three')).toBeGreaterThan(rowOf(frame, 'Task number 1'));
  });

  it('keeps queued prompts at the foot of the transcript, above the plan', () => {
    const state = screen(40, 30, { queuedPrompts: ['parked thought'], planner: 'planning' });
    const frame = render(state);

    expect(rowOf(frame, 'parked thought')).toBeGreaterThan(0);
    expect(rowOf(frame, 'parked thought')).toBeLessThan(rowOf(frame, 'Plan 0/3'));
  });
});
