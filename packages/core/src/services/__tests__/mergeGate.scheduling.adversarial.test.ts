import { describe, it, expect, vi } from 'vitest';
import { TaskOrchestrator } from '../TaskOrchestrator';
import { createTask } from '../../models/Task';
import { BufferedTaskOutputSource } from '../BufferedTaskOutputSource';
import { fakeConfig, FakeRunnerSession, FakeWorktreeIsolation, flushMicrotasks } from '../../testing';
import { fakeNotification } from './sessionTestKit';
import { waitOf } from '../readiness';
import type { IRunner, IRunnerSession } from '../../interfaces/IRunner';
import type { RunnerSpawnOptions } from '../AbstractRunner';

/**
 * Adversarial: the merge gate is one rule (ADR-0020, `readiness.mergeGate`),
 * judged whatever a task's status because a retry of a failed ops task acts on
 * the checkout as a first start does. The surfaces' force-start confirmation
 * and the task row read it through `TaskOrchestrator.getMergeGate`, which must
 * give the start rule's answer.
 */

function setup() {
  const sessions: FakeRunnerSession[] = [];
  const spawn = vi.fn(async (o: RunnerSpawnOptions): Promise<IRunnerSession> => {
    const session = new FakeRunnerSession(`s${sessions.length + 1}`, o.taskId, `native-${sessions.length + 1}`);
    sessions.push(session);
    return session;
  });
  const runner: IRunner = { spawn, stop: vi.fn(), stopAll: vi.fn(), activeCount: 0 };
  const isolation = new FakeWorktreeIsolation();
  const orchestrator = TaskOrchestrator.compose({
    config: fakeConfig({ worktreeIsolation: true }),
    notifications: fakeNotification(),
    runner,
    output: new BufferedTaskOutputSource(),
    isolation,
    workspaceRoot: () => '/repo',
    workspaceEnv: async () => ({ env: {}, blockedEnvrc: null, refused: [], trackedEnvFile: null }),
  });
  return { orchestrator, sessions, isolation };
}

async function until(condition: () => boolean): Promise<void> {
  for (let i = 0; i < 50 && !condition(); i += 1) await flushMicrotasks();
  expect(condition()).toBe(true);
}

describe('the gate of a pending ops task', () => {
  it('is the start rule\'s gate', async () => {
    const { orchestrator, sessions } = setup();
    orchestrator.loadPlan([
      createTask({ id: 'c1', order: 1, title: 'Change', prompt: 'change' }),
      createTask({ id: 'o2', order: 2, title: 'Ops', prompt: 'ops', ops: true, dependencies: ['c1'] }),
    ]);
    await orchestrator.approveReview();
    sessions[0].reportComplete({ status: 'done', summary: '' });
    await until(() => orchestrator.storeInstance.get('c1')!.status === 'completed');
    await flushMicrotasks();

    const waits = orchestrator.startWaits(orchestrator.storeInstance.get('o2')!);
    expect(waitOf(waits, 'merge-gate')?.unmerged).toEqual(['c1']);
    expect(orchestrator.getMergeGate('o2')).toEqual(['c1']);
  });
});

describe('the gate of a failed ops task', () => {
  // ADVERSARIAL FINDING (readiness): getMergeGate empties the gate for any
  // task whose status has left pending/approved, so a failed ops task whose
  // ancestor is still unmerged reports no gate although startWaits (and the
  // planner's `waits:` note) says merge-gate. The row and the force-start
  // confirmation read this, so a force start passes the gate without asking
  // and a queued force start records an empty pastGate and stops at the gate
  // when it starts. Expected: judged whatever the status, as
  // readiness.mergeGate is — a retry of a failed ops task acts on the
  // checkout as a first start does.
  it.skip('is the start rule\'s gate too', async () => {
    const { orchestrator, sessions } = setup();
    orchestrator.loadPlan([
      createTask({ id: 'c1', order: 1, title: 'Change', prompt: 'change' }),
      createTask({ id: 'o2', order: 2, title: 'Ops', prompt: 'ops', ops: true, dependencies: ['c1'] }),
    ]);
    await orchestrator.approveReview();
    sessions[0].reportComplete({ status: 'done', summary: '' });
    await until(() => orchestrator.storeInstance.get('c1')!.status === 'completed');
    await flushMicrotasks();

    // Force it past the gate once, then fail it: a retry now acts on the
    // checkout as its first start did.
    await orchestrator.forceStartTask('o2');
    sessions.at(-1)!.reportComplete({ status: 'failed', summary: '', reason: 'nope' });
    await until(() => orchestrator.storeInstance.get('o2')!.status === 'failed');

    const waits = orchestrator.startWaits(orchestrator.storeInstance.get('o2')!);
    expect(waitOf(waits, 'merge-gate')?.unmerged).toEqual(['c1']);
    expect(orchestrator.getMergeGate('o2')).toEqual(['c1']);
  });
});
