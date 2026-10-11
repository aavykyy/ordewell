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
  it('uses planner formatting and exposes the actual model beside task status', () => {
    render(<TaskCard task={task({ attemptUsage: [usage] })} models={[]} />);
    const line = screen.getByText(/12,400 in/);
    expect(line.textContent).toContain('3,100 out · $0.42 · context 18% · 5s');
    expect(line.getAttribute('title')).toContain('actual-model');
  });

  it('shows unknown for a legacy attempt without reports or measured wall time', () => {
    render(<TaskCard task={task()} models={[]} />);
    expect(screen.getByText(/unknown in/).textContent).toContain('cost unknown · context unknown · time unknown');
  });

  it('renders a subtask ledger and the plan sum of all attempts separately', () => {
    const sub = task({ id: 'sub', attemptUsage: [usage] });
    const parent = task({ subtasks: [sub], attemptUsage: [{ ...usage, attempt: 2 }] });
    const mounted = render(<SubTaskCard task={sub} parentTask={parent} models={[]} />);
    expect(screen.getByText(/12,400 in/)).toBeDefined();
    mounted.unmount();
    const { container } = render(<PlanCardGroup tasks={[parent]} models={[]} />);
    expect(container.querySelector('.plan-usage')?.textContent).toContain('24,800 in · 6,200 out · $0.84 · 10s');
  });

  it('uses the latest attempt and clears an earlier attempt\'s measures', () => {
    render(<TaskCard task={task({ attemptUsage: [usage, { ...usage, attempt: 2, totals: {}, byModel: [], lastPromptTokens: undefined, contextWindow: undefined }] })} models={[]} />);
    expect(screen.getByText(/unknown in/)).toBeDefined();
    expect(screen.queryByText(/12,400 in/)).toBeNull();
  });
});
