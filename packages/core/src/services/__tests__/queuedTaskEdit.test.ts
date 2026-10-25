import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeConfig, makeSession, saves } from './sessionTestKit';
import { NOW, plan, recordingRunner, task, until } from './supervisorTestKit';
import type { DiscoveredModel, RunnerId } from '../../models/Task';

const model = (modelId: string, variants: string[] = []): DiscoveredModel =>
  ({ modelId, modelLabel: modelId, variants: variants.map((id) => ({ id, label: id })) });

const MODELS: Partial<Record<RunnerId, DiscoveredModel[]>> = {
  'claude-code': [model('claude-sonnet-4-5', ['low', 'high'])],
  codex: [model('gpt-5-codex', ['low', 'high'])],
};

beforeEach(() => {
  vi.useFakeTimers({ now: NOW, toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
});

afterEach(() => {
  vi.useRealTimers();
});

/**
 * A run where one task is at work and the next waits on it, so a card edit
 * lands between the task being queued and the scheduler's claim — the window
 * the card's narrower precondition exists for.
 */
async function runningSession() {
  const run = recordingRunner();
  const session = makeSession({
    runner: run.runner,
    config: fakeConfig({ maxParallelSessions: 1 }),
    modelResolver: {
      modelsForRunners: async (runners: RunnerId[]) => Object.fromEntries(runners.map((r) => [r, MODELS[r] ?? []])),
      getCachedRunnerModels: () => [],
      contextWindowFor: () => undefined,
    },
  });
  const draft = plan([
    task('t1', 1),
    task('t2', 2, { dependencies: ['t1'], prompt: 'do t2' }),
  ]);
  session.loadPlan(draft, 'build it', process.cwd());
  await session.execute({ command: 'run_plan' }, { kind: 'user' });
  return { session, run };
}

describe('an edit to a queued task while the plan runs', () => {
  it('is what the claim starts, and what the next save holds', async () => {
    const { session, run } = await runningSession();
    expect(run.spawnedIds()).toEqual(['t1']);

    await session.updateTask('t2', {
      assignedRunner: 'codex',
      assignedModel: { modelId: 'gpt-5-codex', modelLabel: 'GPT-5 Codex', thinkingEffort: 'high' },
      prompt: 'do t2, with the cache',
    }, { requireUnstarted: true });

    run.of('t1').reportComplete({ status: 'done', summary: '' });
    await until(() => run.spawnedIds().includes('t2'));

    const spawned = run.runner.spawn.mock.calls.find(([opts]) => opts.taskId === 't2')![0];
    expect(spawned).toMatchObject({
      runner: 'codex',
      modelId: 'gpt-5-codex',
      thinkingEffort: 'high',
      prompt: expect.stringContaining('do t2, with the cache'),
    });
    expect(saves(session).mock.lastCall![0].tasks.find((saved) => saved.id === 't2')).toMatchObject({
      assignedRunner: 'codex',
      assignedModel: { modelId: 'gpt-5-codex', thinkingEffort: 'high' },
      prompt: 'do t2, with the cache',
    });

    const reloaded = makeSession();
    reloaded.loadPlan(structuredClone(saves(session).mock.lastCall![0]), 'build it', process.cwd());
    expect(reloaded.planTasks.find((saved) => saved.id === 't2')).toMatchObject({
      assignedRunner: 'codex',
      assignedModel: { modelId: 'gpt-5-codex', thinkingEffort: 'high' },
      prompt: 'do t2, with the cache',
    });
  });

  it('is refused once the task is live, leaving its attempt and stored values alone', async () => {
    const { session, run } = await runningSession();
    const before = session.planTasks.find((t) => t.id === 't1')!;

    await expect(session.updateTask('t1', { prompt: 'rewrite the running task' }, { requireUnstarted: true }))
      .rejects.toThrow(/"Task t1" started before this change was saved/);

    expect(session.planTasks.find((t) => t.id === 't1')).toMatchObject({ status: before.status, prompt: before.prompt });
    expect(run.spawnedIds()).toEqual(['t1']);
    expect(run.of('t1')).toBeDefined();
  });
});
