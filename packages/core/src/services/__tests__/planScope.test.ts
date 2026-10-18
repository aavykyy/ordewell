import { describe, it, expect, vi } from 'vitest';
import { createTask, type LegacyPlanState, type ResearchProgress } from '../../models/Task';
import { makeSession, saves, FakeRunnerSession } from './sessionTestKit';
import type { IRunner } from '../../interfaces/IRunner';
import type { ConversationTurn } from '../AiService';

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

  // A research subagent the abandoned turn started reports back as it stops,
  // with its partial findings, after the adopt: the next save is the adopted
  // plan's, here the one a message sent to it makes before its turn opens.
  it('when another plan is adopted mid-turn, a subagent of the turn that finishes afterwards stays out of the adopted plan', async () => {
    let progress: ((p: ResearchProgress) => void) | undefined;
    const session = makeSession({
      aiService: {
        startConversation: vi.fn().mockResolvedValue({ kind: 'message', text: 'hello', researchLog: [] }),
        continueConversation: vi.fn((_message: string, onProgress: (p: ResearchProgress) => void, signal?: AbortSignal): Promise<ConversationTurn> => {
          if (progress) return Promise.resolve({ kind: 'message', text: 'answered', researchLog: [] });
          progress = onProgress;
          return new Promise<never>(() => {
            signal?.addEventListener('abort', () => onProgress({ type: 'subagent_finished', subagentId: 'sa1', outcome: 'stopped', digest: 'partial findings' }));
          });
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
    await session.continueConversation('hello again');

    const otherSaves = saves(session).mock.calls.filter(([, , , id]) => id === 'other');
    for (const [plan] of otherSaves) expect((plan.researchLog ?? []).filter((e) => 'type' in e && e.type === 'subagent')).toEqual([]);
    expect((adopted.researchLog ?? []).filter((e) => 'type' in e && e.type === 'subagent')).toEqual([]);
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
    await session.execute({ command: 'run_plan' }, { kind: 'user' });
    await vi.waitFor(() => expect(session.isExecuting).toBe(true));
    runner.stopAll.mockClear();

    session.loadPlan(savedPlan(), 'other goal', '/repo', { sessionId: 'other' });

    expect(runner.stopAll).toHaveBeenCalled();
    expect(session.isExecuting).toBe(false);
  });

  it('when another plan is adopted after a run ended on a failure, nothing of that run carries over', async () => {
    const runner = {
      spawn: vi.fn(async ({ taskId }: Parameters<IRunner['spawn']>[0]) => new FakeRunnerSession(`s-${taskId}`, taskId)),
      stop: vi.fn(),
      stopAll: vi.fn(),
      activeCount: 0,
    } satisfies IRunner;
    const broadcast = vi.fn();
    const session = makeSession({ runner, broadcast });
    session.loadPlan({ ...savedPlan([createTask({ id: 't1', order: 1, title: 'Task 1', prompt: 'do it' })]), status: 'approved' }, 'first goal', '/repo');
    await session.execute({ command: 'run_plan' }, { kind: 'user' });
    await vi.waitFor(() => expect(runner.spawn).toHaveBeenCalled());
    (await runner.spawn.mock.results[0].value).reportComplete({ status: 'failed', summary: '', reason: 'broke' });
    await vi.waitFor(() => expect(session.isExecuting).toBe(false));

    session.loadPlan({ ...savedPlan(), status: 'approved' }, 'other goal', '/repo', { sessionId: 'other' });
    broadcast.mockClear();
    runner.spawn.mockClear();
    await session.reschedule();

    expect(broadcast.mock.calls.map(([m]) => m.type)).not.toContain('review_needed');
    expect(runner.spawn).not.toHaveBeenCalled();
    expect(session.status).toBe('approved');
  });
});
