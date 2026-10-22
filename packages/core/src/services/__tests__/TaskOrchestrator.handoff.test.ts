import { describe, it, expect, vi } from 'vitest';
import { TaskOrchestrator } from '../TaskOrchestrator';
import { createTask } from '../../models/Task';
import type { StoredHandoff } from '../../models/Handoff';
import type { IRunner, ScriptExit } from '../../interfaces/IRunner';
import { fakeConfig, FakeRunnerSession, FakeWorktreeIsolation } from '../../testing';
import { fakeNotification } from './sessionTestKit';
import { BufferedTaskOutputSource } from '../BufferedTaskOutputSource';

/**
 * The handoff of a task with no model to write one (ADR-0047): a user task's,
 * derived from the user's act, reaches the plan and the log as an authored one
 * does, and a dependent is given it.
 */

function recording(prefix: string) {
  const sessions: FakeRunnerSession[] = [];
  const spawn = vi.fn(async (opts: Parameters<IRunner['spawn']>[0]) => {
    const session = new FakeRunnerSession(`${prefix}${sessions.length + 1}`, opts.taskId, null);
    sessions.push(session);
    return session;
  });
  const runner = { spawn, stop: vi.fn(async () => {}), stopAll: vi.fn(), activeCount: 0 } satisfies IRunner;
  return { runner, spawn, sessions };
}

function setup() {
  const agents = recording('a');
  const scripts = recording('s');
  const handoffs: Array<{ sessionId: string | undefined; taskId: string; handoff: StoredHandoff }> = [];
  const orchestrator = TaskOrchestrator.compose({
    config: fakeConfig(),
    notifications: fakeNotification(),
    runner: agents.runner,
    scriptRunner: scripts.runner,
    output: new BufferedTaskOutputSource(),
    isolation: new FakeWorktreeIsolation(),
    workspaceRoot: () => '/repo',
    recordHandoff: (sessionId, taskId, handoff) => { handoffs.push({ sessionId, taskId, handoff }); },
  });
  const endScript = (taskId: string, exit: ScriptExit, durationMs: number) => {
    const session = scripts.sessions.filter((x) => x.taskId === taskId).at(-1)!;
    session.emitEvent({ type: 'script_exit', durationMs, code: 0, signal: null });
    session.reportScriptExit(exit);
    session.emitExit(0);
  };
  const promptOf = (taskId: string) => agents.spawn.mock.calls.find(([o]) => o.taskId === taskId)?.[0].prompt;
  return { orchestrator, agents, scripts, endScript, promptOf, handoffs, task: (id: string) => orchestrator.storeInstance.get(id)! };
}

describe('the handoff of a user task (ADR-0047)', () => {
  it('says the user completed it and lists its steps, in the plan and in a log of its own', async () => {
    const e = setup();
    e.orchestrator.loadPlan([createTask({
      id: 'u1', order: 1, title: 'Rotate the key', type: 'user',
      userSteps: [{ order: 2, instruction: 'Update the secret store', completed: false }, { order: 1, instruction: 'Create the new key', completed: false }],
    })]);

    await e.orchestrator.markTaskComplete('u1');

    const handoff = { summary: 'Completed by the user', findings: [], findingCount: 0, report: '1. [x] Create the new key\n2. [x] Update the secret store' };
    expect(e.handoffs).toEqual([{ sessionId: undefined, taskId: 'u1', handoff }]);
    expect(e.task('u1').handoff).toEqual({ summary: 'Completed by the user', findings: [], findingCount: 0 });
  });

  it('reaches a task that depends on it, as the summary of what the user did', async () => {
    const e = setup();
    e.orchestrator.loadPlan([
      createTask({ id: 'u1', order: 1, title: 'Rotate the key', type: 'user', userSteps: [{ order: 1, instruction: 'Create the new key', completed: false }] }),
      createTask({ id: 't2', order: 2, title: 'Deploy', prompt: 'Deploy it', dependencies: ['u1'] }),
    ]);
    await e.orchestrator.approveReview();
    await e.orchestrator.markTaskComplete('u1');

    await vi.waitFor(() => expect(e.promptOf('t2')).toBeDefined());
    expect(e.promptOf('t2')).toContain('Completed by the user');
  });
});

describe('the handoff of a script task (ADR-0047)', () => {
  it('reaches a task that depends on it, as its exit and how long it took', async () => {
    const e = setup();
    e.orchestrator.loadPlan([
      createTask({ id: 's1', order: 1, title: 'Build', type: 'script', commands: [['make']] }),
      createTask({ id: 't2', order: 2, title: 'Deploy', prompt: 'Deploy it', dependencies: ['s1'] }),
    ]);
    await e.orchestrator.approveReview();
    await vi.waitFor(() => expect(e.scripts.sessions).toHaveLength(1));

    e.endScript('s1', { outcome: 'passed' }, 1200);

    await vi.waitFor(() => expect(e.promptOf('t2')).toBeDefined());
    expect(e.promptOf('t2')).toContain('exited 0 in 1.2 s');
  });
});
