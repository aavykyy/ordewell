import { describe, it, expect, vi } from 'vitest';
import { createTask, type LegacyPlanState, type ResearchProgress } from '../../models/Task';
import { makeSession, saves, FakeRunnerSession } from './sessionTestKit';
import type { IRunner } from '../../interfaces/IRunner';

function savedPlan(tasks = [createTask({ id: 'o1', order: 1, title: 'Other task', prompt: 'do it' })]): LegacyPlanState {
  const now = new Date().toISOString();
  return { tasks, generatedAt: now, status: 'draft', runners: ['claude-code'], lastUpdated: now };
}

describe('the plan scope ends', () => {
  it('when another plan is adopted mid-turn, the turn\'s subagent steps stay out of the adopted plan and its save', async () => {
    let progress: ((p: ResearchProgress) => void) | undefined;
    const session = makeSession({
      aiService: {
        startConversation: vi.fn().mockResolvedValue({ kind: 'message', text: 'hello', researchLog: [] }),
        continueConversation: vi.fn((_message: string, onProgress: (p: ResearchProgress) => void) => {
          progress = onProgress;
          return new Promise<never>(() => {});
        }),
        hasActiveConversation: () => true,
      },
    });
    await session.startPlanning('first goal', ['claude-code']);
    void session.continueConversation('research the cache').catch(() => {});
    await vi.waitFor(() => expect(progress).toBeDefined());
    progress!({ type: 'subagent_started', subagentId: 'sa1', brief: 'find the cache' });

    const adopted = savedPlan();
    session.loadPlan(adopted, 'other goal', '/repo', { sessionId: 'other' });

    expect(adopted.researchLog ?? []).toEqual([]);
    const otherSaves = saves(session).mock.calls.filter(([, , , id]) => id === 'other');
    expect(otherSaves.length).toBeGreaterThan(0);
    for (const [plan] of otherSaves) expect(plan.researchLog ?? []).toEqual([]);
  });

  it('when another plan is adopted mid-run, the run stops with it: no agent of the old plan is left running', async () => {
    const runner = {
      spawn: vi.fn(async ({ taskId }: Parameters<IRunner['spawn']>[0]) => new FakeRunnerSession(`s-${taskId}`, taskId)),
      stop: vi.fn(),
      stopAll: vi.fn(),
      activeCount: 0,
    } satisfies IRunner;
    const session = makeSession({ runner });
    session.loadPlan({ ...savedPlan([createTask({ id: 't1', order: 1, title: 'Task 1', prompt: 'do it' })]), status: 'approved' }, 'first goal', '/repo');
    await session.executePlan();
    await vi.waitFor(() => expect(session.isExecuting).toBe(true));
    runner.stopAll.mockClear();

    session.loadPlan(savedPlan(), 'other goal', '/repo', { sessionId: 'other' });

    expect(runner.stopAll).toHaveBeenCalled();
    expect(session.isExecuting).toBe(false);
  });
});
