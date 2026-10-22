import { describe, it, expect } from 'vitest';
import { readableTaskIds } from '../Handoff';
import { createTask } from '../Task';

describe('the tasks a task may read (ADR-0047)', () => {
  // setup ← build ← check ⇄ fix (the check's loop body), docs beside them, and a subtask under build.
  const plan = [
    createTask({ id: 'setup', order: 1 }),
    createTask({ id: 'build', order: 2, dependencies: ['setup'], subtasks: [createTask({ id: 'build.1', order: 1, dependencies: ['setup'] })] }),
    createTask({ id: 'check', order: 3, dependencies: ['build'], loop: { body: ['fix'], maxRounds: 3 } }),
    createTask({ id: 'fix', order: 4, dependencies: ['check'] }),
    createTask({ id: 'docs', order: 5 }),
  ];

  it('is the task itself and its dependencies, followed all the way back', () => {
    expect([...readableTaskIds(plan, 'check')].sort()).toEqual(['build', 'check', 'fix', 'setup']);
  });

  it('reaches a loop\'s other end both ways: a check its body, and a body task its check', () => {
    expect(readableTaskIds(plan, 'check').has('fix')).toBe(true);
    expect([...readableTaskIds(plan, 'fix')].sort()).toEqual(['build', 'check', 'fix', 'setup']);
  });

  it('leaves out a task the graph never gave it, a subtask\'s own dependencies counted', () => {
    expect([...readableTaskIds(plan, 'docs')]).toEqual(['docs']);
    expect([...readableTaskIds(plan, 'build.1')].sort()).toEqual(['build.1', 'setup']);
  });
});
