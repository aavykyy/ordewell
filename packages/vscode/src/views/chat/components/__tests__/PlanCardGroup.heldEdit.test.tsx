import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import PlanCardGroup from '../PlanCardGroup';
import type { HeldEdit, RunView, SerializedTask, Task } from '@ordewell/core';
import { EMPTY_RUN } from '@ordewell/core/plan-utils';

/**
 * The planner turn's edit lands when its reply ends (ADR-0029). Until then the
 * plan view lists what it would change, apart from the task cards: proposed,
 * not approved, so nothing in the list can run, retry or edit a task.
 */

const task = (id: string, order: number, title: string): Task => ({
  id, order, title, description: '', type: 'ai', status: 'pending', dependencies: [], subtasks: [], assignedRunner: 'claude-code', taskMode: 'build',
});

const serialized = (t: Task): SerializedTask => ({ ...t, assignedModel: null, prompt: null, userSteps: undefined, autonomy: undefined, sliceType: undefined, userStoriesCovered: undefined, subtasks: [] });

const held: HeldEdit = {
  turnId: 'turn-1',
  tasks: [
    { label: '1', task: serialized(task('t1', 1, 'Write the parser')) },
    { label: '2', mark: 'changed', task: serialized(task('t2', 2, 'Wire the parser into the CLI')) },
    { label: '3', mark: 'removed', task: serialized(task('t3', 3, 'Delete the old lexer')) },
    { label: '4', mark: 'added', task: serialized(task('t4', 4, 'Add a cache')) },
  ],
};

function plan(run: RunView) {
  return render(
    <PlanCardGroup
      run={run}
      tasks={[task('t1', 1, 'Write the parser'), task('t2', 2, 'Wire the CLI'), task('t3', 3, 'Delete the old lexer')]}
      models={[]}
      onExecutePlan={vi.fn()}
      onRunTask={vi.fn()}
      onRetry={vi.fn()}
      onSkip={vi.fn()}
      onRemoveTask={vi.fn()}
      onSplit={vi.fn()}
      onMerge={vi.fn()}
    />,
  );
}

describe('the plan view while the planner turn holds an edit', () => {
  it('lists the proposed tasks, marked, saying they land when the reply ends', () => {
    plan({ ...EMPTY_RUN, heldEdit: held });

    const proposed = screen.getByRole('region', { name: /Proposed/ });
    expect(within(proposed).getByText('Proposed: lands when this reply ends')).toBeTruthy();
    expect(within(proposed).getByText('Add a cache').closest('li')?.getAttribute('data-mark')).toBe('added');
    expect(within(proposed).getByText('Wire the parser into the CLI').closest('li')?.getAttribute('data-mark')).toBe('changed');
    // Struck through, not hidden: the user sees what is going away.
    expect(within(proposed).getByText('Delete the old lexer').closest('s, del')).toBeTruthy();
    // A task the edit leaves alone is not listed again.
    expect(within(proposed).queryByText('Write the parser')).toBeNull();
  });

  it('has no control on a proposed task, and does not promise it will run', () => {
    plan({ ...EMPTY_RUN, heldEdit: held });

    const proposed = screen.getByRole('region', { name: /Proposed/ });
    expect(within(proposed).queryAllByRole('button')).toEqual([]);
    expect(proposed.textContent).not.toMatch(/will run|runs next/i);
  });

  it('is gone once the edit lands or is dropped', () => {
    plan(EMPTY_RUN);

    expect(screen.queryByRole('region', { name: /Proposed/ })).toBeNull();
    expect(screen.queryByText('Add a cache')).toBeNull();
  });
});
