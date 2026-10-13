import { describe, it, expect } from 'vitest';
import { createTask } from '../../models/Task';
import { flattenTasksWithParents } from '../../models/Task';
import { findTaskRef, resolveTaskRef, taskOrderLabel, taskRef, taskRefOf, titledTaskRef } from '../TaskRefs';

// Task #1 holds two subtasks, so subtask orders 1 and 2 shadow top-level #1
// and #2 in a flattened plan — the shape every older grammar got wrong.
const plan = [
  createTask({
    id: 'build-id', order: 1, title: 'Build',
    subtasks: [
      createTask({ id: 'lint-id', order: 1, title: 'Lint' }),
      createTask({
        id: 'test-id', order: 2, title: 'Test',
        subtasks: [
          createTask({ id: 'unit-id', order: 1, title: 'Unit' }),
          createTask({ id: 'e2e-id', order: 2, title: 'E2E', subtasks: [createTask({ id: 'smoke-id', order: 1, title: 'Smoke' })] }),
        ],
      }),
    ],
  }),
  createTask({ id: 'deploy-id', order: 2, title: 'Deploy' }),
  createTask({ id: 'docs-id', order: 3, title: '2' }),
];

describe('taskOrderLabel / taskRef / titledTaskRef', () => {
  it.each([
    [{ order: 2 }, undefined, '2', '#2'],
    [{ order: 1 }, { order: 2 }, '2.1', '#2.1'],
  ])('labels %o under %o as %s', (task, parent, label, ref) => {
    expect(taskOrderLabel(task, parent)).toBe(label);
    expect(taskRef(task, parent)).toBe(ref);
  });

  it('names a task in full', () => {
    expect(titledTaskRef({ order: 3, title: 'Deploy' })).toBe('#3 Deploy');
    expect(titledTaskRef({ order: 2, title: 'Test' }, { order: 1 })).toBe('#1.2 Test');
  });
});

describe('resolveTaskRef', () => {
  it.each<[string | number, string | undefined]>([
    ['deploy-id', 'deploy-id'],
    ['test-id', 'test-id'],
    ['  deploy-id  ', 'deploy-id'],
    ['#2', 'deploy-id'],
    ['2', 'deploy-id'],
    [2, 'deploy-id'],
    ['#1', 'build-id'],
    ['#1.2', 'test-id'],
    ['1.1', 'lint-id'],
    ['#2.1', undefined],
    ['#4', undefined],
    ['#1.2.1', 'unit-id'],
    ['1.2.2.1', 'smoke-id'],
    ['#1.1.1', undefined],
    ['#1.2.3', undefined],
    ['#2.1.1', undefined],
    ['#1.2.', undefined],
    ['#1.x', undefined],
    ['#', undefined],
    ['', undefined],
    ['Deploy', 'deploy-id'],
    ['Lint', 'lint-id'],
    ['deploy', undefined],
    ['Nothing', undefined],
  ])('resolves %j to %s', (ref, id) => {
    expect(resolveTaskRef(plan, ref)?.id).toBe(id);
  });

  it('reads a bare number as an order before a title that spells it', () => {
    expect(resolveTaskRef(plan, '2')?.id).toBe('deploy-id');
  });

  it('round-trips every label it renders, at every depth', () => {
    const rows = flattenTasksWithParents(plan);
    expect(rows.map((r) => r.task.id)).toContain('smoke-id');
    for (const { task, ref } of rows) {
      expect(resolveTaskRef(plan, ref)).toBe(task);
      expect(resolveTaskRef(plan, taskRefOf(plan, task.id) ?? '')).toBe(task);
    }
  });

  it('labels a task by its full path below depth 2', () => {
    const smoke = findTaskRef(plan, 'smoke-id');
    expect(smoke?.label).toBe('1.2.2.1');
    expect(taskRefOf(plan, 'unit-id')).toBe('#1.2.1');
    expect(flattenTasksWithParents(plan).find((r) => r.task.id === 'smoke-id')?.ref).toBe('#1.2.2.1');
  });

  it('extends a labelled parent', () => {
    expect(taskRef({ order: 1 }, { order: 2, label: '1.2' })).toBe('#1.2.1');
  });
});
