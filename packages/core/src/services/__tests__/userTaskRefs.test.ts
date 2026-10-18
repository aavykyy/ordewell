import { describe, it, expect } from 'vitest';
import { createTask } from '../../models/Task';
import { makeSession, taskOf, testWorkspace } from './sessionTestKit';

/**
 * The user may name a task by a unique prefix of its id on top of the
 * reference grammar, wherever they type one: the CLI's controls send it to the
 * command seam as typed, so the seam reads it the way the TUI does.
 */

function session() {
  const s = makeSession();
  s.loadPlan({
    tasks: [
      createTask({ id: 'alpha-1', order: 1, title: 'Setup', prompt: 'setup' }),
      createTask({ id: 'alpha-2', order: 2, title: 'Build', prompt: 'build' }),
      createTask({ id: 'beta-3', order: 3, title: 'Docs', prompt: 'docs' }),
    ],
    generatedAt: new Date().toISOString(),
    status: 'approved' as const,
    runners: ['claude-code' as const],
    lastUpdated: new Date().toISOString(),
  }, 'goal', testWorkspace, { persist: false });
  return s;
}

describe('a task named by a unique id prefix', () => {
  it('is the task the user meant, through the command seam', async () => {
    const s = session();

    const outcome = await s.execute({ command: 'skip_task', task: 'bet' }, { kind: 'user' });

    expect(outcome.ok).toBe(true);
    expect(taskOf(s, 'beta-3')?.status).toBe('skipped');
  });

  it('names no task when more than one id starts with it', async () => {
    const s = session();

    const outcome = await s.execute({ command: 'skip_task', task: 'alpha' }, { kind: 'user' });

    expect(outcome).toMatchObject({ ok: false, message: 'There is no task "alpha" in this plan.' });
  });

  it('is not read for the planner, whose references are ids, labels and titles', async () => {
    const s = session();

    const outcome = await s.execute({ command: 'skip_task', task: 'bet' }, { kind: 'planner-turn' });

    expect(outcome.ok).toBe(false);
    expect(taskOf(s, 'beta-3')?.status).not.toBe('skipped');
  });
});
