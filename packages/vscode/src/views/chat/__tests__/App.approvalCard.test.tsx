import React from 'react';
import { describe, it, expect, beforeEach } from 'vitest';
import { render, fireEvent } from '@testing-library/react';
import type { ResearchStep, SessionMessage } from '@ordewell/core';
import App from '../App';
import { api, hostBridge, openActivity } from './hostBridge';

const TURN = 'turn-1';

const REQUEST: Extract<SessionMessage, { type: 'approval_request' }> = {
  type: 'approval_request',
  id: 'ap-1',
  kind: 'shell_command',
  subject: 'npm test',
  scope: 'npm test',
  detail: 'Planner research wants to run: npm test',
  turnId: TURN,
};

describe('approval card', () => {
  let host: ReturnType<typeof hostBridge>;
  beforeEach(() => {
    render(<App />);
    host = hostBridge();
    api.postMessage.mockClear();
  });

  it('asks in the chat, naming kind, subject, scope and detail, with Allow/Deny', () => {
    host.session(REQUEST);

    const card = document.querySelector('.approval-card')!;
    expect(card).toBeTruthy();
    expect(card.textContent).toContain('Run a command');
    expect(card.textContent).toContain('npm test');
    expect(card.textContent).toContain('Planner research wants to run: npm test');
    // The grant outlives this one call — disclosed before the click.
    expect(card.textContent).toContain('Approving also allows npm test for the rest of this session.');
    expect([...card.querySelectorAll('button')].map((b) => b.textContent)).toEqual(['Allow', 'Deny']);
  });

  it('answers Allow through the host and then shows the granted resolution', () => {
    host.session(REQUEST);

    fireEvent.click(document.querySelector('.approval-card-allow')!);
    expect(api.postMessage).toHaveBeenCalledWith({ type: 'resolveApproval', id: 'ap-1', granted: true });

    // What the host's resolve reaches, broadcast back to every surface.
    host.session({ type: 'approval_settled', id: 'ap-1', granted: true });
    // Answered, it folds into the activity it belongs to.
    expect(document.querySelector('.conversation > .approval-card')).toBeNull();
    expect(document.querySelector('.activity-group-toggle')!.textContent).toBe('Settled an approval request');
    openActivity();
    const card = document.querySelector('.approval-card')!;
    expect(card.getAttribute('data-status')).toBe('granted');
    expect(card.textContent).toContain('Approved');
    expect(card.querySelectorAll('button')).toHaveLength(0);
  });

  it('answers Deny through the host, which shows as denied', () => {
    host.session(REQUEST);

    fireEvent.click(document.querySelector('.approval-card-deny')!);
    expect(api.postMessage).toHaveBeenCalledWith({ type: 'resolveApproval', id: 'ap-1', granted: false });

    host.session({ type: 'approval_settled', id: 'ap-1', granted: false });
    openActivity();
    const card = document.querySelector('.approval-card')!;
    expect(card.getAttribute('data-status')).toBe('denied');
    expect(card.textContent).toContain('Denied');
  });

  it('counts a command the user denied once, on the command, with the answer still in the group', () => {
    host.session({ type: 'planner_turn_started', turnId: TURN });
    host.session({ type: 'research_step', tool: 'bash', args: '{"command":"npm test"}', toolCallId: 'tc-1', turnId: TURN });
    host.session(REQUEST);
    fireEvent.click(document.querySelector('.approval-card-deny')!);
    host.session({ type: 'approval_settled', id: 'ap-1', granted: false });
    host.session({
      type: 'research_step_done', turnId: TURN,
      step: { id: 's', tool: 'bash', args: '{"command":"npm test"}', result: 'denied', timestamp: '', success: false, outcome: 'denied', toolCallId: 'tc-1' } as ResearchStep,
    });

    expect(document.querySelector('.activity-group-toggle')!.textContent).toBe('1 command denied');
    openActivity();
    expect(document.querySelector('.approval-card')!.getAttribute('data-status')).toBe('denied');
  });

  it('shows a decision nobody was asked about with its source, and nothing to click', () => {
    host.session({
      type: 'approval_decided', kind: 'shell_command', subject: 'npm test', scope: 'npm test', granted: true, source: 'remembered',
    });
    openActivity();

    const card = document.querySelector('.approval-card')!;
    expect(card.textContent).toContain('Auto-approved');
    expect(card.textContent).toContain('remembered');
    expect(card.querySelectorAll('button')).toHaveLength(0);
  });

  it.each([
    [true, 'mode', 'Auto-approved (policy)'],
    [true, 'pre-approved', 'Auto-approved (pre-approved)'],
    [true, 'remembered', 'Auto-approved (remembered)'],
    [false, 'mode', 'Auto-denied (policy)'],
    [false, 'remembered', 'Auto-denied (remembered)'],
    [false, 'no-channel', 'Auto-denied (no approval channel)'],
  ] as const)('renders a subagent web-read decision (%s, %s)', (granted, source, label) => {
    host.session({ type: 'approval_decided', kind: 'web_search', subject: 'tokio', scope: 'web_search:duckduckgo', granted, source });
    openActivity();

    const card = document.querySelector('.approval-card')!;
    expect(card.textContent).toContain(label);
    expect(card.textContent).toContain('tokio');
    expect(card.querySelectorAll('button')).toHaveLength(0);
  });

  it('shows an external path as a workspace escape, not a command', () => {
    host.session({ type: 'approval_request', id: 'ap-2', kind: 'external_path', subject: '/tmp/dump/a.log', scope: '/tmp/dump/*' });

    const card = document.querySelector('.approval-card')!;
    expect(card.textContent).toContain('outside the workspace');
    expect(card.textContent).toContain('/tmp/dump/a.log');
  });
});
