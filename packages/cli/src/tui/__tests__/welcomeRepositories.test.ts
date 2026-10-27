import { describe, it, expect, beforeAll } from 'vitest';
import type { IsolationPreview, PreviewRepo } from '@ordewell/core';
import { initialState, reduce, type Action } from '../reducer';
import { render } from '../render';
import { chatScrollMax } from '../layout';
import { stripAnsi, style, width } from '../ansi';
import type { TuiState } from '../state';

beforeAll(() => { style.enabled = false; });

const on = (path: string, branch: string, extra: Partial<PreviewRepo> = {}): PreviewRepo => ({
  path,
  head: { kind: 'branch', branch, commit: 'a1b2c3d' },
  dirty: false,
  ...extra,
});

const preview = (status: IsolationPreview['status'], repos: PreviewRepo[] = [], extra: Partial<IsolationPreview> = {}): IsolationPreview =>
  ({ status, repos, shared: [], ...extra });

const welcome = (over: Partial<TuiState> = {}): TuiState => initialState({ rows: 40, cols: 100, ...over });
const text = (state: TuiState): string => render(state).map(stripAnsi).join('\n');
const flat = (state: TuiState): string => text(state).replace(/\s+/g, ' ');

describe('the welcome repositories and branches', () => {
  it('says it is checking while the launch read is on its way, and claims no repository yet', () => {
    const out = text(welcome());

    expect(out).toContain('Repositories and branches');
    expect(out).toContain('Checking repositories…');
    expect(out).not.toContain('No Git repository');
  });

  it('says it is checking again during a refresh rather than keeping the last answer', () => {
    const state = welcome({ isolationPreview: null });

    expect(text(state)).toContain('Checking repositories…');
  });

  it('names the repository, its branch and the commit, and that code tasks get isolated worktrees', () => {
    const out = text(welcome({ isolationPreview: preview('ready', [on('.', 'main')]) }));

    expect(out).toContain('Repositories and branches');
    expect(out).toContain('This workspace · on main (a1b2c3d)');
    expect(out).toContain('Code tasks run in isolated git worktrees based on the repositories and branches below.');
  });

  it('lists every repository of a group with its own branch or detached HEAD', () => {
    const out = text(welcome({
      isolationPreview: preview('ready', [
        on('services/api', 'feature/x'),
        { path: 'web', head: { kind: 'detached', commit: 'deadbee' }, dirty: false },
        { path: 'libs/core', head: { kind: 'branch', branch: 'release/2.0', commit: 'c0ffee1' }, dirty: false },
      ]),
    }));

    expect(out).toContain('services/api · on feature/x (a1b2c3d)');
    expect(out).toContain('web · detached HEAD at deadbee');
    expect(out).toContain('libs/core · on release/2.0 (c0ffee1)');
  });

  it('says plainly that tasks run in the workspace without isolated worktrees when there is no repository', () => {
    const out = text(welcome({ isolationPreview: preview('no-repo') }));

    expect(out).toContain('No Git repository detected. Tasks run in the workspace without isolated worktrees.');
    expect(out).not.toContain('This workspace ·');
  });

  it('does not turn a failed read into no repository, and gives the reason', () => {
    const out = flat(welcome({ isolationPreview: preview('failed', [], { error: 'git did not answer' }) }));

    expect(out).toContain("Could not read the Git repositories just now, so Ordewell can't say yet whether code tasks get isolated worktrees.");
    expect(out).toContain('git did not answer');
    expect(out).not.toContain('No Git repository');
  });

  it.each<[IsolationPreview['status'], string]>([
    ['git-missing', 'Git was not found, so tasks run in the workspace without isolated worktrees.'],
    ['disabled', 'Worktree isolation is turned off, so tasks run in the workspace without isolated worktrees.'],
    ['no-commits', 'No repository has a commit yet, so tasks run in the workspace without isolated worktrees.'],
  ])('words %s as itself, not as no repository', (status, words) => {
    const out = flat(welcome({ isolationPreview: preview(status, [on('api', 'main')]) }));

    expect(out).toContain(words);
    expect(out).not.toContain('No Git repository');
  });

  it('names the uncommitted changes and the start-time decision a dirty tree waits on', () => {
    const out = flat(welcome({
      isolationPreview: preview('dirty', [on('api', 'main', { dirty: true }), on('web', 'main')], { shared: ['web'] }),
    }));

    expect(out).toContain('api · on main (a1b2c3d) · uncommitted changes to tracked files');
    expect(out).toContain('web · on main (a1b2c3d)');
    expect(out).toContain('stash them or run without isolation');
    expect(out).toContain('Shared live between tasks: web');
  });

  it('keeps a long repository name and branch whole in a narrow pane, inside its width', () => {
    const cols = 32;
    const state = welcome({
      rows: 40,
      cols,
      isolationPreview: preview('ready', [on('services/an-extraordinarily-long-repository-name', 'feature/a-very-long-branch-name')]),
    });

    for (const line of render(state)) expect(width(line)).toBeLessThanOrEqual(cols);
    expect(text(state).replace(/\s+/g, '')).toContain('services/an-extraordinarily-long-repository-name');
    expect(flat(state)).toContain('Code tasks run in isolated git worktrees');
  });

  it('stays inside a short terminal with many repositories, and scrolls back to the isolation wording', () => {
    const repos = Array.from({ length: 12 }, (_, i) => on(`services/svc-${i}`, 'main'));
    const state = welcome({ rows: 8, cols: 32, isolationPreview: preview('ready', repos) });

    expect(render(state)).toHaveLength(8);
    for (const line of render(state)) expect(width(line)).toBeLessThanOrEqual(32);
    const max = chatScrollMax(state);
    expect(max).toBeGreaterThan(0);
    const reachable = Array.from({ length: max + 1 }, (_, scroll) => flat({ ...state, scroll })).some((frame) => frame.includes('Code tasks run in isolated git worktrees'));
    expect(reachable).toBe(true);
  });
});

describe('the welcome preview discards a stale read', () => {
  const apply = (actions: Action[], start: TuiState = welcome()): TuiState =>
    actions.reduce((state, action) => reduce(state, action).state, start);

  it('keeps the newer read when an older answer lands after it', () => {
    const state = apply([
      { type: 'isolationPreviewLoading', read: 1 },
      { type: 'isolationPreviewLoading', read: 2 },
      { type: 'isolationPreviewLoaded', read: 1, preview: preview('no-repo') },
      { type: 'isolationPreviewLoaded', read: 2, preview: preview('ready', [on('.', 'main')]) },
    ]);

    expect(state.isolationPreview?.status).toBe('ready');
  });

  it('ignores an older failure once a newer answer is on screen', () => {
    const state = apply([
      { type: 'isolationPreviewLoading', read: 1 },
      { type: 'isolationPreviewLoaded', read: 1, preview: preview('ready', [on('.', 'main')]) },
      { type: 'isolationPreviewFailed', read: 0, message: 'old failure' },
      { type: 'isolationPreviewLoading', read: 2 },
      { type: 'isolationPreviewFailed', read: 1, message: 'stale failure' },
    ]);

    expect(state.isolationPreview).toBeNull();
  });

  it('shows a transport failure as a failed read, never as no repository', () => {
    const state = apply([
      { type: 'isolationPreviewLoading', read: 1 },
      { type: 'isolationPreviewFailed', read: 1, message: 'the server had stopped' },
    ]);

    expect(state.isolationPreview).toMatchObject({ status: 'failed', repos: [], shared: [], error: 'the server had stopped' });
    expect(text(state)).not.toContain('No Git repository');
  });

  it('asks again when a revived daemon answers, so a replaced workspace config is not kept', () => {
    const next = reduce(welcome({ isolationPreview: preview('ready', [on('.', 'main')]) }), { type: 'daemonReconnected' });

    expect(next.effects).toEqual([{ type: 'loadIsolationPreview' }]);
  });
});
