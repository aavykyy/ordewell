import { describe, it, expect } from 'vitest';
import { canSetDependencies, dependencyCandidates, dependentsOf } from '../TaskOps';
import { createTask, type Task } from '../../models/Task';

function chain(): Task[] {
  return [
    createTask({ id: 'a', order: 1, title: 'Setup' }),
    createTask({ id: 'b', order: 2, title: 'Build', dependencies: ['a'] }),
    createTask({ id: 'c', order: 3, title: 'Test', dependencies: ['a', 'b'] }),
  ];
}

describe('dependentsOf', () => {
  it('names the tasks a removal would detach', () => {
    expect(dependentsOf(chain(), 'a').map((t) => t.id)).toEqual(['b', 'c']);
    expect(dependentsOf(chain(), 'b').map((t) => t.id)).toEqual(['c']);
  });

  it('reports nothing for a leaf', () => {
    expect(dependentsOf(chain(), 'c')).toEqual([]);
  });
});

describe('dependencyCandidates', () => {
  it('offers only the tasks displayed before the target', () => {
    expect(dependencyCandidates(chain(), 'c').map((t) => t.id)).toEqual(['a', 'b']);
    expect(dependencyCandidates(chain(), 'a')).toEqual([]);
  });

  it('offers every task for one that does not exist yet', () => {
    expect(dependencyCandidates(chain()).map((t) => t.id)).toEqual(['a', 'b', 'c']);
  });

  it('offers nothing for an unknown id rather than pretending it is new', () => {
    expect(dependencyCandidates(chain(), 'nope')).toEqual([]);
  });
});

describe('canSetDependencies', () => {
  it('accepts a list of earlier tasks', () => {
    expect(canSetDependencies(chain(), 'c', ['a'])).toEqual({ ok: true });
    expect(canSetDependencies(chain(), 'c', [])).toEqual({ ok: true });
  });

  it('rejects a self-reference', () => {
    const result = canSetDependencies(chain(), 'b', ['b']);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/cannot depend on itself/);
  });

  it('rejects a dependency that closes a cycle', () => {
    const result = canSetDependencies(chain(), 'a', ['c']);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/cycle/i);
  });

  it('rejects an id no task has', () => {
    expect(canSetDependencies(chain(), 'c', ['ghost']).error).toMatch(/Unknown dependency/);
  });

  it('rejects an edit to a task that is not in the plan', () => {
    expect(canSetDependencies(chain(), 'ghost', [])).toEqual({ ok: false, error: 'Task not found' });
  });
});

// These literals describe the same graph the planner and direct-edit APIs read.
function branchedPlan(): Task[] {
  return [
    createTask({ id: 'a', order: 1, title: 'A', subtasks: [
      createTask({ id: 'a1', order: 1, title: 'A1' }),
      createTask({ id: 'a2', order: 2, title: 'A2', subtasks: [createTask({ id: 'leaf', order: 1, title: 'Leaf' })] }),
    ] }),
    createTask({ id: 'b', order: 2, title: 'B', subtasks: [createTask({ id: 'b1', order: 1, title: 'B1' })] }),
  ];
}

describe('dependencies across the plan tree', () => {
  it.each([
    ['a', 'b1', true],
    ['a1', 'a2', true],
    ['a1', 'b1', true],
    ['b1', 'a2', true],
    ['a', 'leaf', false],
    ['leaf', 'a', false],
    ['leaf', 'a2', false],
    ['leaf', 'leaf', false],
    ['leaf', 'missing', false],
  ])('%s depending on %s is allowed: %s', (id, dep, allowed) => {
    expect(canSetDependencies(branchedPlan(), id, [dep]).ok).toBe(allowed);
  });

  it('detects a cycle across two branches', () => {
    const tasks = branchedPlan();
    tasks[1].subtasks[0].dependencies = ['a1'];
    expect(canSetDependencies(tasks, 'a1', ['b1'])).toEqual({
      ok: false, error: 'Dependency cycle detected: "A1" → "B1" → "A1"',
    });
  });
});
