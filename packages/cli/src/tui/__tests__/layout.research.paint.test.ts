import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { initialState } from '../reducer';
import { planLayout } from '../layout';
import { stripAnsi, style, width } from '../ansi';
import { inkOf } from './paint';
import type { TaskView, TuiState } from '../state';

let saved: { enabled: boolean; attributes: boolean };

beforeAll(() => {
  saved = { enabled: style.enabled, attributes: style.attributes };
  style.enabled = true;
});

afterAll(() => {
  Object.assign(style, saved);
});

const task = (over: Partial<TaskView> = {}): TaskView => ({
  id: 't1',
  order: 1,
  title: 'Why does the cache serve stale entries?',
  type: 'ai',
  status: 'in_progress',
  dependencies: [],
  assignedRunner: 'opencode',
  research: true,
  assignedModel: { modelId: 'deepseek', modelLabel: 'DeepSeek V4.1 Flash', thinkingEffort: 'high' },
  ...over,
});

const state = (over: Partial<TuiState> = {}, overTask: Partial<TaskView> = {}): TuiState =>
  initialState({
    sessionId: 's1',
    rows: 60,
    cols: 120,
    focus: 'chat',
    tasks: [task(overTask)],
    ...over,
  });

/**
 * The task's metadata row. `planLayout` is asked for the pane width directly,
 * not `render`, so the side pane switching to a stacked layout below 70
 * columns cannot hide the row this test is about.
 */
const metaLine = (cols: number, source: TuiState = state()): string => {
  const line = planLayout(source, 60, cols).lines.find((candidate) => stripAnsi(candidate).includes('resea'));
  if (line === undefined) throw new Error(`no research metadata row at ${cols} columns`);
  return line;
};

describe('a running research task paints its metadata consistently', () => {
  it.each([120, 70, 69, 60])('keeps research cyan and the rest grey where the line fits at %i columns', (cols) => {
    const line = metaLine(cols);

    expect(inkOf(line, 'research')).toMatchObject({ fg: 'cyan' });
    expect(inkOf(line, ' · opencode · DeepSeek V4.1 Flash · high')).toMatchObject({ fg: 'grey' });
  });

  it.each([
    [50, ' · opencode'],
    [40, ' · opencode'],
    [30, ' · opencod'],
    [24, ' · o'],
  ])('keeps research cyan and the metadata grey when the line is cut at %i columns', (cols, tail) => {
    const line = metaLine(cols);

    expect(width(line)).toBeLessThanOrEqual(cols);
    expect(stripAnsi(line).endsWith('…')).toBe(true);
    expect(inkOf(line, 'research')).toMatchObject({ fg: 'cyan' });
    expect(inkOf(line, tail)).toMatchObject({ fg: 'grey' });
  });

  it('keeps the visible part of research cyan when the cut falls inside the word', () => {
    const line = metaLine(17);

    expect(width(line)).toBeLessThanOrEqual(17);
    expect(inkOf(line, 'resea')).toMatchObject({ fg: 'cyan' });
  });

  it('keeps an activity label and the separator before the mark grey', () => {
    const line = metaLine(160, state({}, { awaitingApproval: 1 }));

    expect(inkOf(line, 'waiting for approval: enter opens it')).toMatchObject({ fg: 'grey' });
    expect(inkOf(line, 'research')).toMatchObject({ fg: 'cyan' });
    expect(inkOf(line, ' · opencode · DeepSeek V4.1 Flash · high')).toMatchObject({ fg: 'grey' });
  });

  it('drops the effort variant rather than the model when only one fits, keeping the row grey', () => {
    const wide = metaLine(120);
    expect(stripAnsi(wide)).toContain('DeepSeek V4.1 Flash · high');
    expect(inkOf(wide, ' · high')).toMatchObject({ fg: 'grey' });

    const narrow = metaLine(50);
    expect(stripAnsi(narrow)).not.toContain('high');
    expect(inkOf(narrow, ' · opencode')).toMatchObject({ fg: 'grey' });
  });

  it('renders the same labels with no escapes when colour is disabled', () => {
    style.enabled = false;
    try {
      const line = metaLine(120);

      expect(line).not.toContain('\x1b');
      expect(stripAnsi(line)).toContain('research · opencode · DeepSeek V4.1 Flash · high');
    } finally {
      style.enabled = true;
    }
  });
});
