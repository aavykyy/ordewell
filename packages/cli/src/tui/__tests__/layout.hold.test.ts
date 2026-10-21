import { describe, it, expect, beforeAll } from 'vitest';
import { initialState } from '../reducer';
import { planRows } from '../state';
import { render } from '../render';
import { style } from '../ansi';
import type { TaskView, TuiState } from '../state';

beforeAll(() => { style.enabled = false; });

const frame = (state: TuiState): string => render(state).join('\n');

const task = (over: Partial<TaskView> = {}): TaskView => ({
  id: 't1', order: 1, title: 'Add the route', type: 'ai', status: 'pending', dependencies: [], assignedRunner: 'claude-code', ...over,
});

const plan = (tasks: TaskView[], over: Partial<TuiState> = {}): TuiState =>
  initialState({
    sessionId: 's1', rows: 30, cols: 120, focus: 'plan', tasks,
    runners: [{ id: 'claude-code', name: 'Claude Code', enabled: true }],
    ...over,
  });

describe('plan pane — a task on hold', () => {
  it('shows why it is held, not just that it is not running', () => {
    const out = frame(plan([task({ holdReason: 'could not connect to Ordewell\'s tools; start it again' })]));
    expect(out).toContain('on hold: could not connect to Ordewell\'s tools');
    expect(out).toContain('start it again');
  });

  it('says nothing about a hold that has no reason', () => {
    expect(frame(plan([task()]))).not.toContain('on hold');
  });

  it('shows a subtask\'s own hold reason', () => {
    const state = plan([task({
      subtasks: [task({ id: 't1a', order: 1, title: 'Nested', holdReason: 'cancelled; retry or force start to run it again' })],
    })], { expandedTaskId: 't1' });
    expect(planRows(state)).toHaveLength(2);
    expect(frame(state)).toContain('⏸ on hold: cancelled; retry or force start to');
    expect(frame(state)).toContain('run it again');
  });
});
