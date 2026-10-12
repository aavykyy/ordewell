import React from 'react';
import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { RUN_SETTINGS_DEFAULTS } from '@ordewell/core';
import App from '../App';
import { post as send } from './hostBridge';

const t1 = {
  id: 't1', order: 1, title: 'Add rate limiting', description: '', type: 'ai' as const,
  status: 'pending' as const, dependencies: [], subtasks: [], assignedRunner: 'claude-code',
  taskMode: 'build',
};
const plan = {
  tasks: [t1], generatedAt: new Date().toISOString(), status: 'draft' as const,
  runners: ['claude-code'], lastUpdated: new Date().toISOString(),
};
const bar = () => document.querySelector('.plan-dock-bar')!.textContent!;

/** Run settings are the user's, changed by chat commands and shown wherever a run is (ADR-0030). */
describe('run settings in the chat', () => {
  beforeEach(() => {
    render(<App />);
  });

  it('lists them on the empty chat, with the commands that change them', () => {
    send({ type: 'setConfiguredProviders', providers: ['openrouter'] });
    send({ type: 'setRunSettings', autonomous: true, run: { ...RUN_SETTINGS_DEFAULTS, supervisorLevel: 'act' } });

    const setup = document.querySelector('.empty-state-setup')!.textContent!;
    expect(setup).toMatch(/Autonomy\s*Full\s*\/auto/);
    expect(setup).toMatch(/Run\s*supervisor Act · auto-merge off · autorun off\s*\/supervisor · \/automerge · \/autorun/);
  });

  it('shows them on the plan bar, and the run\'s own level where it differs', () => {
    send({ type: 'setRunSettings', autonomous: true, run: { ...RUN_SETTINGS_DEFAULTS, supervisorLevel: 'act', mergeAtGatesAutomatically: true } });
    send({ type: 'planUpdated', plan });
    expect(bar()).toContain('Supervisor: Act');
    expect(bar()).toContain('Merge at gates automatically');

    send({ type: 'planUpdated', plan: { ...plan, status: 'running', runSettings: { mergeAtGatesAutomatically: true, supervisorLevel: 'watch' } } });
    expect(bar()).toContain('Supervisor: Act → Watch');

    send({ type: 'planUpdated', plan: { ...plan, status: 'running', runSettings: { mergeAtGatesAutomatically: true, supervisorLevel: 'act', unsupervised: 'its wake-up turn failed twice' } } });
    expect(bar()).toContain('Supervisor: Act → unsupervised');
  });

  it('has no controls for them on the plan: they are chat commands', () => {
    send({ type: 'planUpdated', plan });

    expect(screen.queryByRole('checkbox', { name: /Merge at gates automatically/ })).toBeNull();
    expect(screen.queryByRole('combobox', { name: /Supervisor/ })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Drop to Watch' })).toBeNull();
  });
});
