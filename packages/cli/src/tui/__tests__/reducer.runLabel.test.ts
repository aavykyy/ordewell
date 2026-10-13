import { describe, it, expect } from 'vitest';
import { initialState, reduce } from '../reducer';
import type { TaskView, TuiState } from '../state';
import { lastMessage } from './chat';

function task(over: Partial<TaskView> = {}): TaskView {
  return { id: 't1', order: 1, title: 'Add multiply', type: 'ai', status: 'pending', dependencies: [], assignedRunner: 'claude-code', ...over };
}

function running(): TuiState {
  return initialState({
    sessionId: 's1',
    status: 'executing',
    tasks: [task(), task({ id: 't2', title: 'Add reverse', assignedRunner: 'opencode' })],
  });
}

describe('the status line during a run', () => {
  it('logs a started task as a settled line, never a pending research step', () => {
    const { state } = reduce(running(), { type: 'taskStarted', taskId: 't1', title: 'Add multiply', runner: 'claude-code', sessionId: 's1' });

    expect(state.conversation.blocks.some((b) => b.type === 'tool')).toBe(false);
    expect(lastMessage(state)).toMatchObject({ role: 'system', text: 'Started "Add multiply" · claude-code' });
    expect(state.busyLabel).toBe('Add multiply · claude-code');
  });

  it('stops naming a task once it has finished', () => {
    let { state } = reduce(running(), { type: 'taskStarted', taskId: 't1', title: 'Add multiply', runner: 'claude-code', sessionId: 's1' });
    ({ state } = reduce(state, { type: 'taskStarted', taskId: 't2', title: 'Add reverse', runner: 'opencode', sessionId: 's1' }));
    expect(state.busyLabel).toBe('Add multiply · claude-code (+1 more)');

    ({ state } = reduce(state, { type: 'statusUpdate', tasks: [{ id: 't1', status: 'completed', verdict: null }, { id: 't2', status: 'in_progress', verdict: null }], sessionId: 's1' }));
    expect(state.busyLabel).toBe('Add reverse · opencode');
  });

  it('says the run is waiting on the user when only a conflicted task is left', () => {
    const { state } = reduce(running(), { type: 'statusUpdate', tasks: [{ id: 't1', status: 'completed', verdict: null }, { id: 't2', status: 'awaiting_user', verdict: null }], sessionId: 's1' });

    expect(state.busyLabel).toBe('1 task waits for you');
  });
});
