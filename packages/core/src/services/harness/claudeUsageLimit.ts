import { hour24, lastMatch, month, placeWallTime, type WallTime } from '../../utils/wallTime';

const CLAUDE_RESET_RE = /You['’]ve hit your [^\n]*?· (?:your [^·\n]*? )?resets (?:([A-Z][a-z]{2}) (\d{1,2}), (?:(\d{4}), )?)?(\d{1,2})(?::(\d{2}))?([ap]m) \(([A-Za-z0-9_+\-/]+)\)/g;

/**
 * When Claude Code's usage limit resets: "You've hit your session limit ·
 * resets 8:10pm (Europe/Rome)", or "· resets Oct 14, 8:10pm (Europe/Rome)"
 * beyond a day, with the year only when it differs; the time zone is always
 * named. Throws on a zone name the runtime does not know.
 */
export function claudeUsageLimitReset(text: string, now: Date): Date | null {
  const m = lastMatch(CLAUDE_RESET_RE, text);
  if (!m) return null;
  const [, mon, day, year, hour, minute, meridiem, zone] = m;
  const wall: WallTime = { hour: hour24(hour, meridiem), minute: Number(minute ?? 0) };
  if (mon) {
    const at = month(mon);
    if (at === undefined) return null;
    Object.assign(wall, { month: at, day: Number(day), ...(year ? { year: Number(year) } : {}) });
  }
  return placeWallTime(wall, zone, now);
}
