import { describe, it, expect, beforeAll } from 'vitest';
import { initialState, reduce, type Effect, type Step } from '../reducer';
import { stripAnsi, style, width } from '../ansi';
import { bodyRows } from '../layout';
import { render } from '../render';
import type { TaskView, TuiState } from '../state';
import { chatOf } from './chat';

beforeAll(() => {
  // The copied text is stripped of paint either way; leaving colour on would
  // only make the pane-width assertions read as if they were about escapes.
  style.enabled = false;
});

/**
 * At cols 80 with a plan, `planPaneWidth` is 36 and `chatPaneWidth` 43 — so the
 * chat owns columns 1–43, the divider is 44, and the plan owns 45–80. Every
 * column in these tests is chosen against that layout.
 */
const CHAT_LAST = 43;
const PLAN_FIRST = 45;

const tasks: TaskView[] = [
  { id: 'a', order: 1, title: 'Add the login route', type: 'ai', status: 'pending', dependencies: [] },
  { id: 'b', order: 2, title: 'Write the tests', type: 'ai', status: 'pending', dependencies: ['a'] },
];

const screenState = (over: Partial<TuiState> = {}): TuiState =>
  initialState({ rows: 24, cols: 80, tasks, runSettingsKnown: true, ...over });

const mouse = (state: TuiState, name: string, col: number, row: number): Step =>
  reduce(state, { type: 'key', key: { name, col, row } });

/**
 * Two panes whose text cannot be confused for one another: every chat row says
 * PANECHAT and every task title says PANEPLAN, so a copy that spliced the two
 * shows up as the wrong word rather than as an off-by-one column.
 */
const twoPanes = (): TuiState => screenState({
  conversation: chatOf(...Array.from({ length: 30 }, (_, i): ['user', string] => ['user', `PANECHAT row ${i} filling the whole chat pane`])),
  tasks: Array.from({ length: 20 }, (_, i): TaskView => ({
    id: `t${i}`, order: i + 1, title: `PANEPLAN task ${i}`, type: 'ai', status: 'pending', dependencies: [],
  })),
});

/** Press, drag and release across the given cells, returning the release step. */
function drag(state: TuiState, from: [number, number], to: [number, number]): Step {
  const down = mouse(state, 'mousedown', from[0], from[1]).state;
  const moved = mouse(down, 'mousedrag', to[0], to[1]).state;
  return mouse(moved, 'mouseup', to[0], to[1]);
}

const copied = (effects: Effect[]): string => {
  const effect = effects.find((e): e is Extract<Effect, { type: 'copyText' }> => e.type === 'copyText');
  if (!effect) throw new Error('the release emitted no copyText effect');
  return effect.text;
};

describe('a drag inside one pane', () => {
  it('anchors the selection where the button went down and pins it to that pane', () => {
    const down = mouse(screenState(), 'mousedown', 5, 3).state;
    const dragged = mouse(down, 'mousedrag', 20, 3).state;

    expect(dragged.selection).toEqual({
      anchor: { col: 5, row: 3 },
      head: { col: 20, row: 3 },
      pane: 'chat',
    });
  });

  it('clamps a drag that wanders out of the plan pane back to the pane it started in', () => {
    const down = mouse(screenState(), 'mousedown', 60, 3).state;
    const wandered = mouse(down, 'mousedrag', 10, 6).state;

    // The row is honoured — the selection runs *down* the plan pane — but the
    // column stops at the plan's first column instead of crossing the divider.
    expect(wandered.selection).toEqual({
      anchor: { col: 60, row: 3 },
      head: { col: PLAN_FIRST, row: 6 },
      pane: 'plan',
    });
  });

  it('clamps a chat drag that wanders into the plan pane back to the chat', () => {
    const down = mouse(screenState(), 'mousedown', 10, 3).state;
    const wandered = mouse(down, 'mousedrag', 70, 5).state;

    expect(wandered.selection).toMatchObject({ head: { col: CHAT_LAST, row: 5 }, pane: 'chat' });
  });
});

describe('what a release copies', () => {
  it('copies chat text only, with not one character of the plan pane in it', () => {
    const text = copied(drag(twoPanes(), [1, 6], [CHAT_LAST, 9]).effects);

    expect(text).toContain('PANECHAT');
    expect(text).not.toContain('PANEPLAN');
    // The divider itself lives one column past the chat pane and must not come
    // along either — it is the seam the splice used to happen at.
    expect(text).not.toContain('│');
  });

  it('copies plan text only when the drag started there', () => {
    const text = copied(drag(twoPanes(), [PLAN_FIRST, 6], [78, 9]).effects);

    expect(text).toContain('PANEPLAN');
    expect(text).not.toContain('PANECHAT');
  });

  it('returns one line per selected row, each clipped to the origin pane', () => {
    const text = copied(drag(twoPanes(), [1, 6], [CHAT_LAST, 9]).effects);
    const lines = text.split('\n');

    expect(lines).toHaveLength(4);
    for (const line of lines) expect(width(line)).toBeLessThanOrEqual(CHAT_LAST);
  });

  it('addresses columns by grapheme cluster, so text after a ZWJ emoji copies from where it is drawn', () => {
    const state = screenState({ conversation: chatOf(['user', '👨‍👩‍👧 NEEDLE tail']) });
    const frame = render(state);
    const row = frame.findIndex((line) => line.includes('NEEDLE'));
    const prefix = frame[row].slice(0, frame[row].indexOf('NEEDLE'));

    const text = copied(drag(state, [width(prefix) + 1, row + 1], [CHAT_LAST, row + 1]).effects);

    expect(text).toBe('NEEDLE tail');
  });

  // A cell-addressed highlight left standing after release would drift once the
  // copy notice's chat message reflows the transcript underneath it — so release
  // must drop the selection in the same step that copies its text.
  it('drops the selection in the very release that copies it', () => {
    const released = drag(twoPanes(), [1, 6], [CHAT_LAST, 9]);

    expect(copied(released.effects)).toContain('PANECHAT');
    expect(released.state.selection).toBeNull();
  });
});

describe('a drag across the composer', () => {
  // The chat pane is 43 columns wide here, so a draft this long can only be
  // copied whole by a selection that reaches past the pane it starts in.
  const DRAFT = 'DEAR SELF: this draft runs well past the chat pane and out to the far edge';

  const composing = (): TuiState => {
    const base = twoPanes();
    return { ...base, editor: { ...base.editor, text: DRAFT, cursor: 0 } };
  };

  /** The 1-based frame row the composer paints the draft on. */
  const composerRow = (state: TuiState): number =>
    render(state).findIndex((line) => stripAnsi(line).includes(DRAFT)) + 1;

  it('copies the whole line, not the chat pane\'s half, when the plan pane is open', () => {
    const state = composing();
    const row = composerRow(state);
    expect(row).toBeGreaterThan(0);
    const painted = stripAnsi(render(state)[row - 1]).trimEnd();

    const text = copied(drag(state, [1, row], [state.cols, row]).effects);

    expect(text).toBe(painted);
    expect(text).toContain(DRAFT);
  });

  it('still stops a body row at the pane edge', () => {
    const state = twoPanes();
    const text = copied(drag(state, [10, 6], [80, 9]).effects);
    const lines = text.split('\n');

    // The composer's rows are the whole frame now, but the body's are not: a
    // drag that wanders across the divider still stops at the chat pane.
    for (const line of lines) expect(width(line)).toBeLessThanOrEqual(CHAT_LAST);
    expect(text).not.toContain('PANEPLAN');
  });

  it('clamps the body rows of a body-to-composer drag and widens only the chrome', () => {
    const state = composing();
    const frame = render(state);
    const row = composerRow(state);
    const body = bodyRows(state);
    const lines = copied(drag(state, [10, 6], [state.cols, row]).effects).split('\n');
    const status = body + 1 - 6;

    expect(lines).toHaveLength(row - 6 + 1);
    // Rows 6..body stay inside the chat pane; never one line of the plan's.
    for (let r = 6; r <= body; r++) {
      expect(lines[r - 6]).toBe(stripAnsi(frame[r - 1]).slice(r === 6 ? 9 : 0, CHAT_LAST).trimEnd());
    }
    // The status row is chrome: its badge sits past the chat pane's edge.
    expect(lines[status]).toBe(stripAnsi(frame[body]).trimEnd());
    expect(lines[status]).toContain('supervisor');
    // The composer row itself, whole.
    expect(lines.at(-1)).toBe(stripAnsi(frame[row - 1]).trimEnd());
  });

  it('treats the reverse drag, composer to body, the same way', () => {
    const state = composing();
    const frame = render(state);
    const row = composerRow(state);
    const body = bodyRows(state);
    // Column 80 is in the plan pane's half of the body, and the press decides
    // the pane for the whole drag, so the body rows stay in that pane.
    const lines = copied(drag(state, [state.cols, row], [10, 6]).effects).split('\n');
    const status = body + 1 - 6;

    expect(lines).toHaveLength(row - 6 + 1);
    for (let r = 6; r <= body; r++) {
      expect(lines[r - 6]).toBe(stripAnsi(frame[r - 1]).slice(PLAN_FIRST - 1, state.cols).trimEnd());
    }
    expect(lines[status]).toBe(stripAnsi(frame[body]).trimEnd());
    expect(lines[status]).toContain('supervisor');
    expect(lines.at(-1)).toBe(stripAnsi(frame[row - 1]).trimEnd());
  });

  it('inverts every painted column of the line, past the chat pane', () => {
    // The caret's own inverse comes and goes inside the range; the row is
    // highlighted exactly when one range covers all of its visible text.
    const highlighted = (line: string): string => stripAnsi(line.split('\x1b[7m').slice(1).join('').split('\x1b[27m')[0]);
    style.enabled = true;
    try {
      const state = composing();
      const row = composerRow(state);
      const plain = render(state)[row - 1];
      const down = mouse(state, 'mousedown', 1, row).state;
      const dragged = mouse(down, 'mousedrag', state.cols, row).state;

      expect(highlighted(render(dragged)[row - 1])).toBe(stripAnsi(plain));
      expect(stripAnsi(plain)).toContain(DRAFT);
    } finally {
      style.enabled = false;
    }
  });
});

describe('a click that is not a drag', () => {
  it('clears the standing selection instead of copying an empty range', () => {
    // A standing selection only exists mid-drag now — release drops it — so
    // this leaves the button down rather than using the drag() helper.
    const down1 = mouse(twoPanes(), 'mousedown', 1, 6).state;
    const selected = mouse(down1, 'mousedrag', CHAT_LAST, 9).state;
    expect(selected.selection).not.toBeNull();

    const down2 = mouse(selected, 'mousedown', 10, 12).state;
    const clicked = mouse(down2, 'mouseup', 10, 12);

    expect(clicked.state.selection).toBeNull();
    expect(clicked.effects).toEqual([]);
  });
});

describe('what a drag must not disturb', () => {
  it('never reaches the line editor', () => {
    const typing = screenState({ editor: { ...initialState().editor, text: 'draft', cursor: 5 } });
    const after = drag(typing, [5, 6], [20, 8]).state;

    expect(after.editor.text).toBe('draft');
  });

  it('never reaches the plan pane shortcuts, which would expand or remove a task', () => {
    const planFocused = screenState({ focus: 'plan', sessionId: 's1' });
    const after = drag(planFocused, [PLAN_FIRST, 6], [70, 8]);

    expect(after.state.expandedTaskId).toBeNull();
    expect(after.state.overlay).toBeNull();
    expect(after.effects.every((e) => e.type === 'copyText')).toBe(true);
  });

  // A resize re-lays out both panes and moves the divider, so the cells a
  // standing selection names now hold different text — and a span anchored
  // where the plan pane used to start can end up straddling the new divider,
  // which is the splice the pane pinning exists to prevent.
  it('drops a standing selection when the terminal is resized', () => {
    // Same reasoning as the click-clears case: a standing selection only
    // exists mid-drag, so leave the button down instead of releasing first.
    const down = mouse(twoPanes(), 'mousedown', PLAN_FIRST, 6).state;
    const selected = mouse(down, 'mousedrag', 70, 9).state;
    expect(selected.selection).not.toBeNull();

    const resized = reduce(selected, { type: 'resize', rows: 40, cols: 120 }).state;
    expect(resized.selection).toBeNull();
  });

  it('leaves the wheel scrolling both panes exactly as before', () => {
    const state = twoPanes();
    const overChat = reduce(state, { type: 'key', key: { name: 'scrollup', col: 10, row: 5 } }).state;
    expect(overChat.scroll).toBe(3);
    expect(overChat.selection).toBeNull();

    const overPlan = reduce(state, { type: 'key', key: { name: 'scrolldown', col: 60, row: 5 } }).state;
    expect(overPlan.planScroll).not.toBeNull();
    expect(overPlan.scroll).toBe(0);
  });
});
