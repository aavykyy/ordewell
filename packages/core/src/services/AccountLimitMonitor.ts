import type { AccountLimitBucket, AccountLimitSnapshot } from '../models/AccountLimits';

/** What one acquisition found. `owner` is a key to compare accounts by, never shown or logged. */
export type AccountLimitReading =
  /** A full read: it replaces every bucket and window known before. `followUp` asks for one more, coalesced. */
  | { kind: 'limits'; owner: string; plan?: string; buckets: AccountLimitBucket[]; followUp?: boolean }
  /**
   * A transient failure; `owner` when the account was still seen signed in
   * before it failed, `retryAfterMs` when the service said how long to wait.
   */
  | { kind: 'failed'; owner?: string; retryAfterMs?: number }
  /** The account changed while it was being read: what was read may be the old one's. */
  | { kind: 'account_changed' }
  | { kind: 'signed_out' | 'unsupported' | 'not_installed' };

/**
 * One runner's way of reading its account's limits. Registered with the
 * monitor once; the monitor alone decides when it runs, and never runs two of
 * its acquisitions at once.
 */
export interface AccountLimitCollector {
  /** The runner id the snapshot is filed under, and what a task's assignment is matched against. */
  readonly harness: string;
  readonly label: string;
  /** The one model provider its limits meter, when the runner serves others too (`AccountLimitSnapshot.provider`). */
  readonly provider?: string;
  /** The effective auth and config the reads see; a change clears what was read under the old one. */
  scope(): string;
  /** Must settle on its own deadline; `signal` aborts it early, and its result is then ignored. */
  acquire(signal: AbortSignal): Promise<AccountLimitReading>;
}

export type AccountLimitListener = (snapshots: readonly AccountLimitSnapshot[]) => void;

export interface AccountLimitMonitorOptions {
  /** One per runner, in the order surfaces list them. */
  collectors: readonly AccountLimitCollector[];
  /** The clock reads are stamped with; timers are the platform's, so a test fakes both together. */
  now?: () => number;
}

/** How often a foreground monitor reads an account that has limits to show. */
const POLL_MS = 60_000;
/** How often it looks again at an account with none: signed out, unsupported, not installed. */
const IDLE_POLL_MS = 5 * 60_000;
/** The least time between two reads of one account, however many surfaces ask. */
const MIN_SPACING_MS = 10_000;
/** The longest a run of failures pushes the next poll out. */
const MAX_BACKOFF_MS = 15 * 60_000;
/** A collector that ignores its own deadline is abandoned after this. */
const DEADLINE_MS = 30_000;
/** The longest a platform timer waits: past it, `setTimeout` fires at once instead. */
const MAX_TIMER_MS = 2 ** 31 - 1;

/** `soon` is the spacing between reads; `later` waits for the next poll, or the backoff. */
type Pace = 'soon' | 'later';

interface Entry {
  readonly collector: AccountLimitCollector;
  snapshot: AccountLimitSnapshot;
  /** Whose limits the snapshot holds; undefined while it holds none. */
  owner?: string;
  /** The auth scope the last acquisition started under. */
  scope?: string;
  /** Bumped by everything that makes an acquisition's answer worthless: a newer start, a fence, dispose. */
  generation: number;
  inFlight?: AbortController;
  /** Asked for again while one was in flight: one follow-up, however many asks, at the sooner pace asked. */
  owed: Pace | null;
  failures: number;
  /** No read starts before this, however it is asked for: the service asked for the wait. */
  notBefore: number | null;
  /** Reads in a row that found the account changing under them. */
  changes: number;
  lastStartedAt: number | null;
  timer?: ReturnType<typeof setTimeout>;
  dueAt?: number;
  resetTimer?: ReturnType<typeof setTimeout>;
}

/**
 * Every installed runner's account limits, owned once per host above any
 * panel, task or planner (the planner footer and each task log only
 * subscribe). It decides when each collector runs — on request, about once a
 * minute while in the foreground, again when a reported window resets — and
 * never runs two acquisitions of one account at once.
 *
 * It believes only the newest acquisition of the scope it started under: an
 * answer that arrives after a newer start, a scope change, an account change
 * or dispose is dropped. A full read replaces what was known; a failure keeps
 * the last read, marked stale, only when the same account was seen; anything
 * else forgets it. Nothing is persisted: a new host starts knowing nothing.
 */
export class AccountLimitMonitor {
  private readonly entries: Entry[];
  private readonly listeners = new Set<AccountLimitListener>();
  private readonly now: () => number;
  private foreground = false;
  private disposed = false;
  private published: readonly AccountLimitSnapshot[];

  constructor(options: AccountLimitMonitorOptions) {
    this.now = options.now ?? Date.now;
    this.entries = options.collectors.map((collector) => ({
      collector,
      snapshot: blank(collector, 'unknown'),
      generation: 0,
      owed: null,
      failures: 0,
      notBefore: null,
      changes: 0,
      lastStartedAt: null,
    }));
    this.published = this.collect();
  }

  snapshots(): readonly AccountLimitSnapshot[] {
    return this.published;
  }

  /** Hear every change; the returned function stops it. */
  subscribe(listener: AccountLimitListener): () => void {
    if (this.disposed) return () => {};
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  /**
   * Read now, or as soon as the spacing between reads allows; with no
   * harness, every one. Asks made while a read is out become one follow-up.
   */
  refresh(harness?: string): void {
    this.each(harness, (entry) => this.request(entry, 'soon'));
  }

  /**
   * A surface connected. It is drawn what is known, so only an account that
   * is not being read and was not read within the poll interval is read again:
   * a webview made ready just after a focused start does not read twice.
   */
  surfaceConnected(): void {
    if (this.disposed) return;
    this.each(undefined, (entry) => {
      this.fenceScopeChange(entry);
      const since = this.lastStart(entry);
      if (entry.inFlight || (since !== null && this.now() - since < POLL_MS)) return;
      this.request(entry, 'soon');
    });
  }

  /**
   * Something spent from the account — a model call, a task's turn — so a
   * read would show more. Folded into the next poll, or the backoff after a
   * failure, so a busy planner does not read the account on every call; in
   * the background, where nothing polls, into the read coming back makes.
   */
  invalidate(harness?: string): void {
    this.each(harness, (entry) => this.request(entry, 'later'));
  }

  /** Polling runs only in the foreground; coming back reads at once. */
  setForeground(active: boolean): void {
    if (this.disposed || active === this.foreground) return;
    this.foreground = active;
    if (active) {
      this.refresh();
      return;
    }
    for (const entry of this.entries) this.clearTimer(entry);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const entry of this.entries) {
      entry.generation++;
      entry.inFlight?.abort();
      entry.inFlight = undefined;
      this.clearTimer(entry);
      if (entry.resetTimer) clearTimeout(entry.resetTimer);
    }
    this.listeners.clear();
  }

  private each(harness: string | undefined, run: (entry: Entry) => void): void {
    for (const entry of this.entries) {
      if (harness === undefined || entry.collector.harness === harness) run(entry);
    }
  }

  private request(entry: Entry, pace: Pace): void {
    if (this.disposed) return;
    this.fenceScopeChange(entry);
    if (entry.inFlight) {
      if (entry.owed !== 'soon') entry.owed = pace;
      return;
    }
    if (pace === 'later' && !this.foreground) return;
    const since = this.lastStart(entry);
    if (since === null) {
      this.schedule(entry, this.now());
      return;
    }
    this.schedule(entry, since + (pace === 'soon' ? MIN_SPACING_MS : this.interval(entry)));
  }

  /**
   * When the last read started, never later than now: a wall clock set back
   * since would put it ahead, and every wait measured from it would grow by
   * the step, focus and refresh included.
   */
  private lastStart(entry: Entry): number | null {
    return entry.lastStartedAt === null ? null : Math.min(entry.lastStartedAt, this.now());
  }

  /** How long after one read the next poll comes: a minute, longer for an account with nothing to show, backed off after failures. */
  private interval(entry: Entry): number {
    if (entry.failures > 0) return Math.min(POLL_MS * 2 ** entry.failures, MAX_BACKOFF_MS);
    return entry.snapshot.buckets.length > 0 ? POLL_MS : IDLE_POLL_MS;
  }

  /** The auth or config the reads see has changed: what was read under the old one, or is being read, is not this one's. */
  private fenceScopeChange(entry: Entry): void {
    const scope = entry.collector.scope();
    if (entry.scope === undefined || scope === entry.scope) return;
    entry.scope = scope;
    entry.generation++;
    entry.inFlight?.abort();
    entry.inFlight = undefined;
    entry.owed = null;
    entry.failures = 0;
    entry.notBefore = null;
    entry.changes = 0;
    entry.lastStartedAt = null;
    this.forget(entry);
  }

  private schedule(entry: Entry, requested: number): void {
    // The service's wait is held to its cap from now, for the same reason as
    // {@link lastStart}, and kept held: capped afresh on every call, a timer a
    // blur clears would be re-armed a whole cap later on each return.
    if (entry.notBefore !== null) entry.notBefore = Math.min(entry.notBefore, this.now() + MAX_BACKOFF_MS);
    const at = Math.max(requested, entry.notBefore ?? requested);
    if (entry.timer && entry.dueAt !== undefined && entry.dueAt <= at) return;
    this.clearTimer(entry);
    const delay = at - this.now();
    if (delay <= 0) {
      this.start(entry);
      return;
    }
    entry.dueAt = at;
    entry.timer = setTimeout(() => {
      entry.timer = undefined;
      entry.dueAt = undefined;
      this.start(entry);
    }, delay);
    entry.timer.unref?.();
  }

  private clearTimer(entry: Entry): void {
    if (entry.timer) clearTimeout(entry.timer);
    entry.timer = undefined;
    entry.dueAt = undefined;
  }

  private start(entry: Entry): void {
    if (this.disposed || entry.inFlight) return;
    this.clearTimer(entry);
    entry.scope = entry.collector.scope();
    const generation = ++entry.generation;
    const controller = new AbortController();
    entry.inFlight = controller;
    entry.lastStartedAt = this.now();

    let deadline: ReturnType<typeof setTimeout> | undefined;
    const abandoned = new Promise<AccountLimitReading>((resolve) => {
      deadline = setTimeout(() => {
        controller.abort();
        resolve({ kind: 'failed' });
      }, DEADLINE_MS);
      deadline.unref?.();
    });
    const acquired = entry.collector.acquire(controller.signal).catch((): AccountLimitReading => ({ kind: 'failed' }));
    void Promise.race([acquired, abandoned]).then((reading) => {
      clearTimeout(deadline);
      if (this.disposed || generation !== entry.generation) return;
      entry.inFlight = undefined;
      try {
        this.apply(entry, reading);
      } finally {
        this.next(entry);
      }
    });
  }

  private apply(entry: Entry, reading: AccountLimitReading): void {
    if (reading.kind !== 'account_changed') entry.changes = 0;
    entry.notBefore = reading.kind === 'failed' && reading.retryAfterMs !== undefined && reading.retryAfterMs > 0
      ? this.now() + Math.min(reading.retryAfterMs, MAX_BACKOFF_MS)
      : null;
    switch (reading.kind) {
      case 'limits': {
        entry.owner = reading.owner;
        entry.failures = 0;
        if (reading.followUp) entry.owed = 'soon';
        const readAt = this.now();
        const passed = reading.buckets.some((bucket) => bucket.windows.some((window) => window.resetsAt !== null && Date.parse(window.resetsAt) <= readAt));
        this.show(entry, {
          harness: entry.collector.harness,
          label: entry.collector.label,
          ...(entry.collector.provider ? { provider: entry.collector.provider } : {}),
          // Codex can report a window whose reset has already gone by; its share is then the old window's.
          status: passed ? 'stale' : 'fresh',
          ...(reading.plan ? { plan: reading.plan } : {}),
          buckets: reading.buckets,
          readAt: new Date(readAt).toISOString(),
        });
        this.watchResets(entry);
        return;
      }
      case 'failed':
        entry.failures++;
        if (reading.owner !== undefined && reading.owner === entry.owner && entry.snapshot.buckets.length > 0) {
          this.show(entry, { ...entry.snapshot, status: 'stale' });
        } else {
          this.forget(entry);
        }
        return;
      case 'account_changed':
        this.forget(entry);
        // One change reads the new account at once; a run of them would respawn the probe back to back, so it backs off like failures.
        if (entry.changes++ === 0) {
          entry.owed = 'soon';
          entry.lastStartedAt = null;
        } else {
          entry.failures++;
          entry.owed = 'later';
        }
        return;
      default:
        entry.failures = 0;
        entry.owner = undefined;
        this.clearResetTimer(entry);
        this.show(entry, blank(entry.collector, reading.kind));
    }
  }

  /** After an acquisition: the follow-up it owes, else the next poll. */
  private next(entry: Entry): void {
    const owed = entry.owed;
    if (owed) {
      entry.owed = null;
      this.request(entry, owed);
      return;
    }
    const since = this.lastStart(entry);
    if (!this.foreground || since === null) return;
    this.schedule(entry, since + this.interval(entry));
  }

  /** At the earliest future reset the share shown belongs to a window that is over: stale until read again. */
  private watchResets(entry: Entry): void {
    this.clearResetTimer(entry);
    const now = this.now();
    const resets = entry.snapshot.buckets
      .flatMap((bucket) => bucket.windows.map((window) => (window.resetsAt === null ? NaN : Date.parse(window.resetsAt))))
      .filter((at) => Number.isFinite(at) && at > now);
    if (resets.length === 0) return;
    const generation = entry.generation;
    const delay = Math.min(...resets) - now;
    entry.resetTimer = setTimeout(() => {
      entry.resetTimer = undefined;
      if (this.disposed || generation !== entry.generation) return;
      // A reset further off than one timer can wait: wait again from here.
      if (delay > MAX_TIMER_MS) {
        this.watchResets(entry);
        return;
      }
      if (entry.snapshot.status === 'fresh') this.show(entry, { ...entry.snapshot, status: 'stale' });
      this.request(entry, 'soon');
    }, Math.min(delay, MAX_TIMER_MS));
    entry.resetTimer.unref?.();
  }

  private clearResetTimer(entry: Entry): void {
    if (entry.resetTimer) clearTimeout(entry.resetTimer);
    entry.resetTimer = undefined;
  }

  private forget(entry: Entry): void {
    entry.owner = undefined;
    this.clearResetTimer(entry);
    this.show(entry, blank(entry.collector, 'unknown'));
  }

  private show(entry: Entry, snapshot: AccountLimitSnapshot): void {
    const before = entry.snapshot;
    entry.snapshot = freeze(snapshot);
    if (JSON.stringify(before) === JSON.stringify(entry.snapshot)) return;
    this.published = this.collect();
    for (const listener of [...this.listeners]) {
      // One surface failing to draw is that surface's: the others still hear, and the read that called this still schedules the next.
      try { listener(this.published); } catch { /* the listener's own */ }
    }
  }

  private collect(): readonly AccountLimitSnapshot[] {
    return Object.freeze(this.entries.map((entry) => entry.snapshot));
  }
}

function blank(collector: AccountLimitCollector, status: AccountLimitSnapshot['status']): AccountLimitSnapshot {
  return freeze({ harness: collector.harness, label: collector.label, ...(collector.provider ? { provider: collector.provider } : {}), status, buckets: [], readAt: null });
}

/** Deeply frozen: one snapshot object is handed to every listener, so none may change it under the others. */
function freeze(snapshot: AccountLimitSnapshot): AccountLimitSnapshot {
  if (Object.isFrozen(snapshot)) return snapshot;
  return Object.freeze({
    ...snapshot,
    buckets: Object.freeze(snapshot.buckets.map((bucket) => Object.freeze({
      ...bucket,
      windows: Object.freeze(bucket.windows.map((window) => Object.freeze({ ...window }))),
    }))),
  });
}
