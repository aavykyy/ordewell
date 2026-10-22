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

function setup(isolation = new FakeWorktreeIsolation()) {
  const agents = recording('a');
  const scripts = recording('s');
  const handoffs: Array<{ sessionId: string | undefined; taskId: string; handoff: StoredHandoff }> = [];
  const orchestrator = TaskOrchestrator.compose({
    config: fakeConfig({ conflictRepairAttempts: 2 }),
    notifications: fakeNotification(),
    runner: agents.runner,
    scriptRunner: scripts.runner,
    output: new BufferedTaskOutputSource(),
    isolation,
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

    e.scripts.sessions[0].emitOutput('PASS_OUTPUT_SENTINEL');
    e.endScript('s1', { outcome: 'passed' }, 1200);

    await vi.waitFor(() => expect(e.promptOf('t2')).toBeDefined());
    expect(e.promptOf('t2')).toContain('exited 0 in 1.2 s');
    expect(e.promptOf('t2')).toContain('PASS_OUTPUT_SENTINEL');
  });
});

describe('authored handoffs across attempts (ADR-0047)', () => {
  it('stores the repair handoff before starting the dependent', async () => {
    const isolation = new FakeWorktreeIsolation();
    isolation.outcomes.set('a', 'conflict');
    const e = setup(isolation);
    e.orchestrator.loadPlan([
      createTask({ id: 'a', order: 1, title: 'Build', prompt: 'Build' }),
      createTask({ id: 'b', order: 2, prompt: 'Continue', dependencies: ['a'] }),
    ]);
    await e.orchestrator.approveReview();
    e.agents.sessions[0].reportComplete({ status: 'done', summary: 'Original result' });
    await vi.waitFor(() => expect(e.agents.sessions).toHaveLength(2));
    isolation.outcomes.set('a', 'merged');
    e.agents.sessions[1].reportComplete({ status: 'done', summary: 'Repair result', findings: [{ severity: 'info', title: 'Repaired' }], report: 'Repair report' });
    await vi.waitFor(() => expect(e.promptOf('b')).toBeDefined());
    expect(e.task('a').handoff?.summary).toBe('Repair result');
    expect(e.handoffs.map((h) => [h.sessionId, h.handoff.summary])).toEqual([['a1', 'Original result'], ['a2', 'Repair result']]);
    expect(e.handoffs[1].handoff.report).toBe('Repair report');
    expect(e.promptOf('b')).toContain('Repair result');
    expect(e.promptOf('b')).not.toContain('Original result');
  });
});

it('keeps full findings and the report only in the attempt log for new completions', async () => {
  const e = setup();
  e.orchestrator.loadPlan([createTask({ id: 'a', order: 1, prompt: 'Review' })]);
  await e.orchestrator.approveReview();
  e.agents.sessions[0].reportComplete({ status: 'done', summary: 'Digest', findings: Array.from({ length: 30 }, (_, i) => ({ severity: 'major', title: `UNIQUE_FINDING_${i + 1}` })), report: 'PRIVATE_REPORT_SENTINEL' });
  await vi.waitFor(() => expect(e.task('a').status).toBe('completed'));
  const plan = JSON.stringify(e.orchestrator.storeInstance.snapshot());
  expect(plan).not.toContain('PRIVATE_REPORT_SENTINEL');
  expect(plan).not.toContain('UNIQUE_FINDING_30');
  expect(e.task('a').outputSummary?.report).toBeUndefined();
  expect(e.handoffs[0].handoff.report).toBe('PRIVATE_REPORT_SENTINEL');
  expect(e.handoffs[0].handoff.findings).toHaveLength(30);
});
