import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import TaskCard from '../TaskCard';
import SubTaskCard from '../SubTaskCard';
import type { Task } from '@ordewell/core';

const RUNNERS = [{ id: 'codex', displayName: 'Codex' }, { id: 'claude-code', displayName: 'Claude Code' }];
const task = (over: Partial<Task> = {}): Task => ({
  id: 't', order: 1, title: 'Work', description: '', type: 'ai', status: 'in_progress', dependencies: [], subtasks: [],
  assignedRunner: 'codex', taskMode: 'build', assignedModel: { modelId: 'openai/gpt', modelLabel: 'GPT', thinkingEffort: 'high' },
  ...over,
});
const pickers = { runners: RUNNERS, onRunnerChange: vi.fn(), onModeChange: vi.fn() };

describe('the assignment while a plan executes', () => {
  beforeEach(cleanup);

  it('replaces the runner, model and mode pickers with a read-only runner · model · variant on a task card', () => {
    const { container } = render(<TaskCard task={task()} models={[]} isExecuting {...pickers} />);
    fireEvent.click(screen.getByText('Work'));

    expect(screen.queryByLabelText('Runner')).toBeNull();
    expect(screen.queryByLabelText(/^Mode/)).toBeNull();
    expect(container.querySelector('.task-assignment-readonly')?.textContent).toBe('Assignedcodex · GPT · high');
    // The header line under the title is there in every state.
    expect(container.querySelector('.task-heading .task-assignment')?.textContent).toBe('codex · GPT · high');
  });

  it('replaces them on a subtask card too', () => {
    const sub = task({ id: 'sub' });
    const { container } = render(<SubTaskCard task={sub} parentTask={task({ subtasks: [sub] })} models={[]} isExecuting {...pickers} />);
    fireEvent.click(screen.getByText('Work'));

    expect(screen.queryByLabelText('Runner')).toBeNull();
    expect(container.querySelector('.task-assignment-readonly')?.textContent).toBe('Assignedcodex · GPT · high');
    expect(container.querySelector('.task-heading .task-assignment')?.textContent).toBe('codex · GPT · high');
  });

  it('keeps the pickers, and no read-only copy, before execution', () => {
    const { container } = render(<TaskCard task={task({ status: 'pending' })} models={[]} {...pickers} />);
    fireEvent.click(screen.getByText('Work'));

    expect(screen.getByLabelText('Runner')).toBeTruthy();
    expect(container.querySelector('.task-assignment-readonly')).toBeNull();
    expect(container.querySelector('.task-heading .task-assignment')).not.toBeNull();
  });

  it('shows nothing for a manual task, which no runner executes', () => {
    const { container } = render(<TaskCard task={task({ type: 'user' })} models={[]} isExecuting {...pickers} />);
    fireEvent.click(screen.getByText('Work'));

    expect(container.querySelector('.task-assignment-readonly')).toBeNull();
  });
});
