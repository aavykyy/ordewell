import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { SettingsService } from '../SettingsService';

/** Runs in place of the swap's rename, as another process would act while it happens; reset after each test. */
let duringSwap: ((to: string) => void) | null = null;

vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>();
  return {
    ...actual,
    renameSync: (from: fs.PathLike, to: fs.PathLike) => {
      duringSwap?.(String(to));
      actual.renameSync(from, to);
    },
  };
});

describe('SettingsService — the save lock is only ever released by its holder', () => {
  let dir: string;
  let file: string;
  let lock: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ordewell-settings-lock-'));
    file = path.join(dir, 'settings.json');
    lock = `${file}.lock`;
  });

  afterEach(() => {
    duringSwap = null;
    fs.rmSync(dir, { recursive: true, force: true });
  });

  // A save suspended past the stale age has its lock taken over by another
  // process; on waking it must not remove the lock that is no longer its own.
  it('leaves the lock another process took over while it swapped', () => {
    duringSwap = (to) => {
      if (to !== file) return;
      fs.rmSync(lock);
      fs.writeFileSync(lock, 'other');
    };

    new SettingsService(file).setEnabledRunners(['codex']);

    expect(fs.readFileSync(lock, 'utf8')).toBe('other');
  });

  // Two waiters found the same lock stale; the other removed it and took its
  // own before this one got to it. That fresh lock is waited on, not removed.
  it('does not remove a fresh lock that replaced the stale one it found', () => {
    fs.writeFileSync(lock, 'dead');
    const longAgo = new Date(Date.now() - 60_000);
    fs.utimesSync(lock, longAgo, longAgo);
    let freshAt: number | undefined;
    let waited: number | undefined;
    duringSwap = (to) => {
      if (to === file) waited = freshAt === undefined ? undefined : Date.now() - freshAt;
      else if (freshAt === undefined && to.startsWith(`${lock}.`)) {
        fs.rmSync(lock);
        fs.writeFileSync(lock, 'fresh');
        freshAt = Date.now();
      }
    };

    new SettingsService(file).setEnabledRunners(['codex']);

    // It goes ahead only once the fresh lock has itself gone stale.
    expect(waited).toBeGreaterThanOrEqual(2_000);
    expect(new SettingsService(file).getEnabledRunners()).toEqual(['codex']);
  }, 10_000);

  it('releases its own lock', () => {
    new SettingsService(file).setEnabledRunners(['codex']);
    expect(fs.existsSync(lock)).toBe(false);
  });
});
