import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { replayTaskLog } from '@ordewell/core';
import { stripAnsi, style, width } from '../ansi';
import { bodyRows, chatScrollMax, composerRows } from '../layout';
import { render } from '../render';
import { initialState, type TaskLogState, type TaskView, type TuiState } from '../state';
import { registerSkillCommands } from '../slash';
import { chatOf } from './chat';

const GREY_BG = '\x1b[48;5;234m';
const RESET = '\x1b[0m';
const GREY_ON_BAND = '\x1b[38;5;245m';

let wasEnabled: boolean;
beforeEach(() => { wasEnabled = style.enabled; style.enabled = true; });
afterEach(() => { style.enabled = wasEnabled; registerSkillCommands([]); });

const tasks: TaskView[] = [
  { id: 'a', order: 1, title: 'Add the login route', type: 'ai', status: 'completed', dependencies: [] },
  { id: 'b', order: 2, title: 'Write the tests', type: 'ai', status: 'running', dependencies: ['a'], assignedRunner: 'claude-code' },
];

const typed = (text: string, over: Partial<TuiState> = {}, cursor = text.length): TuiState => {
  const s = initialState({ rows: 24, cols: 80, ...over });
  return { ...s, editor: { ...s.editor, text, cursor } };
};

/** The rows of the frame that start on the band. With an empty transcript these are the composer's alone. */
const bandRows = (state: TuiState): string[] => render(state).filter((row) => row.startsWith(GREY_BG));

describe('the composer sits on the grey band', () => {
  it('is the typed row between an empty row above and one below, the full width of the screen', () => {
    const rows = bandRows(typed('add a login route'));
    expect(rows.map(stripAnsi)).toEqual([
      ' '.repeat(80),
      `❯ add a login route${' '.repeat(80 - 19)}`,
      ' '.repeat(80),
    ]);
    for (const row of rows) expect(row.endsWith(RESET)).toBe(true);
  });

  it('keeps the three rows together, directly above the footer', () => {
    const frame = render(typed('hi'));
    const first = frame.findIndex((row) => row.startsWith(GREY_BG));
    expect(frame.slice(first, first + 3).every((row) => row.startsWith(GREY_BG))).toBe(true);
    expect(frame[first + 3].startsWith(GREY_BG)).toBe(false);
    expect(frame).toHaveLength(24);
  });

  it('keeps the brand prompt glyph, and the band after it', () => {
    const [, text] = bandRows(typed('hello'));
    expect(text).toContain(`${GREY_BG}${style.brand('❯ ')}${GREY_BG}`);
  });

  it('puts the caret over a whole emoji, not half its surrogate pair', () => {
    const [, text] = bandRows(typed('a😀b', {}, 1));
    expect(text).toContain(`a\x1b[7m😀${RESET}${GREY_BG}b`);
  });

  it('puts the caret over a whole emoji in the task prompt editor too', () => {
    const state = initialState({
      sessionId: 's1', rows: 30, cols: 100, focus: 'plan', tasks: [tasks[0]],
      expandedTaskId: 'a',
      taskEditor: { text: 'do 😀 it', cursor: 3, history: [], historyIndex: 0, draft: '' },
    });
    expect(render(state).join('\n')).toContain(`do ${style.inverse('😀')} it`);
  });

  it('shows the caret inside the band and carries the band on past it', () => {
    const [, text] = bandRows(typed('abcdef', {}, 2));
    expect(text).toContain(`ab\x1b[7mc${RESET}${GREY_BG}def`);
    expect(width(text)).toBe(80);
  });

  it('shows the caret block after the text when it sits at the end', () => {
    const [, text] = bandRows(typed('abc'));
    expect(text).toContain(`abc\x1b[7m ${RESET}${GREY_BG}`);
  });

  it('puts every row of a multi-line draft on the band, continuation rows indented', () => {
    const rows = bandRows(typed('one\ntwo\nthree'));
    expect(rows.map((row) => stripAnsi(row).trimEnd())).toEqual(['', '❯ one', '  two', '  three', '']);
    for (const row of rows) expect(width(row)).toBe(80);
  });

  it('wraps a long draft under the band, every wrapped row padded to the width', () => {
    const rows = bandRows(typed('word '.repeat(40), { cols: 40 }));
    expect(rows.length).toBeGreaterThan(4);
    for (const row of rows) {
      expect(width(row)).toBe(40);
      expect(row.endsWith(RESET)).toBe(true);
    }
  });

  it('paints a /skill token in the brand teal on the band and keeps the band after it', () => {
    registerSkillCommands([{ name: 'grilling', description: 'Grill the plan' }]);
    const [, text] = bandRows(typed('use /grilling now'));
    expect(text).toContain(`${style.brand('/grilling')}${GREY_BG}`);
  });

  it('shows the suggestion hint in a grey that stays legible on the band, band intact after it', () => {
    const [, text] = bandRows(typed('/task-m'));
    expect(text).toContain(`${GREY_ON_BAND}  `);
    expect(stripAnsi(text)).toContain('task-model');
    expect(width(text)).toBe(80);
    expect(text.endsWith(RESET)).toBe(true);
  });

  it('is one row between the empty ones while the plan pane has focus, the prompt kept but quiet', () => {
    const rows = bandRows(typed('draft', { focus: 'plan', tasks }));
    expect(rows).toHaveLength(3);
    expect(rows.map((row) => stripAnsi(row).trimEnd())).toEqual(['', '❯ draft', '']);
    expect(rows[1]).toContain(`${GREY_ON_BAND}❯ ${RESET}${GREY_BG}`);
    expect(rows[1]).not.toContain('\x1b[7m');
  });

  it('never exceeds the width when a blurred draft is longer than the screen', () => {
    for (const row of bandRows(typed('x'.repeat(200), { focus: 'plan', tasks, cols: 50 }))) {
      expect(width(row)).toBe(50);
      expect(row.endsWith(RESET)).toBe(true);
    }
  });

  it('stays below the divider and the plan pane: it is under both, at the whole width', () => {
    const frame = render(typed('hello', { cols: 100, tasks }));
    const rows = frame.filter((row) => row.startsWith(GREY_BG) && !stripAnsi(row).includes('│'));
    expect(rows).toHaveLength(3);
    for (const row of rows) {
      expect(width(row)).toBe(100);
      expect(row).not.toContain('\x1b[K');
    }
    const dividers = frame.filter((row) => stripAnsi(row).includes('│'));
    expect(dividers.length).toBeGreaterThan(0);
  });

  it('is on the task view\'s composer too, with its accent label', () => {
    const task: TaskView = { id: 't1', order: 3, title: 'Refactor', type: 'ai', status: 'in_progress', dependencies: [], assignedRunner: 'claude-code' };
    const taskView: TaskLogState = {
      taskId: 't1',
      view: replayTaskLog([{ type: 'text_delta', text: 'On it.' }, { type: 'turn_end', reason: 'completed' }]),
      attempts: [1], attempt: 1, pending: [], loaded: true, followLatest: true, queuedIndex: 0,
    };
    const rows = bandRows(typed('keep going', { tasks: [task], taskView }));
    expect(rows.map((row) => stripAnsi(row).trimEnd())).toEqual(['', '→ Task 3 keep going', '']);
    expect(rows[1]).toContain(`${GREY_BG}\x1b[94m→ Task 3 ${RESET}${GREY_BG}`);
    for (const row of rows) expect(width(row)).toBe(80);
  });
});

describe('the band rows are part of the layout', () => {
  it('takes exactly two rows from the body', () => {
    // rows − status − footer(1) − composer(1 text + 2 band)
    expect(bodyRows(typed('hi'))).toBe(24 - 1 - 1 - 3);
    expect(bodyRows(typed('a\nb\nc'))).toBe(24 - 1 - 1 - 5);
    expect(bodyRows(typed('hi', { focus: 'plan', tasks }))).toBe(24 - 1 - 1 - 3);
  });

  it('keeps the frame exactly as tall as the terminal, as the draft grows', () => {
    for (const draft of ['', 'a', 'a\nb', 'a\nb\nc\nd', 'word '.repeat(60)]) {
      expect(render(typed(draft))).toHaveLength(24);
    }
  });

  it('scrolls the transcript to its true top at the scroll bound, and not before', () => {
    const entries = Array.from({ length: 40 }, (_, i): ['planner', string] => ['planner', `line ${String(i).padStart(2, '0')}`]);
    // Tasks so the welcome has gone, and line 00 is the transcript's top.
    const base = typed('', { conversation: chatOf(...entries), tasks, cols: 100 });
    const max = chatScrollMax(base);
    expect(max).toBeGreaterThan(0);

    const top = render({ ...base, scroll: max }).map(stripAnsi);
    expect(top[0]).toContain('line 00');
    const oneShort = render({ ...base, scroll: max - 1 }).map(stripAnsi);
    expect(oneShort[0]).not.toContain('line 00');
  });

  it('shows the newest line directly above the status row at the tail', () => {
    const entries = Array.from({ length: 40 }, (_, i): ['planner', string] => ['planner', `line ${String(i).padStart(2, '0')}`]);
    const frame = render(typed('', { conversation: chatOf(...entries) })).map(stripAnsi);
    const last = frame.findIndex((row) => row.includes('line 39'));
    const composer = frame.findIndex((row) => row.startsWith('❯ '));
    // The block's gap, the status row, the band's empty row.
    expect(composer - last).toBe(4);
  });
});

describe('with colour off', () => {
  it('has no colour escape, but keeps the inverse caret and the empty rows', () => {
    style.enabled = false;
    try {
      const frame = render(typed('add a login route'));
      expect(frame).toHaveLength(24);
      // SGR 7 and its reset are the only escapes left: they mark the caret,
      // which NO_COLOR must not take away while the hardware cursor is hidden.
      // eslint-disable-next-line no-control-regex
      for (const row of frame) expect(row.replace(/\x1b\[(?:7|0)m/g, '')).not.toContain('\x1b');
      const at = frame.findIndex((row) => row.startsWith('❯ add a login route'));
      expect(at).toBeGreaterThan(0);
      expect(frame[at]).toContain('\x1b[7m \x1b[0m');
      expect(frame[at - 1].trim()).toBe('');
      expect(frame[at + 1].trim()).toBe('');
      expect(bodyRows(typed('hi'))).toBe(24 - 1 - 1 - 3);
    } finally {
      style.enabled = true;
    }
  });
});

describe('a sent message on the band, in the whole frame', () => {
  const sent = (over: Partial<TuiState> = {}): TuiState =>
    typed('', { conversation: chatOf(['user', 'add a login route'], ['planner', 'On it.']), ...over });

  it('has an empty grey row above and below, each the width of the screen', () => {
    const frame = render(sent());
    const at = frame.findIndex((row) => stripAnsi(row).startsWith('❯ add a login route'));
    expect(at).toBeGreaterThan(0);
    for (const row of frame.slice(at - 1, at + 2)) {
      expect(row.startsWith(GREY_BG)).toBe(true);
      expect(row.endsWith(RESET)).toBe(true);
      expect(width(row)).toBe(80);
    }
    expect(stripAnsi(frame[at - 1]).trim()).toBe('');
    expect(stripAnsi(frame[at + 1]).trim()).toBe('');
    expect(frame[at]).toContain(`${GREY_BG}${style.bandGrey('❯')}${GREY_BG}`);
  });

  it('spans the chat pane and stops at the divider when the plan pane is up', () => {
    const frame = render(sent({ cols: 100, tasks }));
    const at = frame.findIndex((row) => stripAnsi(row).includes('❯ add a login route'));
    expect(at).toBeGreaterThan(0);
    for (const row of frame.slice(at - 1, at + 2)) {
      const chatSide = row.slice(0, row.indexOf('\x1b[K'));
      expect(chatSide.startsWith(GREY_BG)).toBe(true);
      expect(width(chatSide)).toBe(53);
      expect(row).toContain('│');
      expect(row.slice(row.indexOf('│'))).not.toContain(GREY_BG);
    }
  });

  it('survives scrolling the transcript, a fresh render and a narrow terminal', () => {
    const many = [
      ...Array.from({ length: 30 }, (_, i): ['planner', string] => ['planner', `reply ${i}`]),
      ['user', 'the message that matters'] as ['user', string],
      ...Array.from({ length: 4 }, (_, i): ['planner', string] => ['planner', `after ${i}`]),
    ];
    for (const cols of [30, 80]) {
      const base = sent({ cols, conversation: chatOf(...many) });
      for (const scroll of [0, 2, 5]) {
        const frame = render({ ...base, scroll });
        const at = frame.findIndex((row) => stripAnsi(row).includes('❯ the message that matters'));
        if (at < 0) continue;
        expect(frame[at - 1].startsWith(GREY_BG)).toBe(true);
        expect(frame[at].startsWith(GREY_BG)).toBe(true);
        expect(frame[at + 1].startsWith(GREY_BG)).toBe(true);
        expect(width(frame[at])).toBe(cols);
      }
    }
  });

  it('caps a huge draft to a window that keeps the caret, and says what it hides', () => {
    // A pasted log: wrapping and painting all of it on every keystroke is what
    // froze typing. The composer shows a window around the caret instead.
    const state = typed('x'.repeat(128 * 1024));
    expect(composerRows(state)).toBeLessThanOrEqual(12);
    const rows = bandRows(state);
    expect(rows.map(stripAnsi).join('\n')).toContain('characters not shown');
    expect(rows.map(stripAnsi).join('\n')).toContain('xxx');
    // The caret sits at the end of the draft, inside the shown window.
    expect(rows.join('\n')).toContain(style.inverse(' '));
  });

  it('still marks the caret when colour is off, because only colour is off', () => {
    // NO_COLOR disables colour, not SGR 7; the driver hides the hardware
    // cursor, so an inverse caret is the only insertion point there is.
    style.enabled = false;
    try {
      const row = render(typed('ab')).find((r) => stripAnsi(r).includes('❯ ab'));
      expect(row).toBeDefined();
      expect(row).toContain('ab\x1b[7m \x1b[0m');
    } finally {
      style.enabled = true;
    }
  });
});
