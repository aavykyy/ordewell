import React from 'react';
import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen, within, fireEvent } from '@testing-library/react';
import { RUN_SETTINGS_DEFAULTS, type GlobalRunSettings } from '@ordewell/core';
import App from '../App';
import { api, post as send } from './hostBridge';

const settings = (run: Partial<GlobalRunSettings> = {}, extra: { autonomous?: boolean; maxParallel?: number } = {}) => send({
  type: 'setRunSettings',
  autonomous: extra.autonomous ?? true,
  run: { ...RUN_SETTINGS_DEFAULTS, ...run },
  maxParallel: extra.maxParallel ?? 5,
});
const row = (name: string) => within(screen.getByRole('group', { name }));

/** The Run block of the Settings panel: each click saves one setting through the host (ADR-0030). */
describe('run settings in the Settings panel', () => {
  beforeEach(() => {
    render(<App />);
    settings();
    api.postMessage.mockClear();
  });

  it.each([
    ['Autonomy', 'Guarded', { autonomous: false }],
    ['Supervisor', 'Off', { run: { supervisorLevel: 'off' } }],
    ['Supervisor', 'Act', { run: { supervisorLevel: 'act' } }],
    ['Automerge', 'On', { run: { mergeAtGatesAutomatically: true } }],
    ['Autorun', 'On', { run: { autorun: true } }],
  ])('%s → %s posts %j', (name, label, change) => {
    fireEvent.click(row(name).getByRole('button', { name: label }));
    expect(api.postMessage).toHaveBeenCalledWith({ type: 'changeSettings', change });
  });

  it('marks the current value and posts nothing when it is clicked again', () => {
    expect(row('Supervisor').getByRole('button', { name: 'Watch' })).toHaveAttribute('aria-pressed', 'true');
    expect(row('Automerge').getByRole('button', { name: 'Off' })).toHaveAttribute('aria-pressed', 'true');
    fireEvent.click(row('Supervisor').getByRole('button', { name: 'Watch' }));
    expect(api.postMessage).not.toHaveBeenCalled();
  });

  it('a number commits on Enter, any whole number at or above its floor', () => {
    const parallel = screen.getByRole('spinbutton', { name: 'Parallel tasks' });
    expect(parallel).toHaveValue(5);
    fireEvent.change(parallel, { target: { value: '17' } });
    expect(api.postMessage).not.toHaveBeenCalled();
    fireEvent.keyDown(parallel, { key: 'Enter' });
    expect(api.postMessage).toHaveBeenCalledWith({ type: 'changeSettings', change: { maxParallel: 17 } });
  });

  it('a number commits on blur too', () => {
    const retries = screen.getByRole('spinbutton', { name: 'Supervisor retries' });
    fireEvent.change(retries, { target: { value: '0' } });
    fireEvent.blur(retries);
    expect(api.postMessage).toHaveBeenCalledWith({ type: 'changeSettings', change: { run: { supervisorRetryLimit: 0 } } });
  });

  it.each([
    ['Parallel tasks', '0'],
    ['Supervisor reads', '0'],
    ['Supervisor retries', '-1'],
    ['Parallel tasks', '2.5'],
    ['Parallel tasks', ''],
  ])('%s refuses %j: marked invalid, never sent', (name, typed) => {
    const input = screen.getByRole('spinbutton', { name });
    fireEvent.change(input, { target: { value: typed } });
    expect(input).toHaveAttribute('aria-invalid', 'true');
    fireEvent.keyDown(input, { key: 'Enter' });
    fireEvent.blur(input);
    expect(api.postMessage).not.toHaveBeenCalled();
  });

  it('shows the host\'s value again when the host answers, whatever was typed', () => {
    const parallel = screen.getByRole('spinbutton', { name: 'Parallel tasks' });
    fireEvent.change(parallel, { target: { value: '0' } });
    settings({}, { maxParallel: 8 });
    expect(parallel).toHaveValue(8);
    expect(parallel).not.toHaveAttribute('aria-invalid', 'true');
  });

  it('hides the supervisor limits while the supervisor is Off', () => {
    expect(screen.getByRole('spinbutton', { name: 'Supervisor reads' })).toHaveValue(RUN_SETTINGS_DEFAULTS.wakeUpReadBudget);
    settings({ supervisorLevel: 'off' });
    expect(screen.queryByRole('spinbutton', { name: 'Supervisor retries' })).toBeNull();
    expect(screen.queryByRole('spinbutton', { name: 'Supervisor reads' })).toBeNull();
    expect(screen.getByRole('spinbutton', { name: 'Parallel tasks' })).toBeInTheDocument();
  });

  it('/settings opens a collapsed panel at the Run block', () => {
    fireEvent.click(screen.getByRole('button', { name: /^Settings/ }));
    expect(document.querySelector('.setup-panel-body')).toHaveClass('collapsed');

    send({ type: 'openSettings' });

    expect(document.querySelector('.setup-panel-body')).not.toHaveClass('collapsed');
    expect(screen.getByRole('region', { name: 'Run' })).toHaveFocus();
  });
});
