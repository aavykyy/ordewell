import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionMessage } from '../SessionMessage';
import { makeSession } from './sessionTestKit';
import { ctx, heldPlanner, NOW, plan, prose, settled, task, until } from './supervisorTestKit';

/**
 * The open planner turn holds its edit until the reply ends (ADR-0029). The
 * session tells surfaces what it would leave, so the user can see it before.
 */

beforeEach(() => {
  vi.useFakeTimers({ now: NOW, toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
});

afterEach(() => {
  vi.useRealTimers();
});

/** A plan not yet run, with the user's turn open and the planner's reply in the test's hands. */
async function openTurn() {
  const planner = heldPlanner();
  const messages: SessionMessage[] = [];
  const session = makeSession({ aiService: planner.aiService, broadcast: (m) => messages.push(m) });
  session.loadPlan(plan([task('t1', 1), task('t2', 2)], { status: 'draft' }), 'build it', process.cwd());
  void session.continueConversation('add a cache');
  await until(() => planner.calls.length === 1);
  return { session, planner, messages };
}

type Held = Extract<SessionMessage, { type: 'plan_edit_held' }>;
const heldEvents = (messages: SessionMessage[]): Held[] => messages.filter((m): m is Held => m.type === 'plan_edit_held');
const marks = (event: Held) => event.held?.tasks.map((t) => [t.task.title, t.mark ?? null]);

describe('the edit a planner turn holds', () => {
  it('is announced as the plan it would leave, each changed task marked, while the plan itself stays as it is', async () => {
    const { session, planner, messages } = await openTurn();

    await planner.tools().editPlan!({ ops: [
      { op: 'add', task: { title: 'Add a cache', prompt: 'add a cache' } },
      { op: 'remove', taskId: 't2' },
      { op: 'update', taskId: 't1', changes: { title: 'Task one' } },
    ] }, ctx);

    expect(marks(heldEvents(messages).at(-1)!)).toEqual([['Task one', 'changed'], ['Task t2', 'removed'], ['Add a cache', 'added']]);
    expect(heldEvents(messages).at(-1)!.held!.turnId).toBe(messages.find((m) => m.type === 'planner_turn_started')!.turnId);
    expect(session.planTasks.map((t) => t.title)).toEqual(['Task t1', 'Task t2']);
  });

  it('is cleared after the plan that carries it when the reply ends and it lands', async () => {
    const { session, planner, messages } = await openTurn();
    await planner.tools().editPlan!({ ops: [{ op: 'add', task: { title: 'Add a cache', prompt: 'add a cache' } }] }, ctx);

    planner.calls[0].finish(prose('Added a cache.'));
    await settled();

    expect(session.planTasks.map((t) => t.title)).toContain('Add a cache');
    const types = messages.map((m) => m.type);
    const cleared = messages.findIndex((m) => m.type === 'plan_edit_held' && m.held === null);
    expect(cleared).toBeGreaterThan(types.lastIndexOf('plan_generated'));
    expect(heldEvents(messages).map((e) => e.held === null)).toEqual([false, true]);
  });

  it('is cleared when the turn is stopped, and nothing lands', async () => {
    const { session, planner, messages } = await openTurn();
    await planner.tools().editPlan!({ ops: [{ op: 'remove', taskId: 't2' }] }, ctx);

    session.abortPlannerTurn();
    await settled();

    expect(heldEvents(messages).map((e) => e.held === null)).toEqual([false, true]);
    expect(session.planTasks.map((t) => t.id)).toEqual(['t1', 't2']);
  });

  it('is cleared when the edit is refused as it lands', async () => {
    const { session, planner, messages } = await openTurn();
    await planner.tools().editPlan!({ ops: [{ op: 'update', taskId: 't2', changes: { title: 'Renamed' } }] }, ctx);
    // The user removes the task the edit changes before the reply ends.
    await session.removeTask('t2');

    planner.calls[0].finish(prose('Renamed it.'));
    await settled();

    expect(heldEvents(messages).map((e) => e.held === null)).toEqual([false, true]);
    expect(session.planTasks.map((t) => t.title)).toEqual(['Task t1']);
  });

  it('shows nothing for an edit that does not apply, and not again once a whole plan replaces the edit', async () => {
    const { planner, messages } = await openTurn();

    const refused = await planner.tools().editPlan!({ ops: [{ op: 'remove', taskId: 'nope' }] }, ctx);
    expect(refused.isError).toBe(true);
    expect(heldEvents(messages)).toEqual([]);

    await planner.tools().editPlan!({ ops: [{ op: 'remove', taskId: 't2' }] }, ctx);
    const submitted = await planner.tools().submitPlan!({ tasks: [{ title: 'Only', description: 'one', prompt: 'do', assignedRunner: 'claude-code', sliceType: 'AFK', autonomy: 'AFK' }] }, ctx);
    expect(submitted.isError, submitted.text).toBeFalsy();
    expect(heldEvents(messages).map((e) => e.held === null)).toEqual([false, true]);
  });

  it('is in the run a surface joining mid-turn is given, and out of it once the turn is over', async () => {
    const { session, planner } = await openTurn();
    await planner.tools().editPlan!({ ops: [{ op: 'add', task: { title: 'Add a cache', prompt: 'add a cache' } }] }, ctx);

    expect(session.runSnapshot().heldEdit?.tasks.map((t) => t.mark)).toEqual([undefined, undefined, 'added']);

    planner.calls[0].finish(prose('Added a cache.'));
    await settled();

    expect(session.runSnapshot().heldEdit).toBeUndefined();
  });
});
