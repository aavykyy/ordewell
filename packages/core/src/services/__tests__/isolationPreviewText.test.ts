import { describe, it, expect } from 'vitest';
import { describeIsolationPreview } from '../isolationPreviewText';
import type { IsolationPreview, PreviewRepo } from '../../interfaces/IWorktreeIsolation';

const on = (path: string, branch: string, extra: Partial<PreviewRepo> = {}): PreviewRepo => ({ path, head: { kind: 'branch', branch, commit: 'a1b2c3d' }, dirty: false, ...extra });
const of = (status: IsolationPreview['status'], repos: PreviewRepo[] = [], extra: Partial<IsolationPreview> = {}): IsolationPreview => ({ status, repos, shared: [], ...extra });

describe('describeIsolationPreview', () => {
  it('says code tasks get isolated worktrees from the repositories and branches listed, and that ops tasks do not', () => {
    const notice = describeIsolationPreview(of('ready', [on('.', 'main')]));

    expect(notice.summary).toBe('Code tasks run in isolated git worktrees based on the repositories and branches below.');
    expect(notice.note).toContain('Ops and script tasks use your checkout');
    expect(notice.repos).toEqual([{ name: 'This workspace', detail: 'on main (a1b2c3d)' }]);
  });

  it('lists every repository of a group, by its workspace-relative path', () => {
    const repos = ['api', 'services/billing', 'web'].map((p) => on(p, 'main'));

    expect(describeIsolationPreview(of('ready', repos)).repos.map((r) => r.name)).toEqual(['api', 'services/billing', 'web']);
  });

  it('names a detached HEAD by its commit and a repository above the workspace by where it starts', () => {
    const notice = describeIsolationPreview(of('ready', [
      { path: '.', top: '../..', head: { kind: 'detached', commit: 'deadbee' }, dirty: false },
    ]));

    expect(notice.repos).toEqual([{ name: 'Repository above this workspace (../..)', detail: 'detached HEAD at deadbee' }]);
  });

  it('says a commitless repository of a ready group is shared, not isolated', () => {
    const notice = describeIsolationPreview(of('ready', [on('api', 'main'), { path: 'new', head: { kind: 'unborn', branch: 'main' } }]));

    expect(notice.repos[1].detail).toBe('no commits yet on main; tasks share it instead of isolating it');
  });

  it('waits for the start-time decision on a dirty tree rather than promising or denying isolation', () => {
    const notice = describeIsolationPreview(of('dirty', [on('.', 'main', { dirty: true })]));

    expect(notice.summary).toContain('once you decide what to do with uncommitted changes');
    expect(notice.note).toContain('stash them or run without isolation');
    expect(notice.repos[0].detail).toBe('on main (a1b2c3d) · uncommitted changes to tracked files');
    expect(notice.summary).not.toContain('without isolated worktrees');
  });

  it.each([
    ['no-repo', 'No Git repository detected. Tasks run in the workspace without isolated worktrees.'],
    ['disabled', 'Worktree isolation is turned off, so tasks run in the workspace without isolated worktrees.'],
    ['git-missing', 'Git was not found, so tasks run in the workspace without isolated worktrees.'],
    ['no-commits', 'No repository has a commit yet, so tasks run in the workspace without isolated worktrees.'],
  ] as const)('says tasks run in the workspace for %s', (status, summary) => {
    expect(describeIsolationPreview(of(status)).summary).toBe(summary);
  });

  it('never claims there is no repository when it could not look', () => {
    const notice = describeIsolationPreview(of('failed', [], { error: 'git could not be read in the workspace' }));

    expect(notice.summary).toContain("can't say yet");
    expect(notice.summary).not.toMatch(/No Git repository|without isolated worktrees/);
    expect(notice.note).toContain('git could not be read in the workspace');
  });

  it('names what tasks share live, and counts what it leaves out of a long list', () => {
    const shared = ['a', 'b', 'c', 'd', 'e', 'f', 'g'];

    expect(describeIsolationPreview(of('ready', [on('.', 'main')], { shared: ['vendored'] })).shared).toBe('Shared live between tasks: vendored');
    expect(describeIsolationPreview(of('ready', [on('.', 'main')], { shared })).shared).toBe('Shared live between tasks: a, b, c, d, e and 2 more');
    expect(describeIsolationPreview(of('ready', [on('.', 'main')])).shared).toBeUndefined();
  });
});
