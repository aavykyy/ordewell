import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { fireEvent, render } from '@testing-library/react';
import { RUN_SETTINGS_DEFAULTS } from '@ordewell/core';
import EmptyState from '../EmptyState';

const withAutorun = (autorun: boolean) => ({ autonomous: false, run: { ...RUN_SETTINGS_DEFAULTS, autorun } });

describe('EmptyState — signed-out planner', () => {
  it('names the agent in one sentence, with the dot the pill also uses', () => {
    const { container } = render(<EmptyState signedOut={{ label: 'Claude Code' }} />);
    const warning = container.querySelector('.planner-auth-warning');
    expect(warning?.getAttribute('role')).toBe('status');
    expect(warning?.getAttribute('aria-live')).toBe('polite');
    expect(container.querySelector('.planner-auth-warning-text')?.textContent).toBe('Claude Code is not logged in.');
    expect(warning?.querySelector('.planner-auth-dot')?.getAttribute('aria-hidden')).toBe('true');
  });

  it('says nothing when the planner is signed in', () => {
    const { container } = render(<EmptyState />);
    expect(container.querySelector('.planner-auth-warning')).toBeNull();
  });

  it('offers the login beside the sentence, and shows what it is doing while it runs', () => {
    const onLogIn = vi.fn();
    const { container, rerender } = render(<EmptyState signedOut={{ label: 'Claude Code', onLogIn }} />);
    const button = container.querySelector<HTMLButtonElement>('.planner-login-btn');
    expect(button?.textContent).toBe('Log in');
    expect(button?.getAttribute('aria-label')).toBe('Log in to Claude Code');
    expect(button).not.toBeDisabled();
    expect(button?.getAttribute('aria-busy')).toBeNull();

    fireEvent.click(button!);
    expect(onLogIn).toHaveBeenCalledTimes(1);

    rerender(<EmptyState signedOut={{ label: 'Claude Code', onLogIn, pending: true }} />);
    const pending = container.querySelector<HTMLButtonElement>('.planner-login-btn');
    expect(pending?.textContent).toContain('Signing in…');
    expect(pending?.getAttribute('aria-label')).toBe('Signing in to Claude Code');
    expect(pending).toBeDisabled();
    expect(pending?.getAttribute('aria-busy')).toBe('true');
    expect(pending?.querySelector('.planner-login-spinner')).toBeTruthy();
  });

  it('says why a sign-in did not finish in the same line, with the same button to retry', () => {
    const { container } = render(
      <EmptyState signedOut={{ label: 'Claude Code', onLogIn: () => {}, failure: 'The terminal closed before sign-in finished.' }} />,
    );

    expect(container.querySelector('.planner-auth-failure')?.textContent).toBe('The terminal closed before sign-in finished.');
    // The result takes the sentence's slot rather than adding a line under it.
    expect(container.querySelector('.planner-auth-warning-text')).toBeNull();
    expect(container.querySelector<HTMLButtonElement>('.planner-login-btn')).not.toBeDisabled();
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
