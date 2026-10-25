import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type * as Sqlite from 'node:sqlite';
import { Worker, type WorkerOptions } from 'node:worker_threads';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { openCodeGoAccountLimitCollector, type OpenCodeGoAccountLimitOptions } from '../openCodeGoLimits';
import { AccountLimitMonitor } from '../../AccountLimitMonitor';
import { accountLimitsText, type AccountLimitWindow } from '../../../models/AccountLimits';

/*
 * The collector end to end below the network: a synthetic OpenCode store read
 * by the real reader, and an injected `fetch` that answers what OpenCode's
 * services answer. The Console shape is the one a signed-in Go account's
 * `/console/api/go/status` returned on 2026-10-25 (keys and value types only,
 * values made up); the key shape is v1.18.34's `/zen/go/v1/usage` handler.
 */
const { DatabaseSync } = process.getBuiltinModule('node:sqlite') as typeof Sqlite;

const NOW = Date.now();
const HOUR = 3_600_000;
const iso = (offsetMs: number) => new Date(NOW + offsetMs).toISOString();

const ACCESS = 'access-secret-6b1f';
const REFRESH = 'refresh-secret-91aa';
const GO_KEY = 'go-key-secret-c4d2';

const consoleStatus = (meters: Record<string, unknown> = {}, over: Record<string, unknown> = {}) => ({
  subscriberUserId: 'usr_secret_id', product: 'go', renewalProduct: 'go', paymentMethodId: 'pm_secret', paymentMethodKind: 'card',
  renewalCurrency: 'usd', useBalance: false, cancelAtPeriodEnd: false, resumability: 'none', renewalPending: false, nextPeriodPaid: false,
  access: {
    startsAt: iso(-10 * 24 * HOUR), endsAt: iso(20 * 24 * HOUR), cancelAtPeriodEnd: false,
    meters: {
      fiveHour: { startsAt: iso(-HOUR), resetsAt: iso(4 * HOUR), limitMicroCents: '300000000', usedMicroCents: '3000000' },
      week: { startsAt: iso(-24 * HOUR), resetsAt: iso(6 * 24 * HOUR), limitMicroCents: '750000000', usedMicroCents: '43500000' },
      month: { resetsAt: iso(20 * 24 * HOUR), limitMicroCents: '1500000000', usedMicroCents: '43500000' },
      ...meters,
    },
  },
  upgradePrice: { amountMicroCents: '3000000000', currency: 'usd' },
  ...over,
});

const keyUsage = (over: Record<string, unknown> = {}) => ({
  usage: {
    rolling: { status: 'ok', percent: 12, resetsAt: iso(3 * HOUR) },
    weekly: { status: 'rate-limited', percent: 100, resetsAt: iso(2 * 24 * HOUR) },
    monthly: { status: 'ok', percent: 38, resetsAt: iso(12 * 24 * HOUR) },
    ...over,
  },
});

interface Call { url: string; init: RequestInit }

let home: string;
let data: string;
let calls: Call[];
let workers: number;
let reply: (call: Call) => Promise<Response>;

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  async () => new Response(typeof body === 'string' ? body : JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

const fakeFetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
  const call = { url: String(input), init: init ?? {} };
  calls.push(call);
  return reply(call);
}) as typeof fetch;

function store(rows: { id: string; integration: string; value: unknown; active?: number }[]): string {
  const path = join(data, 'opencode.db');
  rmSync(path, { force: true });
  const db = new DatabaseSync(path);
  db.exec(`CREATE TABLE credential (id text PRIMARY KEY, integration_id text, label text NOT NULL, value text NOT NULL,
    connector_id text, method_id text, active integer, time_created integer NOT NULL, time_updated integer NOT NULL)`);
  const insert = db.prepare('INSERT INTO credential (id, integration_id, label, value, active, time_created, time_updated) VALUES (?, ?, ?, ?, ?, 1, 1)');
  for (const row of rows) insert.run(row.id, row.integration, row.id, JSON.stringify(row.value), row.active ?? 1);
  db.close();
  return path;
}

const consoleLogin = (over: Record<string, unknown> = {}, metadata: Record<string, unknown> = {}) => ({
  type: 'oauth', methodID: 'console', access: ACCESS, refresh: REFRESH, expires: NOW + 48 * HOUR,
  metadata: { server: 'https://opencode.ai/console', orgID: 'org-1', accountID: 'acct-1', ...metadata }, ...over,
});
const signedInToConsole = (over?: Record<string, unknown>, metadata?: Record<string, unknown>) =>
  store([{ id: 'cred_console', integration: 'opencode', value: consoleLogin(over, metadata) }]);
const holdingGoKey = () => store([{ id: 'cred_go', integration: 'opencode-go', value: { type: 'key', key: GO_KEY } }]);

function collector(over: Partial<OpenCodeGoAccountLimitOptions> = {}, deps: OpenCodeGoAccountLimitOptions['deps'] = {}) {
  return openCodeGoAccountLimitCollector({
    isInstalled: async () => true,
    ...over,
    deps: {
      fetch: fakeFetch,
      env: () => ({}),
      reader: { homedir: () => home, spawnWorker: (source: string, options: WorkerOptions) => { workers++; return new Worker(source, options); } },
      ...deps,
    },
  });
}

const acquire = (c = collector(), signal = new AbortController().signal) => c.acquire(signal);

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'oc-go-'));
  data = join(home, '.local', 'share', 'opencode');
  mkdirSync(data, { recursive: true });
  calls = [];
  workers = 0;
  reply = json(200, consoleStatus());
});
afterEach(() => { rmSync(home, { recursive: true, force: true }); });

describe('OpenCode Go account limits', () => {
  it('asks the Console with the selected sign-in and its organization, and files three windows, the month as Monthly', async () => {
    signedInToConsole();

    const reading = await acquire();

    expect(calls).toHaveLength(1);
    const [call] = calls;
    expect(call.url).toBe('https://opencode.ai/console/api/go/status');
    expect(call.init.method).toBe('GET');
    expect(call.init.redirect).toBe('error');
    expect(call.init.body).toBeUndefined();
    expect(call.init.headers).toEqual({ authorization: `Bearer ${ACCESS}`, accept: 'application/json', 'x-org-id': 'org-1' });
    expect(reading).toMatchObject({ kind: 'limits', plan: 'go' });
    if (reading.kind !== 'limits') throw new Error('no limits');
    expect(reading.buckets).toEqual([{ id: 'opencode-go', windows: [
      { slot: 'primary', usedPercent: 1, durationMinutes: 300, resetsAt: iso(4 * HOUR) },
      { slot: 'secondary', usedPercent: 5.8, durationMinutes: 10080, resetsAt: iso(6 * 24 * HOUR) },
      { slot: 'tertiary', period: 'month', usedPercent: 2.9, durationMinutes: null, resetsAt: iso(20 * 24 * HOUR) },
    ] }]);
  });

  it('asks the Go usage endpoint with a key, with no organization, and reads its used percentages as given', async () => {
    holdingGoKey();
    reply = json(200, keyUsage());

    const reading = await acquire();

    expect(calls.map((c) => c.url)).toEqual(['https://opencode.ai/zen/go/v1/usage']);
    expect(calls[0].init.headers).toEqual({ authorization: `Bearer ${GO_KEY}`, accept: 'application/json' });
    if (reading.kind !== 'limits') throw new Error('no limits');
    expect(reading.plan).toBeUndefined();
    expect(reading.buckets[0].windows.map((w) => [w.usedPercent, w.durationMinutes, w.period ?? null])).toEqual([[12, 300, null], [100, 10080, null], [38, null, 'month']]);
  });

  it('reads each meter as the ratio of its own two amounts, exactly, whatever their size', async () => {
    signedInToConsole();
    const share = async (meter: Record<string, unknown>) => {
      reply = json(200, consoleStatus({ fiveHour: { resetsAt: iso(HOUR), ...meter } }));
      const reading = await acquire();
      if (reading.kind !== 'limits') return reading.kind;
      return reading.buckets[0].windows.find((w) => w.slot === 'primary')?.usedPercent ?? 'absent';
    };

    expect(await share({ usedMicroCents: '0', limitMicroCents: '300000000' })).toBe(0);
    expect(await share({ usedMicroCents: 150, limitMicroCents: 300 })).toBe(50);
    expect(await share({ usedMicroCents: '1', limitMicroCents: '300000000000' })).toBeGreaterThan(0);
    expect(await share({ usedMicroCents: '123456789012345678901234567890', limitMicroCents: '246913578024691357802469135780' })).toBe(50);
    expect(await share({ usedMicroCents: '9007199254740993', limitMicroCents: '18014398509481986' })).toBe(50);
    // More than the allowance is all of it, not more.
    expect(await share({ usedMicroCents: '400', limitMicroCents: '300' })).toBe(100);
    // No allowance reported, or amounts that are not whole non-negative numbers, is no share.
    for (const bad of [
      { usedMicroCents: '5', limitMicroCents: '0' },
      { usedMicroCents: null, limitMicroCents: '300' },
      { usedMicroCents: '1.5', limitMicroCents: '300' },
      { usedMicroCents: '-1', limitMicroCents: '300' },
      { usedMicroCents: '1e3', limitMicroCents: '300' },
      { usedMicroCents: 1e300, limitMicroCents: 1e301 },
      { usedMicroCents: '1'.repeat(80), limitMicroCents: '2'.repeat(80) },
    ]) {
      const window = await share(bad);
      expect(window === null || window === 'absent').toBe(true);
    }
  });

  it('keeps the windows it can read and leaves a reset it was not told unknown', async () => {
    signedInToConsole();
    reply = json(200, consoleStatus({ week: undefined, month: { limitMicroCents: '100', usedMicroCents: '10' } }));

    const reading = await acquire();

    if (reading.kind !== 'limits') throw new Error('no limits');
    const windows = reading.buckets[0].windows;
    expect(windows.map((w) => w.slot)).toEqual(['primary', 'tertiary']);
    expect(windows[1]).toEqual<AccountLimitWindow>({ slot: 'tertiary', period: 'month', usedPercent: 10, durationMinutes: null, resetsAt: null });
  });

  it('tolerates a Go Plus answer: its product names the plan, and its own amounts the share', async () => {
    signedInToConsole();
    reply = json(200, consoleStatus({ fiveHour: { resetsAt: iso(HOUR), limitMicroCents: '1200000000', usedMicroCents: '600000000', extra: true } }, { product: 'go-plus', newField: { nested: [1] } }));

    const reading = await acquire();

    expect(reading).toMatchObject({ kind: 'limits', plan: 'go-plus' });
    if (reading.kind !== 'limits') throw new Error('no limits');
    expect(reading.buckets[0].windows[0].usedPercent).toBe(50);
  });

  it('says unsupported for a Console account with no Go plan, and failed (same account) for an answer it cannot read', async () => {
    signedInToConsole();
    reply = json(200, consoleStatus({}, { access: null }));
    expect(await acquire()).toEqual({ kind: 'unsupported' });

    for (const body of ['not json', [], { access: { meters: 'none' } }, consoleStatus({ fiveHour: null, week: null, month: null })]) {
      reply = json(200, body);
      expect(await acquire()).toMatchObject({ kind: 'failed', owner: expect.any(String) });
    }
    reply = json(200, keyUsage({ rolling: { status: 'ok', percent: 'lots' }, weekly: null, monthly: { percent: -3 } }));
    holdingGoKey();
    expect(await acquire()).toMatchObject({ kind: 'failed', owner: expect.any(String) });
  });

  it('tells the service\'s refusals apart: signed out, no plan, denied, throttled, down', async () => {
    signedInToConsole();
    const answer = async (status: number, body: unknown = {}, headers: Record<string, string> = {}) => {
      reply = json(status, body, headers);
      return acquire();
    };

    expect(await answer(401)).toEqual({ kind: 'signed_out' });
    expect(await answer(404)).toEqual({ kind: 'unsupported' });
    // Denied — SSO, another organization — keeps nothing of what was read before.
    expect(await answer(403)).toEqual({ kind: 'failed' });
    // A throttled quota read is not an exhausted quota.
    expect(await answer(429, {}, { 'retry-after': '120' })).toMatchObject({ kind: 'failed', owner: expect.any(String), retryAfterMs: 120_000 });
    expect(await answer(429, {}, { 'retry-after': new Date(NOW + 10 * 60_000).toUTCString() })).toMatchObject({ kind: 'failed', retryAfterMs: expect.any(Number) });
    expect(await answer(503)).toMatchObject({ kind: 'failed', owner: expect.any(String) });

    holdingGoKey();
    expect(await answer(403, { type: 'error', error: { type: 'EntitlementError', message: 'No subscription' } })).toEqual({ kind: 'unsupported' });
    expect(await answer(403, { type: 'error', error: { type: 'Other' } })).toEqual({ kind: 'failed' });
  });

  it('follows no redirect, so a credential never leaves the fixed origin', async () => {
    signedInToConsole();
    reply = async () => { throw new TypeError('fetch failed: unexpected redirect'); };
    expect(await acquire()).toMatchObject({ kind: 'failed', owner: expect.any(String) });

    reply = json(302, '', { location: 'https://elsewhere.example.test/' });
    expect(await acquire()).toMatchObject({ kind: 'failed' });
    expect(calls.every((c) => c.url.startsWith('https://opencode.ai/'))).toBe(true);
  });

  it('stops reading an answer past its size bound, and a request past its deadline', async () => {
    signedInToConsole();
    let cancelled = false;
    reply = async () => new Response(new ReadableStream({
      pull(controller) { controller.enqueue(new Uint8Array(16 * 1024).fill(32)); },
      cancel() { cancelled = true; },
    }), { status: 200 });
    expect(await acquire()).toMatchObject({ kind: 'failed', owner: expect.any(String) });
    expect(cancelled).toBe(true);

    reply = (call) => new Promise((_resolve, reject) => {
      call.init.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
    });
    const started = Date.now();
    expect(await acquire(collector({}, { fetch: fakeFetch, env: () => ({}), reader: { homedir: () => home }, timeoutMs: 200 }))).toMatchObject({ kind: 'failed', owner: expect.any(String) });
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  it('cancels the request when the read is aborted', async () => {
    signedInToConsole();
    let requestSignal: AbortSignal | undefined;
    reply = (call) => new Promise((_resolve, reject) => {
      requestSignal = call.init.signal ?? undefined;
      requestSignal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
    });
    const controller = new AbortController();
    const pending = acquire(collector(), controller.signal);
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    controller.abort();

    // At once, not at the request's own deadline.
    expect(requestSignal?.aborted).toBe(true);
    expect(await pending).toMatchObject({ kind: 'failed' });
  });

  it('never sends a sign-in OpenCode has to refresh first, and never refreshes it', async () => {
    signedInToConsole({ expires: NOW + 10_000 });

    expect(await acquire()).toMatchObject({ kind: 'failed', owner: expect.any(String) });
    expect(calls).toHaveLength(0);
  });

  it('asks nothing without a login, of a login it cannot use, or of a store it cannot read', async () => {
    expect(await acquire()).toEqual({ kind: 'signed_out' });
    store([{ id: 'cred_x', integration: 'opencode', value: { type: 'external', methodID: 'sso' } }]);
    expect(await acquire()).toEqual({ kind: 'unsupported' });
    store([
      { id: 'cred_1', integration: 'opencode', value: consoleLogin() },
      { id: 'cred_2', integration: 'opencode', value: consoleLogin() },
    ]);
    expect(await acquire()).toEqual({ kind: 'failed' });
    signedInToConsole();
    expect(await acquire(collector({}, { reader: { homedir: () => home, workerExecArgv: ['--no-experimental-sqlite'] } }))).toEqual({ kind: 'unsupported' });
    expect(await acquire(collector({ isInstalled: async () => false }))).toEqual({ kind: 'not_installed' });
    expect(calls).toHaveLength(0);
  });

  it('reads the store once while it is unchanged, and asks the service once per acquisition', async () => {
    signedInToConsole();
    const c = collector();

    await acquire(c);
    await acquire(c);
    await acquire(c);

    expect(workers).toBe(1);
    expect(calls).toHaveLength(3);
  });

  it('finds the store through the workspace\'s environment, as an OpenCode task would', async () => {
    const xdg = join(home, 'workspace-data');
    mkdirSync(join(xdg, 'opencode'), { recursive: true });
    writeFileSync(join(xdg, 'opencode', 'auth.json'), JSON.stringify({ 'opencode-go': { type: 'api', key: 'workspace-go-key' } }));
    reply = json(200, keyUsage());
    const roots: string[] = [];

    await acquire(collector({ workspaceRoot: () => '/repo' }, {
      fetch: fakeFetch, env: () => ({}), reader: { homedir: () => home },
      workspaceEnv: async (root) => { roots.push(root); return { XDG_DATA_HOME: xdg }; },
    }));

    expect(roots).toEqual(['/repo']);
    expect(calls[0].init.headers).toMatchObject({ authorization: 'Bearer workspace-go-key' });
  });

  it('keeps no secret in what it hands the monitor, and prints nothing', async () => {
    signedInToConsole();
    const printed = (['log', 'info', 'warn', 'error', 'debug'] as const).map((level) => vi.spyOn(console, level).mockImplementation(() => undefined));
    const seen: unknown[] = [];
    try {
      for (const r of [json(200, consoleStatus()), json(401, { error: ACCESS }), json(429, {}), async () => { throw new Error(`boom ${ACCESS}`); }]) {
        reply = r;
        seen.push(await acquire());
      }
    } finally {
      for (const spy of printed) spy.mockRestore();
    }

    const text = JSON.stringify(seen);
    for (const secret of [ACCESS, REFRESH, 'org-1', 'acct-1', 'usr_secret_id', 'pm_secret']) expect(text).not.toContain(secret);
    for (const spy of printed) expect(spy).not.toHaveBeenCalled();
  });

  describe('through the monitor', () => {
    let monitor: AccountLimitMonitor | undefined;
    // The monitor's spacing between reads runs on the fake clock; the store and the worker stay real.
    beforeEach(() => { vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] }); });
    afterEach(() => { monitor?.dispose(); monitor = undefined; vi.useRealTimers(); });

    it('draws the row, keeps it stale for the same login, and forgets it for another organization', async () => {
      signedInToConsole();
      monitor = new AccountLimitMonitor({ collectors: [collector()] });
      monitor.refresh();
      await vi.waitFor(() => expect(monitor!.snapshots()[0].status).toBe('fresh'));
      const [snapshot] = monitor.snapshots();
      expect(snapshot).toMatchObject({ harness: 'opencode', label: 'OpenCode Go', provider: 'opencode-go', plan: 'go' });
      expect(accountLimitsText(snapshot)).toBe('OpenCode Go 5h 1% used · Weekly 6% used · Monthly 3% used');

      // The same sign-in, refreshed by OpenCode, failing to answer: the last read stays, stale.
      signedInToConsole({ access: 'refreshed-access' });
      reply = json(503, {});
      monitor.refresh();
      await vi.advanceTimersByTimeAsync(10_000);
      await vi.waitFor(() => expect(monitor!.snapshots()[0].status).toBe('stale'));

      // Another organization failing to answer is no reason to show the first one's.
      signedInToConsole({}, { orgID: 'org-2' });
      monitor.refresh();
      await vi.advanceTimersByTimeAsync(10_000);
      await vi.waitFor(() => expect(monitor!.snapshots()[0].status).toBe('unknown'));
      expect(JSON.stringify(monitor.snapshots())).not.toContain(ACCESS);
    });

    it('drops a reply that arrives after dispose', async () => {
      signedInToConsole();
      let release: (() => void) | undefined;
      reply = () => new Promise((resolve) => { release = () => resolve(new Response(JSON.stringify(consoleStatus()), { status: 200 })); });
      monitor = new AccountLimitMonitor({ collectors: [collector()] });
      const published: unknown[] = [];
      monitor.subscribe((s) => published.push(s));
      monitor.refresh();
      await vi.waitFor(() => expect(release).toBeDefined());
      monitor.dispose();
      release!();
      await vi.advanceTimersByTimeAsync(20);

      expect(published).toEqual([]);
      expect(monitor.snapshots()[0].status).toBe('unknown');
    });
  });
});
