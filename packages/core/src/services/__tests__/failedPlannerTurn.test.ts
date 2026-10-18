import { describe, it, expect, vi } from 'vitest';
import { createTask, type LegacyPlanState, type ResearchProgress } from '../../models/Task';
import { FakeRunnerSession, makeSession, saves, testWorkspace } from './sessionTestKit';
import type { IRunner } from '../../interfaces/IRunner';
import type { ConversationRequest } from '../AiService';
import type { Session } from '../createSession';
import type { PlannerToolHandler } from '../mcp/tools';
import type { SkillInfo } from '../SkillsService';

/** A runner double that records the order tasks were spawned in. */
function recordingRunner(spawned: string[]): IRunner {
  return {
    spawn: vi.fn(async ({ taskId }: { taskId: string }) => {
      spawned.push(taskId);
      return new FakeRunnerSession(`s-${taskId}`, taskId);
    }),
    stop: vi.fn(),
    stopAll: vi.fn(),
    activeCount: 0,
  } as unknown as IRunner;
}

function dialoguePlan(): LegacyPlanState {
  return {
    tasks: [],
    generatedAt: new Date().toISOString(),
    status: 'draft',
    runners: ['claude-code'],
    lastUpdated: new Date().toISOString(),
    conversationHistory: [
      { role: 'user', content: 'build me a parser', timestamp: '2026-01-01T00:00:00Z' },
      { role: 'assistant', content: 'Which file formats?', timestamp: '2026-01-01T00:00:01Z' },
    ],
    researchLog: [
      { id: 'r-1', type: 'user_prompt', content: 'build me a parser', timestamp: '2026-01-01T00:00:00Z' },
    ],
  };
}

/**
 * A plan the scheduler has already run into a pause: one completed AI task, one
 * AI task the user cancelled (on hold) and one pending `user` task. Nothing is
 * live, but `tick()` keeps the scheduler armed so a landed edit can still fan
 * work out — which is how the persist-then-throw scenario below is reached.
 */
function pausedRunPlan(): LegacyPlanState {
  return {
    tasks: [
      createTask({ id: 'a', order: 1, title: 'Setup', prompt: 'p', status: 'completed', assignedRunner: 'claude-code' }),
      createTask({ id: 'b', order: 2, title: 'Build', prompt: 'p', dependencies: ['a'], assignedRunner: 'claude-code' }),
      createTask({ id: 'c', order: 3, title: 'Sign off', type: 'user', dependencies: ['a'], assignedRunner: 'claude-code' }),
    ],
    generatedAt: new Date().toISOString(),
    status: 'approved',
    runners: ['claude-code'],
    lastUpdated: new Date().toISOString(),
    conversationHistory: [
      { role: 'user', content: 'build it', timestamp: '2026-01-01T00:00:00Z' },
      { role: 'assistant', content: 'Plan generated with 3 tasks.', timestamp: '2026-01-01T00:00:01Z', kind: 'plan_generated' },
    ],
    researchLog: [],
  };
}

describe('a planner turn that fails', () => {
  // The transport can reject for reasons unrelated to the session (a model or
  // planner switch leaving the AI adapter mismatched). The user message is
  // held until the turn lands — written, every failed retry would silently
  // diverge session memory from what is on disk / shown.
  it('writes nothing of its own when the AI transport rejects', async () => {
    const session = makeSession({
      aiService: {
        startConversation: vi.fn(),
        continueConversation: vi.fn().mockRejectedValue(new Error('planner transport mismatch')),
        hasActiveConversation: () => true,
        reset: vi.fn(),
      },
    });
    session.loadPlan(dialoguePlan(), 'build me a parser', testWorkspace, { persist: false });

    await expect(session.continueConversation('JSON and YAML')).rejects.toThrow('planner transport mismatch');

    expect(session.planState!.conversationHistory).toHaveLength(2);
    expect(session.planState!.conversationHistory![1].content).toBe('Which file formats?');
    expect(session.planState!.researchLog).toHaveLength(1);
  });

  // `settleTurn` can persist a task_ops turn and only *then* hit a throwing
  // step (the re-tick that fans the edited plan out, via the orchestrator's
  // onTaskChanged observer). The orchestrator isolates a throwing observer
  // from its own scheduling (TaskOrchestrator.emit), so this no longer
  // reaches the caller as a rejection — but the guard this exercises is that
  // the already-persisted, already-broadcast task_ops turn stays regardless.
  it('keeps an already-persisted task_ops turn when the re-tick broadcast fails', async () => {
    const spawned: string[] = [];
    let armed = false;
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const broadcast = vi.fn((msg: { type: string }) => {
      // The mutatePlan notify broadcasts planner_message/plan_generated; only
      // the re-tick's status_update is the "later step" that fails.
      if (armed && msg.type === 'status_update') throw new Error('boom after persist');
    });
    const session = makeSession({
      runner: recordingRunner(spawned),
      broadcast,
      aiService: {
        startConversation: vi.fn(),
        continueConversation: vi.fn().mockResolvedValue({
          kind: 'task_ops',
          ops: [{ op: 'add', task: { title: 'Docs', description: 'write docs', prompt: 'write the docs', dependencies: ['a'] } }],
          text: '', researchLog: [],
        }),
        hasActiveConversation: () => true,
        reset: vi.fn(),
      },
    });
    session.loadPlan(pausedRunPlan(), 'build it', testWorkspace, { persist: false });
    await session.executePlan();
    await session.cancelTask('b');

    armed = true;
    const plan = await session.continueConversation('add a docs task');
    armed = false;

    // 2 pre-call + the user message + the assistant task_ops entry — the
    // persisted turn survives the broadcast failure, and the call itself no
    // longer fails on account of it.
    expect(plan.conversationHistory).toHaveLength(4);
    expect(plan.conversationHistory![3].content).toContain('Tasks updated');
    expect(plan.researchLog).toHaveLength(1);
    expect(errorSpy).toHaveBeenCalled();

    errorSpy.mockRestore();
  });
});

describe('a failed turn after a save of the user\'s during it', () => {
  const skill: SkillInfo = {
    name: 'review-plan', description: 'Review a plan', metadata: { name: 'review-plan', description: 'Review a plan' },
    source: 'global', path: '/skills/review-plan/SKILL.md', content: 'REVIEW BODY', appliesTo: 'planner', modelInvocable: true, userInvocable: false,
  };

  /**
   * A planner that loads a skill and starts a research subagent in its second
   * turn, while VS Code re-adopts the plan — a save no planner turn made —
   * and then fails.
   */
  function failingAfterASave() {
    let tools: PlannerToolHandler | undefined;
    const session: Session = makeSession({
      skillsService: { findSkill: (name: string) => (name === skill.name ? skill : undefined), listSkills: () => [skill] },
      aiService: {
        startConversation: vi.fn(async (req: ConversationRequest) => {
          tools = req.plannerTools?.handler;
          return { kind: 'message' as const, text: 'Which store?', researchLog: [] };
        }),
        continueConversation: vi.fn(async (_message: string, onProgress: (p: ResearchProgress) => void) => {
          await tools!.loadSkill!({ name: skill.name }, { signal: new AbortController().signal });
          onProgress({ type: 'subagent_started', subagentId: 'sa1', brief: 'find the store' });
          onProgress({ type: 'subagent_finished', subagentId: 'sa1', outcome: 'done', digest: 'postgres' });
          session.loadPlan(session.planState!, 'build me a parser', testWorkspace);
          throw new Error('planner transport down');
        }),
        hasActiveConversation: () => true,
        reset: vi.fn(),
      },
    });
    return session;
  }

  it('leaves no planner skill load behind, so none is replayed', async () => {
    const session = failingAfterASave();
    await session.startPlanning('build me a parser', ['claude-code']);

    await expect(session.continueConversation('postgres')).rejects.toThrow('planner transport down');

    expect(session.planState!.conversationHistory!.map((m) => m.content)).toEqual(['build me a parser', 'Which store?']);
    expect(saves(session).mock.calls.at(-1)![0].conversationHistory!.some((m) => m.kind === 'skill_load')).toBe(false);
  });

  it('leaves no research subagent of the turn behind', async () => {
    const session = failingAfterASave();
    await session.startPlanning('build me a parser', ['claude-code']);

    await expect(session.continueConversation('postgres')).rejects.toThrow('planner transport down');

    const subagents = (log: LegacyPlanState['researchLog']) => (log ?? []).filter((e) => 'type' in e && e.type === 'subagent');
    expect(subagents(session.planState!.researchLog)).toEqual([]);
    expect(subagents(saves(session).mock.calls.at(-1)![0].researchLog)).toEqual([]);
  });
});

describe('a failed turn after a task settled during it', () => {
  // A verdict is saved the moment it lands. That save is not the turn landing:
  // it finds nothing of the turn to write, so a turn that then fails leaves no
  // message behind, in memory or on disk.
  it('leaves nothing of the turn in memory or on disk', async () => {
    const live = new Map<string, FakeRunnerSession>();
    const runner = {
      spawn: vi.fn(async ({ taskId }: { taskId: string }) => {
        const s = new FakeRunnerSession(`s-${taskId}`, taskId);
        live.set(taskId, s);
        return s;
      }),
      stop: vi.fn(),
      stopAll: vi.fn(),
      activeCount: 0,
    } as unknown as IRunner;
    let finishTask = (): void => {};
    const session = makeSession({
      runner,
      aiService: {
        startConversation: vi.fn(),
        continueConversation: vi.fn(async () => {
          finishTask();
          await vi.waitFor(() => expect(session.planTasks[0].status).toBe('completed'));
          throw new Error('planner transport down');
        }),
        hasActiveConversation: () => true,
        reset: vi.fn(),
      },
    });
    const plan = dialoguePlan();
    plan.tasks = [createTask({ id: 'a', order: 1, title: 'Setup', prompt: 'p', assignedRunner: 'claude-code' })];
    session.loadPlan(plan, 'build me a parser', testWorkspace, { persist: false });
    await session.executePlan();
    finishTask = () => {
      live.get('a')!.reportComplete({ status: 'done', summary: '' });
      live.get('a')!.emitOutput(`\n`);
      live.get('a')!.emitExit(0);
    };

    await expect(session.continueConversation('JSON and YAML')).rejects.toThrow('planner transport down');

    expect(session.planState!.conversationHistory!.map((m) => m.content)).toEqual(['build me a parser', 'Which file formats?']);
    const onDisk = saves(session).mock.calls.at(-1)![0];
    expect(onDisk.conversationHistory!.map((m) => m.content)).toEqual(['build me a parser', 'Which file formats?']);
    expect(onDisk.tasks[0].status).toBe('completed');
  });
});
