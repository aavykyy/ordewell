import { spawn } from 'child_process';
import { existsSync, readFileSync, unlinkSync, mkdirSync, openSync } from 'fs';
import { homedir } from 'os';
import { dirname, join, resolve } from 'path';
import http from 'http';
import { createServer } from 'net';
import { bearerHeaderValue, clearDaemonToken, globalDataDir, readDaemonToken } from '@ordewell/core';
import { flag } from './utils/args';

export const DEFAULT_PORT = 3742;
// Paths are read at call time, not import time: a test (and a shell that
// re-exports HOME) changes the home directory after this module loads.
function configDir(): string {
  return globalDataDir();
}

// Pre-`.ordewell` install: daemon tokens already moved to globalDataDir() via
// daemonToken.ts, but a daemon spawned by old code before this upgrade wrote
// its PID file here — `stopDaemon` falls back to it so that daemon is still
// reachable to stop, rather than orphaned by a path it doesn't know moved.
function oldConfigDir(): string {
  return join(homedir(), '.config', 'ordewell');
}

// One PID file per port so a second daemon doesn't clobber the first one's
// entry (and `stop --server --port N` kills the daemon the user meant).
function pidFileFor(port: number): string {
  const dir = configDir();
  return port === DEFAULT_PORT ? join(dir, 'server.pid') : join(dir, `server-${port}.pid`);
}

function oldPidFileFor(port: number): string {
  const dir = oldConfigDir();
  return port === DEFAULT_PORT ? join(dir, 'server.pid') : join(dir, `server-${port}.pid`);
}

/** The PID a file names, or undefined when it is missing or not a positive integer. */
function readPidFile(file: string): number | undefined {
  try {
    const pid = parseInt(readFileSync(file, 'utf8').trim(), 10);
    return Number.isInteger(pid) && pid > 0 ? pid : undefined;
  } catch {
    return undefined;
  }
}

type DaemonInfo =
  | { kind: 'daemon'; pid: number }
  /** Nothing owns the port: a stale PID file and token are safe to remove. */
  | { kind: 'unreachable' }
  /** Something owns the port, but it cannot prove which process it is. Never signal it. */
  | { kind: 'unverifiable' };

/**
 * Ask the daemon on `port` which process it is. A daemon older than this
 * route answers 404, and a mismatched token answers 401: both mean "someone
 * owns the port, but the PID file cannot be checked against it".
 */
async function daemonInfo(port: number): Promise<DaemonInfo> {
  const token = readDaemonToken(port);
  try {
    const res = await httpGet(
      `http://127.0.0.1:${port}/api/server`,
      2000,
      token ? { Authorization: bearerHeaderValue(token) } : {},
    );
    if (res.status !== 200) return { kind: 'unverifiable' };
    const parsed: unknown = JSON.parse(res.data);
    const pid = (parsed as Partial<{ pid: unknown }>).pid;
    return typeof pid === 'number' && Number.isInteger(pid) && pid > 0
      ? { kind: 'daemon', pid }
      : { kind: 'unverifiable' };
  } catch (err) {
    const code = (err as { code?: string } | null)?.code;
    return code === 'ECONNREFUSED' || String(err).includes('ECONNREFUSED')
      ? { kind: 'unreachable' }
      : { kind: 'unverifiable' };
  }
}

function httpGet(
  url: string,
  timeoutMs: number = 2000,
  headers: Record<string, string> = {},
): Promise<{ status: number; data: string }> {
  return new Promise((resolve, reject) => {
    const req = http.get(url, { timeout: timeoutMs, headers }, (res) => {
      // Decoded once the body is whole: a multi-byte character split across two
      // chunks would otherwise turn into U+FFFD at the seam.
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => { chunks.push(chunk); });
      res.on('end', () => resolve({ status: res.statusCode || 0, data: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
  });
}

// The server ships as its own package (`@ordewell/web`) that this CLI depends
// on, so the installed layout resolves it like any other dependency. The
// relative path is the source-checkout case, where nothing is in node_modules
// yet — it is a fallback, not the primary, because it silently resolves to the
// wrong scope directory under a non-flat install.
function getWebServerPath(): string {
  const candidates: string[] = [];
  try {
    candidates.push(join(dirname(require.resolve('@ordewell/web/package.json')), 'dist', 'server', 'main.js'));
  } catch {
    // Not installed as a dependency — a source checkout, handled below.
  }
  candidates.push(resolve(__dirname, '..', '..', 'web', 'dist', 'server', 'main.js'));

  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  throw new Error(
    `Ordewell server not found (looked in: ${candidates.join(', ')}). `
    + `In a source checkout, run: npm run build -w packages/web`
  );
}

export async function isDaemonRunning(port: number = DEFAULT_PORT): Promise<boolean> {
  const token = readDaemonToken(port);
  try {
    const res = await httpGet(
      `http://127.0.0.1:${port}/api/workspaces`,
      2000,
      token ? { Authorization: bearerHeaderValue(token) } : {},
    );
    // 401 still means a daemon owns this port. Reporting it as absent would
    // send `startDaemon` to spawn a second one that cannot bind; reporting it
    // as present lets the next real request answer with the token-file message.
    return res.status === 200 || res.status === 401;
  } catch {
    return false;
  }
}

export async function startDaemon(
  port: number = DEFAULT_PORT,
  opts?: { detached?: boolean; quiet?: boolean; cwd?: string },
): Promise<void> {
  // A raw-mode full-screen client cannot afford stray writes to stdout: they
  // land inside the frame it is painting. `quiet` is for a revive that happens
  // while the TUI is on screen, not for startup, where the messages are useful.
  const say = opts?.quiet ? () => {} : (msg: string) => console.log(msg);
  if (await isDaemonRunning(port)) {
    say(`Server already running on http://127.0.0.1:${port}`);
    return;
  }

  const serverPath = getWebServerPath();

  const dir = configDir();
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  const pidFile = pidFileFor(port);
  const logFd = openSync(join(dir, 'server.log'), 'a');
  // detached=false puts the daemon in the caller's own process group, so a
  // terminal hangup (closing the tab) reaches it via the same kernel-delivered
  // SIGHUP as the caller — no JS-level signal relay required, and none of the
  // native stdio-teardown races a JS handler is exposed to on that path. Only
  // the TUI opts into this; every other command wants the default detached,
  // outlives-this-invocation daemon.
  const detached = opts?.detached ?? true;

  // Belt-and-braces for the not-detached case: process-group SIGHUP covers a
  // closed terminal tab, but not a caller killed by PID directly (`kill -9`)
  // or a multiplexer that doesn't relay the signal. `--watch-parent` has the
  // daemon poll for that and self-terminate, so an owned daemon never
  // outlives the CLI that spawned it and orphans don't accumulate.
  const child = spawn(process.execPath, [
    serverPath,
    '--port', String(port),
    // The daemon writes the file itself once it is listening, and removes it
    // on shutdown. A CLI-side write before the bind would leave the loser of a
    // two-CLI race owning the winner's entry, or a dead PID after a crash.
    '--pid-file', pidFile,
    ...(detached ? [] : ['--watch-parent', String(process.pid)]),
  ], {
    detached,
    stdio: ['ignore', logFd, logFd],
    env: { ...process.env },
    // A daemon owned by a workspace client must ask that workspace's account
    // about a login (ADR-0016), not the directory the client was launched from.
    ...(opts?.cwd ? { cwd: opts.cwd } : {}),
  });

  if (detached) child.unref();

  for (let i = 0; i < 30; i++) {
    await new Promise((r) => setTimeout(r, 500));
    if (await isDaemonRunning(port)) {
      // The daemon's own PID, not the child's: a child that lost the bind race
      // has exited, and the winner is what the message must name.
      say(`Server started on http://127.0.0.1:${port} (PID ${readPidFile(pidFile) ?? child.pid})`);
      return;
    }
  }

  const failure = `Server did not respond within 15s. Check logs: ${join(dir, 'server.log')}`;
  // A quiet caller is a live TUI: killing its process would drop the user out
  // of a full-screen app with a half-restored terminal, so it gets a throw to
  // handle instead. Every other caller keeps the exit it has always had.
  if (opts?.quiet) throw new Error(failure);
  console.error(failure);
  process.exit(1);
}

export async function stopDaemon(port: number = DEFAULT_PORT): Promise<boolean> {
  let pidFile = pidFileFor(port);
  if (!existsSync(pidFile) && existsSync(oldPidFileFor(port))) pidFile = oldPidFileFor(port);
  if (!existsSync(pidFile)) {
    console.error(`No server PID file found for port ${port}. Is the server running?`);
    return false;
  }

  const filePid = readPidFile(pidFile);
  if (!filePid) {
    try { unlinkSync(pidFile); } catch { /* empty */ }
    clearDaemonToken(port);
    console.error(`Removed an unreadable PID file for port ${port}. Is the server running?`);
    return false;
  }

  const info = await daemonInfo(port);
  if (info.kind === 'unverifiable') {
    // A PID from an unverified file may now belong to any process the OS has
    // recycled it for. Refuse rather than risk killing something unrelated.
    console.error(
      `A server owns port ${port} but could not name its own process (it may predate this check, or the token file is stale). `
      + `Not signalling PID ${filePid}. Stop it yourself with: kill ${filePid}`,
    );
    return false;
  }
  if (info.kind === 'unreachable') {
    try { unlinkSync(pidFile); } catch { /* empty */ }
    // A daemon killed outright never ran its own shutdown, so its token file
    // may still be sitting there looking usable.
    clearDaemonToken(port);
    console.log('Server was not running (stale PID removed).');
    return true;
  }

  const pid = info.pid;
  try {
    process.kill(pid, 'SIGTERM');
  } catch (err) {
    const code = (err as Error & { code?: string }).code;
    if (code !== 'ESRCH') throw err;
    try { unlinkSync(pidFile); } catch { /* empty */ }
    console.log('Server was not running (stale PID removed).');
    return true;
  }
  try { unlinkSync(pidFile); } catch { /* empty */ }
  console.log(pid === filePid
    ? `Server stopped (PID ${pid}).`
    : `Server stopped (PID ${pid}); its PID file named the stale ${filePid}.`);
  return true;
}

export async function ensureDaemon(port?: number): Promise<number> {
  const { port: p } = await ensureDaemonOwned(port);
  return p;
}

/**
 * Like `ensureDaemon`, but also reports whether this call spawned a fresh
 * daemon vs. found one already running. Callers that want to tie the
 * daemon's life to their own (e.g. the TUI) must only do so when `owned` is
 * true — otherwise they'd kill a daemon some other client (a concurrent
 * `ordewell web` or `ordewell tui`) is relying on.
 */
export async function ensureDaemonOwned(
  port?: number,
  opts?: { detached?: boolean; quiet?: boolean; cwd?: string },
): Promise<{ port: number; owned: boolean }> {
  const p = port || DEFAULT_PORT;
  if (await isDaemonRunning(p)) return { port: p, owned: false };
  if (!opts?.quiet) console.error(`Server not running. Starting daemon on port ${p}...`);
  await startDaemon(p, opts);
  return { port: p, owned: true };
}

/**
 * True when this error means "nothing was listening", as opposed to "the
 * server answered badly" or "the connection broke mid-flight".
 *
 * The distinction is what makes an automatic retry safe. ECONNREFUSED is
 * refused at the TCP handshake, so the request was never delivered and cannot
 * have been half-applied — replaying it is not a second execution. ECONNRESET
 * and EPIPE are deliberately *not* included: those can arrive after the server
 * read the request, so a retry could start a second plan or a second run.
 */
export function isConnectionRefused(err: unknown): boolean {
  const code = (err as { code?: unknown } | null)?.code;
  if (code === 'ECONNREFUSED') return true;
  // The code survives a normal reject, but not every layer preserves it —
  // `String(err)` through a worker boundary keeps only the message.
  const message = err instanceof Error ? err.message : String(err ?? '');
  return message.includes('ECONNREFUSED');
}

/**
 * What to tell a user whose daemon is not there. Node's own wording — `connect
 * ECONNREFUSED 127.0.0.1:3742` — names a socket, not a thing they can act on.
 */
export function describeConnectionRefused(port: number): string {
  return `No Ordewell server is listening on port ${port}. `
    + `It may have been stopped, or it may have crashed: check ${join(configDir(), 'server.log')}. `
    + `Start one with \`ordewell web --daemon\`.`;
}

/**
 * An OS-assigned free port, so a caller that wants a private daemon doesn't
 * have to guess one that's actually unused.
 */
export function findFreePort(): Promise<number> {
  return new Promise((resolvePromise, reject) => {
    const srv = createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const address = srv.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      srv.close(() => resolvePromise(port));
    });
  });
}

/**
 * Which daemon a command should talk to: explicit `--port`, else ORDEWELL_PORT,
 * else the default. Lets a CLI invocation target an isolated second daemon
 * instead of whatever is already on 3742.
 */
export function resolvePort(args: string[] = []): number {
  const parsedArg = parseInt(flag(args, '--port') ?? '', 10);
  if (!isNaN(parsedArg) && parsedArg > 0) return parsedArg;
  const fromEnv = parseInt(process.env.ORDEWELL_PORT ?? '', 10);
  if (!isNaN(fromEnv) && fromEnv > 0) return fromEnv;
  return DEFAULT_PORT;
}
