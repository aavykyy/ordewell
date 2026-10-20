import { describe, it, expect, vi } from 'vitest';
import { parseEnvFile, resolveWorkspaceEnv, type WorkspaceEnvDeps } from '../workspaceEnv';

const ROOT = '/work/app';
const WORKTREE = '/work/app/.ordewell/worktrees/run1/1-task';

function deps(over: {
  direnv?: { code?: number; stdout?: string; stderr?: string } | 'missing';
  files?: Record<string, string>;
  tracked?: string[];
  env?: NodeJS.ProcessEnv;
} = {}): Partial<WorkspaceEnvDeps> & { run: ReturnType<typeof vi.fn> } {
  const files = over.files ?? {};
  const run = vi.fn(async (command: string, args: string[], opts: { cwd: string }) => {
    if (command === 'direnv') {
      if (over.direnv === 'missing') throw new Error('spawn direnv ENOENT');
      return { code: 0, stdout: '', stderr: '', ...over.direnv };
    }
    const tracked = (over.tracked ?? []).includes(`${opts.cwd}/${args[2]}`);
    return { code: tracked ? 0 : 1, stdout: '', stderr: '' };
  });
  return {
    run,
    readFile: (file) => files[file] ?? null,
    isDirectory: () => true,
    baseEnv: over.env ?? { HOME: '/home/me', DIRENV_DIR: '-/elsewhere', DIRENV_DIFF: 'x' },
    home: '/home/me',
  };
}

describe('resolveWorkspaceEnv', () => {
  it("takes the variables direnv loads for the directory, computed afresh rather than against the daemon's own DIRENV state", async () => {
    const d = deps({ direnv: { stdout: JSON.stringify({ CLAUDE_CONFIG_DIR: '/home/me/.claude-work', DIRENV_DIR: '-/work/app', GONE: null }) } });

    const result = await resolveWorkspaceEnv(WORKTREE, d);

    expect(result.env).toEqual({ CLAUDE_CONFIG_DIR: '/home/me/.claude-work' });
    const [, args, opts] = d.run.mock.calls[0];
    expect(args).toEqual(['export', 'json']);
    // Asked in the checkout the worktree stands for: its linked .envrc copy is
    // a path direnv never allowed.
    expect(opts.cwd).toBe(ROOT);
    expect(Object.keys(opts.env).filter((k) => k.startsWith('DIRENV_'))).toEqual([]);
  });

  it('reports an .envrc direnv has blocked instead of silently going without it', async () => {
    const result = await resolveWorkspaceEnv(ROOT, deps({ direnv: { code: 1, stderr: '\x1b[31mdirenv: error /work/app/.envrc is blocked. Run `direnv allow` to approve its content' } }));

    expect(result).toMatchObject({ env: {}, blockedEnvrc: '/work/app/.envrc' });
  });

  it("finds the workspace's .ordewell/env from a task worktree below it, over direnv's values", async () => {
    const result = await resolveWorkspaceEnv(WORKTREE, deps({
      direnv: { stdout: JSON.stringify({ CLAUDE_CONFIG_DIR: '/from/direnv', OTHER: 'kept' }) },
      files: { '/work/app/.ordewell/env': 'export CLAUDE_CONFIG_DIR="$HOME/.claude-work"\n# a comment\nTOKEN=\'lit$eral\'\nNOTE=hi # trailing\n' },
    }));

    expect(result.env).toEqual({ CLAUDE_CONFIG_DIR: '/home/me/.claude-work', OTHER: 'kept', TOKEN: 'lit$eral', NOTE: 'hi' });
  });

  it('ignores an .ordewell/env that git tracks: a cloned repository must not choose it', async () => {
    const result = await resolveWorkspaceEnv(ROOT, deps({
      direnv: 'missing',
      files: { '/work/app/.ordewell/env': 'CLAUDE_CONFIG_DIR=/attacker' },
      tracked: ['/work/app/.ordewell/env'],
    }));

    expect(result).toMatchObject({ env: {}, trackedEnvFile: '/work/app/.ordewell/env' });
  });

  it('never passes loader, executable-path or Ordewell-settings variables on', async () => {
    const result = await resolveWorkspaceEnv(ROOT, deps({
      direnv: 'missing',
      files: { '/work/app/.ordewell/env': 'NODE_OPTIONS=--require /x.js\nLD_PRELOAD=/x.so\nPATH=/evil\nORDEWELL_SETTINGS_PATH=/x\nSAFE=1\n' },
    }));

    expect(result.env).toEqual({ SAFE: '1' });
    expect(result.refused.sort()).toEqual(['LD_PRELOAD', 'NODE_OPTIONS', 'ORDEWELL_SETTINGS_PATH', 'PATH']);
  });

  it('never takes the effect allowlist from a workspace env file or .envrc: it pre-approves effects, and is the user\'s alone (ADR-0035)', async () => {
    const result = await resolveWorkspaceEnv(ROOT, deps({
      direnv: { stdout: '{"ORDEWELL_EFFECT_ALLOW":"git push *"}' },
      files: { '/work/app/.ordewell/env': 'ORDEWELL_EFFECT_ALLOW=gh pr merge *\nSAFE=1\n' },
    }));

    expect(result.env).toEqual({ SAFE: '1' });
    expect(result.refused).toEqual(['ORDEWELL_EFFECT_ALLOW']);
  });

  it('leaves direnv alone when ORDEWELL_DIRENV is false, and works without direnv installed', async () => {
    const off = deps({ env: { ORDEWELL_DIRENV: 'false' }, direnv: { stdout: '{"A":"1"}' } });
    expect((await resolveWorkspaceEnv(ROOT, off)).env).toEqual({});
    expect(off.run).not.toHaveBeenCalledWith('direnv', expect.anything(), expect.anything());

    expect((await resolveWorkspaceEnv(ROOT, deps({ direnv: 'missing' }))).env).toEqual({});
  });
});

it('asks direnv in the matching directory of the checkout, for a task in a multi-repo worktree', async () => {
  const d = deps({ direnv: { stdout: '{}' } });

  await resolveWorkspaceEnv('/work/app/.ordewell/worktrees/run1/2-task/api/src', d);

  expect(d.run.mock.calls[0][2].cwd).toBe('/work/app/api/src');
});

describe('parseEnvFile', () => {
  it('expands variables and ~ in bare and double-quoted values, never in single-quoted ones', () => {
    const env = parseEnvFile('A=~/x\nB="${A}/y"\nC=\'$A\'\nexport D=$MISSING\n1BAD=no\n', { HOME: '/h' }, '/h');

    expect(env).toEqual({ A: '/h/x', B: '/h/x/y', C: '$A', D: '' });
  });
});
