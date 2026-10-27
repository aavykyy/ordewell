import React from 'react';
import { describe, it, expect, beforeEach } from 'vitest';
import { render } from '@testing-library/react';
import type { IsolationPreview } from '@ordewell/core';
import App from '../App';
import { hostBridge, post } from './hostBridge';

const notice = () => document.querySelector('.isolation-notice');
// Name, head and commit are separate elements in the card; the row reads in that order.
const rows = () => [...document.querySelectorAll('.isolation-repo')].map((r) => {
  const part = (sel: string) => r.querySelector(sel)?.textContent ?? '';
  return [part('.isolation-repo-name'), part('.isolation-repo-head'), part('.isolation-repo-commit')].filter(Boolean).join(' ');
});
const preview = (branch: string): IsolationPreview => ({
  status: 'ready', shared: [], repos: [{ path: '.', head: { kind: 'branch', branch, commit: 'a1b2c3d' }, dirty: false }],
});

/** The startup view as the host drives it, on a window that can plan. */
describe('the startup view\'s repositories and branches', () => {
  beforeEach(() => {
    render(<App />);
    hostBridge();
    post({ type: 'setConfiguredProviders', providers: ['openrouter'] });
  });

  it('is absent until the host says, with the composer and the first screen already usable', () => {
    expect(document.body.textContent).toContain('What would you like to build?');
    expect(notice()).toBeNull();
    expect(document.querySelector('textarea')).not.toBeNull();
  });

  it('shows what the host found, and the current branch replaces an old one', () => {
    post({ type: 'isolationPreview', preview: preview('main') });
    expect(rows()).toEqual(['This workspace on main a1b2c3d']);

    post({ type: 'isolationPreview', preview: preview('feature/x') });
    expect(rows()).toEqual(['This workspace on feature/x a1b2c3d']);
  });

  it('withdraws the old branch while the host re-reads, claiming neither a repository nor none', () => {
    post({ type: 'isolationPreview', preview: preview('main') });

    post({ type: 'isolationPreview', preview: null });

    expect(notice()?.textContent).toBe('Checking repositories…');
    expect(document.body.textContent).not.toContain('main');
    expect(document.body.textContent).not.toContain('No Git repository');
  });

  it('says no repository only when the host found none', () => {
    post({ type: 'isolationPreview', preview: { status: 'no-repo', repos: [], shared: [] } });

    expect(notice()?.textContent).toContain('No Git repository detected. Tasks run in the workspace without isolated worktrees.');
  });

  it('survives a new session: the repositories belong to the workspace', () => {
    post({ type: 'isolationPreview', preview: preview('main') });

    post({ type: 'restoreChat' });
    post({ type: 'setState', state: 'empty' });

    expect(rows()).toEqual(['This workspace on main a1b2c3d']);
  });
});

describe('the first screen when nothing can plan', () => {
  it('shows the same repositories, since a window with no agent yet still has a workspace', () => {
    render(<App />);
    hostBridge();
    post({ type: 'setConfiguredProviders', providers: [] });
    post({ type: 'setRunners', runners: [] });
    post({ type: 'setPlannerBackends', backends: [], provider: 'openrouter' });
    post({ type: 'isolationPreview', preview: preview('main') });

    expect(document.querySelector('.get-started')).not.toBeNull();
    expect(rows()).toEqual(['This workspace on main a1b2c3d']);
  });
});
