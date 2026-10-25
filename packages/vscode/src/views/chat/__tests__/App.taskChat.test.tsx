import React from 'react';
import { beforeEach, describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { createTask } from '@ordewell/core';
import App from '../App';
import { api, post } from './hostBridge';

const pending = createTask({ id: 't1', order: 1, title: 'Parse JSON', status: 'pending' });

function showPlan(task = pending): void {
  post({ type: 'planUpdated', plan: { tasks: [task], generatedAt: '', lastUpdated: '', status: 'approved', runners: [] } });
}

describe('a task chat appears with its first attempt, from the run view', () => {
  beforeEach(() => {
    render(<App />);
    api.postMessage.mockClear();
  });

  it('has no Open chat before the task starts', () => {
    showPlan();
    expect(screen.queryByRole('button', { name: 'Open chat' })).toBeNull();
  });

  it('shows it on the status that starts the attempt, with no output or usage', () => {
    showPlan();
    post({ type: 'runView', view: { tasks: [{ id: 't1', status: 'in_progress', verdict: null, attempted: true, subtasks: [] }], runMerge: null, handoff: null, mergeResult: null } });
    expect(screen.getByRole('button', { name: 'Open chat' })).toBeTruthy();
  });

  it('leaves a task completed by a mark without one', () => {
    showPlan({ ...pending, status: 'completed' });
    expect(screen.queryByRole('button', { name: 'Open chat' })).toBeNull();
  });
});
