import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { replayTaskLog, type DisplayBlock, type MessageBlock } from '@ordewell/core';
import { stripAnsi, style, width } from '../ansi';
import { conversationLines } from '../blocks';
import { chatLayout } from '../layout';
import { initialState } from '../reducer';
import type { TaskLogState, TaskView } from '../state';

const GREY_BG = '\x1b[48;5;236m';
const RESET = '\x1b[0m';

const message = (role: MessageBlock['role'], text: string, over: Partial<MessageBlock> = {}): MessageBlock =>
  ({ type: 'message', id: 'b1', role, text, streaming: false, ...over });

const draw = (blocks: DisplayBlock[], cols: number): string[] => conversationLines(blocks, cols, false);

/** The rows between the block's leading edge and the blank gap that closes it. */
const bandOf = (rows: string[]): string[] => rows.slice(0, rows.lastIndexOf(''));

let wasEnabled: boolean;
beforeEach(() => { wasEnabled = style.enabled; style.enabled = true; });
afterEach(() => { style.enabled = wasEnabled; });

describe('a sent user message sits on a grey band', () => {
  it('is the text between an empty row above and one below, full pane width', () => {
    const rows = draw([message('user', 'add a login route')], 30);
    expect(rows.map(stripAnsi)).toEqual([
      ' '.repeat(30),
      `❯ add a login route${' '.repeat(11)}`,
      ' '.repeat(30),
      '',
    ]);
  });

  it('wraps long text under the same band, continuation lines indented', () => {
    const rows = bandOf(draw([message('user', 'alpha beta gamma delta epsilon zeta')], 16));
    expect(rows.map(stripAnsi)).toEqual([
      ' '.repeat(16),
      '❯ alpha beta    ',
      '  gamma delta   ',
      '  epsilon zeta  ',
      ' '.repeat(16),
    ]);
  });

  it('paints every band row, empty ones and rows after the cyan ❯ reset included', () => {
    const rows = bandOf(draw([message('user', 'one two three four five six seven')], 16));
    expect(rows.length).toBeGreaterThan(3);
    for (const row of rows) {
      expect(row.startsWith(GREY_BG)).toBe(true);
      expect(row.endsWith(RESET)).toBe(true);
      const inner = row.slice(0, -RESET.length);
      expect(inner.split(RESET).slice(1).every((after) => after.startsWith(GREY_BG) || after === '')).toBe(true);
    }
    expect(rows[1]).toContain(`\x1b[36m❯${RESET}${GREY_BG}`);
  });

  it('keeps the band through a /skill token colour', () => {
    const rows = bandOf(draw([message('user', 'use /tdd here', { skills: ['tdd'] })], 24));
    expect(rows[1]).toContain(`\x1b[36m/tdd${RESET}${GREY_BG}`);
    expect(stripAnsi(rows[1])).toBe(`❯ use /tdd here${' '.repeat(9)}`);
  });

  it('measures exactly the pane width on every row, wide glyphs and a long word included', () => {
    for (const cols of [8, 20, 33]) {
      const rows = bandOf(draw([message('user', '日本語のメッセージ and averyveryverylongwordthatcannotfit')], cols));
      for (const row of rows) expect(width(row)).toBe(cols);
    }
  });

  it('never overflows a pane narrower than the marker', () => {
    for (const row of bandOf(draw([message('user', 'hello')], 1))) expect(width(row)).toBe(1);
  });

  it('is redrawn for the new width when the pane resizes', () => {
    const blocks = [message('user', 'same block, two widths')];
    expect(bandOf(draw(blocks, 40)).every((row) => width(row) === 40)).toBe(true);
    expect(bandOf(draw(blocks, 24)).every((row) => width(row) === 24)).toBe(true);
  });

  it('leaves the planner, the agent and the system without a band', () => {
    for (const role of ['planner', 'agent', 'supervisor', 'system', 'error'] as const) {
      const rows = draw([message(role, 'hello there')], 30);
      expect(rows.some((row) => row.includes(GREY_BG))).toBe(false);
      expect(rows.map(stripAnsi)[0]).not.toBe(' '.repeat(30));
    }
  });

  it('with colour off is the empty rows and the text as it was, no escape code', () => {
    style.enabled = false;
    const rows = draw([message('user', 'add a login route')], 30);
    expect(rows).toEqual(['', '❯ add a login route', '', '']);
  });
});

describe('in the task view', () => {
  const task: TaskView = { id: 't1', order: 1, title: 'Refactor', type: 'ai', status: 'in_progress', dependencies: [], assignedRunner: 'claude-code' };
  const taskLog: TaskLogState = {
    taskId: 't1',
    view: replayTaskLog([
      { type: 'turn_start', message: 'Do the task' },
      { type: 'text_delta', text: 'On it.' },
      { type: 'turn_end', reason: 'completed' },
    ]),
    attempts: [1], attempt: 1, pending: [], loaded: true, followLatest: true, queuedIndex: 0,
  };

  it('puts the runner log\'s user message on the band too', () => {
    const state = initialState({ sessionId: 's1', focus: 'chat', rows: 24, cols: 100, tasks: [task], taskView: taskLog });
    const { lines } = chatLayout(state, 20, 50);
    const at = lines.findIndex((row) => stripAnsi(row).startsWith('❯ Do the task'));
    expect(at).toBeGreaterThan(0);
    for (const row of lines.slice(at - 1, at + 2)) {
      expect(row.startsWith(GREY_BG)).toBe(true);
      expect(width(row)).toBe(50);
    }
    expect(stripAnsi(lines[at - 1]).trim()).toBe('');
    expect(stripAnsi(lines[at + 1]).trim()).toBe('');
  });
});
