/**
 * Reading a wall-clock time out of a runner's message: the pieces each
 * connector's usage-limit reader shares, whatever its runner's wording.
 */

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

export interface WallTime { year?: number; month?: number; day?: number; hour: number; minute: number }

export function lastMatch(re: RegExp, text: string): RegExpExecArray | null {
  let last: RegExpExecArray | null = null;
  for (const m of text.matchAll(re)) last = m as RegExpExecArray;
  return last;
}

export function hour24(hour: string, meridiem: string): number {
  const h = Number(hour) % 12;
  return meridiem.toLowerCase() === 'pm' ? h + 12 : h;
}

export function month(name: string | undefined): number | undefined {
  if (!name) return undefined;
  const at = MONTHS.indexOf(name.toLowerCase());
  return at < 0 ? undefined : at;
}

/**
 * The instant a wall-clock time names in `zone` (local time when absent). A
 * time with no date is the next one at or after `now` — the runners print
 * a bare time only for a reset within the day — allowing an hour for a
 * message read a little after it was written. A date with no year is this
 * year's: a runner that omits it adds it whenever it differs.
 */
export function placeWallTime(wall: WallTime, zone: string | undefined, now: Date): Date {
  const today = wallFields(now, zone);
  const year = wall.year ?? today.year;
  const monthIndex = wall.month ?? today.month;
  const day = wall.day ?? today.day;
  const at = fromWall(year, monthIndex, day, wall.hour, wall.minute, zone);
  if (wall.day !== undefined || at.getTime() >= now.getTime() - HOUR_MS) return at;
  return fromWall(year, monthIndex, day + 1, wall.hour, wall.minute, zone);
}

const HOUR_MS = 60 * 60_000;

function wallFields(instant: Date, zone: string | undefined): { year: number; month: number; day: number; hour: number; minute: number; second: number } {
  if (!zone) {
    return { year: instant.getFullYear(), month: instant.getMonth(), day: instant.getDate(), hour: instant.getHours(), minute: instant.getMinutes(), second: instant.getSeconds() };
  }
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: zone, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric',
  }).formatToParts(instant);
  const field = (type: Intl.DateTimeFormatPartTypes): number => Number(parts.find((p) => p.type === type)?.value ?? 0);
  return { year: field('year'), month: field('month') - 1, day: field('day'), hour: field('hour'), minute: field('minute'), second: field('second') };
}

/** A zone's offset from UTC at an instant, read back through Intl because nothing else in the runtime knows IANA zones. */
function zoneOffsetMs(instant: number, zone: string): number {
  const f = wallFields(new Date(instant), zone);
  return Date.UTC(f.year, f.month, f.day, f.hour, f.minute, f.second) - Math.floor(instant / 1000) * 1000;
}

function fromWall(year: number, monthIndex: number, day: number, hour: number, minute: number, zone: string | undefined): Date {
  if (!zone) return new Date(year, monthIndex, day, hour, minute);
  const asUtc = Date.UTC(year, monthIndex, day, hour, minute);
  // Twice, because the offset at the first guess may sit across a DST change from the answer.
  let instant = asUtc - zoneOffsetMs(asUtc, zone);
  instant = asUtc - zoneOffsetMs(instant, zone);
  return new Date(instant);
}
