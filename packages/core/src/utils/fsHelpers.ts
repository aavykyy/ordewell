import * as fs from 'fs';
import * as path from 'path';
import { randomUUID } from 'crypto';

export const STATE_DIR = '.ordewell';

export function ensureDir(dir: string): void {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

/**
 * Replace `filePath` with `content` in one step. Writing in place truncates
 * the old bytes first, so a crash, power loss or a full disk mid-write leaves
 * an empty or half-written file where the last good one was — silent loss of
 * the only copy, for a session or a saved plan. The bytes go to a fresh temp
 * file beside the target and a rename swaps it in; within one directory that
 * is atomic, so a reader sees the old file or the new one.
 */
export function writeFileAtomic(filePath: string, content: string): void {
  const dir = path.dirname(filePath);
  ensureDir(dir);
  // Same directory, so the rename stays on one filesystem; random, so the name
  // can never collide with another process writing the same file.
  const tempPath = path.join(dir, `.${path.basename(filePath)}.${randomUUID()}.tmp`);
  fs.writeFileSync(tempPath, content, { flag: 'wx' });
  try {
    fs.renameSync(tempPath, filePath);
  } catch (err) {
    try {
      fs.unlinkSync(tempPath);
    } catch {
      // Already gone; the rename error is the one worth reporting.
    }
    throw err;
  }
}

export function getStateDir(baseDir?: string): string {
  return path.join(baseDir ?? process.cwd(), STATE_DIR);
}

const IGNORE_FILE = '.gitignore';

/**
 * Ignores the state directory's contents except this file and `skills/`, so a
 * project's skills are committed and reach every task worktree through git —
 * the bootstrap never links `.ordewell/` (ADR-0013). Plans and sessions stay
 * uncommittable without touching a file the developer wrote; editing their
 * root `.gitignore` would be the intrusive version of this.
 */
export const STATE_DIR_IGNORE = '*\n!.gitignore\n!skills/\n!skills/**\n';

/** What older builds wrote: everything ignored, the rules file included. */
const LEGACY_IGNORES = new Set(['*', '*\n']);

/**
 * Idempotent, and never overwrites a file the developer customised (to commit
 * their plans deliberately, say). Only the exact legacy rule is upgraded.
 */
export function ensureStateDirIgnored(baseDir?: string): void {
  const dir = getStateDir(baseDir);
  ensureDir(dir);
  const file = path.join(dir, IGNORE_FILE);
  try {
    // `wx` rather than an existsSync check: two surfaces can save concurrently,
    // and the loser of that race must not clobber the winner's file.
    fs.writeFileSync(file, STATE_DIR_IGNORE, { flag: 'wx' });
    return;
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
  }
  if (LEGACY_IGNORES.has(fs.readFileSync(file, 'utf8'))) fs.writeFileSync(file, STATE_DIR_IGNORE);
}
