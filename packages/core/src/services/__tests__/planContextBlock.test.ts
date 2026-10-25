import { describe, it, expect, vi } from 'vitest';
import { createTask, type LegacyPlanState, type Task } from '../../models/Task';
import { makeSession } from './sessionTestKit';

describe('the plan block\'s task-shape fields', () => {
  function planWithMixedTasks(): LegacyPlanState {
    return {
      tasks: [
        createTask({
          id: 'ai-1',
          order: 1,
          title: 'Implement thing',
          prompt: 'do it',
          type: 'ai',
          autonomy: 'AFK',
          sliceType: 'AFK',
          taskMode: 'build',
          assignedModel: { modelId: 'sonnet', modelLabel: 'Sonnet', thinkingEffort: 'high' },
        }),
        createTask({
          id: 'man-1',
          order: 2,
          title: 'Manually configure DNS',
          prompt: 'do it',
          type: 'user',
          autonomy: 'HITL',
          sliceType: 'HITL',
          userSteps: [
            { order: 1, instruction: 'Log into registrar', completed: false },
            { order: 2, instruction: 'Add TXT record', completed: false },
          ],
        }),
      ],
      generatedAt: new Date().toISOString(),
      status: 'approved',
      runners: ['claude-code'],
      lastUpdated: new Date().toISOString(),
    };
  }

  it('distinguishes an AI task from a MAN task, and shows step count instead of model/mode for MAN', async () => {
    const continueConversation = vi.fn().mockResolvedValue({ kind: 'message', text: 'ok', researchLog: [] });
    const session = makeSession({
      aiService: {
        continueConversation,
        hasActiveConversation: () => true,
      },
    });
    session.loadPlan(planWithMixedTasks(), 'Test goal', '/repo');

    await session.continueConversation('go on');
    const outgoing = continueConversation.mock.calls[0][0] as string;

    const aiLine = outgoing.split('\n').find((l) => l.includes('id=ai-1'));
    const manLine = outgoing.split('\n').find((l) => l.includes('id=man-1'));

    expect(aiLine).toContain('type:AI');
    expect(aiLine).toContain('autonomy:AFK');
    expect(aiLine).toContain('slice:AFK');
    expect(aiLine).not.toContain('mode:');
    expect(aiLine).not.toContain('read-only');
    expect(aiLine).toContain('effort:high');

    expect(manLine).toContain('type:MAN');
    expect(manLine).toContain('autonomy:HITL');
    expect(manLine).toContain('slice:HITL');
    expect(manLine).toContain('steps:2');
    // Model/mode fields are meaningless for a MAN task and must not appear.
    expect(manLine).not.toContain('mode:');
    expect(manLine).not.toContain('model:');
    // The runner the plan stored for it is nothing a manual task runs on.
    expect(manLine).not.toContain('runner:');
    expect(aiLine).toContain('runner:');
  });

  it('marks a task in its runner\'s read-only mode as read-only', async () => {
    const continueConversation = vi.fn().mockResolvedValue({ kind: 'message', text: 'ok', researchLog: [] });
    const session = makeSession({ aiService: { continueConversation, hasActiveConversation: () => true } });
    const plan = planWithMixedTasks();
    plan.tasks = plan.tasks.map((t) => (t.id === 'ai-1' ? { ...t, taskMode: 'plan' } : t));
    session.loadPlan(plan, 'Test goal', '/repo');

    await session.continueConversation('go on');
    const outgoing = continueConversation.mock.calls[0][0] as string;

    expect(outgoing.split('\n').find((l) => l.includes('id=ai-1'))).toContain(' read-only ');
  });

  it('shows each task\'s status and its dependencies by #order, not just id', async () => {
    const continueConversation = vi.fn().mockResolvedValue({ kind: 'message', text: 'ok', researchLog: [] });
    const session = makeSession({
      aiService: {
        continueConversation,
        hasActiveConversation: () => true,
      },
    });
    const plan = planWithMixedTasks();
    plan.tasks[1].dependencies = ['ai-1'];
    session.loadPlan(plan, 'Test goal', '/repo');

    await session.continueConversation('go on');
    const outgoing = continueConversation.mock.calls[0][0] as string;

    const aiLine = outgoing.split('\n').find((l) => l.includes('id=ai-1'));
    const manLine = outgoing.split('\n').find((l) => l.includes('id=man-1'));

    expect(aiLine).toContain('[pending]');
    expect(manLine).toContain('deps:[#1]');
  });

  describe('why a task cannot start yet, from the scheduler\'s start rule', () => {
    const at = (id: string, order: number, over: Partial<Task> = {}) => createTask({ id, order, title: `Task ${id}`, prompt: 'do it', assignedRunner: 'claude-code', ...over });
    const plan = (approved: boolean): LegacyPlanState => ({
      tasks: [at('t1', 1), at('t2', 2, { dependencies: ['t1'] }), at('t3', 3)],
      generatedAt: new Date().toISOString(), status: approved ? 'approved' : 'draft', runners: ['claude-code'], lastUpdated: new Date().toISOString(),
      ...(approved ? { approvedTasks: ['t1', 't2'] } : {}),
    });
    async function linesOf(approved: boolean): Promise<(id: string) => string> {
      const continueConversation = vi.fn().mockResolvedValue({ kind: 'message', text: 'ok', researchLog: [] });
      const session = makeSession({ aiService: { continueConversation, hasActiveConversation: () => true } });
      session.loadPlan(plan(approved), 'Test goal', '/repo');
      await session.continueConversation('why is nothing running?');
      const lines = (continueConversation.mock.calls[0][0] as string).split('\n');
      return (id) => lines.find((l) => l.includes(`id=${id} `))!;
    }

    it('names the first reason on each line of an approved plan', async () => {
      const line = await linesOf(true);
      expect(line('t1')).not.toContain('waits:');
      expect(line('t2')).toMatch(/ waits:dependencies\[#1\]$/);
      expect(line('t3')).toMatch(/ waits:unapproved$/);
    });

    it('says nothing before the user approves the plan, when nothing of it starts', async () => {
      const line = await linesOf(false);
      for (const id of ['t1', 't2', 't3']) expect(line(id)).not.toContain('waits:');
    });
  });

  it('keeps the per-turn plan block compact — a short suffix per task, not a paragraph, on a large plan', async () => {
    const continueConversation = vi.fn().mockResolvedValue({ kind: 'message', text: 'ok', researchLog: [] });
    const session = makeSession({
      aiService: {
        continueConversation,
        hasActiveConversation: () => true,
      },
    });
    const tasks = Array.from({ length: 40 }, (_, i) =>
      createTask({ id: `t${i + 1}`, order: i + 1, title: `Task ${i + 1}`, prompt: 'do it', assignedRunner: 'claude-code' }),
    );
    session.loadPlan(
      { tasks, generatedAt: new Date().toISOString(), status: 'approved', runners: ['claude-code'], lastUpdated: new Date().toISOString() },
      'Test goal',
      '/repo',
    );

    await session.continueConversation('go on');
    const outgoing = continueConversation.mock.calls[0][0] as string;

    const taskLines = outgoing.split('\n').filter((l) => l.includes('id=t'));
    expect(taskLines).toHaveLength(40);
    // A short scalar-only line per task, not a paragraph — bound generously.
    for (const line of taskLines) expect(line.length).toBeLessThan(200);
  });

  it('advertises every field the applier accepts, including previously-unadvertised ones like type and autonomy', async () => {
    const continueConversation = vi.fn().mockResolvedValue({ kind: 'message', text: 'ok', researchLog: [] });
    const session = makeSession({
      aiService: {
        continueConversation,
        hasActiveConversation: () => true,
      },
    });
    session.loadPlan(planWithMixedTasks(), 'Test goal', '/repo');

    await session.continueConversation('go on');
    const outgoing = continueConversation.mock.calls[0][0] as string;

    for (const field of ['type', 'autonomy', 'sliceType', 'thinkingEffort', 'userSteps', 'taskMode']) {
      expect(outgoing).toContain(`"${field}"`);
    }
  });

  it('lets the planner flip a field the protocol previously failed to advertise (sliceType)', async () => {
    const session = makeSession({
      aiService: {
        continueConversation: vi.fn().mockResolvedValue({
          kind: 'task_ops',
          ops: [{ op: 'update', taskId: 'ai-1', changes: { sliceType: 'HITL' } }],
          text: '{"taskOps":[...]}',
          researchLog: [],
        }),
        hasActiveConversation: () => true,
        reset: vi.fn(),
      },
    });
    session.loadPlan(planWithMixedTasks(), 'Test goal', '/repo', { persist: false });

    await session.continueConversation('flip task 1 to a HITL slice');

    expect(session.planTasks.find((t) => t.id === 'ai-1')!.sliceType).toBe('HITL');
  });
});
