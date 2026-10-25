import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { AccountLimitMonitor, type AccountLimitCollector, type AccountLimitReading } from '../AccountLimitMonitor';
import type { AccountLimitBucket, AccountLimitSnapshot } from '../../models/AccountLimits';

/**
 * The monitor against a collector whose every acquisition the test answers
 * by hand, on a fixed fake clock: what it publishes, when it reads again, and
 * which answers it refuses to believe.
 */
const T0 = new Date('2026-03-02T10:00:00.000Z');

interface Pending {
  signal: AbortSignal;
  answer(reading: AccountLimitReading): void;
}

function fakeCollector(harness = 'codex', label = 'Codex') {
  const calls: Pending[] = [];
  let scope = 'home-a';
  const collector: AccountLimitCollector = {
    harness,
    label,
    scope: () => scope,
    acquire: (signal) => new Promise<AccountLimitReading>((resolve) => { calls.push({ signal, answer: resolve }); }),
  };
  return {
    collector,
    calls,
    setScope: (next: string) => { scope = next; },
    last: () => calls[calls.length - 1],
  };
}

const bucket = (used: number, resetsAt: string | null = null): AccountLimitBucket => ({
  id: 'codex',
  windows: [{ slot: 'primary', usedPercent: used, durationMinutes: 300, resetsAt }],
});
const limits = (used: number, owner = 'alice', extra: Partial<Extract<AccountLimitReading, { kind: 'limits' }>> = {}): AccountLimitReading =>
  ({ kind: 'limits', owner, plan: 'plus', buckets: [bucket(used)], ...extra });

/** Lets the monitor's promise callbacks run without moving the clock. */
const settle = () => vi.advanceTimersByTimeAsync(0);

describe('the account-limit monitor', () => {
  let published: (readonly AccountLimitSnapshot[])[];
  let monitor: AccountLimitMonitor | undefined;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(T0);
    published = [];
  });
  afterEach(() => {
    monitor?.dispose();
    monitor = undefined;
    vi.useRealTimers();
  });

  function start(...collectors: AccountLimitCollector[]): AccountLimitMonitor {
    monitor = new AccountLimitMonitor({ collectors });
    monitor.subscribe((snapshots) => published.push(snapshots));
    return monitor;
  }

  it('knows nothing until the first read, then publishes it as fresh with the time it was read', async () => {
    const codex = fakeCollector();
    const m = start(codex.collector);
    expect(m.snapshots()).toEqual([{ harness: 'codex', label: 'Codex', status: 'unknown', buckets: [], readAt: null }]);

    m.refresh();
    codex.last().answer(limits(24));
    await settle();

    expect(m.snapshots()).toEqual([{ harness: 'codex', label: 'Codex', status: 'fresh', plan: 'plus', buckets: [bucket(24)], readAt: T0.toISOString() }]);
    expect(published.at(-1)).toEqual(m.snapshots());
  });

  it('runs one acquisition at a time and folds every request made meanwhile into a single follow-up', async () => {
    const codex = fakeCollector();
    const m = start(codex.collector);
    m.refresh();
    m.refresh();
    m.refresh();
    expect(codex.calls).toHaveLength(1);

    codex.last().answer(limits(10));
    await settle();
    // The follow-up waits out the spacing between reads rather than running back to back.
    expect(codex.calls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(codex.calls).toHaveLength(2);
    codex.last().answer(limits(11));
    await settle();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(codex.calls).toHaveLength(2);
  });

  it('replaces the whole picture on every full read, dropping buckets and windows it no longer reports', async () => {
    const codex = fakeCollector();
    const m = start(codex.collector);
    m.refresh();
    codex.last().answer({ kind: 'limits', owner: 'alice', buckets: [bucket(90), { id: 'spark', name: 'Spark', windows: [{ slot: 'primary', usedPercent: 40, durationMinutes: 60, resetsAt: null }] }] });
    await settle();

    await vi.advanceTimersByTimeAsync(10_000);
    m.refresh();
    codex.last().answer({ kind: 'limits', owner: 'alice', buckets: [{ id: 'codex', windows: [] }] });
    await settle();

    expect(m.snapshots()[0]).toMatchObject({ status: 'fresh', buckets: [{ id: 'codex', windows: [] }] });
    expect(m.snapshots()[0]).not.toHaveProperty('plan');
  });

  it('folds activity hints into the next poll rather than reading on each one, and backs off on failure', async () => {
    const codex = fakeCollector();
    const m = start(codex.collector);
    m.setForeground(true);
    codex.last().answer(limits(10));
    await settle();

    for (let i = 0; i < 5; i++) {
      m.invalidate();
      await vi.advanceTimersByTimeAsync(10_000);
    }
    expect(codex.calls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(codex.calls).toHaveLength(2);

    codex.last().answer({ kind: 'failed' });
    await settle();
    m.invalidate();
    await vi.advanceTimersByTimeAsync(119_000);
    expect(codex.calls).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(codex.calls).toHaveLength(3);
  });

  it('waits as long as a throttled read was told to, whoever asks meanwhile, then returns to the minute', async () => {
    const codex = fakeCollector();
    const m = start(codex.collector);
    m.setForeground(true);
    codex.last().answer(limits(10));
    await settle();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(codex.calls).toHaveLength(2);

    codex.last().answer({ kind: 'failed', owner: 'alice', retryAfterMs: 600_000 });
    await settle();
    // The last read stays, stale, while the wait runs: a throttled read is not an empty account.
    expect(m.snapshots()[0]).toMatchObject({ status: 'stale', buckets: [bucket(10)] });
    await vi.advanceTimersByTimeAsync(30_000);
    m.refresh();
    m.setForeground(false);
    m.setForeground(true);
    await vi.advanceTimersByTimeAsync(569_000);
    expect(codex.calls).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(codex.calls).toHaveLength(3);

    codex.last().answer(limits(12));
    await settle();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(codex.calls).toHaveLength(4);
  });

  it('files the provider a collector meters on every snapshot it publishes', async () => {
    const go = fakeCollector('opencode', 'OpenCode Go');
    const m = start({ ...go.collector, provider: 'opencode-go' });
    expect(m.snapshots()[0]).toMatchObject({ provider: 'opencode-go', status: 'unknown' });

    m.refresh();
    go.last().answer(limits(5));
    await settle();
    expect(m.snapshots()[0]).toMatchObject({ provider: 'opencode-go', status: 'fresh' });
    m.refresh();
    await vi.advanceTimersByTimeAsync(10_000);
    go.last().answer({ kind: 'signed_out' });
    await settle();
    expect(m.snapshots()[0]).toMatchObject({ provider: 'opencode-go', status: 'signed_out' });
  });

  it('reads again once more when a read reports a sparse update arrived during it', async () => {
    const codex = fakeCollector();
    const m = start(codex.collector);
    m.refresh();
    codex.last().answer(limits(10, 'alice', { followUp: true }));
    await settle();
    await vi.advanceTimersByTimeAsync(10_000);

    expect(codex.calls).toHaveLength(2);
    expect(m.snapshots()[0].buckets).toEqual([bucket(10)]);
  });

  it('keeps the last read as stale when the same account fails to answer, and forgets it when the account is not seen', async () => {
    const codex = fakeCollector();
    const m = start(codex.collector);
    m.refresh();
    codex.last().answer(limits(30));
    await settle();

    await vi.advanceTimersByTimeAsync(10_000);
    m.refresh();
    codex.last().answer({ kind: 'failed', owner: 'alice' });
    await settle();
    expect(m.snapshots()[0]).toMatchObject({ status: 'stale', buckets: [bucket(30)], readAt: T0.toISOString() });

    await vi.advanceTimersByTimeAsync(60_000);
    m.refresh();
    codex.last().answer({ kind: 'failed' });
    await settle();
    expect(m.snapshots()[0]).toMatchObject({ status: 'unknown', buckets: [], readAt: null });
  });

  it('never keeps another account\'s limits: a different owner on failure clears them', async () => {
    const codex = fakeCollector();
    const m = start(codex.collector);
    m.refresh();
    codex.last().answer(limits(30, 'alice'));
    await settle();

    await vi.advanceTimersByTimeAsync(10_000);
    m.refresh();
    codex.last().answer({ kind: 'failed', owner: 'bob' });
    await settle();

    expect(m.snapshots()[0]).toMatchObject({ status: 'unknown', buckets: [] });
  });

  it('clears and reads again at once when the account changed during a read', async () => {
    const codex = fakeCollector();
    const m = start(codex.collector);
    m.refresh();
    codex.last().answer(limits(30));
    await settle();

    await vi.advanceTimersByTimeAsync(10_000);
    m.refresh();
    codex.last().answer({ kind: 'account_changed' });
    await settle();

    expect(m.snapshots()[0]).toMatchObject({ status: 'unknown', buckets: [] });
    expect(codex.calls).toHaveLength(3);
  });

  it('backs off like a failure when the account keeps changing during reads, instead of reading back to back', async () => {
    const codex = fakeCollector();
    const m = start(codex.collector);
    m.setForeground(true);
    codex.last().answer({ kind: 'account_changed' });
    await settle();
    // The first change reads the new account at once.
    expect(codex.calls).toHaveLength(2);

    codex.last().answer({ kind: 'account_changed' });
    await settle();
    expect(codex.calls).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(119_000);
    expect(codex.calls).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(codex.calls).toHaveLength(3);

    codex.last().answer({ kind: 'account_changed' });
    await settle();
    await vi.advanceTimersByTimeAsync(239_000);
    expect(codex.calls).toHaveLength(3);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(codex.calls).toHaveLength(4);

    // A read that settles ends the run: the next change reads at once again.
    codex.last().answer(limits(7, 'bob'));
    await settle();
    await vi.advanceTimersByTimeAsync(10_000);
    m.refresh();
    codex.last().answer({ kind: 'account_changed' });
    await settle();
    expect(codex.calls).toHaveLength(6);
    expect(m.snapshots()[0]).toMatchObject({ status: 'unknown', buckets: [] });
  });

  it('tells signed out, unsupported and not installed apart, none of them with limits', async () => {
    for (const kind of ['signed_out', 'unsupported', 'not_installed'] as const) {
      const codex = fakeCollector();
      const m = start(codex.collector);
      m.refresh();
      codex.last().answer({ kind });
      await settle();
      expect(m.snapshots()[0]).toEqual({ harness: 'codex', label: 'Codex', status: kind, buckets: [], readAt: null });
      m.dispose();
    }
  });

  it('drops the previous auth scope\'s limits before reading under a new one, and ignores the old read\'s late answer', async () => {
    const codex = fakeCollector();
    const m = start(codex.collector);
    m.refresh();
    codex.last().answer(limits(30));
    await settle();

    await vi.advanceTimersByTimeAsync(10_000);
    m.refresh();
    const old = codex.last();
    codex.setScope('home-b');
    m.refresh(); // in flight: folded into a follow-up
    old.answer(limits(31));
    await settle();
    await vi.advanceTimersByTimeAsync(10_000);

    expect(codex.calls).toHaveLength(3);
    expect(m.snapshots()[0]).toMatchObject({ status: 'unknown', buckets: [] });
    codex.last().answer(limits(5, 'carol'));
    await settle();
    expect(m.snapshots()[0]).toMatchObject({ status: 'fresh', buckets: [bucket(5)] });
  });

  it('polls about once a minute only while in the foreground', async () => {
    const codex = fakeCollector();
    const m = start(codex.collector);
    m.setForeground(true);
    expect(codex.calls).toHaveLength(1);
    codex.last().answer(limits(1));
    await settle();

    await vi.advanceTimersByTimeAsync(60_000);
    expect(codex.calls).toHaveLength(2);
    codex.last().answer(limits(2));
    await settle();

    m.setForeground(false);
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(codex.calls).toHaveLength(2);

    m.setForeground(true);
    expect(codex.calls).toHaveLength(3);
  });

  it('reads for a surface that connects only what was not read, or is not being read, within the minute', async () => {
    const codex = fakeCollector();
    const m = start(codex.collector);
    m.setForeground(true);
    m.surfaceConnected();
    codex.last().answer(limits(1));
    await settle();
    await vi.advanceTimersByTimeAsync(59_000);
    m.surfaceConnected();
    expect(codex.calls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(codex.calls).toHaveLength(2);
    codex.last().answer(limits(2));
    await settle();

    m.setForeground(false);
    await vi.advanceTimersByTimeAsync(60_000);
    m.surfaceConnected();
    expect(codex.calls).toHaveLength(3);
  });

  it('holds activity hints while in the background, for the read coming back to the foreground makes', async () => {
    const codex = fakeCollector();
    const m = start(codex.collector);
    m.refresh();
    codex.last().answer(limits(1));
    await settle();

    for (let i = 0; i < 60; i++) {
      m.invalidate();
      await vi.advanceTimersByTimeAsync(10_000);
    }
    expect(codex.calls).toHaveLength(1);

    m.setForeground(true);
    expect(codex.calls).toHaveLength(2);
  });

  it('keeps its minute, its spacing and a service\'s wait when the wall clock is set back', async () => {
    const codex = fakeCollector();
    const m = start(codex.collector);
    m.setForeground(true);
    vi.setSystemTime(T0.getTime() - 24 * 3_600_000);
    codex.last().answer(limits(1));
    await settle();

    await vi.advanceTimersByTimeAsync(60_000);
    expect(codex.calls).toHaveLength(2);
    vi.setSystemTime(Date.now() - 24 * 3_600_000);
    codex.last().answer(limits(2));
    await settle();
    m.refresh();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(codex.calls).toHaveLength(3);

    codex.last().answer({ kind: 'failed', owner: 'alice', retryAfterMs: 5 * 60_000 });
    await settle();
    vi.setSystemTime(Date.now() - 24 * 3_600_000);
    m.refresh();
    await vi.advanceTimersByTimeAsync(15 * 60_000);
    expect(codex.calls).toHaveLength(4);
  });

  it('still reads within its cap when the wall clock is set back during a service\'s wait and focus keeps coming and going', async () => {
    const codex = fakeCollector();
    const m = start(codex.collector);
    m.setForeground(true);
    codex.last().answer(limits(1));
    await settle();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(codex.calls).toHaveLength(2);

    codex.last().answer({ kind: 'failed', owner: 'alice', retryAfterMs: 5 * 60_000 });
    await settle();
    vi.setSystemTime(Date.now() - 24 * 3_600_000);
    const stepped = Date.now();

    // Away for a minute and a half in every ten: each return re-asks, and no timer survives the next blur.
    let minute = 0;
    while (codex.calls.length === 2 && minute < 60) {
      if (minute % 10 === 0) m.setForeground(false);
      await vi.advanceTimersByTimeAsync(30_000);
      if (minute % 10 === 1) m.setForeground(true);
      await vi.advanceTimersByTimeAsync(30_000);
      minute++;
    }
    // Capped at 15 min from the first return, 1.5 min after the step.
    expect(codex.calls).toHaveLength(3);
    expect((Date.now() - stepped) / 60_000).toBeLessThanOrEqual(17);
  });

  it('backs off after failures, up to a bound, and returns to the minute once a read succeeds', async () => {
    const codex = fakeCollector();
    const m = start(codex.collector);
    m.setForeground(true);
    const gaps: number[] = [];
    let at = Date.now();
    for (let i = 0; i < 6; i++) {
      codex.last().answer({ kind: 'failed' });
      await settle();
      const before = codex.calls.length;
      while (codex.calls.length === before) await vi.advanceTimersByTimeAsync(1_000);
      gaps.push((Date.now() - at) / 1000);
      at = Date.now();
    }
    expect(gaps).toEqual([120, 240, 480, 900, 900, 900]);

    codex.last().answer(limits(1));
    await settle();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(codex.calls).toHaveLength(8);
  });

  it('gives up on an acquisition that never settles, aborting it, and reads again later', async () => {
    const codex = fakeCollector();
    const m = start(codex.collector);
    m.setForeground(true);
    const hung = codex.last();

    await vi.advanceTimersByTimeAsync(30_000);
    expect(hung.signal.aborted).toBe(true);
    expect(m.snapshots()[0].status).toBe('unknown');

    hung.answer(limits(99));
    await settle();
    expect(m.snapshots()[0].status).toBe('unknown');
    await vi.advanceTimersByTimeAsync(120_000);
    expect(codex.calls).toHaveLength(2);
  });

  it('marks a read stale once a window\'s reset has passed and reads again, never showing it as 0%', async () => {
    const codex = fakeCollector();
    const m = start(codex.collector);
    m.refresh();
    const reset = new Date(T0.getTime() + 5 * 60_000).toISOString();
    codex.last().answer({ kind: 'limits', owner: 'alice', buckets: [bucket(100, reset)] });
    await settle();

    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(m.snapshots()[0]).toMatchObject({ status: 'stale', buckets: [bucket(100, reset)] });
    expect(codex.calls).toHaveLength(2);
  });

  it('keeps a read fresh until a reset further off than a timer can wait, then marks it stale', async () => {
    const codex = fakeCollector();
    const m = start(codex.collector);
    m.refresh();
    const days = 40;
    const reset = new Date(T0.getTime() + days * 24 * 3_600_000).toISOString();
    codex.last().answer({ kind: 'limits', owner: 'alice', buckets: [bucket(10, reset)] });
    await settle();

    await vi.advanceTimersByTimeAsync((days - 1) * 24 * 3_600_000);
    expect(m.snapshots()[0].status).toBe('fresh');
    await vi.advanceTimersByTimeAsync(24 * 3_600_000);
    expect(m.snapshots()[0].status).toBe('stale');
  });

  it('calls a read stale when it reports a window whose reset has already gone by', async () => {
    const codex = fakeCollector();
    const m = start(codex.collector);
    m.refresh();
    const reset = new Date(T0.getTime() - 60_000).toISOString();
    codex.last().answer({ kind: 'limits', owner: 'alice', buckets: [bucket(100, reset)] });
    await settle();

    expect(m.snapshots()[0]).toMatchObject({ status: 'stale', buckets: [bucket(100, reset)] });
  });

  it('reads every collector independently and publishes them in registration order', async () => {
    const codex = fakeCollector();
    const other = fakeCollector('claude-code', 'Claude Code');
    const m = start(codex.collector, other.collector);
    m.refresh();
    other.last().answer(limits(7, 'dana'));
    await settle();

    expect(m.snapshots().map((s) => [s.harness, s.status])).toEqual([['codex', 'unknown'], ['claude-code', 'fresh']]);
    m.refresh('codex');
    expect(codex.calls).toHaveLength(1);
    expect(other.calls).toHaveLength(1);
  });

  it('cancels what is in flight and stops all timers and listeners on dispose', async () => {
    const codex = fakeCollector();
    const m = start(codex.collector);
    m.setForeground(true);
    const inFlight = codex.last();
    const count = published.length;

    m.dispose();
    expect(inFlight.signal.aborted).toBe(true);
    inFlight.answer(limits(50));
    await vi.advanceTimersByTimeAsync(60 * 60_000);
    m.refresh();

    expect(codex.calls).toHaveLength(1);
    expect(published).toHaveLength(count);
  });

  it('keeps every other listener, the polling and the reset watch going when one listener throws', async () => {
    const codex = fakeCollector();
    const m = start(codex.collector);
    let throws = true;
    m.subscribe(() => {
      if (!throws) return;
      throws = false;
      throw new Error('a surface failed to draw');
    });
    const later: (readonly AccountLimitSnapshot[])[] = [];
    m.subscribe((snapshots) => later.push(snapshots));
    m.setForeground(true);
    const reset = new Date(T0.getTime() + 90_000).toISOString();
    codex.last().answer({ kind: 'limits', owner: 'alice', buckets: [bucket(10, reset)] });
    await settle();

    expect(later.at(-1)?.[0].status).toBe('fresh');
    await vi.advanceTimersByTimeAsync(60_000);
    expect(codex.calls).toHaveLength(2);
    codex.last().answer({ kind: 'limits', owner: 'alice', buckets: [bucket(11, reset)] });
    await settle();
    expect(later.at(-1)?.[0]).toMatchObject({ status: 'fresh', buckets: [bucket(11, reset)] });
    await vi.advanceTimersByTimeAsync(30_000);
    expect(m.snapshots()[0].status).toBe('stale');
  });

  it('hands out frozen snapshots a listener cannot change', async () => {
    const codex = fakeCollector();
    const m = start(codex.collector);
    m.refresh();
    codex.last().answer(limits(24));
    await settle();

    expect(Object.isFrozen(m.snapshots())).toBe(true);
    expect(Object.isFrozen(m.snapshots()[0])).toBe(true);
  });
});
