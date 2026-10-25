import { describe, it, expect, vi } from 'vitest';
import { applyTaskOps } from '../TaskOps';
import { resolveAssignment, type AssignmentCatalog } from '../TaskAssignment';
import { createTask, type Task } from '../../models/Task';
import { makeSession, saves, taskOf, testWorkspace } from './sessionTestKit';
import type { ModelResolver } from '../ModelResolver';
import { RUN_SETTINGS_DEFAULTS } from '../SettingsService';

const model = (modelId: string, ...levels: string[]) =>
  ({ modelId, modelLabel: modelId.toUpperCase(), variants: levels.map((id) => ({ id, label: id })) });

const CATALOG: AssignmentCatalog = {
  modelsByRunner: {
    'claude-code': [model('claude-sonnet-4-5', 'low', 'high'), model('claude-haiku-4-5')],
    codex: [model('gpt-5-codex', 'low', 'high')],
  },
  runnerModes: {
    'claude-code': [
      { id: 'acceptEdits', label: 'Edit', description: 'edits' },
      { id: 'bypassPermissions', label: 'Bypass', description: 'all', autonomous: true },
      { id: 'plan', label: 'Plan', description: 'read only', readOnly: true },
    ],
    codex: [
      { id: 'agent', label: 'Agent', description: 'sandbox', safe: true },
      { id: 'fullAccess', label: 'Full access', description: 'all', autonomous: true },
      { id: 'inspect', label: 'Inspect', description: 'read only', readOnly: true },
    ],
  },
};

function task(over: Partial<Task> = {}): Task {
  return createTask({ id: 't1', title: 'Setup', prompt: 'do it', assignedRunner: 'claude-code', ...over });
}

describe('adversarial: the live-runner hold reaches the planner\'s edit batch', () => {
  const live: AssignmentCatalog['liveRunner'] = (id) => id === 't1';

  it('refuses a model change on a task whose runner is live but which has not started', () => {
    // The planner lock only reads status; a claimed-but-pending task is what the live hold is for.
    const result = applyTaskOps([task()], [
      { op: 'update', taskId: 't1', changes: { assignedModel: { modelId: 'claude-haiku-4-5', modelLabel: 'Haiku' } } },
    ], ['claude-code'], { ...CATALOG, liveRunner: live });
    expect(result.ok).toBe(false);
    expect(result.errors[0]).toMatch(/has a live runner, so its model and effort cannot change now/);
  });

  it('refuses moving a live task to another runner', () => {
    const result = applyTaskOps([task()], [
      { op: 'update', taskId: 't1', changes: { assignedRunner: 'codex' } },
    ], ['claude-code', 'codex'], { ...CATALOG, liveRunner: live });
    expect(result.ok).toBe(false);
    expect(result.errors[0]).toMatch(/has a live runner, so its runner cannot change now/);
  });

  it('still lands an edit that does not touch the assignment', () => {
    const result = applyTaskOps([task()], [
      { op: 'update', taskId: 't1', changes: { title: 'Renamed' } },
    ], ['claude-code'], { ...CATALOG, liveRunner: live });
    expect(result.ok).toBe(true);
  });
});

describe('adversarial: merge and split parts naming only a runner', () => {
  const claude = () => task({ id: 'm1', title: 'First', assignedModel: { modelId: 'claude-sonnet-4-5', modelLabel: 'Sonnet', thinkingEffort: 'high' }, taskMode: 'acceptEdits' });

  it('a merge onto another runner takes that runner\'s model, effort and mode, and says so', () => {
    const result = applyTaskOps([claude(), task({ id: 'm2', order: 2, title: 'Second' })], [
      { op: 'merge', taskIds: ['m1', 'm2'], merged: { title: 'Merged', prompt: 'both', assignedRunner: 'codex' } },
    ], ['claude-code', 'codex'], CATALOG);
    expect(result.ok).toBe(true);
    const merged = result.tasks.find((t) => t.title === 'Merged')!;
    expect(merged).toMatchObject({ assignedRunner: 'codex', assignedModel: { modelId: 'gpt-5-codex' }, taskMode: 'agent' });
    expect(result.adjustments?.map((a) => [a.field, a.from, a.to])).toContainEqual(['assignedModel', 'claude-sonnet-4-5', 'gpt-5-codex']);
  });

  it('a split part naming another runner is refilled from it; the part that names none keeps its model', () => {
    const result = applyTaskOps([claude()], [
      { op: 'split', taskId: 'm1', parts: [
        { title: 'Part one', prompt: 'one', assignedRunner: 'codex' },
        { title: 'Part two', prompt: 'two' },
      ] },
    ], ['claude-code', 'codex'], CATALOG);
    expect(result.ok).toBe(true);
    const [one, two] = result.tasks;
    expect(one).toMatchObject({ assignedRunner: 'codex', assignedModel: { modelId: 'gpt-5-codex' } });
    expect(two).toMatchObject({ assignedRunner: 'claude-code', assignedModel: { modelId: 'claude-sonnet-4-5' } });
    // 'high' is a level gpt-5-codex also offers, so only the model moved.
    expect(result.adjustments?.map((a) => a.field)).toEqual(['assignedModel']);
  });
});

describe('adversarial: a submitted plan pairing a model with the wrong runner', () => {
  it('refills a new task whose model only another runner lists, and names it', () => {
    const stray = task({ id: 'new1', title: 'New', assignedRunner: 'codex', assignedModel: { modelId: 'claude-sonnet-4-5', modelLabel: 'Sonnet', thinkingEffort: 'low' } });
    const outcome = resolveAssignment({ writer: 'plan', task: stray, catalog: CATALOG });
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.task.assignedModel).toMatchObject({ modelId: 'gpt-5-codex' });
      // 'low' is a level gpt-5-codex also offers, so only the model moved.
      expect(outcome.adjustments.map((a) => [a.field, a.from, a.to])).toEqual([
        ['assignedModel', 'claude-sonnet-4-5', 'gpt-5-codex'],
      ]);
    }
  });

  it('refuses the same pairing for a planner edit', () => {
    const before = task();
    const outcome = resolveAssignment({
      writer: 'edit',
      task: { ...before, assignedModel: { modelId: 'gpt-5-codex', modelLabel: 'GPT' } },
      before,
      catalog: CATALOG,
    });
    expect(outcome).toMatchObject({ ok: false, field: 'assignedModel' });
  });
});

describe('adversarial: a manual task turned into an AI one by a planner update', () => {
  it('derives the mode and fills the model the planner path would', () => {
    const manual = task({ id: 'm1', title: 'Sign off', type: 'user', userSteps: [{ order: 1, instruction: 'sign', completed: false }], assignedRunner: 'codex' });
    const result = applyTaskOps([manual], [
      { op: 'update', taskId: 'm1', changes: { type: 'ai', prompt: 'sign it off' } },
    ], ['claude-code', 'codex'], CATALOG);
    expect(result.ok).toBe(true);
    expect(result.tasks[0]).toMatchObject({ type: 'ai', taskMode: 'agent', assignedModel: { modelId: 'gpt-5-codex' } });
  });

  it('lifting read-only re-derives the mode off the read-only one', () => {
    const readOnly = task({ taskMode: 'plan' });
    const result = applyTaskOps([readOnly], [
      { op: 'update', taskId: 't1', changes: { readOnly: false } },
    ], ['claude-code'], CATALOG);
    expect(result.ok).toBe(true);
    expect(result.tasks[0].taskMode).toBe('bypassPermissions');
  });

  it('says nothing of an adjustment to a task a later op removed', () => {
    const result = applyTaskOps([task()], [
      { op: 'update', taskId: 't1', changes: { assignedModel: { modelId: 'claude-haiku-4-5', modelLabel: 'Haiku' } } },
      { op: 'remove', taskId: 't1' },
    ], ['claude-code'], CATALOG);
    expect(result.ok).toBe(true);
    expect(result.adjustments).toEqual([]);
  });
});

describe('adversarial: a user-added task with a model off the allowlist (session)', () => {
  const CLAUDE_CATALOG = {
    'claude-code': [
      { modelId: 'claude-sonnet-4-5', modelLabel: 'Claude Sonnet 4.5', variants: [{ id: 'low', label: 'Low' }] },
      { modelId: 'claude-haiku-4-5', modelLabel: 'Claude Haiku 4.5', variants: [] },
    ],
  };
  const resolverFor = (models: unknown) =>
    ({ modelsForRunners: vi.fn().mockResolvedValue(models) }) as unknown as Pick<ModelResolver, 'modelsForRunners'>;

  function planWith() {
    return {
      tasks: [createTask({ id: 't1', order: 1, title: 'Setup', prompt: 'setup', assignedRunner: 'claude-code' })],
      generatedAt: new Date().toISOString(),
      status: 'approved' as const,
      runners: ['claude-code' as const],
      lastUpdated: new Date().toISOString(),
    };
  }

  it('is replaced, its effort carried, and the user told', async () => {
    const onNotice = vi.fn();
    const session = makeSession({
      modelResolver: resolverFor(CLAUDE_CATALOG),
      onNotice,
      settings: () => ({ run: { ...RUN_SETTINGS_DEFAULTS, supervisorLevel: 'off' }, modelAllowlist: { 'claude-code': ['claude-haiku-4-5'] } }),
    });
    session.loadPlan(planWith(), 'goal', testWorkspace, { persist: false });

    await session.addTask({ title: 'Docs', prompt: 'write docs', assignedModel: { modelId: 'claude-sonnet-4-5', modelLabel: 'Sonnet', thinkingEffort: 'low' } });

    const added = session.planTasks.at(-1)!;
    expect(added.assignedModel).toMatchObject({ modelId: 'claude-haiku-4-5' });
    expect(onNotice).toHaveBeenCalledWith(expect.objectContaining({
      level: 'info',
      message: expect.stringContaining('Task "Docs": model claude-sonnet-4-5 → claude-haiku-4-5'),
    }));
  });

  it('refuses a runner no manifest declares, as every planner route does', async () => {
    const session = makeSession({ modelResolver: resolverFor(CLAUDE_CATALOG) });
    session.loadPlan(planWith(), 'goal', testWorkspace, { persist: false });

    await expect(session.updateTask('t1', { assignedRunner: 'totally-fake-runner' as never })).rejects.toThrow(/totally-fake-runner/);
    await expect(session.addTask({ title: 'Docs', assignedRunner: 'another-fake' as never })).rejects.toThrow(/another-fake/);
    expect(session.planState!.runners).toEqual(['claude-code']);
  });
});

describe('adversarial: a runner change sent with other fields lands as one save (session)', () => {
  const CLAUDE_CATALOG = {
    'claude-code': [
      { modelId: 'claude-sonnet-4-5', modelLabel: 'Claude Sonnet 4.5', variants: [{ id: 'low', label: 'Low' }, { id: 'high', label: 'High' }] },
    ],
    codex: [{ modelId: 'gpt-5-codex', modelLabel: 'GPT-5 Codex', variants: [] }],
  };
  const resolverFor = (models: unknown) =>
    ({ modelsForRunners: vi.fn().mockResolvedValue(models) }) as unknown as Pick<ModelResolver, 'modelsForRunners'>;

  function planWith() {
    return {
      tasks: [
        createTask({ id: 't1', order: 1, title: 'Setup', prompt: 'setup', assignedRunner: 'claude-code' }),
        createTask({ id: 't2', order: 2, title: 'Build', prompt: 'build', assignedRunner: 'claude-code', dependencies: ['t1'] }),
      ],
      generatedAt: new Date().toISOString(),
      status: 'approved' as const,
      runners: ['claude-code' as const],
      lastUpdated: new Date().toISOString(),
    };
  }

  it('lands the whole patch together and saves once', async () => {
    const session = makeSession({ modelResolver: resolverFor(CLAUDE_CATALOG) });
    session.loadPlan(planWith(), 'goal', testWorkspace, { persist: false });

    const state = await session.updateTask('t1', { assignedRunner: 'codex', dependencies: [], title: 'Set up' });

    expect(state).not.toBeNull();
    expect(taskOf(session, 't1')).toMatchObject({ assignedRunner: 'codex', title: 'Set up', dependencies: [], taskMode: 'fullAccess' });
    expect(saves(session)).toHaveBeenCalledTimes(1);
  });

  it('keeps a model named beside the runner change when the new runner offers it', async () => {
    const session = makeSession({ modelResolver: resolverFor(CLAUDE_CATALOG) });
    session.loadPlan(planWith(), 'goal', testWorkspace, { persist: false });

    await session.updateTask('t1', { assignedRunner: 'codex', assignedModel: { modelId: 'gpt-5-codex', modelLabel: 'GPT-5 Codex' } });

    expect(taskOf(session, 't1')).toMatchObject({ assignedRunner: 'codex', assignedModel: { modelId: 'gpt-5-codex' } });
  });
});
