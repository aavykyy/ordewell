import { afterEach, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type { WebSocket } from 'ws';
import { saveSession, type AccountLimitCollector, type AccountLimitReading, type LegacyPlanState } from '@ordewell/core';
import { OrchestratorPool } from '../orchestratorPool';

const roots: string[] = [];
const pools: OrchestratorPool[] = [];
afterEach(() => {
  for (const pool of pools.splice(0)) pool.destroyAll();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  vi.useRealTimers();
});

function workspace(): string {
  const root = mkdtempSync(join(tmpdir(), 'ordewell-limits-'));
  mkdirSync(join(root, '.git'));
  roots.push(root);
  return root;
}

function adopt(pool: OrchestratorPool, root: string, id: string): void {
  const plan: LegacyPlanState = { status: 'approved', tasks: [], runners: ['codex'], generatedAt: '', lastUpdated: '' };
  saveSession(plan, 'Goal', root, id);
  pool.adoptSavedSession(id, root);
}

function socket() {
  const frames: unknown[] = [];
  const ws = { OPEN: 1, readyState: 1, send: (payload: string) => frames.push(JSON.parse(payload)) } as unknown as WebSocket;
  return { ws, frames };
}

it('shares acquisitions within a workspace and greets every subscriber with its current snapshot', async () => {
  const acquire = vi.fn(async (): Promise<AccountLimitReading> => ({
    kind: 'limits', owner: 'private-owner', buckets: [{ id: 'account', windows: [{ slot: 'primary', usedPercent: 24, durationMinutes: 300, resetsAt: null }] }],
  }));
  const collectors = vi.fn((_root: string): AccountLimitCollector[] => [{ harness: 'codex', label: 'Codex', scope: () => 'fixed', acquire }]);
  const pool = new OrchestratorPool({ accountLimitCollectors: collectors });
  pools.push(pool);
  const root = workspace();
  adopt(pool, root, 'a');
  adopt(pool, root, 'b');
  expect(collectors).not.toHaveBeenCalled();
  const a = socket();
  const b = socket();
  pool.subscribe('a', a.ws);
  pool.subscribe('b', b.ws);
  expect(a.frames[0]).toMatchObject({ type: 'account_limits', sessionId: 'a', limits: [{ status: 'unknown', buckets: [] }] });
  await vi.waitFor(() => expect(a.frames.at(-1)).toMatchObject({ limits: [{ status: 'fresh' }] }));
  expect(acquire).toHaveBeenCalledTimes(1);
  expect(collectors).toHaveBeenCalledTimes(1);
  expect(collectors).toHaveBeenCalledWith(root);
  expect(b.frames.at(-1)).toMatchObject({ sessionId: 'b', limits: [{ status: 'fresh' }] });
  const reconnect = socket();
  pool.subscribe('a', reconnect.ws);
  expect(reconnect.frames[0]).toMatchObject({ limits: [{ status: 'fresh' }] });
  expect(JSON.stringify(reconnect.frames)).not.toContain('private-owner');
});

it('isolates two workspaces, aborts the last disconnected read and ignores its delayed answer', async () => {
  vi.useFakeTimers();
  const pending: { root: string; signal: AbortSignal; finish: (reading: AccountLimitReading) => void }[] = [];
  const pool = new OrchestratorPool({ accountLimitCollectors: (root) => [{
    harness: 'codex', label: 'Codex', scope: () => root,
    acquire: (signal) => new Promise((finish) => { pending.push({ root, signal, finish }); }),
  }] });
  pools.push(pool);
  const one = workspace();
  const two = workspace();
  adopt(pool, one, 'a');
  adopt(pool, one, 'b');
  adopt(pool, two, 'c');
  const a = socket();
  const b = socket();
  const c = socket();
  pool.subscribe('a', a.ws);
  pool.subscribe('b', b.ws);
  pool.subscribe('c', c.ws);
  expect(pending.map((read) => read.root)).toEqual([one, two]);
  pool.unsubscribe('a', a.ws);
  expect(pending[0].signal.aborted).toBe(false);
  pool.unsubscribe('b', b.ws);
  expect(pending[0].signal.aborted).toBe(true);
  expect(pending[1].signal.aborted).toBe(false);
  const reading: AccountLimitReading = { kind: 'limits', owner: 'one', buckets: [{ id: 'account', windows: [{ slot: 'primary', usedPercent: 99, durationMinutes: 300, resetsAt: null }] }] };
  pending[0].finish(reading);
  pending[1].finish({ kind: 'signed_out' });
  await vi.advanceTimersByTimeAsync(0);
  expect(c.frames.at(-1)).toMatchObject({ limits: [{ status: 'signed_out', buckets: [] }] });
  const again = socket();
  pool.subscribe('a', again.ws);
  expect(again.frames).toHaveLength(1);
  expect(again.frames[0]).toMatchObject({ limits: [{ status: 'unknown', buckets: [] }] });
  expect(pending).toHaveLength(3);
  pool.destroyAll();
  expect(pending[2].signal.aborted).toBe(true);
  await vi.advanceTimersByTimeAsync(20 * 60_000);
  expect(pending).toHaveLength(3);
});

it('clears the old workspace on session replacement and drops its late read', async () => {
  const reads: { root: string; signal: AbortSignal; finish: (reading: AccountLimitReading) => void }[] = [];
  const pool = new OrchestratorPool({ accountLimitCollectors: (root) => [{
    harness: 'codex', label: root, scope: () => root,
    acquire: (signal) => new Promise((finish) => { reads.push({ root, signal, finish }); }),
  }] });
  pools.push(pool);
  const one = workspace();
  const two = workspace();
  adopt(pool, one, 's');
  const client = socket();
  pool.subscribe('s', client.ws);
  pool.destroy('s');
  adopt(pool, two, 's');
  expect(reads.map((read) => read.root)).toEqual([one, two]);
  expect(reads[0].signal.aborted).toBe(true);
  expect(client.frames.at(-1)).toMatchObject({ limits: [{ label: two, status: 'unknown' }] });
  reads[0].finish({ kind: 'limits', owner: 'old', buckets: [{ id: 'old-data', windows: [] }] });
  reads[1].finish({ kind: 'unsupported' });
  await vi.waitFor(() => expect(client.frames.at(-1)).toMatchObject({ limits: [{ label: two, status: 'unsupported' }] }));
  expect(JSON.stringify(client.frames)).not.toContain('old-data');
});

it('polls at the monitor pace only while a workspace has connected consumers', async () => {
  vi.useFakeTimers();
  const acquire = vi.fn(async (): Promise<AccountLimitReading> => ({ kind: 'limits', owner: 'test', buckets: [{ id: 'account', windows: [{ slot: 'primary', usedPercent: 10, durationMinutes: 300, resetsAt: null }] }] }));
  const pool = new OrchestratorPool({ accountLimitCollectors: () => [{ harness: 'codex', label: 'Codex', scope: () => 'test', acquire }] });
  pools.push(pool);
  adopt(pool, workspace(), 's');
  await vi.advanceTimersByTimeAsync(120_000);
  expect(acquire).not.toHaveBeenCalled();
  const a = socket();
  const b = socket();
  pool.subscribe('s', a.ws);
  await vi.advanceTimersByTimeAsync(0);
  pool.subscribe('s', b.ws);
  await vi.advanceTimersByTimeAsync(59_999);
  expect(acquire).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(1);
  expect(acquire).toHaveBeenCalledTimes(2);
  pool.unsubscribe('s', a.ws);
  await vi.advanceTimersByTimeAsync(60_000);
  expect(acquire).toHaveBeenCalledTimes(3);
  pool.unsubscribe('s', b.ws);
  await vi.advanceTimersByTimeAsync(600_000);
  expect(acquire).toHaveBeenCalledTimes(3);
});
