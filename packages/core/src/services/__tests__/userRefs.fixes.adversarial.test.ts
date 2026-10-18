import { describe, it, expect } from 'vitest';
import { createTask, type Task } from '../../models/Task';
import { makeSession, taskOf, testWorkspace } from './sessionTestKit';

/**
 * Adversarial, round two, on the reference grammar the seam reads for the
 * user (ADR-0029): the first round added the unique id prefix. The
 * neighbouring references the grammar admits — a dotted subtask path, a
 * title, a full id — must keep working through the same path, and a nested
 * task's id must be prefix-matchable at its depth.
 */

const subtask = (id: string, order: number, title: string, over: Partial<Task> = {}): Task =>
  createTask({ id, order, title, prompt: title, ...over });

function session() {
  const s = makeSession();
  s.loadPlan({
    tasks: [
      createTask({
        id: 'build-1', order: 1, title: 'Build', prompt: 'build',
        subtasks: [
          subtask('draft-1a', 1, 'Draft'),
          subtask('review-1b', 2, 'Review', { dependencies: ['draft-1a'] }),
        ],
      }),
      createTask({ id: 'ship-2', order: 2, title: 'Ship', prompt: 'ship' }),
    ],
    generatedAt: new Date().toISOString(),
    status: 'approved' as const,
    runners: ['claude-code' as const],
    lastUpdated: new Date().toISOString(),
  }, 'goal', testWorkspace, { persist: false });
  return s;
}

describe('adversarial: the seam reads every reference the grammar admits', () => {
  it('resolves a dotted subtask path, a title and a full id as the user', async () => {
    expect((await session().execute({ command: 'skip_task', task: '#1.2' }, { kind: 'user' })).ok).toBe(true);

    const titled = session();
    expect((await titled.execute({ command: 'skip_task', task: 'Ship' }, { kind: 'user' })).ok).toBe(true);
    expect(taskOf(titled, 'ship-2')?.status).toBe('skipped');

    const byId = session();
    expect((await byId.execute({ command: 'skip_task', task: 'ship-2' }, { kind: 'user' })).ok).toBe(true);
    expect(taskOf(byId, 'ship-2')?.status).toBe('skipped');
  });

  it('resolves a unique prefix of a nested task\'s id, not only a top-level one', async () => {
    const s = session();

    const outcome = await s.execute({ command: 'skip_task', task: 'review' }, { kind: 'user' });

    expect(outcome.ok).toBe(true);
    expect(taskOf(s, 'review-1b')?.status).toBe('skipped');
    expect(taskOf(s, 'draft-1a')?.status).toBe('pending');
  });
});
