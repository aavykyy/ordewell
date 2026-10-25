import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type * as Sqlite from 'node:sqlite';
import { Worker, type WorkerOptions } from 'node:worker_threads';
import { mkdtempSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { openCodeGoLoginReader, type OpenCodeGoLogin } from '../openCodeCredentials';

/*
 * The reader against stores built here with OpenCode's own schema: the v2
 * `credential` table (v2.1.4 packages/core/src/credential/sql.ts, as its
 * migrations create it) and the v1 `auth.json`. Every secret is synthetic.
 */
const CREDENTIAL_TABLE = `CREATE TABLE credential (
  id text PRIMARY KEY, integration_id text, label text NOT NULL, value text NOT NULL,
  connector_id text, method_id text, active integer, time_created integer NOT NULL, time_updated integer NOT NULL)`;

// Vite resolves no `node:sqlite` import; the test's own Node has the module.
const { DatabaseSync } = process.getBuiltinModule('node:sqlite') as typeof Sqlite;

const HOUR = 3_600_000;
const NOW = Date.now();

interface Row { id: string; integration: string; value: unknown; active?: 0 | 1 | null; created?: number }

let home: string;
let data: string;
let workers: number;

const spawnWorker = (source: string, options: WorkerOptions) => { workers++; return new Worker(source, options); };
const reader = (over: Parameters<typeof openCodeGoLoginReader>[0] = {}) => openCodeGoLoginReader({ homedir: () => home, spawnWorker, ...over });
const read = (r = reader(), env: NodeJS.ProcessEnv = {}) => r.read(env, new AbortController().signal);

function store(rows: Row[], path = join(data, 'opencode.db')): string {
  const db = new DatabaseSync(path);
  db.exec(CREDENTIAL_TABLE);
  const insert = db.prepare('INSERT INTO credential (id, integration_id, label, value, active, time_created, time_updated) VALUES (?, ?, ?, ?, ?, ?, ?)');
  for (const row of rows) insert.run(row.id, row.integration, row.id, JSON.stringify(row.value), row.active ?? null, row.created ?? 1, row.created ?? 1);
  db.close();
  return path;
}

const consoleLogin = (over: Record<string, unknown> = {}, metadata: Record<string, unknown> = {}) => ({
  type: 'oauth', methodID: 'console', access: 'access-secret', refresh: 'refresh-secret', expires: NOW + 48 * HOUR,
  metadata: { server: 'https://opencode.ai/console', orgID: 'org-1', accountID: 'acct-1', email: 'a@example.test', ...metadata },
  ...over,
});
const goKey = (key = 'go-secret') => ({ type: 'key', key });

const loginOf = (result: OpenCodeGoLogin) => {
  if (result.kind !== 'login') throw new Error(`expected a login, got ${result.kind}`);
  return result.login;
};

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'oc-home-'));
  data = join(home, '.local', 'share', 'opencode');
  mkdirSync(data, { recursive: true });
  workers = 0;
});
afterEach(() => { rmSync(home, { recursive: true, force: true }); });

describe('reading the OpenCode login that serves Go', () => {
  it('takes the active Console sign-in, its organization and expiry, and never its refresh token', async () => {
    store([{ id: 'cred_a', integration: 'opencode', value: consoleLogin(), active: 1 }]);

    const login = loginOf(await read());

    expect(login).toMatchObject({ route: 'console', access: 'access-secret', orgID: 'org-1', expires: NOW + 48 * HOUR });
    expect(JSON.stringify(login)).not.toContain('refresh-secret');
    expect(login.owner).not.toContain('access-secret');
  });

  it('takes the Go key when there is no Console login', async () => {
    store([{ id: 'cred_g', integration: 'opencode-go', value: goKey(), active: 1 }]);

    const login = loginOf(await read());

    expect(login).toMatchObject({ route: 'key', key: 'go-secret' });
    expect(login.owner).not.toContain('go-secret');
  });

  it('follows the Console login, not a neighbouring Go key, because a Console login serves Go when configured', async () => {
    store([
      { id: 'cred_g', integration: 'opencode-go', value: goKey(), active: 1, created: 9 },
      { id: 'cred_a', integration: 'opencode', value: consoleLogin(), active: 1, created: 1 },
    ]);

    expect(loginOf(await read())).toMatchObject({ route: 'console' });
  });

  it('uses a Console API key as the workspace key it is', async () => {
    store([{ id: 'cred_k', integration: 'opencode', value: goKey('workspace-secret'), active: 1 }]);

    expect(loginOf(await read())).toMatchObject({ route: 'key', key: 'workspace-secret' });
  });

  it('picks the connection OpenCode does: the active one over a newer inactive one, else the newest', async () => {
    store([
      { id: 'cred_old', integration: 'opencode', value: consoleLogin({ access: 'old' }), active: 1, created: 1 },
      { id: 'cred_new', integration: 'opencode', value: consoleLogin({ access: 'new' }), active: 0, created: 5 },
    ]);
    expect(loginOf(await read())).toMatchObject({ access: 'old' });

    rmSync(join(data, 'opencode.db'));
    // Rows saved before the active flag have none, and OpenCode uses the newest.
    store([
      { id: 'cred_1', integration: 'opencode', value: consoleLogin({ access: 'first' }), created: 1 },
      { id: 'cred_2', integration: 'opencode', value: consoleLogin({ access: 'second' }), created: 5 },
    ]);
    expect(loginOf(await read())).toMatchObject({ access: 'second' });
  });

  it('refuses to choose between two connections both marked active', async () => {
    store([
      { id: 'cred_1', integration: 'opencode', value: consoleLogin({ access: 'one' }), active: 1, created: 1 },
      { id: 'cred_2', integration: 'opencode', value: consoleLogin({ access: 'two' }), active: 1, created: 5 },
    ]);

    expect(await read()).toEqual({ kind: 'unreadable' });
  });

  it.each([
    ['an external login', { type: 'external', methodID: 'sso' }],
    ['a sign-in to another Console server', consoleLogin({}, { server: 'https://console.example.test' })],
  ])('reads %s as unsupported, never as no login', async (_name, value) => {
    store([{ id: 'cred_a', integration: 'opencode', value, active: 1 }]);

    expect(await read()).toEqual({ kind: 'unsupported' });
  });

  it('treats the retired Console host as the official one, as OpenCode does', async () => {
    store([{ id: 'cred_a', integration: 'opencode', value: consoleLogin({}, { server: 'https://console.opencode.ai' }), active: 1 }]);

    expect(loginOf(await read())).toMatchObject({ route: 'console' });
  });

  it('reads a malformed login as unreadable', async () => {
    store([{ id: 'cred_a', integration: 'opencode', value: consoleLogin({ expires: 'soon' }), active: 1 }]);
    expect(await read()).toEqual({ kind: 'unreadable' });

    rmSync(join(data, 'opencode.db'));
    const db = new DatabaseSync(join(data, 'opencode.db'));
    db.exec(CREDENTIAL_TABLE);
    db.prepare('INSERT INTO credential (id, integration_id, label, value, active, time_created, time_updated) VALUES (?, ?, ?, ?, 1, 1, 1)').run('cred_a', 'opencode', 'x', '{not json');
    db.close();
    expect(await reader().read({}, new AbortController().signal)).toEqual({ kind: 'unreadable' });
  });

  it('keys the owner by connection and organization, not by a token OpenCode refreshes', async () => {
    store([{ id: 'cred_a', integration: 'opencode', value: consoleLogin(), active: 1 }]);
    const first = loginOf(await read()).owner;
    rmSync(join(data, 'opencode.db'));
    store([{ id: 'cred_a', integration: 'opencode', value: consoleLogin({ access: 'rotated', expires: NOW + 96 * HOUR }), active: 1 }]);
    const refreshed = loginOf(await read()).owner;
    rmSync(join(data, 'opencode.db'));
    store([{ id: 'cred_a', integration: 'opencode', value: consoleLogin({}, { orgID: 'org-2' }), active: 1 }]);
    const otherOrg = loginOf(await read()).owner;

    expect(refreshed).toBe(first);
    expect(otherOrg).not.toBe(first);
  });

  it('finds the store where OpenCode does: XDG_DATA_HOME, then OPENCODE_DB relative to it or absolute', async () => {
    const xdg = join(home, 'xdg');
    mkdirSync(join(xdg, 'opencode'), { recursive: true });
    store([{ id: 'cred_x', integration: 'opencode-go', value: goKey('xdg-secret'), active: 1 }], join(xdg, 'opencode', 'opencode.db'));
    store([{ id: 'cred_c', integration: 'opencode-go', value: goKey('channel-secret'), active: 1 }], join(xdg, 'opencode', 'opencode-canary.db'));
    const elsewhere = join(home, 'elsewhere.db');
    store([{ id: 'cred_e', integration: 'opencode-go', value: goKey('absolute-secret'), active: 1 }], elsewhere);

    expect(loginOf(await read(reader(), { XDG_DATA_HOME: xdg }))).toMatchObject({ key: 'xdg-secret' });
    expect(loginOf(await read(reader(), { XDG_DATA_HOME: xdg, OPENCODE_DB: 'opencode-canary.db' }))).toMatchObject({ key: 'channel-secret' });
    expect(loginOf(await read(reader(), { OPENCODE_DB: elsewhere }))).toMatchObject({ key: 'absolute-secret' });
    expect(await read(reader(), { OPENCODE_DB: ':memory:' })).toEqual({ kind: 'unsupported' });
  });

  it('reads the v1 auth.json entry for opencode-go exactly, when there is no v2 store', async () => {
    writeFileSync(join(data, 'auth.json'), JSON.stringify({ opencode: { type: 'api', key: 'zen-secret' }, 'opencode-go': { type: 'api', key: 'legacy-secret' } }));
    expect(loginOf(await read())).toMatchObject({ route: 'key', key: 'legacy-secret' });

    writeFileSync(join(data, 'auth.json'), JSON.stringify({ opencode: { type: 'api', key: 'zen-secret' } }));
    expect(await read()).toEqual({ kind: 'none' });

    writeFileSync(join(data, 'auth.json'), JSON.stringify({ 'opencode-go': { type: 'oauth', access: 'a', refresh: 'r', expires: 1 } }));
    expect(await read()).toEqual({ kind: 'unsupported' });

    writeFileSync(join(data, 'auth.json'), '{nope');
    expect(await read()).toEqual({ kind: 'unreadable' });
  });

  it('reads auth.json when the database is a v1 one with no credential table, and OPENCODE_AUTH_CONTENT over it', async () => {
    const db = new DatabaseSync(join(data, 'opencode.db'));
    db.exec('CREATE TABLE session (id text PRIMARY KEY)');
    db.close();
    writeFileSync(join(data, 'auth.json'), JSON.stringify({ 'opencode-go': { type: 'api', key: 'file-secret' } }));

    expect(loginOf(await read())).toMatchObject({ key: 'file-secret' });
    expect(loginOf(await read(reader(), { OPENCODE_AUTH_CONTENT: JSON.stringify({ 'opencode-go': { type: 'api', key: 'env-secret' } }) }))).toMatchObject({ key: 'env-secret' });
  });

  it('never falls back to a stale auth.json once OpenCode keeps its logins in the database', async () => {
    store([{ id: 'cred_z', integration: 'anthropic', value: goKey('other'), active: 1 }]);
    writeFileSync(join(data, 'auth.json'), JSON.stringify({ 'opencode-go': { type: 'api', key: 'stale-secret' } }));

    expect(await read()).toEqual({ kind: 'none' });
  });

  it('says no login when there is none, and unsupported when only an environment key could be one', async () => {
    expect(await read()).toEqual({ kind: 'none' });
    expect(await read(reader(), { OPENCODE_API_KEY: 'env-only' })).toEqual({ kind: 'unsupported' });
  });

  it('reads the store again only when it changed, and then sees the new login', async () => {
    const path = store([{ id: 'cred_a', integration: 'opencode', value: consoleLogin(), active: 1 }]);
    const r = reader();

    await read(r);
    await read(r);
    await read(r);
    expect(workers).toBe(1);

    const db = new DatabaseSync(path);
    db.prepare('UPDATE credential SET value = ?, time_updated = 2').run(JSON.stringify(consoleLogin({}, { orgID: 'org-9' })));
    db.close();
    const after = loginOf(await read(r));
    expect(workers).toBe(2);
    expect(after).toMatchObject({ orgID: 'org-9' });
  });

  it('opens the store read-only: nothing in the data directory is written', async () => {
    const path = store([{ id: 'cred_a', integration: 'opencode', value: consoleLogin(), active: 1 }]);
    const before = { bytes: readFileSync(path), mtime: statSync(path).mtimeMs, files: readdirSync(data).sort() };

    await read();

    expect(readFileSync(path).equals(before.bytes)).toBe(true);
    expect(statSync(path).mtimeMs).toBe(before.mtime);
    expect(readdirSync(data).sort()).toEqual(before.files);
  });

  it('creates no WAL files beside a store OpenCode closed cleanly', async () => {
    const path = store([{ id: 'cred_a', integration: 'opencode', value: consoleLogin({ access: 'checkpointed' }), active: 1 }]);
    const wal = new DatabaseSync(path);
    wal.exec('PRAGMA journal_mode = WAL');
    wal.close();
    const before = readdirSync(data).sort();

    expect(loginOf(await read())).toMatchObject({ access: 'checkpointed' });
    expect(readdirSync(data).sort()).toEqual(before);
  });

  it('reads what a crashed OpenCode left in its WAL without checkpointing it into the store', async () => {
    const live = join(home, 'live');
    mkdirSync(live);
    const path = store([{ id: 'cred_a', integration: 'opencode', value: consoleLogin(), active: 1 }], join(live, 'opencode.db'));
    const writer = new DatabaseSync(path);
    writer.exec('PRAGMA journal_mode = WAL; PRAGMA wal_autocheckpoint = 0');
    writer.prepare('UPDATE credential SET value = ?').run(JSON.stringify(consoleLogin({ access: 'only-in-wal' })));
    // A copy taken while the writer holds the files is what a crash leaves behind.
    for (const suffix of ['', '-wal', '-shm']) writeFileSync(join(data, `opencode.db${suffix}`), readFileSync(`${path}${suffix}`));
    writer.close();
    const main = readFileSync(join(data, 'opencode.db'));

    expect(loginOf(await read())).toMatchObject({ access: 'only-in-wal' });
    expect(readFileSync(join(data, 'opencode.db')).equals(main)).toBe(true);
    expect(statSync(join(data, 'opencode.db-wal')).size).toBeGreaterThan(0);
  });

  it('reads a store OpenCode is writing in WAL mode', async () => {
    const path = store([{ id: 'cred_a', integration: 'opencode', value: consoleLogin(), active: 1 }]);
    const writer = new DatabaseSync(path);
    writer.exec('PRAGMA journal_mode = WAL');
    writer.prepare('UPDATE credential SET value = ?').run(JSON.stringify(consoleLogin({ access: 'in-wal' })));
    try {
      expect(loginOf(await read())).toMatchObject({ access: 'in-wal' });
    } finally {
      writer.close();
    }
  });

  it('reports a runtime without SQLite as unsupported, never reading auth.json past the database', async () => {
    store([{ id: 'cred_a', integration: 'opencode', value: consoleLogin(), active: 1 }]);
    writeFileSync(join(data, 'auth.json'), JSON.stringify({ 'opencode-go': { type: 'api', key: 'stale-secret' } }));

    expect(await read(reader({ workerExecArgv: ['--no-experimental-sqlite'] }))).toEqual({ kind: 'unsupported' });
  });

  it('gives up on a store locked against readers, within its deadline', async () => {
    const path = store([{ id: 'cred_a', integration: 'opencode', value: consoleLogin(), active: 1 }]);
    const locker = new DatabaseSync(path);
    locker.exec('PRAGMA locking_mode = EXCLUSIVE; BEGIN EXCLUSIVE; UPDATE credential SET time_updated = 3;');
    try {
      const started = Date.now();
      expect(await read(reader({ timeoutMs: 2_000 }))).toEqual({ kind: 'unreadable' });
      expect(Date.now() - started).toBeLessThan(2_500);
    } finally {
      locker.exec('ROLLBACK');
      locker.close();
    }
  });

  it('stops the read at once when aborted', async () => {
    store([{ id: 'cred_a', integration: 'opencode', value: consoleLogin(), active: 1 }]);
    const controller = new AbortController();
    const pending = reader().read({}, controller.signal);
    controller.abort();

    expect(await pending).toEqual({ kind: 'unreadable' });
  });
});
