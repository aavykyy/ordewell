import { describe, it, expect, vi } from 'vitest';
import { createTask, type LegacyPlanState, type Task } from '../../models/Task';
import { makeSession, taskOf, testWorkspace } from './sessionTestKit';
import type { ModelResolver } from '../ModelResolver';

/**
 * Adversarial, round two, on the runner an edit may name (ADR-0001's "the
 * plan is the source of truth"): the first round refused a runner no manifest
 * declares on `addTask` and a runner change. The neighbouring cases: the
 * dedicated `setTaskRunner` entry point, a user task reloaded from a plan that
 * names such a runner and turned into an AI one, and an edit that changes
 * nothing about the assignment.
 */

const CLAUDE_CATALOG = {
  'claude-code': [{ modelId: 'claude-sonnet-4-5', modelLabel: 'Claude Sonnet 4.5', variants: [] }],
};
const resolverFor = (models: unknown) =>
  ({ modelsForRunners: vi.fn().mockResolvedValue(models) }) as unknown as Pick<ModelResolver, 'modelsForRunners'>;

function planWith(tasks: Task[]): LegacyPlanState {
  return {
    tasks,
    generatedAt: new Date().toISOString(),
    status: 'approved' as const,
    runners: ['claude-code' as const],
    lastUpdated: new Date().toISOString(),
  };
}

function session(tasks: Task[]) {
  const s = makeSession({ modelResolver: resolverFor(CLAUDE_CATALOG) });
  s.loadPlan(planWith(tasks), 'goal', testWorkspace, { persist: false });
  return s;
}

describe('adversarial: a runner no manifest declares, named around a direct edit', () => {
  it('is refused by setTaskRunner, the dedicated entry point', async () => {
    const s = session([createTask({ id: 't1', order: 1, title: 'Setup', prompt: 'setup', assignedRunner: 'claude-code' })]);

    await expect(s.setTaskRunner('t1', 'totally-fake-runner' as never)).rejects.toThrow(/totally-fake-runner/);

    expect(taskOf(s, 't1')).toMatchObject({ assignedRunner: 'claude-code' });
    expect(s.planState!.runners).toEqual(['claude-code']);
  });

  it('is refused when a user task reloaded on it is turned into an AI task', async () => {
    const manual = createTask({ id: 'm1', order: 1, title: 'Sign off', type: 'user', assignedRunner: 'legacy-runner' });
    manual.userSteps = [{ order: 1, instruction: 'sign', completed: false }];
    const s = session([manual]);

    await expect(s.updateTask('m1', { type: 'ai', prompt: 'sign it off' })).rejects.toThrow(/legacy-runner/);

    expect(taskOf(s, 'm1')!.type).toBe('user');
    expect(s.planState!.runners).not.toContain('legacy-runner');
  });

  it('still lets an edit that touches no assignment field land on such a reloaded task', async () => {
    const manual = createTask({ id: 'm1', order: 1, title: 'Sign off', type: 'user', assignedRunner: 'legacy-runner' });
    manual.userSteps = [{ order: 1, instruction: 'sign', completed: false }];
    const s = session([manual]);

    const state = await s.updateTask('m1', { title: 'Sign-off check' });

    expect(state).not.toBeNull();
    expect(taskOf(s, 'm1')).toMatchObject({ title: 'Sign-off check', assignedRunner: 'legacy-runner' });
  });

  it('adds no unknown runner to the plan when the add is refused', async () => {
    const s = session([createTask({ id: 't1', order: 1, title: 'Setup', prompt: 'setup', assignedRunner: 'claude-code' })]);

    await expect(s.addTask({ title: 'Docs', prompt: 'docs', assignedRunner: 'another-fake' as never })).rejects.toThrow(/another-fake/);

    expect(s.planState!.tasks).toHaveLength(1);
    expect(s.planState!.runners).toEqual(['claude-code']);
  });
});
