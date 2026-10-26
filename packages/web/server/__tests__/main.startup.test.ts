import { execFileSync, spawn } from 'child_process';
import { createServer } from 'http';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { createServer as createNetServer } from 'net';
import { tmpdir } from 'os';
import { join, resolve } from 'path';
import { beforeAll, describe, expect, it } from 'vitest';
import { daemonBuild, daemonBuildFailure } from './daemonBuild';

// These spawn the built daemon, but `test:quick` on a fresh checkout has no
// dist yet, and the missing build then fails as a fifteen-second "timed out
// waiting for the daemon". Building it here also keeps a stale bundle from
// deciding what the tests see.
beforeAll(() => {
  const build = daemonBuild();
  try {
    execFileSync(build.file, build.args, { cwd: build.cwd, stdio: ['ignore', 'ignore', 'pipe'], encoding: 'utf8' });
  } catch (error) {
    throw daemonBuildFailure(error);
  }
}, 60_000);

function freePort(): Promise<number> {
  return new Promise((resolvePort) => {
    const srv = createNetServer();
    srv.listen(0, '127.0.0.1', () => {
      const address = srv.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      srv.close(() => resolvePort(port));
    });
  });
}

async function waitFor(predicate: () => boolean, timeoutMs = 15000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('timed out waiting for the daemon');
    await new Promise((resolveTick) => setTimeout(resolveTick, 100));
  }
}

describe('daemon startup', () => {
  it('writes its PID file only once listening, and removes it on shutdown', async () => {
    const home = mkdtempSync(join(tmpdir(), 'ordewell-daemon-pid-'));
    mkdirSync(join(home, '.ordewell'));
    const port = await freePort();
    const pidFile = join(home, '.ordewell', `server-${port}.pid`);
    const child = spawn(process.execPath, [
      resolve(__dirname, '../../dist/server/main.js'),
      '--port', String(port),
      '--pid-file', pidFile,
    ], {
      env: { HOME: home, USERPROFILE: home, PATH: '', AI_PROVIDER: 'codex', ORDEWELL_ENABLED_RUNNERS: 'codex' },
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    try {
      await waitFor(() => {
        try { return readFileSync(pidFile, 'utf8').trim() === String(child.pid); } catch { return false; }
      });
      expect(readFileSync(pidFile, 'utf8').trim()).toBe(String(child.pid));

      child.kill('SIGTERM');
      await new Promise<void>((resolveExit) => child.once('close', () => resolveExit()));
      expect(() => readFileSync(pidFile, 'utf8')).toThrow();
    } finally {
      child.kill('SIGKILL');
      rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  });

  it('keeps an owned daemon alive through a SIGINT, so cancelling a login does not stop it', async () => {
    // The TUI ignores Ctrl-C while its login child owns the tty, but the tty
    // delivers SIGINT to the whole foreground group — this daemon included.
    // Treating it as a stop would kill every in-memory session under the login
    // the user only meant to cancel.
    const home = mkdtempSync(join(tmpdir(), 'ordewell-daemon-sigint-'));
    mkdirSync(join(home, '.ordewell'));
    const port = await freePort();
    const pidFile = join(home, '.ordewell', `server-${port}.pid`);
    const child = spawn(process.execPath, [
      resolve(__dirname, '../../dist/server/main.js'),
      '--port', String(port),
      '--pid-file', pidFile,
      '--watch-parent', String(process.pid),
    ], {
      env: { HOME: home, USERPROFILE: home, PATH: '', AI_PROVIDER: 'codex', ORDEWELL_ENABLED_RUNNERS: 'codex' },
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    let closed = false;
    child.once('close', () => { closed = true; });
    try {
      await waitFor(() => {
        try { return readFileSync(pidFile, 'utf8').trim() === String(child.pid); } catch { return false; }
      });

      child.kill('SIGINT');
      await new Promise((resolveTick) => setTimeout(resolveTick, 500));

      expect(closed).toBe(false);
      expect(readFileSync(pidFile, 'utf8').trim()).toBe(String(child.pid));

      child.kill('SIGTERM');
      await new Promise<void>((resolveExit) => child.once('close', () => resolveExit()));
    } finally {
      child.kill('SIGKILL');
      rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  });

  it('preserves the listening daemon token when another daemon cannot bind its port', async () => {
    const home = mkdtempSync(join(tmpdir(), 'ordewell-daemon-start-'));
    const incumbent = createServer((_req, res) => res.end('incumbent'));
    await new Promise<void>((resolve) => incumbent.listen(0, '127.0.0.1', resolve));
    const address = incumbent.address();
    if (!address || typeof address === 'string') throw new Error('No listening port');
    const dataDir = join(home, '.ordewell');
    mkdirSync(dataDir);
    const tokenFile = join(dataDir, `server-${address.port}.token`);
    writeFileSync(tokenFile, 'incumbent-token');
    const child = spawn(process.execPath, [resolve(__dirname, '../../dist/server/main.js'), '--port', String(address.port)], {
      env: { HOME: home, USERPROFILE: home, PATH: '', AI_PROVIDER: 'codex', ORDEWELL_ENABLED_RUNNERS: 'codex' },
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    let stderr = '';
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
    try {
      const exit = await new Promise<number | null>((resolve, reject) => {
        child.once('error', reject);
        child.once('close', resolve);
      });
      expect(exit).not.toBe(0);
      expect(stderr).toContain('EADDRINUSE');
      expect(readFileSync(tokenFile, 'utf8')).toBe('incumbent-token');
      expect(await (await fetch(`http://127.0.0.1:${address.port}`)).text()).toBe('incumbent');
    } finally {
      child.kill();
      await new Promise<void>((resolve) => incumbent.close(() => resolve()));
      rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  });
});
