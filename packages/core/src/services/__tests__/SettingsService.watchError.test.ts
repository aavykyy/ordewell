import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'events';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

interface FakeWatcher extends EventEmitter {
  closed: boolean;
  close(): void;
}

const h = vi.hoisted(() => ({ watchers: [] as unknown[] }));

// fs.watch is the only part replaced: a real watcher cannot be made to fail on
// demand, and a failing one is what this suite is about.
vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>();
  return {
    ...actual,
    watch: () => {
      const watcher = new EventEmitter() as FakeWatcher;
      watcher.closed = false;
      watcher.close = () => { watcher.closed = true; };
      h.watchers.push(watcher);
      return watcher;
    },
  };
});

import { SettingsService } from '../SettingsService';

describe('SettingsService.watch on a failing watcher', () => {
  let dir: string;
  let warn: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    h.watchers = [];
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ordewell-watch-'));
    warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    warn.mockRestore();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('treats a watcher error as a dead watch, not an uncaught exception that kills the host', () => {
    const service = new SettingsService(path.join(dir, 'settings.json'));
    const watching = service.watch(() => {});
    const watcher = h.watchers[0] as FakeWatcher;

    // An EventEmitter with no 'error' listener throws this straight out.
    expect(() => watcher.emit('error', Object.assign(new Error('EMFILE: too many open files, watch'), { code: 'EMFILE' }))).not.toThrow();

    expect(watcher.closed).toBe(true);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toContain('EMFILE');

    // A second error from the same dead watch is not a second report.
    expect(() => watcher.emit('error', new Error('again'))).not.toThrow();
    expect(warn).toHaveBeenCalledTimes(1);

    watching.dispose();
  });
});
