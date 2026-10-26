import { describe, it, expect, vi } from 'vitest';
import { createTask, type DiscoveredModel } from '../../models/Task';
import type { SessionRuntimeSettings } from '../createSession';
import { makeSession } from './sessionTestKit';

const models = (...ids: string[]): DiscoveredModel[] => ids.map((modelId) => ({ modelId, modelLabel: modelId, variants: [] }));
const ops = (list: unknown[]) => ({ kind: 'task_ops', ops: list, text: '{"taskOps":[...]}', researchLog: [] });

/**
 * A plan built while Codex was enabled, its first task on Codex, then Codex
 * switched off by a settings write (the enabled list is right: no toggle
 * defect is involved). `reply` is the planner's next turn, as an API planner's
 * task_ops reply, which lands through the session's PlanChangeCheck.
 */
async function planOnceOnCodex(reply: unknown, continueConversation = vi.fn()) {
  let settings: SessionRuntimeSettings = { enabledRunners: ['codex', 'claude-code', 'opencode'] };
  continueConversation.mockResolvedValueOnce(reply);
  continueConversation.mockResolvedValue({ kind: 'message', text: 'ok', researchLog: [] });
  const session = makeSession({
    aiService: {
      startConversation: vi.fn().mockResolvedValue({
        kind: 'plan',
        tasks: [
          createTask({ id: 't1', order: 1, title: 'On codex', prompt: 'p', assignedRunner: 'codex', assignedModel: { modelId: 'gpt-5', modelLabel: 'gpt-5' } }),
          createTask({ id: 't2', order: 2, title: 'On claude', prompt: 'p', assignedRunner: 'claude-code', assignedModel: { modelId: 'sonnet', modelLabel: 'sonnet' } }),
        ],
        text: '',
        researchLog: [],
      }),
      continueConversation,
      hasActiveConversation: () => true,
    },
    modelResolver: {
      modelsForRunners: vi.fn(async (runners: string[]) => Object.fromEntries(runners.map((r) => [r, models(r === 'codex' ? 'gpt-5' : r === 'claude-code' ? 'sonnet' : 'kimi')]))),
    },
    settings: () => settings,
  });
  await session.startPlanning('goal', ['codex', 'claude-code']);
  settings = { ...settings, enabledRunners: ['claude-code', 'opencode'] };
  return session;
}

describe('a planner edit after Codex is switched off, Codex being only in the plan\'s history', () => {
  it('does not add a task on Codex', async () => {
    const session = await planOnceOnCodex(ops([{ op: 'add', task: { title: 'New', assignedRunner: 'codex' } }]));
    const runners = session.planState!.runners;
    await session.continueConversation('add one');
    expect(runners).toContain('codex');
    expect(session.planTasks.map((t) => [t.title, t.assignedRunner])).not.toContainEqual(['New', 'codex']);
  });

  it('does not put a task that names no runner on Codex, the plan\'s first runner', async () => {
    const session = await planOnceOnCodex(ops([{ op: 'add', task: { title: 'New' } }]));
    await session.continueConversation('add one');
    expect(session.planTasks.find((t) => t.title === 'New')?.assignedRunner).not.toBe('codex');
  });

  it('does not move a task onto Codex', async () => {
    const session = await planOnceOnCodex(ops([{ op: 'update', taskId: 't2', changes: { assignedRunner: 'codex' } }]));
    await session.continueConversation('move it');
    expect(session.planTasks.find((t) => t.id === 't2')?.assignedRunner).toBe('claude-code');
  });

  it('still lands an edit of the Codex task that leaves its runner alone', async () => {
    const session = await planOnceOnCodex(ops([{ op: 'update', taskId: 't1', changes: { title: 'Renamed' } }]));
    await session.continueConversation('rename');
    expect(session.planTasks.find((t) => t.id === 't1')).toMatchObject({ title: 'Renamed', assignedRunner: 'codex' });
  });

  it('names the runners it may use when it refuses, and leaves the plan as it was', async () => {
    const planner = vi.fn();
    const session = await planOnceOnCodex(ops([{ op: 'add', task: { title: 'New', assignedRunner: 'codex' } }]), planner);
    const before = session.planTasks.map((t) => [t.id, t.title, t.assignedRunner]);
    await session.continueConversation('add one');
    expect(session.planTasks.map((t) => [t.id, t.title, t.assignedRunner])).toEqual(before);
    // The refusal goes back to the planner as its corrective turn.
    expect(String(planner.mock.calls[1]?.[0])).toMatch(/Expected one of: claude-code, opencode/);
  });

  it('does not put a subtask on Codex', async () => {
    const session = await planOnceOnCodex(ops([{ op: 'add', task: { title: 'New', assignedRunner: 'claude-code', subtasks: [{ title: 'Child', type: 'ai', sliceType: 'AFK', autonomy: 'AFK' }] } }]));
    await session.continueConversation('add one');
    expect(session.planTasks.flatMap((t) => [t, ...t.subtasks]).filter((t) => t.title === 'New' || t.title === 'Child').map((t) => t.assignedRunner)).not.toContain('codex');
  });

  it('does not split the Codex task into parts that stay on Codex', async () => {
    const session = await planOnceOnCodex(ops([{ op: 'split', taskId: 't1', parts: [{ title: 'One' }, { title: 'Two' }] }]));
    await session.continueConversation('split it');
    expect(session.planTasks.filter((t) => t.title === 'One' || t.title === 'Two').map((t) => t.assignedRunner)).not.toContain('codex');
  });

  it('still moves the Codex task off Codex, and removes it', async () => {
    const moved = await planOnceOnCodex(ops([{ op: 'update', taskId: 't1', changes: { assignedRunner: 'opencode', assignedModel: { modelId: 'kimi', modelLabel: 'kimi' } } }]));
    await moved.continueConversation('move it');
    expect(moved.planTasks.find((t) => t.id === 't1')?.assignedRunner).toBe('opencode');

    const removed = await planOnceOnCodex(ops([{ op: 'remove', taskId: 't1' }]));
    await removed.continueConversation('drop it');
    expect(removed.planTasks.map((t) => t.id)).toEqual(['t2']);
  });

  it('still lands a prompt edit on the Codex task that leaves its runner alone', async () => {
    const session = await planOnceOnCodex(ops([{ op: 'update', taskId: 't1', changes: { prompt: 'do t1 better' } }]));
    await session.continueConversation('refine');
    expect(session.planTasks.find((t) => t.id === 't1')).toMatchObject({ prompt: 'do t1 better', assignedRunner: 'codex' });
  });

  it('leaves the user\'s own edit of a task free to name any runner, Codex included', async () => {
    const session = await planOnceOnCodex(ops([]));
    await session.updateTask('t2', { assignedRunner: 'codex', assignedModel: { modelId: 'gpt-5', modelLabel: 'gpt-5' } });
    expect(session.planTasks.find((t) => t.id === 't2')?.assignedRunner).toBe('codex');
  });
});
