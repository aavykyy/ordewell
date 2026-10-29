import { describe, it, expect, vi } from 'vitest';
import * as vscode from 'vscode';
import { orderLabelItems, pickTaskFor } from '../CommandRegistry';
import { createEmptyPlan, createTask } from '@ordewell/core';

describe('orderLabelItems', () => {
  it('labels subtasks with parent-scoped dotted labels in the quickpick', () => {
    const plan = createEmptyPlan();
    plan.tasks = [
      createTask({ id: 't1', order: 1, title: 'Solo' }),
      createTask({
        id: 'p2', order: 2, title: 'Parent',
        subtasks: [
          createTask({ id: 's1', order: 1, title: 'Sub A' }),
          createTask({ id: 's2', order: 2, title: 'Sub B' }),
        ],
      }),
    ];
    const items = orderLabelItems(plan);
    expect(items.map((i) => i.label)).toEqual([
      '1. Solo',
      '2. Parent',
      '2.1. Sub A',
      '2.2. Sub B',
    ]);
    expect(items[2].description).toBe('s1');
  });
});

describe('pickTaskFor', () => {
  const showQuickPick = vscode.window.showQuickPick as unknown as ReturnType<typeof vi.fn>;

  // A failed dependency leaves its dependent stored as pending; its card reads it as blocked and offers Skip.
  it('offers Skip on a task blocked behind a failed dependency, as its card does', async () => {
    const plan = createEmptyPlan();
    plan.tasks = [
      createTask({ id: 't1', order: 1, title: 'Build', status: 'failed' }),
      createTask({ id: 't2', order: 2, title: 'Test', dependencies: ['t1'] }),
      createTask({ id: 't3', order: 3, title: 'Docs' }),
    ];
    showQuickPick.mockReset();
    showQuickPick.mockResolvedValueOnce(undefined);

    await pickTaskFor('skip', plan);

    const items = showQuickPick.mock.calls[0]![0] as { label: string }[];
    expect(items.map((i) => i.label)).toEqual(['1. Build', '2. Test']);
  });
});
