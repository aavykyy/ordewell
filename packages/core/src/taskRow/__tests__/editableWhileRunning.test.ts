import { describe, expect, it } from 'vitest';
import { editableWhileRunning } from '../index';

/**
 * The card's own rule while a plan runs: only a task that has not itself
 * started keeps its editors. What distinguishes it from the wider direct-edit
 * path is that a task execution has reached — even one the status stream has
 * not caught up with — is not the user's to change from its card.
 */
describe('editableWhileRunning', () => {
  it.each(['pending', 'approved', 'blocked'])('edits a %s task, which has not started', (status) => {
    expect(editableWhileRunning({ status })).toBe(true);
  });

  it.each(['in_progress', 'running', 'awaiting_user', 'completed', 'failed', 'skipped'])('does not edit a %s task, which execution has reached', (status) => {
    expect(editableWhileRunning({ status })).toBe(false);
  });

  it('does not edit a queued task its run already shows starting or waiting on its runner', () => {
    expect(editableWhileRunning({ status: 'approved' }, { isolation: { state: 'active' } })).toBe(false);
    expect(editableWhileRunning({ status: 'approved' }, { isolation: { state: 'repairing' } })).toBe(false);
    expect(editableWhileRunning({ status: 'blocked' }, { awaitingApproval: 1 })).toBe(false);
  });

  it('edits a task returned to pending after a stop, whose kept work is history and not a live attempt', () => {
    expect(editableWhileRunning({ status: 'pending' }, { isolation: { state: 'kept' } })).toBe(true);
    expect(editableWhileRunning({ status: 'approved' }, { isolation: { state: 'conflict' } })).toBe(true);
    expect(editableWhileRunning({ status: 'pending' }, { isolation: { state: 'none' }, awaitingApproval: 0 })).toBe(true);
  });
});
