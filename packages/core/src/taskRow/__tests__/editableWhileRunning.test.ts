import { describe, expect, it } from 'vitest';
import { cardEditable, cardEditNeedsUnstarted, editableWhileRunning, runHoldsEditors } from '../index';

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

const IDLE = { starting: false, advancesOnItsOwn: false };

/**
 * One run fact for the card and the host, so an editor the card offers is one
 * the host accepts: anything that could still move a task on without being
 * asked holds the editors back; a run that ended on a failure does not.
 */
describe('runHoldsEditors', () => {
  it('holds while an attempt is live, a start is opening the run, or the run advances on its own', () => {
    expect(runHoldsEditors(true, IDLE)).toBe(true);
    expect(runHoldsEditors(false, { starting: true, advancesOnItsOwn: false })).toBe(true);
    expect(runHoldsEditors(false, { starting: false, advancesOnItsOwn: true })).toBe(true);
  });

  it('lets go when nothing is live and nothing would advance, a run ended on a failure included', () => {
    expect(runHoldsEditors(false, IDLE)).toBe(false);
  });
});

describe('cardEditable', () => {
  it('keeps every task editable when no run holds the editors', () => {
    expect(cardEditable(false, { status: 'failed' })).toBe(true);
    expect(cardEditable(false, { status: 'completed' })).toBe(true);
  });

  it('holds a task the run reached back while a run holds the editors, even with nothing live', () => {
    expect(cardEditable(true, { status: 'completed' })).toBe(false);
    expect(cardEditable(true, { status: 'pending' })).toBe(true);
  });
});

describe('cardEditNeedsUnstarted', () => {
  it('is the precondition while a run holds the editors', () => {
    expect(cardEditNeedsUnstarted(true, { status: 'pending' })).toBe(true);
    expect(cardEditNeedsUnstarted(true, { status: 'completed' })).toBe(true);
  });

  it('is the precondition of a task that has not started even when the plan is idle, for a start that claims it mid-edit', () => {
    expect(cardEditNeedsUnstarted(false, { status: 'pending' })).toBe(true);
    expect(cardEditNeedsUnstarted(false, { status: 'approved' })).toBe(true);
    expect(cardEditNeedsUnstarted(false, { status: 'blocked' })).toBe(true);
  });

  it('leaves a settled task of an idle plan the wider direct-edit contract', () => {
    expect(cardEditNeedsUnstarted(false, { status: 'failed' })).toBe(false);
    expect(cardEditNeedsUnstarted(false, { status: 'completed' })).toBe(false);
  });
});
