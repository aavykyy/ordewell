import { describe, it, expect } from 'vitest';
import { taskLogState } from '../taskLogState';
import type { TaskLogStatus } from '../../../shared/taskLogProtocol';

function status(overrides: Partial<TaskLogStatus> = {}): TaskLogStatus {
  return {
    taskId: 't1', order: 1, title: 'Task', runner: 'claude-code',
    planStatus: 'in_progress', awaitingApproval: 0, working: false, queued: [], attempts: [1], attempt: 1, continuable: false,
    ...overrides,
  };
}

describe('what a task log header says (ADR-0018, V1)', () => {
  it.each([
    ['completed', 'done', 'Done'],
    ['failed', 'failed', 'Failed'],
  ] as const)('a %s task wins over a stale live turn and approval', (planStatus, kind, label) => {
    expect(taskLogState(status({ planStatus, working: true, awaitingApproval: 1, awaitingReason: 'input' }))).toEqual({ kind, label });
  });

  it('a running turn reads as working, whatever the saved reason is', () => {
    expect(taskLogState(status({ working: true })).label).toBe('Working');
    expect(taskLogState(status({ working: true, awaitingReason: 'input' })).label).toBe('Working');
  });

  it.each([
    ['input', 'waiting', 'Waiting for your input'],
    ['checkpoint', 'checkpoint', 'Checkpoint'],
    ['conflict', 'waiting', 'Merge conflict'],
    ['files-changed', 'waiting', 'Changed tracked files'],
    ['usage-limit', 'waiting', 'Paused on a usage limit'],
  ] as const)('a task waiting on %s is shown as %s', (awaitingReason, kind, label) => {
    expect(taskLogState(status({ planStatus: 'awaiting_user', awaitingReason }))).toMatchObject({ kind, label });
  });

  it('says a skipped task was skipped, and why', () => {
    expect(taskLogState(status({ planStatus: 'skipped', skipReason: 'no GPU on this host' }))).toEqual({ kind: 'idle', label: 'Skipped: no GPU on this host' });
    expect(taskLogState(status({ planStatus: 'skipped' }))).toEqual({ kind: 'idle', label: 'Skipped' });
  });

  it('does not call a blocked task idle', () => {
    expect(taskLogState(status({ planStatus: 'blocked' }))).toMatchObject({ label: 'Blocked' });
  });

  it('reads the task status before the last turn end', () => {
    expect(taskLogState(status({ planStatus: 'completed', lastTurnEnd: 'failed' }))).toMatchObject({ kind: 'done', label: 'Done' });
    expect(taskLogState(status({ planStatus: 'failed' }))).toMatchObject({ kind: 'failed', label: 'Failed' });
  });

  it('falls back to how the last turn ended, then idle', () => {
    expect(taskLogState(status({ lastTurnEnd: 'failed' }))).toMatchObject({ kind: 'failed', label: 'Turn failed' });
    expect(taskLogState(status({ lastTurnEnd: 'interrupted' }))).toMatchObject({ kind: 'idle', label: 'Interrupted' });
    expect(taskLogState(status({ planStatus: 'draft' }))).toMatchObject({ kind: 'idle', label: 'Idle' });
  });

  it('a runner request waiting for an answer wins over the live turn it stopped (A1)', () => {
    expect(taskLogState(status({ working: true, awaitingApproval: 1 }))).toEqual({ kind: 'approval', label: 'Waiting for approval' });
    expect(taskLogState(status({ working: true, awaitingApproval: 3 })).label).toBe('Waiting for approval (3)');
  });
});
