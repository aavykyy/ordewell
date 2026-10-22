import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { createTask, type LegacyPlanState, type PendingPlanTurn, type Task } from '../../models/Task';
import { loadSession, saveSession } from '../../utils/sessionStore';
import { RUN_SETTINGS_DEFAULTS } from '../SettingsService';
import { FakeRunnerSession, makeSession } from './sessionTestKit';
import type { IRunner } from '../../interfaces/IRunner';

/**
 * Adversarial: a session saved before the per-message research budget was
 * removed still carries its keys on disk. Reopening it must ignore them, run,
 * and write the plan back without them, keeping what is still known.
 */

const task = (over: Partial<Task> = {}): Task => createTask({
  id: 't1', order: 1, title: 'Build it', prompt: 'do t1', assignedRunner: 'claude-code', ...over,
});

/** A plan as the build before the removal wrote it: real settings beside the retired ones. */
function preRemovalPlan(): LegacyPlanState {
  return {
    tasks: [{ ...task(), researchWait: 'a report still owed' } as unknown as Task],
    generatedAt: '2026-10-01T00:00:00Z',
    lastUpdated: '2026-10-01T00:00:00Z',
    status: 'approved',
    runners: ['claude-code'],
    conversationHistory: [
      { role: 'user', content: 'build it', timestamp: '2026-10-01T00:00:00Z' },
      { role: 'assistant', content: 'Plan generated with 1 task.', timestamp: '2026-10-01T00:00:01Z' },
    ],
    researchBudget: { tasks: 2, reports: 1 },
    runSettings: {
      mergeAtGatesAutomatically: false,
      supervisorLevel: 'watch',
      researchMaxParallel: 6,
      researchMaxPerMessage: 5,
    } as unknown as LegacyPlanState['runSettings'],
    pendingTurns: [{
      id: 'queued', source: 'supervisor', text: 'A queued note', timestamp: '2026-10-01T00:00:02Z', budgetStarted: true,
    } as unknown as PendingPlanTurn],
  } as unknown as LegacyPlanState;
}

function sessionsDir(workspace: string): string {
  return join(workspace, '.ordewell', 'sessions');
}

function savedPlan(workspace: string, sessionId: string): Record<string, unknown> {
  for (const file of readdirSync(sessionsDir(workspace))) {
    const saved = JSON.parse(readFileSync(join(sessionsDir(workspace), file), 'utf-8'));
    if (saved.meta?.id === sessionId) return saved.plan;
  }
  throw new Error(`no saved session ${sessionId}`);
}

describe('adversarial: a pre-removal research plan reloads and saves clean', () => {
  let workspace: string;
  beforeEach(() => { workspace = mkdtempSync(join(tmpdir(), 'ordewell-legacy-research-')); });
  afterEach(() => { vi.useRealTimers(); rmSync(workspace, { recursive: true, force: true }); });

  it('ignores the retired keys on load, runs a task and writes the plan back without them', async () => {
    mkdirSync(sessionsDir(workspace), { recursive: true });
    writeFileSync(join(sessionsDir(workspace), 'legacy.json'), JSON.stringify({
      meta: {
        id: 'legacy-research', goal: 'build it', runners: ['claude-code'], taskCount: 1,
        status: 'approved', createdAt: '2026-10-01T00:00:00Z', updatedAt: '2026-10-01T00:00:00Z',
      },
      plan: preRemovalPlan(),
    }));

    const loaded = loadSession('legacy-research', workspace);
    expect(loaded).not.toBeNull();
    const plan = loaded!.plan;
    expect(plan).not.toHaveProperty('researchBudget');
    expect(plan.runSettings).not.toHaveProperty('researchMaxParallel');
    expect(plan.runSettings).not.toHaveProperty('researchMaxPerMessage');
    expect(plan.pendingTurns?.[0]).not.toHaveProperty('budgetStarted');
    expect(plan.tasks[0]).not.toHaveProperty('researchWait');
    expect(plan.runSettings?.supervisorLevel).toBe('watch');

    const sessions: FakeRunnerSession[] = [];
    const runner: IRunner = {
      spawn: vi.fn(async ({ taskId }: Parameters<IRunner['spawn']>[0]) => {
        const started = new FakeRunnerSession(`s${sessions.length + 1}`, taskId);
        sessions.push(started);
        return started;
      }),
      stop: vi.fn(), stopAll: vi.fn(), activeCount: 0,
    };
    const session = makeSession({
      workspaceRoot: () => workspace,
      sessionId: 'legacy-research',
      runner,
      saveSession,
      settings: () => ({ run: { ...RUN_SETTINGS_DEFAULTS, supervisorLevel: 'watch', mergeAtGatesAutomatically: false } }),
    });
    session.loadPlan(plan, 'build it', workspace, { sessionId: 'legacy-research' });
    await session.execute({ command: 'run_plan' }, { kind: 'user' });
    await vi.waitFor(() => expect(sessions).toHaveLength(1));
    sessions[0].reportComplete({ status: 'done', summary: 'done' });
    await vi.waitFor(() => expect(session.planTasks[0].status).toBe('completed'));

    const saved = savedPlan(workspace, 'legacy-research');
    expect(saved).not.toHaveProperty('researchBudget');
    expect(saved.runSettings).toMatchObject({ supervisorLevel: 'watch', mergeAtGatesAutomatically: false });
    expect((saved.runSettings as Record<string, unknown>)).not.toHaveProperty('researchMaxParallel');
    expect((saved.runSettings as Record<string, unknown>)).not.toHaveProperty('researchMaxPerMessage');
    expect((saved.pendingTurns as Array<Record<string, unknown>>)[0]).not.toHaveProperty('budgetStarted');
    expect((saved.tasks as Array<Record<string, unknown>>)[0]).not.toHaveProperty('researchWait');
    expect((saved.tasks as Array<Record<string, unknown>>)[0].status).toBe('completed');
    session.destroy();
  });

  it('drops the dead keys when a pre-removal plan is saved without a load', () => {
    saveSession(preRemovalPlan(), 'build it', workspace, 'direct-save');

    const saved = savedPlan(workspace, 'direct-save');
    expect(saved).not.toHaveProperty('researchBudget');
    expect(saved.runSettings).toEqual({ mergeAtGatesAutomatically: false, supervisorLevel: 'watch' });
    expect(saved.pendingTurns).toEqual([{ id: 'queued', source: 'supervisor', text: 'A queued note', timestamp: '2026-10-01T00:00:02Z' }]);
    expect((saved.tasks as Array<Record<string, unknown>>)[0]).not.toHaveProperty('researchWait');
  });
});
