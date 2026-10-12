import React from 'react';
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import TaskCard from '../TaskCard';
import SubTaskCard from '../SubTaskCard';
import PlanCardGroup from '../PlanCardGroup';
import type { Task, AttemptUsage } from '@ordewell/core';

const usage: AttemptUsage = { attempt: 1, runner: 'codex', startedAt: '', wallTimeMs: 5000, totals: { inputTokens: 12400, outputTokens: 3100, reportedCost: { USD: 0.42 } }, byModel: [{ source: 'codex', model: 'actual-model', totals: { inputTokens: 12400, outputTokens: 3100 } }], lastPromptTokens: 36000, contextWindow: 200000 };
const task = (over: Partial<Task> = {}): Task => ({ id: 't', order: 1, title: 'Work', description: '', type: 'ai', status: 'completed', dependencies: [], subtasks: [], assignedRunner: 'codex', ...over });

describe('task card usage', () => {
  it('renders no usage and no model badge in a collapsed card header', () => {
    const { container } = render(<TaskCard task={task({ attemptUsage: [usage], assignedModel: { modelId: 'anthropic/claude-sonnet', modelLabel: 'Sonnet' } })} models={[]} />);
    expect(screen.queryByText(/12,400 in/)).toBeNull();
    expect(container.querySelector('.task-model-badge')).toBeNull();
  });

  it('renders no usage on a subtask card', () => {
    const sub = task({ id: 'sub', attemptUsage: [usage] });
    const parent = task({ subtasks: [sub] });
    render(<SubTaskCard task={sub} parentTask={parent} models={[]} />);
    expect(screen.queryByText(/12,400 in/)).toBeNull();
  });

  it('keeps the plan-wide Tasks total sum of all attempts', () => {
    const parent = task({ attemptUsage: [usage, { ...usage, attempt: 2 }] });
    const { container } = render(<PlanCardGroup tasks={[parent]} models={[]} />);
    expect(container.querySelector('.plan-usage')?.textContent).toContain('24,800 in · 6,200 out · $0.84 · 10s');
    expect(container.textContent).toContain('Tasks total');
  });
});
