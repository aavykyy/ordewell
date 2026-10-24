import * as fs from 'fs';
import { randomUUID } from 'crypto';

/**
 * A lock held this long belongs to a process that died between its check and
 * its swap: no live holder keeps it for more than a moment.
 */
const LOCK_STALE_MS = 2_000;
/** How long a caller waits for a lock it cannot take before it gives up and says so. */
const LOCK_TIMEOUT_MS = 10_000;
const LOCK_POLL_MS = 5;
const LOCK_POLL_MAX_MS = 100;

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Runs `swap` holding `<file>.lock`, created exclusively, so no other process
 * that takes the same lock can change `file` in between `swap`'s look at it
 * and its write. Callers are synchronous, so the wait is too. `doing` names
 * the work in the refusal: "save the settings file".
 *
 * The lock names its holder. A holder frees only its own lock; a waiter may
 * remove one only when two looks a poll apart agree that it is still the same
 * lock — same token, same mtime — and its age says the process that made it
 * died holding it. A lock another waiter has since taken over is a different
 * lock, with another token and a fresh mtime, and is left to its holder. The
 * wait is bounded: a lock that is never free is raised after
 * {@link LOCK_TIMEOUT_MS}, and one that cannot be removed is raised at once,
 * rather than retried for ever. What that leaves is the known window of a
 * holder that neither dies nor finishes: one stalled past the stale age can
 * still be taken over, and the swaps then overlap.
 */
export function withFileLock<T>(file: string, swap: () => T, doing: string): T {
  const lock = `${file}.lock`;
  const token = `${process.pid}:${randomUUID()}`;
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  let last: { token: string; mtimeMs: number } | null = null;
  let poll = LOCK_POLL_MS;
  for (;;) {
    try {
      const fd = fs.openSync(lock, 'wx');
      try {
        fs.writeSync(fd, token);
      } finally {
        fs.closeSync(fd);
      }
      break;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
    }
    // Every wait is bounded, whatever it is waiting on: a lock that is never
    // free is said rather than polled for ever.
    if (Date.now() >= deadline) {
      throw new Error(`Cannot ${doing}: ${lock} is still held after ${Math.round(LOCK_TIMEOUT_MS / 1000)} seconds by a process that is not finishing, or it cannot be removed. Check for a process stuck there, and delete the file if there is none.`);
    }
    let holder: string;
    let mtimeMs: number;
    try {
      holder = fs.readFileSync(lock, 'utf8');
      mtimeMs = fs.statSync(lock).mtimeMs;
    } catch (err) {
      if (gone(err)) {
        last = null;
        continue; // released between the calls
      }
      throw err;
    }
    const stale = Date.now() - mtimeMs > LOCK_STALE_MS;
    if (last && last.token === holder && last.mtimeMs === mtimeMs && stale) {
      unlinkLock(lock);
      last = null;
      continue;
    }
    last = stale ? { token: holder, mtimeMs } : null;
    sleepSync(poll);
    poll = Math.min(poll * 2, LOCK_POLL_MAX_MS);
  }
  try {
    return swap();
  } finally {
    releaseLock(lock, token);
  }
}

/** True for the one error every look at a lock may meet by racing: it is not there any more. */
function gone(err: unknown): boolean {
  return (err as NodeJS.ErrnoException).code === 'ENOENT';
}

/** Frees the lock this caller holds, and leaves one another process has taken over. */
function releaseLock(lock: string, token: string): void {
  let holder: string;
  try {
    holder = fs.readFileSync(lock, 'utf8');
  } catch (err) {
    if (gone(err)) return; // already released
    throw err;
  }
  if (holder === token) unlinkLock(lock);
}

/** Removes a lock, tolerating the race that removed it first and nothing else: a refusal is raised. */
function unlinkLock(lock: string): void {
  try {
    fs.unlinkSync(lock);
  } catch (err) {
    if (!gone(err)) throw err;
  }
}
