import { createHash } from 'crypto';
import { promises as fs } from 'fs';
import { homedir as osHomedir } from 'os';
import { join, resolve } from 'path';
import { Worker, type WorkerOptions } from 'worker_threads';

/*
 * The one OpenCode login that would pay for a Go model, read from where
 * OpenCode keeps it and from nowhere else (ADR-0051). Only the host holds what
 * this returns, only for the request it makes: it is never logged, saved,
 * sent to a webview, the planner or a model, and never refreshed here.
 */

/** A login a Go quota can be asked with. `owner` compares accounts and holds no secret. */
export type OpenCodeGoCredential =
  /** A Console sign-in: its access token, the organization it acts in, and when OpenCode will refresh it. */
  | { route: 'console'; owner: string; access: string; orgID?: string; expires: number }
  /** An API key bound to one workspace: a Go key, or a Console workspace key. */
  | { route: 'key'; owner: string; key: string };

export type OpenCodeGoLogin =
  | { kind: 'login'; login: OpenCodeGoCredential }
  /** No login OpenCode would use for Go. */
  | { kind: 'none' }
  /** A login there is no qualified way to ask a quota with, or a runtime that cannot read the store. */
  | { kind: 'unsupported' }
  /** The store could not be read in time, is malformed, or does not name one login. */
  | { kind: 'unreadable' };

export interface OpenCodeGoLoginReaderDeps {
  homedir?: () => string;
  /** How long one read of the database may take, worker and all. */
  timeoutMs?: number;
  /** The worker boundary; a test counts what it starts. */
  spawnWorker?: (source: string, options: WorkerOptions) => Worker;
  /** Node options the worker starts with: a test turns SQLite off to stand for a runtime without it. */
  workerExecArgv?: string[];
}

export interface OpenCodeGoLoginReader {
  read(env: NodeJS.ProcessEnv, signal: AbortSignal): Promise<OpenCodeGoLogin>;
}

const DEFAULT_TIMEOUT_MS = 5_000;
/** How long the worker waits on a writer's lock before calling the store unreadable. */
const BUSY_MS = 250;
/** No credential value or v1 auth file is anywhere near this; a bigger one is not read. */
const MAX_VALUE_BYTES = 64 * 1024;
const MAX_AUTH_FILE_BYTES = 1024 * 1024;

/**
 * The integrations a Go model is paid through, in the order they win: a
 * Console login serves Go when the Console's config lists it — OpenCode then
 * rebinds the provider to `opencode` (v2.1.4 plugin/provider/opencode.ts) —
 * and only without one does the `opencode-go` key serve it.
 */
const GO_INTEGRATIONS = ['opencode', 'opencode-go'] as const;
const CONSOLE_SERVERS = new Set(['https://opencode.ai/console', 'https://console.opencode.ai']);
/** The variable OpenCode reads a Go key from when it has no stored login; never read here. */
const ENV_KEY = 'OPENCODE_API_KEY';

/**
 * The worker's whole program. `node:sqlite`'s calls are synchronous, so they
 * run off the host's thread: a slow disk or a writer's lock stalls this
 * worker, never the extension. It opens read-only with a short busy wait —
 * immutable for a WAL store with no WAL beside it, which no writer has open
 * and whose main file holds everything, since a read-only open would create
 * the WAL and its index there — ranks the integration's connections the way OpenCode's own switch does
 * (v2.1.4 credential.ts: active, then newest), reads the value of the first
 * only, and runs no migration, pragma that writes, or query of any other row's
 * secret. A Node without the module, or older than its `readOnly` and
 * `timeout` options and URL paths (22.16), answers `no_sqlite`.
 */
const WORKER_SOURCE = `
const { parentPort, workerData } = require('worker_threads');
const { closeSync, existsSync, openSync, readSync } = require('fs');
const { pathToFileURL } = require('url');
function select() {
  const [major, minor] = process.versions.node.split('.').map(Number);
  if (major < 22 || (major === 22 && minor < 16) || major === 23) return { kind: 'no_sqlite' };
  // The module's experimental notice is not the extension's to print.
  process.removeAllListeners('warning');
  let sqlite;
  try { sqlite = require('node:sqlite'); } catch { return { kind: 'no_sqlite' }; }
  const Database = sqlite.Database || sqlite.DatabaseSync;
  let db;
  const location = pathToFileURL(workerData.path);
  if (walStore(workerData.path) && !existsSync(workerData.path + '-wal')) location.searchParams.set('immutable', '1');
  try { db = new Database(location, { readOnly: true, timeout: workerData.busyMs }); } catch { return { kind: 'unreadable' }; }
  try {
    if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'credential'").get()) return { kind: 'no_table' };
    const rank = db.prepare('SELECT id, active FROM credential WHERE integration_id = ? ORDER BY active DESC, time_created DESC, id DESC LIMIT 2');
    for (const integration of workerData.integrations) {
      const rows = rank.all(integration);
      if (rows.length === 0) continue;
      if (rows.length > 1 && rows[0].active === 1 && rows[1].active === 1) return { kind: 'unreadable' };
      const id = String(rows[0].id);
      const row = db.prepare('SELECT value FROM credential WHERE id = ?').get(id);
      const value = row && typeof row.value === 'string' && row.value.length <= workerData.maxValueBytes ? row.value : null;
      return { kind: 'row', integration, id, value };
    }
    return { kind: 'none' };
  } catch {
    return { kind: 'unreadable' };
  } finally {
    db.close();
  }
}
// The header's read-version byte is 2 for a store in WAL mode.
function walStore(path) {
  const header = Buffer.alloc(20);
  let fd;
  try { fd = openSync(path, 'r'); return readSync(fd, header, 0, 20, 0) === 20 && header[18] === 2; }
  catch { return false; }
  finally { if (fd !== undefined) closeSync(fd); }
}
parentPort.postMessage(select());
`;

type StoreAnswer =
  | { kind: 'row'; integration: string; id: string; value: string | null }
  | { kind: 'none' | 'no_table' | 'no_sqlite' | 'unreadable' };

type Json = Record<string, unknown>;
const isRecord = (value: unknown): value is Json => typeof value === 'object' && value !== null && !Array.isArray(value);
const digest = (...parts: string[]) => createHash('sha256').update(parts.join('\0')).digest('hex').slice(0, 32);

/**
 * Where OpenCode keeps its logins, as it resolves them: its data directory is
 * `$XDG_DATA_HOME/opencode` or the XDG default under home on every platform
 * (v2.1.4 util/global-roots.ts); v2's database is `OPENCODE_DB`, relative to
 * it or absolute, else `opencode.db` (cli/database-path.ts) — a pre-release
 * channel's own `opencode-<channel>.db` is found only through `OPENCODE_DB`;
 * v1's logins are its `auth.json`, or `OPENCODE_AUTH_CONTENT` over it.
 */
export function openCodeStorePaths(env: NodeJS.ProcessEnv, home: string): { db: string | null; auth: string } {
  const data = join(env.XDG_DATA_HOME || join(home, '.local', 'share'), 'opencode');
  const file = env.OPENCODE_DB || 'opencode.db';
  return { db: file === ':memory:' ? null : resolve(data, file), auth: join(data, 'auth.json') };
}

/**
 * Reads the login on demand, and again only once a file it came from has
 * changed: an unchanged store is answered from the last read, with no worker.
 */
export function openCodeGoLoginReader(deps: OpenCodeGoLoginReaderDeps = {}): OpenCodeGoLoginReader {
  const homedir = deps.homedir ?? osHomedir;
  let last: { key: string; login: OpenCodeGoLogin } | undefined;

  return {
    async read(env, signal) {
      if (signal.aborted) return { kind: 'unreadable' };
      const paths = openCodeStorePaths(env, homedir());
      const [db, wal, auth] = await Promise.all([
        paths.db ? stamp(paths.db) : null,
        paths.db ? stamp(`${paths.db}-wal`) : null,
        stamp(paths.auth),
      ]);
      const key = JSON.stringify([paths, db, wal, auth, env.OPENCODE_AUTH_CONTENT ? digest(env.OPENCODE_AUTH_CONTENT) : '', Boolean(env[ENV_KEY])]);
      if (last?.key === key) return last.login;
      const login = await readLogin(paths, db !== null, env, signal, deps);
      if (signal.aborted) return { kind: 'unreadable' };
      // A store mid-write reads again next time rather than keeping a failure.
      last = login.kind === 'unreadable' ? undefined : { key, login };
      return login;
    },
  };
}

async function readLogin(paths: { db: string | null; auth: string }, hasDb: boolean, env: NodeJS.ProcessEnv, signal: AbortSignal, deps: OpenCodeGoLoginReaderDeps): Promise<OpenCodeGoLogin> {
  if (paths.db === null) return { kind: 'unsupported' };
  if (hasDb) {
    const answer = await queryStore(paths.db, signal, deps);
    switch (answer.kind) {
      case 'row': return v2Login(paths.db, answer);
      case 'none': return env[ENV_KEY] ? { kind: 'unsupported' } : { kind: 'none' };
      // Whether this database holds the logins cannot be told, so auth.json may be a stale copy.
      case 'no_sqlite': return { kind: 'unsupported' };
      case 'unreadable': return { kind: 'unreadable' };
      case 'no_table': break;
    }
  }
  return legacyLogin(paths.auth, env);
}

function v2Login(db: string, row: Extract<StoreAnswer, { kind: 'row' }>): OpenCodeGoLogin {
  const value = parseJson(row.value);
  if (!isRecord(value)) return { kind: 'unreadable' };
  const metadata = isRecord(value.metadata) ? value.metadata : {};
  if (value.type === 'key') {
    if (typeof value.key !== 'string' || value.key.length === 0) return { kind: 'unreadable' };
    return { kind: 'login', login: { route: 'key', owner: digest('v2', db, row.id, value.key), key: value.key } };
  }
  // A Go-only integration has no sign-in of its own; an external login keeps its secret outside the store.
  if (value.type !== 'oauth' || row.integration !== 'opencode') return { kind: 'unsupported' };
  const server = metadata.server === undefined ? 'https://opencode.ai/console' : metadata.server;
  if (typeof server !== 'string' || !CONSOLE_SERVERS.has(server.replace(/\/+$/, ''))) return { kind: 'unsupported' };
  if (typeof value.access !== 'string' || value.access.length === 0 || !Number.isSafeInteger(value.expires)) return { kind: 'unreadable' };
  const orgID = typeof metadata.orgID === 'string' && metadata.orgID.length > 0 ? metadata.orgID : undefined;
  const account = typeof metadata.accountID === 'string' ? metadata.accountID : '';
  return {
    kind: 'login',
    login: { route: 'console', owner: digest('console', db, row.id, account, orgID ?? ''), access: value.access, ...(orgID ? { orgID } : {}), expires: value.expires as number },
  };
}

/** v1 keeps every provider's login in one file; only the exact `opencode-go` entry is kept from it. */
async function legacyLogin(path: string, env: NodeJS.ProcessEnv): Promise<OpenCodeGoLogin> {
  const content = env.OPENCODE_AUTH_CONTENT ?? await readSmall(path);
  if (content === undefined) return env[ENV_KEY] ? { kind: 'unsupported' } : { kind: 'none' };
  if (content === null) return { kind: 'unreadable' };
  const auth = parseJson(content);
  if (!isRecord(auth)) return { kind: 'unreadable' };
  const entry = auth['opencode-go'];
  if (entry === undefined) return env[ENV_KEY] ? { kind: 'unsupported' } : { kind: 'none' };
  if (!isRecord(entry) || entry.type !== 'api') return { kind: 'unsupported' };
  if (typeof entry.key !== 'string' || entry.key.length === 0) return { kind: 'unreadable' };
  return { kind: 'login', login: { route: 'key', owner: digest('v1', path, entry.key), key: entry.key } };
}

function queryStore(path: string, signal: AbortSignal, deps: OpenCodeGoLoginReaderDeps): Promise<StoreAnswer> {
  return new Promise((settle) => {
    let worker: Worker;
    try {
      worker = (deps.spawnWorker ?? ((source, options) => new Worker(source, options)))(WORKER_SOURCE, {
        eval: true,
        workerData: { path, integrations: GO_INTEGRATIONS, busyMs: BUSY_MS, maxValueBytes: MAX_VALUE_BYTES },
        execArgv: deps.workerExecArgv ?? [],
        resourceLimits: { maxOldGenerationSizeMb: 64 },
      });
    } catch {
      settle({ kind: 'unreadable' });
      return;
    }
    let done = false;
    const finish = (answer: StoreAnswer) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      signal.removeEventListener('abort', aborted);
      void worker.terminate();
      settle(answer);
    };
    const aborted = () => finish({ kind: 'unreadable' });
    const timer = setTimeout(aborted, deps.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    timer.unref?.();
    signal.addEventListener('abort', aborted, { once: true });
    if (signal.aborted) aborted();
    worker.once('message', (answer: StoreAnswer) => finish(answer));
    worker.once('error', aborted);
    worker.once('exit', aborted);
  });
}

/** What tells a file has changed since it was read; null when it is not there. */
async function stamp(path: string): Promise<[number, number, number] | null> {
  try {
    const stat = await fs.stat(path);
    return [stat.ino, stat.size, stat.mtimeMs];
  } catch {
    return null;
  }
}

/** The file's text; undefined when it is not there, null when it cannot be read or is too big to be one. */
async function readSmall(path: string): Promise<string | undefined | null> {
  try {
    const stat = await fs.stat(path);
    if (!stat.isFile() || stat.size > MAX_AUTH_FILE_BYTES) return null;
    return await fs.readFile(path, 'utf8');
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'ENOENT' ? undefined : null;
  }
}

function parseJson(text: string | null): unknown {
  if (text === null) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}
