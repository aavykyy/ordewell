/*
 * A runner account's own limits — a ChatGPT plan's five-hour and weekly
 * windows, say — as the account monitor last read them. Live account data, not
 * usage: nothing here is summed into a ledger, saved with a plan or restored
 * after a reload, and none of it decides whether work pauses (that stays with
 * the in-flight rule). Browser-safe, so a webview words a snapshot itself.
 */

/** One reported window: what share of it is used, how long it is, and when it resets. */
export interface AccountLimitWindow {
  /** Which of a bucket's windows this is, in the order reported; only a label when the length is unknown. */
  slot: 'primary' | 'secondary' | 'tertiary';
  /** The percentage used, as the runner reports it; null when it reported none, which is not 0. */
  usedPercent: number | null;
  /** The window's own length; null when unreported, or when it is a plan month, which has no one length. */
  durationMinutes: number | null;
  /** A window the runner names a month: it runs to its reported reset, however many days that is. */
  period?: 'month';
  /** ISO time the window resets; null when unreported. */
  resetsAt: string | null;
}

/** One independent allowance: the account's own, or one a model is metered by. Never summed with another. */
export interface AccountLimitBucket {
  id: string;
  /** The runner's name for it, when it gives one. */
  name?: string;
  windows: readonly AccountLimitWindow[];
}

/**
 * What the monitor knows of one runner's account. `fresh` and `stale` carry
 * limits; the rest carry none and draw nothing. `stale` is the last good read,
 * kept only while the same account was still seen signed in, or past a reset
 * the monitor has not read since.
 */
export type AccountLimitStatus = 'fresh' | 'stale' | 'signed_out' | 'unsupported' | 'not_installed' | 'unknown';

export interface AccountLimitSnapshot {
  /** The runner id: `codex`. */
  harness: string;
  /** Its display name: `Codex`. */
  label: string;
  status: AccountLimitStatus;
  /**
   * The one model provider these limits meter, for a runner that serves
   * others too: OpenCode's Go plan meters `opencode-go/…` models and nothing
   * else it runs. Absent when they meter whatever the runner serves.
   */
  provider?: string;
  /** The account's plan, as the runner names it. */
  plan?: string;
  buckets: readonly AccountLimitBucket[];
  /** ISO time of the read the buckets came from; null with no buckets. */
  readAt: string | null;
}

/** Whether a snapshot has anything to draw: a signed-in account with at least one known percentage. */
export function hasAccountLimits(snapshot: AccountLimitSnapshot): boolean {
  return (snapshot.status === 'fresh' || snapshot.status === 'stale')
    && snapshot.buckets.some((bucket) => bucket.windows.some((window) => window.usedPercent !== null));
}

/**
 * The limits a task's footer draws: its own runner's account, nobody else's,
 * and of an account that meters one provider only while the task's `model`
 * (`provider/model`) is that provider's. No model known is no provider known.
 */
export function accountLimitsOf(snapshots: readonly AccountLimitSnapshot[], runner: string | undefined, model?: string): AccountLimitSnapshot[] {
  if (!runner) return [];
  return snapshots.filter((snapshot) => snapshot.harness === runner
    && (snapshot.provider === undefined || (model?.startsWith(`${snapshot.provider}/`) ?? false)));
}

const WEEK = 7 * 24 * 60;
const DAY = 24 * 60;

const SLOT_LABELS: Record<AccountLimitWindow['slot'], string> = { primary: 'Primary', secondary: 'Secondary', tertiary: 'Tertiary' };

/** `5h`, `Weekly`, `Daily`, `3d`, `90m` from the window's own length, `Monthly` for a plan month; `Primary`/`Secondary` when it reported neither. */
export function accountLimitWindowLabel(window: AccountLimitWindow): string {
  if (window.period === 'month') return 'Monthly';
  const minutes = window.durationMinutes;
  if (minutes === null) return SLOT_LABELS[window.slot];
  if (minutes === WEEK) return 'Weekly';
  if (minutes === DAY) return 'Daily';
  if (minutes % WEEK === 0) return `${minutes / WEEK}w`;
  if (minutes % DAY === 0) return `${minutes / DAY}d`;
  if (minutes % 60 === 0) return `${minutes / 60}h`;
  return `${minutes}m`;
}

/** `24% used`, `<1% used` for a sliver, `0% used` only when the runner said 0. */
export function accountLimitPercentText(percent: number): string {
  const shown = percent > 0 && percent < 1 ? '<1' : String(Math.round(percent));
  return `${shown}% used`;
}

/**
 * The compact row: `Codex 5h 24% used · Weekly 61% used`, with any other
 * bucket after its own name, and `(stale)` when the read is not current.
 * Null when there is nothing known to draw.
 */
export function accountLimitsText(snapshot: AccountLimitSnapshot): string | null {
  if (!hasAccountLimits(snapshot)) return null;
  const parts = snapshot.buckets.flatMap((bucket, index) => {
    const windows = bucket.windows.flatMap((window) => window.usedPercent === null ? [] : [`${accountLimitWindowLabel(window)} ${accountLimitPercentText(window.usedPercent)}`]);
    if (windows.length === 0) return [];
    return index === 0 ? windows : [`${bucket.name ?? bucket.id} ${windows.join(' · ')}`];
  });
  return `${snapshot.label} ${parts.join(' · ')}${snapshot.status === 'stale' ? ' (stale)' : ''}`;
}

/**
 * The row's hover: each window's exact share and reset, the plan, and how
 * current the read is. `time` words an instant in the reader's clock.
 */
export function accountLimitsTitle(snapshot: AccountLimitSnapshot, time: (at: Date) => string): string {
  const lines = snapshot.buckets.flatMap((bucket, index) => bucket.windows.map((window) => {
    const owner = index === 0 ? snapshot.label : `${snapshot.label} ${bucket.name ?? bucket.id}`;
    const share = window.usedPercent === null ? 'not reported' : `${window.usedPercent}% used`;
    const reset = window.resetsAt ? `, resets ${time(new Date(window.resetsAt))}` : '';
    return `${owner} ${accountLimitWindowLabel(window)}: ${share}${reset}`;
  }));
  if (snapshot.plan) lines.push(`Plan: ${snapshot.plan}`);
  if (snapshot.readAt) {
    const read = time(new Date(snapshot.readAt));
    lines.push(snapshot.status === 'stale' ? `Last read ${read}; not current, a newer read is pending or failed` : `Read ${read}`);
  }
  return lines.join('\n');
}
