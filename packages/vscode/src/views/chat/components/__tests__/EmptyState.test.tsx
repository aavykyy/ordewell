import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { fireEvent, render } from '@testing-library/react';
import { RUN_SETTINGS_DEFAULTS } from '@ordewell/core';
import EmptyState from '../EmptyState';

const withAutorun = (autorun: boolean) => ({ autonomous: false, run: { ...RUN_SETTINGS_DEFAULTS, autorun } });

describe('EmptyState — signed-out planners', () => {
  it('lists every signed-out agent in one sentence each, with the dot the pill also uses', () => {
    const { container } = render(
      <EmptyState signedOut={[
        { runner: 'claude-code', label: 'Claude Code' },
        { runner: 'codex', label: 'Codex' },
      ]} />,
    );
    const region = container.querySelector('.planner-auth-rows');
    expect(region?.getAttribute('role')).toBe('status');
    expect(region?.getAttribute('aria-live')).toBe('polite');
    const rows = [...container.querySelectorAll<HTMLElement>('.planner-auth-row')];
    expect(rows.map((r) => r.dataset.runner)).toEqual(['claude-code', 'codex']);
    expect(rows[0].querySelector('.planner-auth-warning-text')?.textContent).toBe('Claude Code not logged in.');
    expect(rows[1].querySelector('.planner-auth-warning-text')?.textContent).toBe('Codex not logged in.');
    expect(rows[0].querySelector('.planner-auth-dot')?.getAttribute('aria-hidden')).toBe('true');
    expect(rows[1].querySelector('.planner-auth-dot')?.getAttribute('aria-hidden')).toBe('true');
  });

  it('says nothing when every planner is signed in', () => {
    const { container } = render(<EmptyState />);
    expect(container.querySelector('.planner-auth-rows')).toBeNull();
  });

  it('offers each row its own login, naming its agent, and shows what it is doing while it runs', () => {
    const claudeLogin = vi.fn();
    const codexLogin = vi.fn();
    const { container, rerender } = render(
      <EmptyState signedOut={[
        { runner: 'claude-code', label: 'Claude Code', onLogIn: claudeLogin },
        { runner: 'codex', label: 'Codex', onLogIn: codexLogin },
      ]} />,
    );
    const buttons = [...container.querySelectorAll<HTMLButtonElement>('.planner-login-btn')];
    expect(buttons.map((b) => b.textContent)).toEqual(['Log in', 'Log in']);
    expect(buttons.map((b) => b.getAttribute('aria-label'))).toEqual(['Log in to Claude Code', 'Log in to Codex']);
    expect(buttons.every((b) => !b.disabled)).toBe(true);
    expect(buttons.every((b) => b.getAttribute('aria-busy') === null)).toBe(true);

    fireEvent.click(buttons[0]);
    fireEvent.click(buttons[1]);
    expect(claudeLogin).toHaveBeenCalledTimes(1);
    expect(codexLogin).toHaveBeenCalledTimes(1);

    rerender(
      <EmptyState signedOut={[
        { runner: 'claude-code', label: 'Claude Code', onLogIn: claudeLogin, pending: true },
        { runner: 'codex', label: 'Codex', onLogIn: codexLogin },
      ]} />,
    );
    const pending = container.querySelector<HTMLButtonElement>('.planner-auth-row[data-runner="claude-code"] .planner-login-btn')!;
    expect(pending.textContent).toContain('Signing in…');
    expect(pending.getAttribute('aria-label')).toBe('Signing in to Claude Code');
    expect(pending).toBeDisabled();
    expect(pending.getAttribute('aria-busy')).toBe('true');
    expect(pending.querySelector('.planner-login-spinner')).toBeTruthy();
    // Only the agent whose login runs waits.
    expect(container.querySelector<HTMLButtonElement>('.planner-auth-row[data-runner="codex"] .planner-login-btn')).not.toBeDisabled();
  });

  it('says why a sign-in did not finish in that agent\'s line, with the same button to retry', () => {
    const { container } = render(
      <EmptyState signedOut={[
        { runner: 'claude-code', label: 'Claude Code', onLogIn: () => {}, failure: 'The terminal closed before sign-in finished.' },
        { runner: 'codex', label: 'Codex', onLogIn: () => {} },
      ]} />,
    );

    const claude = container.querySelector('.planner-auth-row[data-runner="claude-code"]')!;
    expect(claude.querySelector('.planner-auth-failure')?.textContent).toBe('The terminal closed before sign-in finished.');
    // The result takes that row's sentence slot rather than adding a line.
    expect(claude.querySelector('.planner-auth-warning-text')).toBeNull();
    expect(claude.querySelector<HTMLButtonElement>('.planner-login-btn')).not.toBeDisabled();
    expect(container.querySelector('.planner-auth-row[data-runner="codex"] .planner-auth-failure')).toBeNull();
  });

  it('gives the row one dot, one sentence and one action, in that order', () => {
    const { container } = render(
      <EmptyState signedOut={[{ runner: 'claude-code', label: 'Claude Code', onLogIn: () => {} }]} />,
    );

    const rowEl = container.querySelector('.planner-auth-row')!;
    expect([...rowEl.children].map((el) => el.className)).toEqual([
      'planner-auth-dot',
      'planner-auth-warning-body',
      'planner-login planner-login-btn',
    ]);
  });

  it('gives a signed-out agent with no login command a row and no button', () => {
    const { container } = render(<EmptyState signedOut={[{ runner: 'codex', label: 'Codex' }]} />);

    expect(container.querySelector('.planner-auth-row[data-runner="codex"] .planner-auth-warning-text')?.textContent)
      .toBe('Codex not logged in.');
    expect(container.querySelector('.planner-login-btn')).toBeNull();
  });
});

describe('EmptyState — plan approval', () => {
  it('says neither before the host has sent run settings, since autorun may be on', () => {
    for (const runSettings of [undefined, null]) {
      const { container, unmount } = render(<EmptyState runSettings={runSettings} />);
      expect(container.textContent).not.toContain('Nothing runs until');
      expect(container.textContent).not.toContain('Autorun is on');
      unmount();
    }
  });

  it('says it while autorun is off', () => {
    const { container } = render(<EmptyState runSettings={withAutorun(false)} />);
    expect(container.textContent).toContain('Nothing runs until you approve the plan.');
  });

  it('warns instead of promising approval while autorun is on', () => {
    const { container } = render(<EmptyState runSettings={withAutorun(true)} />);
    expect(container.textContent).not.toContain('Nothing runs until');
    expect(container.querySelector('p.warn')?.textContent).toContain('Autorun is on');
  });
});
