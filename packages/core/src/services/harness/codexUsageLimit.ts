import { hour24, lastMatch, month, placeWallTime, type WallTime } from '../../utils/wallTime';
import type { UsageLimitSignal } from './AgentAdapter';

const CODEX_RESET_RE = /[Tt]ry again at (?:([A-Z][a-z]{2}) (\d{1,2})(?:st|nd|rd|th)?, (\d{4}) )?(\d{1,2}):(\d{2}) ([AP]M)\./g;

/**
 * When Codex's usage limit resets: "You've hit your usage limit. Try again at
 * 8:10 PM." on the same day, else "… at Oct 14th, 2026 8:10 PM.", in the local
 * time of the Codex process — Ordewell's own, as Codex runs as its child.
 */
export function codexUsageLimitReset(text: string, now: Date): Date | null {
  const m = lastMatch(CODEX_RESET_RE, text);
  if (!m) return null;
  const [, mon, day, year, hour, minute, meridiem] = m;
  const wall: WallTime = { hour: hour24(hour, meridiem), minute: Number(minute) };
  if (mon) {
    const at = month(mon);
    if (at === undefined) return null;
    Object.assign(wall, { month: at, day: Number(day), year: Number(year) });
  }
  return placeWallTime(wall, undefined, now);
}

/** One window of Codex's account limits, as `account/rateLimits/*` reports it: `resetsAt` in Unix seconds. */
interface CodexRateLimitWindow {
  usedPercent?: number;
  resetsAt?: number | null;
}

interface CodexRateLimitSnapshot {
  limitId?: string | null;
  primary?: CodexRateLimitWindow | null;
  secondary?: CodexRateLimitWindow | null;
}

/** What Codex has said of its account's limits, by limit id. */
export type CodexRateLimits = ReadonlyMap<string, CodexRateLimitSnapshot>;

/**
 * Fold one `account/rateLimits/updated` into what is known. The update is
 * sparse: a window it leaves null is unknown in it, not cleared.
 */
export function mergeCodexRateLimits(known: CodexRateLimits, params: unknown): CodexRateLimits {
  const snapshot = (params as { rateLimits?: CodexRateLimitSnapshot } | undefined)?.rateLimits;
  if (!snapshot || typeof snapshot !== 'object') return known;
  const id = snapshot.limitId ?? '';
  const before = known.get(id);
  const next = new Map(known);
  next.set(id, { limitId: id, primary: snapshot.primary ?? before?.primary, secondary: snapshot.secondary ?? before?.secondary });
  return next;
}

/**
 * Whether a Codex turn error is its account's usage limit, by the error's
 * `codexErrorInfo`. `rateLimitExceeded` is not: that is the provider's
 * throttle, which Codex retries itself.
 */
function isCodexUsageLimit(error: unknown): boolean {
  const info = (error as { codexErrorInfo?: unknown } | null | undefined)?.codexErrorInfo;
  if (info === 'usageLimitExceeded') return true;
  return typeof info === 'object' && info !== null && 'usageLimitExceeded' in info;
}

/**
 * The limit signal for a Codex turn error, or undefined when it is not the
 * usage limit. The reset is the latest among the windows used up and not yet
 * reset: no work runs before every one of them has reset.
 */
export function codexUsageLimitSignal(error: unknown, limits: CodexRateLimits, now: Date): UsageLimitSignal | undefined {
  if (!isCodexUsageLimit(error)) return undefined;
  const resets = [...limits.values()]
    .flatMap((snapshot) => [snapshot.primary, snapshot.secondary])
    .flatMap((window) => window && (window.usedPercent ?? 0) >= 100 && typeof window.resetsAt === 'number' ? [window.resetsAt * 1000] : [])
    .filter((at) => at > now.getTime());
  return resets.length > 0 ? { resetsAt: new Date(Math.max(...resets)).toISOString() } : {};
}
