import React from 'react';
import { beforeEach, describe, expect, it } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { createTask, type HandoffDigest, type RunTask } from '@ordewell/core';
import App from '../App';
import { api, post } from './hostBridge';

const task = createTask({ id: 't1', order: 1, title: 'Review boundary', status: 'completed' });
const handoff: HandoffDigest = {
  summary: 'Keep the token scoped.\nMore context.', findingCount: 28,
  findings: [{ id: 'F1', severity: 'blocker', title: 'Sibling read', detail: 'The token can read a sibling.', evidence: [{ kind: 'file', path: 'src/token.ts', line: 42 }] }],
  artifacts: [{ kind: 'file', path: 'docs/review.md' }],
};

function update(runTask: RunTask): void {
  post({ type: 'runView', view: { tasks: [runTask], runMerge: null, handoff: null, mergeResult: null } });
}

describe('task handoffs in the plan dock (ADR-0047)', () => {
  beforeEach(() => {
    render(<App />);
    api.postMessage.mockClear();
    post({ type: 'planUpdated', plan: {
      tasks: [task], generatedAt: '', lastUpdated: '', status: 'approved', runners: [],
    } });
  });

  it('shows the digest from the run message, with its full count, and opens the attempt log for the rest', () => {
    update({ ...task, handoff });
    const peek = document.querySelector('.task-handoff-peek');
    expect(peek).toHaveTextContent('Handed over · 28 findings · Blocker · Keep the token scoped.');
    expect(peek).not.toHaveTextContent('More context.');
    fireEvent.click(screen.getByText('Review boundary'));
    expect(screen.getByText('F1 · Blocker · Sibling read')).toBeTruthy();
    expect(screen.getByText('The token can read a sibling.')).toBeTruthy();
    expect(screen.getByText(/src\/token.ts:42/)).toBeTruthy();
    expect(screen.getByText("+27 more findings, in the attempt's log")).toBeTruthy();
    expect(screen.getByText('docs/review.md')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Read full handoff' }));
    expect(api.postMessage).toHaveBeenCalledWith({ type: 'openTaskLog', taskId: 't1' });
    update({ ...task, status: 'in_progress', handoff: undefined });
    expect(document.querySelector('.task-handoff')).toBeNull();
    expect(document.querySelector('.task-handoff-peek')).toBeNull();
  });

  it.each(['script', 'user'] as const)('shows the %s handoff from a saved plan with no findings', (type) => {
    post({ type: 'planUpdated', plan: {
      tasks: [{ ...task, type, handoff: { summary: 'Finished', findings: [], findingCount: 0 } }],
      generatedAt: '', lastUpdated: '', status: 'approved', runners: [],
    } });
    expect(document.querySelector('.task-handoff-peek')).toHaveTextContent('Handed over · no findings · Finished');
    fireEvent.click(screen.getByText('Review boundary'));
    expect(screen.getByText('Handoff · no findings')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Read full handoff' }));
    expect(api.postMessage).toHaveBeenCalledWith({ type: 'openTaskLog', taskId: 't1' });
  });

  it('keeps the loop badge and status beside a handoff', () => {
    const check = { ...task, status: 'failed' as const, loop: { body: ['fix'], maxRounds: 3 }, loopRound: 1,
      verdict: { outcome: 'fail' as const, reported: 'failed' as const, reason: 'Found problems', checks: [], decidedAt: '' } };
    post({ type: 'planUpdated', plan: {
      tasks: [check, createTask({ id: 'fix', order: 2, title: 'Fix', dependencies: ['t1'] })],
      generatedAt: '', lastUpdated: '', status: 'running', runners: [],
    } });
    update({ ...check, handoff });
    expect(document.querySelector('.loop')).toHaveTextContent(/round 1 of 3/i);
    expect(document.querySelector('.status-failed')).toBeNull();
    expect(document.querySelector('.task-handoff-peek')).toHaveTextContent('28 findings');
  });
});
