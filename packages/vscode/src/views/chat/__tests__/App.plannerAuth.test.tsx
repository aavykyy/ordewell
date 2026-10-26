import React from 'react';
import { describe, it, expect, beforeEach } from 'vitest';
import { fireEvent, render } from '@testing-library/react';
import App from '../App';
import { api, post } from './hostBridge';
import type { PlannerBackend } from '../../../shared/protocol';

const signedOutClaude: PlannerBackend = {
  id: 'claude-code',
  label: 'Claude Code',
  kind: 'harness',
  runner: 'claude-code',
  usable: true,
  reason: 'not logged in',
  auth: { state: 'signed-out', loginCommand: ['claude', 'auth', 'login'], detail: 'not logged in' },
};

const signedInClaude: PlannerBackend = {
  ...signedOutClaude,
  reason: 'coding agent · no API key needed',
  auth: { state: 'signed-in', loginCommand: ['claude', 'auth', 'login'] },
};

const pill = () => document.querySelector<HTMLButtonElement>('.planner-pill')!;
const warning = () => document.querySelector('.planner-auth-warning');

/**
 * A signed-out agent is still a working choice — the login is the fix — so it
 * stays offered, and the surface only says what is wrong.
 */
describe('a signed-out planner', () => {
  beforeEach(() => {
    render(<App />);
    post({ type: 'setConfiguredProviders', providers: [] });
  });

  it('flags its pill with a red dot and a title', () => {
    post({ type: 'setPlannerBackends', backends: [signedOutClaude], provider: 'claude-code', runner: 'claude-code' });

    expect(pill().className).toContain('signed-out');
    expect(pill().className).toContain('active');
    expect(pill().querySelector('.planner-auth-dot')).toBeTruthy();
    expect(pill().title).toContain('Not logged in');
  });

  it('keeps a signed-out agent pickable', () => {
    post({
      type: 'setPlannerBackends',
      backends: [signedOutClaude, { id: 'openrouter', label: 'OpenRouter', kind: 'vendor', usable: true }],
      provider: 'openrouter',
    });
    api.postMessage.mockClear();

    fireEvent.click(pill());

    expect(api.postMessage).toHaveBeenCalledWith({ type: 'setPlanner', provider: 'claude-code' });
  });

  it('does not flag a signed-in pill', () => {
    post({ type: 'setPlannerBackends', backends: [signedInClaude], provider: 'claude-code', runner: 'claude-code' });

    expect(pill().className).not.toContain('signed-out');
    expect(pill().querySelector('.planner-auth-dot')).toBeNull();
    expect(pill().title).toBe('coding agent · no API key needed');
  });

  it('warns in the empty state, naming the agent', () => {
    post({ type: 'setPlannerBackends', backends: [signedOutClaude], provider: 'claude-code', runner: 'claude-code' });

    expect(warning()?.getAttribute('role')).toBe('status');
    expect(warning()?.textContent).toContain('Claude Code is not logged in.');
    expect(warning()?.textContent).toContain('sign in from this chat');
  });

  it('stays quiet when the signed-out agent is not the one planning', () => {
    const codex: PlannerBackend = {
      id: 'codex',
      label: 'Codex',
      kind: 'harness',
      runner: 'codex',
      usable: true,
      auth: { state: 'signed-out', loginCommand: ['codex', 'login'] },
    };
    post({ type: 'setPlannerBackends', backends: [signedInClaude, codex], provider: 'claude-code', runner: 'claude-code' });

    expect(warning()).toBeNull();
  });
});
