import { describe, expect, it } from 'vitest';
import { TaskOrchestrator } from '../TaskOrchestrator';
import { BufferedTaskOutputSource } from '../BufferedTaskOutputSource';
import { createTask } from '../../models/Task';
import { RunnerRegistry } from '../../plugins/RunnerRegistry';
import { fakeConfig, FakeRunnerSession, flushMicrotasks } from '../../testing';
import { fakeNotification } from './sessionTestKit';
import type { IRunner } from '../../interfaces/IRunner';

/** A task chat's slash commands are its runner's own (#66): Ordewell only carries them to the runner. */
describe('a runner command through the orchestrator', () => {
  function scheduled() {
    const session = new FakeRunnerSession();
    const runner = { spawn: async () => session, stop: () => session.kill(), stopAll: () => session.kill(), activeCount: 1 } satisfies IRunner;
    const orchestrator = TaskOrchestrator.compose({
      config: fakeConfig(), notifications: fakeNotification(), runner,
      output: new BufferedTaskOutputSource(),
      registry: new RunnerRegistry(), workspaceRoot: () => '/repo',
      workspaceEnv: async () => ({ env: {}, blockedEnvrc: null, refused: [], trackedEnvFile: null }),
    });
    orchestrator.loadPlan([createTask({ id: 't1', order: 1, title: 'Build', prompt: 'Do it' })]);
    return { orchestrator, session };
  }

  it('hands the command to the task\'s runner, and a task waiting for input is back in progress', async () => {
    const { orchestrator, session } = scheduled();
    await orchestrator.forceStartTask('t1');
    session.waitForInput();
    await flushMicrotasks(50);
    expect(orchestrator.storeInstance.get('t1')?.status).toBe('awaiting_user');

    orchestrator.invokeTaskCommand('t1', 'compact', 'keep the API notes');
    expect(session.invoked).toEqual([{ name: 'compact', args: 'keep the API notes' }]);
    expect(orchestrator.storeInstance.get('t1')?.status).toBe('in_progress');
    orchestrator.stop();
  });

  it('refuses a task that is not running, saying there is no turn', () => {
    const { orchestrator } = scheduled();
    expect(() => orchestrator.invokeTaskCommand('t1', 'compact')).toThrow(/is not running/);
  });
});
