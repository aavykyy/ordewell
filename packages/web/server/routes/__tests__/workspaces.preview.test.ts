import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Hono } from 'hono';
import { execFileSync } from 'child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type { IIsolationPreview, IsolationPreview } from '@ordewell/core';
import { OrchestratorPool } from '../../pool/orchestratorPool';
import { workspacesRoute } from '../workspaces';

function appWith(preview: IIsolationPreview): Hono {
  const pool = { previewIsolation: (workspace: string) => preview.preview(workspace) } as unknown as OrchestratorPool;
  const app = new Hono();
  app.route('/api/workspaces', workspacesRoute(pool));
  return app;
}

const answers = (preview: IsolationPreview): IIsolationPreview => ({ preview: async () => preview });

describe('GET /api/workspaces/isolation-preview', () => {
  it('answers with the repositories, branches and isolation status for the workspace asked about', async () => {
    const preview: IsolationPreview = {
      status: 'ready',
      repos: [{ path: '.', head: { kind: 'branch', branch: 'main', commit: 'a1b2c3d' }, dirty: false }],
      shared: [],
    };
    const seen: string[] = [];
    const app = appWith({ preview: async (workspace) => { seen.push(workspace); return preview; } });

    const res = await app.request(`/api/workspaces/isolation-preview?workspace=${encodeURIComponent(process.cwd())}`);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ preview });
    expect(seen).toEqual([process.cwd()]);
  });

  it.each<[IsolationPreview['status'], IsolationPreview]>([
    ['ready', { status: 'ready', repos: [{ path: 'api', head: { kind: 'branch', branch: 'feature/x', commit: 'd4e5f6a' } }, { path: 'web', head: { kind: 'detached', commit: 'deadbee' } }], shared: ['web'] }],
    ['no-repo', { status: 'no-repo', repos: [], shared: [] }],
    ['disabled', { status: 'disabled', repos: [{ path: '.', head: { kind: 'branch', branch: 'main', commit: 'a1b2c3d' } }], shared: [] }],
    ['failed', { status: 'failed', repos: [], shared: [], error: 'git could not be read in the workspace' }],
  ])('carries a %s preview through unchanged', async (_status, preview) => {
    const res = await appWith(answers(preview)).request(`/api/workspaces/isolation-preview?workspace=${encodeURIComponent(process.cwd())}`);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ preview });
  });

  it('waits for the read instead of answering with an empty one', async () => {
    let answer: (preview: IsolationPreview) => void = () => {};
    const app = appWith({ preview: () => new Promise((resolve) => { answer = resolve; }) });

    const pending = Promise.resolve(app.request(`/api/workspaces/isolation-preview?workspace=${encodeURIComponent(process.cwd())}`));
    let answered = false;
    void pending.then(() => { answered = true; });
    await Promise.resolve();
    expect(answered).toBe(false);
    answer({ status: 'no-repo', repos: [], shared: [] });

    expect(await (await pending).json()).toEqual({ preview: { status: 'no-repo', repos: [], shared: [] } });
  });

  it('refuses a workspace that does not exist instead of calling it no repository', async () => {
    const preview = vi.fn(async (): Promise<IsolationPreview> => ({ status: 'no-repo', repos: [], shared: [] }));
    const res = await appWith({ preview }).request('/api/workspaces/isolation-preview?workspace=%2Fdefinitely%2Fnot%2Fhere');

    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ code: 'workspace_not_found' });
    expect(preview).not.toHaveBeenCalled();
  });
});

describe('the daemon preview of a real workspace', () => {
  let dir: string;
  let savedIsolation: string | undefined;
  let savedRepos: string | undefined;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'ordewell-workspaces-preview-'));
    savedIsolation = process.env.ORDEWELL_WORKTREE_ISOLATION;
    savedRepos = process.env.ORDEWELL_WORKSPACE_REPOS;
    delete process.env.ORDEWELL_WORKTREE_ISOLATION;
    delete process.env.ORDEWELL_WORKSPACE_REPOS;
  });

  afterEach(() => {
    if (savedIsolation === undefined) delete process.env.ORDEWELL_WORKTREE_ISOLATION;
    else process.env.ORDEWELL_WORKTREE_ISOLATION = savedIsolation;
    if (savedRepos === undefined) delete process.env.ORDEWELL_WORKSPACE_REPOS;
    else process.env.ORDEWELL_WORKSPACE_REPOS = savedRepos;
    rmSync(dir, { recursive: true, force: true });
  });

  it('reads a repository through the pool the daemon serves and says the branch', async () => {
    const repo = join(dir, 'repo');
    execFileSync('git', ['init', '-q', repo]);
    writeFileSync(join(repo, 'README.md'), '# hi\n');
    execFileSync('git', ['-C', repo, 'add', '.']);
    execFileSync('git', ['-C', repo, '-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-q', '-m', 'init']);
    const app = new Hono();
    app.route('/api/workspaces', workspacesRoute(new OrchestratorPool()));

    const res = await app.request(`/api/workspaces/isolation-preview?workspace=${encodeURIComponent(repo)}`);

    expect(res.status).toBe(200);
    const { preview } = (await res.json()) as { preview: IsolationPreview };
    expect(preview.status).toBe('ready');
    expect(preview.repos).toHaveLength(1);
    expect(preview.repos[0].path).toBe('.');
    expect(preview.repos[0].head).toMatchObject({ kind: 'branch', branch: expect.any(String), commit: expect.any(String) });
  });

  it('keeps the existing list route listing known session workspaces', async () => {
    const app = new Hono();
    app.route('/api/workspaces', workspacesRoute(new OrchestratorPool()));

    const res = await app.request('/api/workspaces');

    expect(res.status).toBe(200);
    expect(await res.json()).toHaveProperty('workspaces');
  });
});
