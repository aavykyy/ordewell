import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'events';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { SettingsService } from '../SettingsService';

const h = vi.hoisted(() => ({ watchers: [] as EventEmitter[] }));

// Keep real saves and stamps, but supply event names independently of the OS.
vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>();
  return {
    ...actual,
    watch: (_dir: fs.PathLike, listener: (event: fs.WatchEventType, filename: string | null) => void) => {
      const watcher = new EventEmitter();
      watcher.on('change', listener);
      h.watchers.push(watcher);
      return Object.assign(watcher, { close: () => watcher.removeAllListeners() });
    },
  };
});

describe('SettingsService.watch filesystem events', () => {
  let dir: string;
  let file: string;
  let service: SettingsService;
  let watching: { dispose(): void };
  let listener: ReturnType<typeof vi.fn>;
  let watcher: EventEmitter;

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    h.watchers = [];
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ordewell-watch-events-'));
    file = path.join(dir, 'settings.json');
    service = new SettingsService(file);
    service.setEnabledRunners(['opencode']);
    listener = vi.fn();
    watching = service.watch(listener);
    watcher = h.watchers[0];
  });

  afterEach(() => {
    watching.dispose();
    vi.useRealTimers();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('reconciles a changed settings file when the event names the watched directory', () => {
    new SettingsService(file).setEnabledRunners(['codex']);

    watcher.emit('change', 'rename', path.basename(dir));
    vi.advanceTimersByTime(49);
    expect(listener).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);

    expect(listener).toHaveBeenCalledTimes(1);
    expect(service.getEnabledRunners()).toEqual(['codex']);
  });

  it('ignores unrelated filenames even while the settings file has changed', () => {
    new SettingsService(file).setEnabledRunners(['codex']);

    for (const name of ['unrelated.json', 'settings.json.lock', 'settings.json.tmp']) {
      watcher.emit('change', 'rename', name);
      vi.advanceTimersByTime(100);
      expect(listener).not.toHaveBeenCalled();
    }

    watcher.emit('change', 'rename', path.basename(dir));
    vi.advanceTimersByTime(50);
    expect(listener).toHaveBeenCalledTimes(1);

    // Directory events also describe siblings; an unchanged stamp stays quiet.
    fs.writeFileSync(path.join(dir, 'unrelated.json'), '{}');
    watcher.emit('change', 'rename', path.basename(dir));
    vi.advanceTimersByTime(100);
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('debounces file and directory events together without unrelated events delaying them', () => {
    new SettingsService(file).setEnabledRunners(['codex']);
    watcher.emit('change', 'rename', path.basename(file));
    vi.advanceTimersByTime(40);

    new SettingsService(file).setEnabledRunners(['codex', 'opencode']);
    watcher.emit('change', 'rename', path.basename(dir));
    vi.advanceTimersByTime(40);
    expect(listener).not.toHaveBeenCalled();

    watcher.emit('change', 'rename', 'unrelated.json');
    vi.advanceTimersByTime(10);
    expect(listener).toHaveBeenCalledTimes(1);
    expect(service.getEnabledRunners()).toEqual(['codex', 'opencode']);

    watcher.emit('change', 'change', path.basename(file));
    watcher.emit('change', 'rename', path.basename(dir));
    vi.advanceTimersByTime(100);
    expect(listener).toHaveBeenCalledTimes(1);
  });
});
