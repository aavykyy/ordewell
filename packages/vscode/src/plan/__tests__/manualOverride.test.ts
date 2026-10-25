import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as vscode from 'vscode';
import { createTask, type Task } from '@ordewell/core';
import { markTaskByHand } from '../PlanManager';

const showWarningMessage = vscode.window.showWarningMessage as unknown as ReturnType<typeof vi.fn>;

const IDLE = { starting: false, running: false, scheduled: false, resumable: false, advancesOnItsOwn: false };

function deps(tasks: Task[], activity = IDLE, outcome: { ok: boolean; message: string } = { ok: true, message: 'done' }) {
  const session = {
    planState: { tasks },
    activity,
    execute: vi.fn().mockResolvedValue(outcome),
  };
  return { session };
}

const ai = (status: Task['status'] = 'pending') => createTask({ id: 't1', order: 1, title: 'Fix', status, assignedRunner: 'claude-code' });
const manual = () => createTask({ id: 't1', order: 1, title: 'Sign off', type: 'user' });

/**
 * The host's half of the manual-completion policy (ADR-0029): a modal in the
 * core's words, the yes and the status it was asked about on the command, and
 * no modal at all where the core would refuse.
 */
describe('Mark complete and Mark not done from the host', () => {
  beforeEach(() => showWarningMessage.mockReset());

  it('asks in the core\'s words, and sends nothing when the modal is dismissed', async () => {
    const { session } = deps([ai()]);
    showWarningMessage.mockResolvedValue(undefined);

    await markTaskByHand('complete', 't1', { session: session as never });

    expect(showWarningMessage).toHaveBeenCalledWith(
      'Mark task #1 Fix complete? You vouch for its work although no passing verdict said it was done. Any changes it kept may land in your run, and the tasks that depend on it are released to start on a future run.',
      { modal: true },
      'Mark complete',
    );
    expect(session.execute).not.toHaveBeenCalled();
  });

  it('sends the yes with the status the user was asked about', async () => {
    const { session } = deps([ai('failed')]);
    showWarningMessage.mockResolvedValue('Mark complete');

    await markTaskByHand('complete', 't1', { session: session as never });

    expect(session.execute).toHaveBeenCalledWith({ command: 'mark_complete', task: 't1', confirmed: true, seen: 'failed' }, { kind: 'user' });
  });

  it('asks before it takes a completion back, and says what that leaves alone', async () => {
    const { session } = deps([ai('completed')]);
    showWarningMessage.mockResolvedValue('Mark not done');

    await markTaskByHand('uncomplete', 't1', { session: session as never });

    expect(showWarningMessage.mock.calls[0][0]).toContain('The work it did stays where it is');
    expect(session.execute).toHaveBeenCalledWith({ command: 'mark_not_done', task: 't1', confirmed: true, seen: 'completed' }, { kind: 'user' });
  });

  it.each([
    ['starting', { ...IDLE, starting: true, advancesOnItsOwn: true }],
    ['running', { ...IDLE, running: true, advancesOnItsOwn: true }],
    ['scheduled', { ...IDLE, scheduled: true, advancesOnItsOwn: true }],
    ['holding a queued force start', { ...IDLE, advancesOnItsOwn: true }],
    ['waiting out a usage limit', { ...IDLE, resumable: true, advancesOnItsOwn: true }],
  ])(
    'tells the user to Stop the run first, and asks nothing, while the run is %s',
    async (_name, activity) => {
      const { session } = deps([ai()], activity);

      await markTaskByHand('complete', 't1', { session: session as never });

      expect(showWarningMessage).toHaveBeenCalledTimes(1);
      expect(showWarningMessage.mock.calls[0][0]).toContain('Stop the run first');
      expect(showWarningMessage.mock.calls[0]).toHaveLength(1);
      expect(session.execute).not.toHaveBeenCalled();
    },
  );

  it('asks for a run that ended on a failure, since overriding the failed task is the way out', async () => {
    const { session } = deps([ai('failed')], { ...IDLE, resumable: false });
    showWarningMessage.mockResolvedValue('Mark complete');

    await markTaskByHand('complete', 't1', { session: session as never });

    expect(showWarningMessage.mock.calls[0][0]).toContain('You vouch for its work');
    expect(session.execute).toHaveBeenCalledWith({ command: 'mark_complete', task: 't1', confirmed: true, seen: 'failed' }, { kind: 'user' });
  });

  it('signs off a manual task without a question, during a run too', async () => {
    const { session } = deps([manual()], { ...IDLE, running: true });

    await markTaskByHand('complete', 't1', { session: session as never });

    expect(showWarningMessage).not.toHaveBeenCalled();
    expect(session.execute).toHaveBeenCalledWith({ command: 'mark_complete', task: 't1' }, { kind: 'user' });
  });

  it('throws the seam\'s refusal so the caller can show it', async () => {
    const { session } = deps([ai()], IDLE, { ok: false, message: 'Task #1 "Fix" has changed since you were asked: it failed.' });
    showWarningMessage.mockResolvedValue('Mark complete');

    await expect(markTaskByHand('complete', 't1', { session: session as never })).rejects.toThrow('has changed since you were asked');
  });
});
