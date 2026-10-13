import { describe, it, expect, vi } from 'vitest';
import { TaskOrchestrator } from '../TaskOrchestrator';
import { createTask } from '../../models/Task';
import { BufferedTaskOutputSource } from '../BufferedTaskOutputSource';
import { fakeConfig, FakeRunnerSession, FakeWorktreeIsolation, flushMicrotasks } from '../../testing';
import { fakeNotification } from './sessionTestKit';
import type { IRunner } from '../../interfaces/IRunner';

function sessionRunner() {
  const sessions: FakeRunnerSession[] = [];
  const spawn = vi.fn(async (opts: Parameters<IRunner['spawn']>[0]) => {
    const session = new FakeRunnerSession(`s${sessions.length + 1}`, opts.taskId);
    sessions.push(session);
    return session;
  });
  const runner: IRunner = { spawn, stop: vi.fn(), stopAll: vi.fn(), activeCount: 0 };
  return { sessions, runner };
}

/**
 * A settings change fires its scheduling pass without a caller waiting on it;
 * a failure there must still be said, never left as an unhandled rejection.
 */
describe('a run setting changed under an open run', () => {
  it('says why the scheduling it triggers failed instead of leaving it unhandled', async () => {
    const isolation = new FakeWorktreeIsolation();
    isolation.isActive = async () => { throw new Error('isActive boom'); };
    const notifications = fakeNotification();
    const { runner } = sessionRunner();
    const orchestrator = TaskOrchestrator.compose({
      config: fakeConfig({ worktreeIsolation: true }),
      notifications,
      runner,
      output: new BufferedTaskOutputSource(),
      isolation,
      workspaceRoot: () => '/repo',
    });

    orchestrator.loadPlan([createTask({ id: 't1', order: 1, title: 'Change', prompt: 'edit' })]);
    // Hold new starts so the run opens undecided: the change below is what
    // first asks isolation, and that is where the tree check throws.
    const release = orchestrator.holdStarts();
    await orchestrator.approveReview();
    expect(orchestrator.isScheduling).toBe(true);

    release();
    orchestrator.runSettingsChanged();

    await vi.waitFor(() => expect(notifications.error).toHaveBeenCalledWith(expect.stringContaining('isActive boom')));
    await flushMicrotasks();
  });
});
