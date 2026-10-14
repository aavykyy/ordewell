import { hour24, lastMatch, month, placeWallTime, type WallTime } from '../../utils/wallTime';

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
