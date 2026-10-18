import { describe, expect, it, vi } from 'vitest';
import { makeSession, FakeRunnerSession } from './sessionTestKit';
import { FakeWorktreeIsolation } from '../../testing';
import { createTask, type LegacyPlanState, type Task } from '../../models/Task';
import type { IRunner } from '../../interfaces/IRunner';
import type { RunTask, RunView, SessionMessage } from '../SessionMessage';
import { reduceRun } from '../runView';

/**
 * Adversarial: "core decides when the run is closed" (ADR-0013, ADR-0020) only
 * holds if a surface that refreshes — the daemon's `run` field, VS Code's
 * `runSnapshot()` adopt — sees exactly what a surface folding the stream sees:
 * a Merge all during a run keeps the isolation marks and the x conflict key,
 * and only `run_closed` drops them. The one known difference is `mergeResult`,
 * which a snapshot deliberately does not keep (createSession, runSnapshot).
 */

const task = (id: string, order: number, over: Partial<Task> = {}) =>
  createTask({ id, order, title: `Task ${id}`, prompt: `do ${id}`, assignedRunner: 'claude-code', taskMode: 'acceptEdits', ...over });

function plan(tasks: Task[]): LegacyPlanState {
  const now = new Date().toISOString();
  return { tasks, generatedAt: now, status: 'approved', runners: ['claude-code'], lastUpdated: now, runSettings: { mergeAtGatesAutomatically: false } };
}

function setup() {
  const runnerSessions: FakeRunnerSession[] = [];
  const runner = {
    spawn: vi.fn(async (spawn: { taskId: string }) => {
      const t = new FakeRunnerSession(`s${runnerSessions.length + 1}`, spawn.taskId);
      runnerSessions.push(t);
      return t;
    }),
    stop: vi.fn(),
    stopAll: vi.fn(),
    activeCount: 0,
  } satisfies IRunner;
  const messages: SessionMessage[] = [];
  const isolation = new FakeWorktreeIsolation();
  const session = makeSession({ runner, isolation, broadcast: (m) => { messages.push(m); } });
  return { session, messages, isolation, runnerSession: (taskId: string) => runnerSessions.find((t) => t.taskId === taskId)! };
}

/** The stream folded from the plan as it was adopted, without `mergeResult` (never kept by a snapshot). */
function foldedFrom(early: RunView, messages: SessionMessage[]): RunView {
  const view = messages.reduce(reduceRun, early);
  return { ...view, mergeResult: null };
}

/** Marks and handoff, the fields the surfaces' conflict key and cards are drawn from. */
function shape(view: RunView) {
  return {
    tasks: view.tasks.map((t: RunTask) => [t.id, t.status, t.isolation?.state ?? null]),
    handoff: view.handoff === null ? null : 'kept',
  };
}

describe('adversarial: the run a refresh serves equals the run the stream told', () => {
  it('a Merge all mid-run keeps the marks and no handoff, on the stream and on a refresh alike', async () => {
    const env = setup();
    const t1 = task('t1', 1);
    const t2 = task('t2', 2, { dependencies: ['t1'] });
    env.session.loadPlan(plan([t1, t2]), 'goal', '/repo', { persist: false });
    const early = env.session.runSnapshot();
    env.messages.length = 0;

    await env.session.execute({ command: 'run_plan' }, { kind: 'user' });
    env.runnerSession('t1').reportComplete({ status: 'done', summary: 'landed' });
    await vi.waitFor(() => expect(env.session.planTasks[0].status).toBe('completed'));
    await vi.waitFor(() => expect(env.isolation.taskIdsFor('integrate')).toContain('t1'));
    await vi.waitFor(() => expect(env.isolation.taskIdsFor('prepare')).toContain('t2'));

    await env.session.execute({ command: 'merge_all' }, { kind: 'user' });

    expect(env.messages.map((m) => m.type)).toContain('isolation_merge');
    expect(env.messages.map((m) => m.type)).not.toContain('run_closed');

    const folded = foldedFrom(early, env.messages);
    const snapshot = env.session.runSnapshot();
    // mergeResult is the one field a snapshot does not keep, by design.
    expect(shape(folded)).toEqual(shape(snapshot));
    // The mid-run merge is not a close: t2's mark survives on both, so the x key stays.
    const marks = Object.fromEntries(snapshot.tasks.map((t) => [t.id, t.isolation?.state ?? null]));
    expect(marks['t2']).not.toBeNull();
    expect(snapshot.handoff).toBeNull();
  });

  it('after the run is closed, a refresh serves no marks and no handoff either', async () => {
    const env = setup();
    const t1 = task('t1', 1);
    env.session.loadPlan(plan([t1]), 'goal', '/repo', { persist: false });
    const early = env.session.runSnapshot();
    env.messages.length = 0;

    await env.session.execute({ command: 'run_plan' }, { kind: 'user' });
    env.runnerSession('t1').reportComplete({ status: 'done', summary: 'landed' });
    await vi.waitFor(() => expect(env.session.planTasks[0].status).toBe('completed'));
    await vi.waitFor(() => expect(env.messages.map((m) => m.type)).toContain('isolation_handoff'));

    await env.session.execute({ command: 'merge_all' }, { kind: 'user' });
    expect(env.messages.map((m) => m.type)).toContain('run_closed');

    const folded = foldedFrom(early, env.messages);
    const snapshot = env.session.runSnapshot();
    expect(shape(folded)).toEqual(shape(snapshot));
    for (const view of [folded, snapshot]) {
      expect(view.tasks.every((t) => t.isolation === undefined)).toBe(true);
      expect(view.handoff).toBeNull();
    }
  });

  it('a discard closes the run the same way on both paths', async () => {
    const env = setup();
    const t1 = task('t1', 1);
    env.session.loadPlan(plan([t1]), 'goal', '/repo', { persist: false });
    const early = env.session.runSnapshot();
    env.messages.length = 0;

    await env.session.execute({ command: 'run_plan' }, { kind: 'user' });
    env.runnerSession('t1').reportComplete({ status: 'done', summary: 'landed' });
    await vi.waitFor(() => expect(env.session.planTasks[0].status).toBe('completed'));

    await env.session.discardRun();

    const folded = foldedFrom(early, env.messages);
    const snapshot = env.session.runSnapshot();
    expect(shape(folded)).toEqual(shape(snapshot));
    expect(snapshot.tasks.every((t) => t.isolation === undefined)).toBe(true);
  });
});
