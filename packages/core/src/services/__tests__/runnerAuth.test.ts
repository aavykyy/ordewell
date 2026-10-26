import { describe, it, expect, vi } from 'vitest';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readRunnerAuth, signedOutFromFailure, type RunnerAuthExec } from '../runnerAuth';
import { CLAUDE_CODE_MANIFEST } from '../../plugins/builtin/claude-code.manifest';
import { CODEX_MANIFEST } from '../../plugins/builtin/codex.manifest';
import { OPENCODE_MANIFEST } from '../../plugins/builtin/opencode.manifest';

type Answer = { code: number; stdout?: string; stderr?: string };

function execAnswering(answer: Answer): RunnerAuthExec & ReturnType<typeof vi.fn> {
  return vi.fn(async () => ({
    code: answer.code,
    stdout: answer.stdout ?? '',
    stderr: answer.stderr ?? '',
  })) as unknown as RunnerAuthExec & ReturnType<typeof vi.fn>;
}

describe('readRunnerAuth', () => {
  it('asks the runner its own status command and reads Claude signed in from a clean exit', async () => {
    const exec = execAnswering({ code: 0, stdout: '{"loggedIn":true,"authMethod":"claude.ai"}' });

    expect(await readRunnerAuth(CLAUDE_CODE_MANIFEST, { exec })).toEqual({
      state: 'signed-in',
      loginCommand: ['claude', 'auth', 'login'],
    });
    expect(exec).toHaveBeenCalledWith('claude', ['auth', 'status'], expect.anything());
  });

  it('reads Claude signed out from the JSON its status command prints on failure', async () => {
    // The shape `claude auth status` prints when the user logged out, observed on a signed-out host.
    const exec = execAnswering({
      code: 1,
      stdout: '{\n  "loggedIn": false,\n  "authMethod": "none",\n  "apiProvider": "firstParty"\n}\n',
    });

    expect(await readRunnerAuth(CLAUDE_CODE_MANIFEST, { exec })).toEqual({
      state: 'signed-out',
      loginCommand: ['claude', 'auth', 'login'],
      detail: 'not logged in',
    });
  });

  it('keeps an older Claude whose status output does not parse unknown, not signed out', async () => {
    const exec = execAnswering({ code: 1, stdout: 'error: unknown command auth', stderr: '' });

    expect(await readRunnerAuth(CLAUDE_CODE_MANIFEST, { exec })).toEqual({
      state: 'unknown',
      loginCommand: ['claude', 'auth', 'login'],
    });
  });

  it('reads Codex signed out from its own status line', async () => {
    // `codex login status` prints this and exits 1 on a signed-out host.
    const exec = execAnswering({ code: 1, stdout: 'Not logged in\n' });

    expect(await readRunnerAuth(CODEX_MANIFEST, { exec })).toEqual({
      state: 'signed-out',
      loginCommand: ['codex', 'login'],
      detail: 'not logged in',
    });
    expect(exec).toHaveBeenCalledWith('codex', ['login', 'status'], expect.anything());
  });

  it('reads Codex signed in from a clean status exit', async () => {
    const exec = execAnswering({ code: 0, stdout: 'Logged in using ChatGPT\n' });

    expect(await readRunnerAuth(CODEX_MANIFEST, { exec })).toEqual({
      state: 'signed-in',
      loginCommand: ['codex', 'login'],
    });
  });

  it('reports unknown when the binary is missing or the status command times out', async () => {
    const missing: RunnerAuthExec = vi.fn(async () => {
      throw Object.assign(new Error('spawn claude ENOENT'), { code: 'ENOENT' });
    });

    expect(await readRunnerAuth(CLAUDE_CODE_MANIFEST, { exec: missing })).toEqual({
      state: 'unknown',
      loginCommand: ['claude', 'auth', 'login'],
    });
  });

  it("runs the status command with the supplied workspace environment over the daemon's own", async () => {
    const exec: RunnerAuthExec = vi.fn(async () => ({ code: 0, stdout: '{}', stderr: '' }));

    await readRunnerAuth(CLAUDE_CODE_MANIFEST, { exec, env: { CLAUDE_CONFIG_DIR: '/home/me/.claude-b' } });

    const options = vi.mocked(exec).mock.calls[0][2];
    expect(options.env.CLAUDE_CONFIG_DIR).toBe('/home/me/.claude-b');
    expect(options.env.PATH).toBeTruthy();
    expect(options.timeout).toBeGreaterThan(0);
  });

  it("never throws when a runner's own reader fails", async () => {
    const manifest = {
      ...CLAUDE_CODE_MANIFEST,
      auth: { statusArgs: ['auth', 'status'], loginArgs: ['auth', 'login'], read: () => { throw new Error('boom'); } },
    };
    const exec = execAnswering({ code: 0, stdout: '{}' });

    expect(await readRunnerAuth(manifest, { exec })).toEqual({
      state: 'unknown',
      loginCommand: ['claude', 'auth', 'login'],
    });
  });

  it('reports a runner with no status command unknown and offers it no login', async () => {
    const exec: RunnerAuthExec = vi.fn(async () => ({ code: 0, stdout: '', stderr: '' }));

    expect(await readRunnerAuth(OPENCODE_MANIFEST, { exec })).toEqual({ state: 'unknown' });
    expect(exec).not.toHaveBeenCalled();
  });

  // A timeout is not an answer: execFile kills the child and hands back no
  // exit status, so whatever it printed before hanging must not be judged.
  it.skipIf(process.platform === 'win32')('reports unknown, not signed out, when a status probe times out after printing its line', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ordewell-auth-timeout-'));
    const cli = join(dir, 'codex');
    writeFileSync(cli, '#!/bin/sh\necho "Not logged in" >&2\nexec sleep 5\n');
    chmodSync(cli, 0o755);
    try {
      const manifest = { ...CODEX_MANIFEST, runner: { command: cli } };

      expect(await readRunnerAuth(manifest, { timeoutMs: 1000 })).toEqual({
        state: 'unknown',
        loginCommand: [cli, 'login'],
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('signedOutFromFailure', () => {
  it("reads the runner's own not-logged-in words as signed out, with its login command", () => {
    expect(signedOutFromFailure(CLAUDE_CODE_MANIFEST, 'Not logged in · Please run /login')).toEqual({
      state: 'signed-out',
      loginCommand: ['claude', 'auth', 'login'],
      detail: 'not logged in',
    });
    expect(signedOutFromFailure(CODEX_MANIFEST, 'Not logged in\n')).toEqual({
      state: 'signed-out',
      loginCommand: ['codex', 'login'],
      detail: 'not logged in',
    });
  });

  it('leaves an unrelated failure, and a runner that declares no login, unjudged', () => {
    expect(signedOutFromFailure(CLAUDE_CODE_MANIFEST, 'The repository is not a git repository')).toBeUndefined();
    expect(signedOutFromFailure(OPENCODE_MANIFEST, 'Not logged in · Please run /login')).toBeUndefined();
  });

  // The phrase alone is not the runner's own verdict: a failed turn may quote
  // another tool (GitHub CLI, an MCP server) that is not logged in. Recording
  // that as the agent's state walls the planner until the next probe.
  it('leaves an unrelated failure that merely mentions a login elsewhere', () => {
    const passage = 'gh: You are not logged in to any GitHub hosts.';
    expect(signedOutFromFailure(CLAUDE_CODE_MANIFEST, passage)).toBeUndefined();
    expect(signedOutFromFailure(CODEX_MANIFEST, passage)).toBeUndefined();
  });

  it("never throws when a runner's reader cannot judge a failure", () => {
    const manifest = {
      ...CLAUDE_CODE_MANIFEST,
      auth: { statusArgs: ['auth', 'status'], loginArgs: ['auth', 'login'], read: () => { throw new Error('boom'); } },
    };

    expect(signedOutFromFailure(manifest, 'anything')).toBeUndefined();
  });
});
