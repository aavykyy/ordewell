import { describe, it, expect, beforeAll } from 'vitest';
import { initialState } from '../reducer';
import { render } from '../render';
import { style } from '../ansi';
import type { TaskView, TuiState } from '../state';

beforeAll(() => { style.enabled = false; });

// The pane is narrow and wraps a long label, so a label is looked for as the one sentence it is.
const frame = (state: TuiState): string => render(state)
  .map((row) => row.split('│').at(-1)!.trim())
  .join(' ')
  .replace(/\s+/g, ' ');

const task = (over: Partial<TaskView> = {}): TaskView => ({
  id: 't1', order: 1, title: 'Why does the cache serve stale entries?', type: 'ai', status: 'pending', dependencies: [], assignedRunner: 'claude-code', ...over,
});

const plan = (tasks: TaskView[], over: Partial<TuiState> = {}): TuiState =>
  initialState({
    sessionId: 's1', rows: 30, cols: 120, focus: 'plan', tasks,
    runners: [{ id: 'claude-code', name: 'Claude Code', enabled: true }],
    ...over,
  });

describe('plan pane — a research task (ADR-0037)', () => {
  it('marks the row as research where an AI task says AI', () => {
    expect(frame(plan([task({ research: true })]))).toMatch(/ 1 RES Why does the cache/);
    expect(frame(plan([task()]))).toMatch(/ 1 AI Why does the cache/);
  });

  it('keeps the mark on a running row, whose tag says RUN', () => {
    const out = frame(plan([task({ research: true, status: 'in_progress' })]));
    expect(out).toMatch(/ 1 RUN Why does the cache/);
    expect(out).toContain('research · claude-code');
  });

  it('says in the expanded row what makes it research', () => {
    const out = frame(plan([task({ research: true })], { expandedTaskId: 't1' }));
    expect(out).toContain('Read-only: it lands nothing. Its report wakes the planner when it ends.');
  });

  it('draws no mark on a task that is not research', () => {
    const out = frame(plan([task()]));
    expect(out).not.toContain('RES');
  });
});
