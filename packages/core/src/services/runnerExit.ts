/**
 * What a stopped runner says about why it stopped, and what ending an attempt
 * does to the runner it leaves behind. TaskOrchestrator acts on the answers.
 */

/**
 * Why a runner stopped, as far as the tail of its own output says. `usage-limit`
 * is the account, not the task, running out; anything else is `stopped`.
 */
export type RunnerStop = 'usage-limit' | 'stopped';

/**
 * What a runner says when its account, not the task, ran out. A stop with no
 * `task_complete` call that names a limit is retryable once the limit resets, so it pauses the
 * task instead of failing it. Deliberately narrow: a false positive would leave
 * a genuinely broken task waiting on the user forever, and the words below are
 * the ones the runners print for this and nothing else.
 */
const USAGE_LIMIT_RE = /\b(?:usage|session|weekly|daily|monthly) limit\b|\brate limit (?:exceeded|reached)\b|\brate[- ]limited\b|\blimit (?:will )?reset\b|\bquota (?:exceeded|reached)\b|\btoo many requests\b/i;

/** How much of a stopped runner's tail is read for the limit signature: the error is the last thing it prints. */
const USAGE_LIMIT_TAIL = 4096;

/** Classify a stopped runner from the tail of its own output. */
export function classifyRunnerStop(output: string): RunnerStop {
  return USAGE_LIMIT_RE.test(output.slice(-USAGE_LIMIT_TAIL)) ? 'usage-limit' : 'stopped';
}

/** Every way an attempt ends: a verdict, a usage limit, cancel, release, Mark complete, retry, a failed spawn, stop, plan load. */
export type AttemptEnd = 'verdict' | 'usage-limit' | 'cancel' | 'release' | 'complete' | 'retry' | 'spawn-failed' | 'stop' | 'load';

/**
 * Whether ending an attempt with this reason has to stop its own runner now.
 * A verdict and a usage limit end it too (ADR-0018, L1): its log lives in Ordewell, and
 * whatever it did after the verdict would go unverified. Stop and load reset
 * every runner at once instead.
 */
export function stopsRunner(reason: AttemptEnd): boolean {
  return reason !== 'stop' && reason !== 'load';
}

/**
 * When a runner's usage limit resets, read from the limit message it printed,
 * or null when that runner's wording carries no time Ordewell can read — the
 * task then waits for a manual retry. Each runner words it its own way:
 *
 * - Claude Code: "You've hit your session limit · resets 8:10pm (Europe/Rome)",
 *   or "· resets Oct 14, 8:10pm (Europe/Rome)" beyond a day, with the year
 *   only when it differs; the time zone is always named.
 * - Codex: "You've hit your usage limit. Try again at 8:10 PM." on the same
 *   day, else "… at Oct 14th, 2026 8:10 PM.", in the local time of the Codex
 *   process — Ordewell's own, as Codex runs as its child.
 * - OpenCode passes its provider's error text through and adds no reset
 *   time of its own, so none is read.
 */
export function readUsageLimitReset(runner: string, output: string, now: Date = new Date()): Date | null {
  const tail = output.slice(-USAGE_LIMIT_TAIL);
  let reset: Date | null = null;
  try {
    if (runner === 'claude-code') reset = claudeReset(tail, now);
    else if (runner === 'codex') reset = codexReset(tail, now);
  } catch {
    // An unknown time zone name: the time cannot be placed, so it is not guessed.
    return null;
  }
  // A reset long past is not this stop's: the words were left over, and acting on them would retry at once.
  if (!reset || reset.getTime() < now.getTime() - DAY_MS) return null;
  return reset;
}

const DAY_MS = 24 * 60 * 60_000;
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

const CLAUDE_RESET_RE = /You['’]ve hit your [^\n]*?· (?:your [^·\n]*? )?resets (?:([A-Z][a-z]{2}) (\d{1,2}), (?:(\d{4}), )?)?(\d{1,2})(?::(\d{2}))?([ap]m) \(([A-Za-z0-9_+\-/]+)\)/g;
const CODEX_RESET_RE = /[Tt]ry again at (?:([A-Z][a-z]{2}) (\d{1,2})(?:st|nd|rd|th)?, (\d{4}) )?(\d{1,2}):(\d{2}) ([AP]M)\./g;

interface WallTime { year?: number; month?: number; day?: number; hour: number; minute: number }

function lastMatch(re: RegExp, text: string): RegExpExecArray | null {
  let last: RegExpExecArray | null = null;
  for (const m of text.matchAll(re)) last = m as RegExpExecArray;
  return last;
}

function hour24(hour: string, meridiem: string): number {
  const h = Number(hour) % 12;
  return meridiem.toLowerCase() === 'pm' ? h + 12 : h;
}

function month(name: string | undefined): number | undefined {
  if (!name) return undefined;
  const at = MONTHS.indexOf(name.toLowerCase());
  return at < 0 ? undefined : at;
}

function claudeReset(text: string, now: Date): Date | null {
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

function codexReset(text: string, now: Date): Date | null {
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

/**
 * The instant a wall-clock time names in `zone` (local time when absent). A
 * time with no date is the next one at or after `now` — both runners print
 * a bare time only for a reset within the day — allowing an hour for a
 * message read a little after it was written. A date with no year is this
 * year's: Claude Code adds the year whenever it differs.
 */
function placeWallTime(wall: WallTime, zone: string | undefined, now: Date): Date {
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
