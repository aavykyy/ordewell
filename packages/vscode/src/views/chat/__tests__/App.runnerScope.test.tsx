import React from 'react';
import { describe, it, expect, beforeEach } from 'vitest';
import { cleanup, fireEvent, render } from '@testing-library/react';
import App from '../App';
import type { RunnerMeta } from '../../../shared/protocol';
import { api, post } from './hostBridge';

const NAMES: Record<string, string> = { 'claude-code': 'Claude Code', codex: 'Codex', opencode: 'OpenCode' };

/** The runner list as the host sends it: every installed runner, with the ones the saved list holds on. */
const list = (...on: string[]): RunnerMeta[] =>
  Object.entries(NAMES).map(([id, displayName]) => ({ id, displayName, enabled: on.includes(id) }));

const pill = (name: string): HTMLElement => {
  const found = [...document.querySelectorAll<HTMLElement>('.runner-pill')].find((p) => p.textContent?.includes(name));
  if (!found) throw new Error(`no ${name} pill`);
  return found;
};

/** The state each pill shows: on, off, or disabled (not in the saved list). */
const states = (): Record<string, string> =>
  Object.fromEntries([...document.querySelectorAll<HTMLElement>('.runner-pill')].map((p) => [
    p.textContent!.trim(),
    (['disabled', 'on', 'off'] as const).find((s) => p.classList.contains(s)) ?? '?',
  ]));

/** What the webview asked the host to do about runners since the mock was last cleared. */
const runnerRequests = (): unknown[] =>
  api.postMessage.mock.calls.map(([msg]) => msg as { type: string }).filter((m) => m.type === 'setRunnerEnabled' || m.type === 'enableRunner');

// The pills are the user's saved choice of runners (ADR-0043), not a selection
// kept in the webview: a click asks the host to save it, and what the host
// answers is what the pills show.
describe('the Runners block pills are the saved runner choice', () => {
  beforeEach(() => {
    render(<App />);
  });

  it('shows every saved-enabled runner on, and the rest disabled', () => {
    post({ type: 'setRunners', runners: list('claude-code', 'opencode') });

    expect(states()).toEqual({ 'Claude Code': 'on', Codex: 'disabled', OpenCode: 'on' });
  });

  it('asks the host to save Codex off when it is clicked from all three on', () => {
    post({ type: 'setRunners', runners: list('claude-code', 'codex', 'opencode') });
    expect(states()).toEqual({ 'Claude Code': 'on', Codex: 'on', OpenCode: 'on' });
    api.postMessage.mockClear();

    fireEvent.click(pill('Codex'));

    expect(runnerRequests()).toEqual([{ type: 'setRunnerEnabled', runnerId: 'codex', enabled: false }]);
  });

  it('shows the pill the way the host says after the save, and Codex disabled for the next plan too', () => {
    post({ type: 'setRunners', runners: list('claude-code', 'codex', 'opencode') });
    fireEvent.click(pill('Codex'));

    post({ type: 'setRunners', runners: list('claude-code', 'opencode') });

    expect(states()).toEqual({ 'Claude Code': 'on', Codex: 'disabled', OpenCode: 'on' });
  });

  it('puts Codex back on when the host answers that the save was rejected', () => {
    post({ type: 'setRunners', runners: list('claude-code', 'codex', 'opencode') });
    api.postMessage.mockClear();
    fireEvent.click(pill('Codex'));
    expect(runnerRequests()).toHaveLength(1);

    post({ type: 'setRunners', runners: list('claude-code', 'codex', 'opencode') });

    expect(states()).toEqual({ 'Claude Code': 'on', Codex: 'on', OpenCode: 'on' });
  });

  it('ends on the host\'s final list when a late discovery list lands between the click and the save', () => {
    post({ type: 'setRunners', runners: list('claude-code', 'codex', 'opencode') });
    api.postMessage.mockClear();
    fireEvent.click(pill('Codex'));

    // Discovery began before the save, so its list still holds Codex; the list for the saved choice follows.
    post({ type: 'setRunners', runners: list('claude-code', 'codex', 'opencode') });
    post({ type: 'setRunners', runners: list('claude-code', 'opencode') });

    expect(runnerRequests()).toEqual([{ type: 'setRunnerEnabled', runnerId: 'codex', enabled: false }]);
    expect(states()).toEqual({ 'Claude Code': 'on', Codex: 'disabled', OpenCode: 'on' });
  });

  it('asks nothing when the last runner on is clicked: the choice is never emptied from here', () => {
    post({ type: 'setRunners', runners: list('claude-code') });
    expect(states()['Claude Code']).toBe('on');
    api.postMessage.mockClear();

    fireEvent.click(pill('Claude Code'));

    expect(runnerRequests()).toEqual([]);
    expect(states()['Claude Code']).toBe('on');
  });
});

describe('the Runners block after the webview is reloaded', () => {
  it('shows the runners the user allowed on, from the host\'s list alone', () => {
    const first = render(<App />);
    post({ type: 'setRunners', runners: list('claude-code', 'opencode') });
    first.unmount();
    cleanup();

    render(<App />);
    post({ type: 'setRunners', runners: list('claude-code', 'opencode') });

    expect(states()).toEqual({ 'Claude Code': 'on', Codex: 'disabled', OpenCode: 'on' });
  });
});
