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
const loginButton = () => document.querySelector<HTMLButtonElement>('.planner-login-btn')!;
const pillLogins = () => [...document.querySelectorAll<HTMLButtonElement>('.planner-pill-login')];

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
    expect(warning()?.querySelector('.planner-auth-warning-text')?.textContent).toBe('Claude Code is not logged in.');
    expect(loginButton().textContent).toBe('Log in');
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

  it('signs the active planner in from the empty state, and waits on that button alone', () => {
    post({ type: 'setPlannerBackends', backends: [signedOutClaude], provider: 'claude-code', runner: 'claude-code' });
    api.postMessage.mockClear();

    fireEvent.click(loginButton());

    // Named, so a pending planner switch cannot sign in the previous agent.
    expect(api.postMessage).toHaveBeenCalledWith({ type: 'loginPlanner', runner: 'claude-code' });
    expect(loginButton()).toBeDisabled();
    expect(loginButton().getAttribute('aria-busy')).toBe('true');
    expect(loginButton().textContent).toContain('Signing in…');

    post({ type: 'plannerLoginEnded', runner: 'claude-code', ok: true });

    expect(loginButton()).not.toBeDisabled();
    expect(loginButton().getAttribute('aria-busy')).toBeNull();
  });

  it('signs in the agent the empty state names while a planner switch is still pending', () => {
    const signedOutCodex: PlannerBackend = {
      id: 'codex',
      label: 'Codex',
      kind: 'harness',
      runner: 'codex',
      usable: true,
      auth: { state: 'signed-out', loginCommand: ['codex', 'login'] },
    };
    post({ type: 'setPlannerBackends', backends: [signedOutClaude, signedOutCodex], provider: 'claude-code', runner: 'claude-code' });
    // The host has not answered the switch yet: the empty state already names
    // Codex, while the saved config still points at Claude Code.
    const codexPill = [...document.querySelectorAll<HTMLButtonElement>('.planner-pill')]
      .find((p) => p.textContent === 'Codex')!;
    fireEvent.click(codexPill);
    expect(warning()?.querySelector('.planner-auth-warning-text')?.textContent).toBe('Codex is not logged in.');
    api.postMessage.mockClear();

    fireEvent.click(loginButton());

    expect(api.postMessage).toHaveBeenCalledWith({ type: 'loginPlanner', runner: 'codex' });
  });

  it('signs in a signed-out pill without switching the planner to it', () => {
    const codex: PlannerBackend = {
      id: 'codex',
      label: 'Codex',
      kind: 'harness',
      runner: 'codex',
      usable: true,
      auth: { state: 'signed-out', loginCommand: ['codex', 'login'] },
    };
    post({ type: 'setPlannerBackends', backends: [signedInClaude, codex], provider: 'claude-code', runner: 'claude-code' });
    api.postMessage.mockClear();

    expect(pillLogins()).toHaveLength(1);
    expect(pillLogins()[0].getAttribute('aria-label')).toBe('Log in to Codex');
    fireEvent.click(pillLogins()[0]);

    expect(api.postMessage).toHaveBeenCalledWith({ type: 'loginPlanner', runner: 'codex' });
    expect(api.postMessage).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'setPlanner' }));
    expect(pillLogins()[0]).toBeDisabled();
    expect(pillLogins()[0].getAttribute('aria-busy')).toBe('true');
    expect(pillLogins()[0].getAttribute('aria-label')).toBe('Signing in to Codex');
    // Only that agent's action waits: the pill bar stays usable.
    for (const p of document.querySelectorAll<HTMLButtonElement>('.planner-pill')) expect(p).not.toBeDisabled();
    expect(pill().className).toContain('active');
  });

  it('offers the active agent its login on the pill once the empty state is gone', () => {
    post({ type: 'setPlannerBackends', backends: [signedOutClaude], provider: 'claude-code', runner: 'claude-code' });
    // A planner turn in flight: there is a conversation now, so the first
    // screen with its login row is not drawn.
    post({ type: 'plannerTurn', active: true });
    expect(warning()).toBeNull();
    api.postMessage.mockClear();

    expect(pillLogins()).toHaveLength(1);
    fireEvent.click(pillLogins()[0]);

    expect(api.postMessage).toHaveBeenCalledWith({ type: 'loginPlanner', runner: 'claude-code' });
    expect(api.postMessage).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'setPlanner' }));
  });

  it('shows a pill login failure under that pill, leaving the empty state alone', () => {
    const codex: PlannerBackend = {
      id: 'codex',
      label: 'Codex',
      kind: 'harness',
      runner: 'codex',
      usable: true,
      auth: { state: 'signed-out', loginCommand: ['codex', 'login'] },
    };
    post({ type: 'setPlannerBackends', backends: [signedInClaude, codex], provider: 'claude-code', runner: 'claude-code' });
    fireEvent.click(pillLogins()[0]);

    post({ type: 'plannerLoginEnded', runner: 'codex', ok: false, message: 'Sign-in did not finish in time.' });

    expect(document.querySelector('.planner-pill-login-failure')?.textContent).toBe('Sign-in did not finish in time.');
    expect(pillLogins()[0]).not.toBeDisabled();
    // The failure belongs to Codex, not to the planner this session uses.
    expect(warning()).toBeNull();
  });

  it('shows why a login did not finish, inline, and lets the button be tried again', () => {
    post({ type: 'setPlannerBackends', backends: [signedOutClaude], provider: 'claude-code', runner: 'claude-code' });
    fireEvent.click(loginButton());

    post({ type: 'plannerLoginEnded', runner: 'claude-code', ok: false, message: 'The terminal closed before sign-in finished.' });

    expect(document.querySelector('.planner-auth-failure')?.textContent).toBe('The terminal closed before sign-in finished.');
    // The reason replaces the state sentence: the row stays one line, and the
    // pill above must not repeat it.
    expect(document.querySelector('.planner-auth-warning-text')).toBeNull();
    expect(document.querySelector('.planner-pill-login-failure')).toBeNull();
    expect(loginButton()).not.toBeDisabled();
    expect(loginButton().getAttribute('aria-busy')).toBeNull();
  });
});
