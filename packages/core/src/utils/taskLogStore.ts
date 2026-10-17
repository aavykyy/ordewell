import * as fs from 'fs';
import * as path from 'path';
import type { TaskLogEvent } from '../models/TaskLog';
import { ensureStateDirIgnored } from './fsHelpers';
import { idSegment, sessionDataDir } from './sessionStore';

/*
 * A structured task's log on disk (ADR-0018, P1):
 * `.ordewell/sessions/<session>/tasks/<task>/<attempt>.jsonl`, one
 * append-only file per attempt, one event per line. Earlier attempts are
 * kept; the whole tree goes with its session (`deleteSession`).
 */

/** Which session's logs, in which workspace. */
export interface TaskLogLocation {
  baseDir: string;
  sessionId: string;
}

/** One attempt's file, open for appending. */
export interface TaskLogFile {
  readonly attempt: number;
  append(events: readonly TaskLogEvent[]): void;
}

const EXTENSION = '.jsonl';

function taskDir({ baseDir, sessionId }: TaskLogLocation, taskId: string): string {
  return path.join(sessionDataDir(sessionId, baseDir), 'tasks', idSegment(taskId));
}

/** The attempts a task has a log for, oldest first. */
export function listTaskLogAttempts(location: TaskLogLocation, taskId: string): number[] {
  let names: string[];
  try {
    names = fs.readdirSync(taskDir(location, taskId));
  } catch {
    return [];
  }
  return names
    .map((name) => (/^([1-9]\d*)\.jsonl$/.exec(name)?.[1]))
    .filter((n): n is string => n !== undefined)
    .map(Number)
    .sort((a, b) => a - b);
}

/**
 * Start an attempt's file, under the attempt's own number so its log and its
 * usage ledger name the same attempt. Without one, or when that file already
 * exists, it takes the next number after what is on disk: nothing saved is
 * ever overwritten.
 */
export function openTaskLog(location: TaskLogLocation, taskId: string, attempt?: number): TaskLogFile {
  ensureStateDirIgnored(location.baseDir);
  const dir = taskDir(location, taskId);
  fs.mkdirSync(dir, { recursive: true });
  const next = (listTaskLogAttempts(location, taskId).pop() ?? 0) + 1;
  let number = attempt !== undefined && Number.isInteger(attempt) && attempt >= 1 ? attempt : next;
  for (;;) {
    const file = path.join(dir, `${number}${EXTENSION}`);
    try {
      // `wx`: a second surface opening the same task's next attempt at the
      // same moment takes the number after, never the same file.
      fs.writeFileSync(file, '', { flag: 'wx' });
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === 'EEXIST') { number = Math.max(number + 1, next); continue; }
      throw err;
    }
    return {
      attempt: number,
      append(events) {
        if (events.length === 0) return;
        fs.appendFileSync(file, events.map((e) => `${JSON.stringify(e)}\n`).join(''));
      },
    };
  }
}

function isEvent(value: unknown): value is TaskLogEvent {
  return typeof value === 'object' && value !== null && typeof (value as { type?: unknown }).type === 'string';
}

/**
 * One attempt's events, in order; empty when it has no log. A line that does
 * not parse is skipped — the last one, most likely, cut off by a crash
 * mid-write — so what was saved before it still reads.
 */
export function readTaskLog(location: TaskLogLocation, taskId: string, attempt: number): TaskLogEvent[] {
  if (!Number.isInteger(attempt) || attempt < 1) return [];
  let raw: string;
  try {
    raw = fs.readFileSync(path.join(taskDir(location, taskId), `${attempt}${EXTENSION}`), 'utf-8');
  } catch {
    return [];
  }
  const events: TaskLogEvent[] = [];
  for (const line of raw.split('\n')) {
    if (!line) continue;
    try {
      const parsed: unknown = JSON.parse(line);
      if (isEvent(parsed)) events.push(parsed);
    } catch {
      // Skipped, as documented above.
    }
  }
  return events;
}
