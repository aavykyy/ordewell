import React from 'react';
import { describe, it, expect } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import TaskCard from '../TaskCard';
import SubTaskCard from '../SubTaskCard';
import type { Task } from '@ordewell/core';

// Within the hour from now, so the label is a bare clock time whatever the date.
const soon = (): Date => {
  const at = new Date();
  at.setMinutes(at.getMinutes() < 30 ? 50 : at.getMinutes(), 0, 0);
  return at;
};

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: 't1', order: 1, title: 'Test task', description: 'A task', type: 'ai', status: 'awaiting_user',
    awaitingReason: 'usage-limit', resumeAt: soon().toISOString(),
    dependencies: [], subtasks: [], assignedRunner: 'claude-code', taskMode: 'build',
    ...overrides,
  };
}

describe('a task paused on a usage limit (#84)', () => {
  it('says when it resumes, and cancels that without a running plan', () => {
    const cancelled: string[] = [];
    render(<TaskCard task={makeTask()} models={[]} onCancelResume={(id) => cancelled.push(id)} />);

    expect(screen.getByText('Paused on a usage limit', { selector: '.task-status-badge' })).toBeTruthy();
    expect(screen.getByText(/^Resumes at \d{1,2}(:\d{2})?[ap]m$/)).toBeTruthy();
    fireEvent.click(screen.getByText('Cancel resume'));
    expect(cancelled).toEqual(['t1']);
  });

  it('shows neither once it waits for a manual retry', () => {
    render(<TaskCard task={makeTask({ resumeAt: undefined })} models={[]} onCancelResume={() => {}} />);
    expect(screen.getByText('Paused on a usage limit', { selector: '.task-status-badge' })).toBeTruthy();
    expect(screen.queryByText(/^Resumes at/)).toBeNull();
    expect(screen.queryByText('Cancel resume')).toBeNull();
  });

  it('offers the cancel among a running plan\'s actions too', () => {
    const cancelled: string[] = [];
    render(<TaskCard task={makeTask()} models={[]} isExecuting onCancelResume={(id) => cancelled.push(id)} expanded onExpandedChange={() => {}} />);
    fireEvent.click(screen.getByText('Cancel Resume'));
    expect(cancelled).toEqual(['t1']);
  });

  it('says it on a subtask card as well', () => {
    const cancelled: string[] = [];
    const parent = makeTask({ id: 'p1', status: 'in_progress', awaitingReason: undefined, resumeAt: undefined });
    render(<SubTaskCard task={makeTask({ id: 's1' })} parentTask={parent} models={[]} onCancelResume={(id) => cancelled.push(id)} />);
    expect(screen.getByText(/^Resumes at /)).toBeTruthy();
    fireEvent.click(screen.getByText('Cancel resume'));
    expect(cancelled).toEqual(['s1']);
  });
});
