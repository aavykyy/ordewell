import * as fs from 'fs';
import * as path from 'path';
import { randomUUID } from 'crypto';
import { globalDataDir, migrateOldConfigDir } from '../utils/globalDataDir';
import type { SupervisorLevel } from '../models/Execution';
import { DEFAULT_SUPERVISOR_RETRY_LIMIT } from './LoopGuards';
import { DEFAULT_WAKE_UP_READ_BUDGET } from './Supervisor';

/** How a run is started, watched and merged: the user's, not a plan's (ADR-0030). */
export interface GlobalRunSettings {
  supervisorLevel: SupervisorLevel;
  mergeAtGatesAutomatically: boolean;
  /** Start a plan when the planner submits it, approved as if the user had pressed Execute. */
  autorun: boolean;
  /** Retries an Act supervisor may make of one task in a run (a loop guard). */
  supervisorRetryLimit: number;
  /** Reads a wake-up turn may make, in place of a user message's caps. */
  wakeUpReadBudget: number;
  /** Research attempts that may run together (ADR-0037 R4). */
  researchMaxParallel: number;
  /** Research starts and automatic report turns allowed per user message (ADR-0037 R4). */
  researchMaxPerMessage: number;
}

export const RUN_SETTINGS_DEFAULTS: Readonly<GlobalRunSettings> = {
  supervisorLevel: 'watch',
  mergeAtGatesAutomatically: false,
  autorun: false,
  supervisorRetryLimit: DEFAULT_SUPERVISOR_RETRY_LIMIT,
  wakeUpReadBudget: DEFAULT_WAKE_UP_READ_BUDGET,
  researchMaxParallel: 2,
  researchMaxPerMessage: 4,
};

export class RunSettingsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RunSettingsError';
  }
}

const SUPERVISOR_LEVELS: readonly SupervisorLevel[] = ['off', 'watch', 'act'];

/** Each value's own check, so a hand-edited file and a refused update agree on what is usable. */
const RUN_SETTING_CHECKS: { [K in keyof GlobalRunSettings]: { valid: (v: unknown) => v is GlobalRunSettings[K]; refusal: string } } = {
  supervisorLevel: {
    valid: (v): v is SupervisorLevel => typeof v === 'string' && (SUPERVISOR_LEVELS as readonly string[]).includes(v),
    refusal: 'The supervisor level must be off, watch or act.',
  },
  mergeAtGatesAutomatically: {
    valid: (v): v is boolean => typeof v === 'boolean',
    refusal: 'Merge at gates automatically must be on or off.',
  },
  autorun: {
    valid: (v): v is boolean => typeof v === 'boolean',
    refusal: 'Autorun must be on or off.',
  },
  supervisorRetryLimit: {
    valid: (v): v is number => Number.isInteger(v) && (v as number) >= 0,
    refusal: 'The retry limit must be a whole number of retries, 0 or more.',
  },
  wakeUpReadBudget: {
    valid: (v): v is number => Number.isInteger(v) && (v as number) >= 1,
    refusal: 'The wake-up read budget must be a whole number of reads, 1 or more.',
  },
  researchMaxParallel: {
    valid: (v): v is number => Number.isSafeInteger(v) && (v as number) >= 1,
    refusal: 'The research parallel limit must be a whole number, 1 or more.',
  },
  researchMaxPerMessage: {
    valid: (v): v is number => Number.isSafeInteger(v) && (v as number) >= 1,
    refusal: 'The research per-message limit must be a whole number, 1 or more.',
  },
};

const RUN_SETTING_KEYS = Object.keys(RUN_SETTING_CHECKS) as (keyof GlobalRunSettings)[];

export interface UserSettings {
  modelAllowlist?: Record<string, string[]>;
  /** Last model (and its thinking effort) the user chose for each planner backend, keyed by planner backend id. */
  plannerModels?: Record<string, { model: string; effort?: string }>;
  /**
   * Runners the user picked for planning. Absent — not empty — is what falls
   * back to the environment's defaults; `[]` is a deliberate "none of them".
   */
  enabledRunners?: string[];
  /** Full (true) or Guarded (false), ADR-0001; Full until the user chooses. */
  autonomousMode?: boolean;
  supervisorLevel?: SupervisorLevel;
  mergeAtGatesAutomatically?: boolean;
  autorun?: boolean;
  supervisorRetryLimit?: number;
  wakeUpReadBudget?: number;
  researchMaxParallel?: number;
  researchMaxPerMessage?: number;
}

/**
 * The model allowlist, remembered planner models and enabled runners are shared
 * across processes by default. `ORDEWELL_SETTINGS_PATH` lets independent runs
 * use separate files: otherwise a write in one run would change another's
 * settings when `getAll()` detects the new mtime.
 */
export function getSettingsPath(): string {
  const override = process.env.ORDEWELL_SETTINGS_PATH;
  if (override && override.trim()) return override.trim();
  return path.join(globalDataDir(), 'settings.json');
}

/**
 * A remembered planner model is spawned verbatim by whichever agent becomes the
 * planner, so a hand-edited or older file is read entry by entry rather than
 * trusted: an entry without a real id would restore a planner that cannot start.
 * An unusable *effort* only loses the level, never the model that carried it.
 */
function readPlannerModels(raw: unknown): Record<string, { model: string; effort?: string }> | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const out: Record<string, { model: string; effort?: string }> = {};
  for (const [provider, entry] of Object.entries(raw as Record<string, unknown>)) {
    if (!entry || typeof entry !== 'object') continue;
    const { model, effort } = entry as { model?: unknown; effort?: unknown };
    if (typeof model !== 'string' || !model.trim()) continue;
    out[provider] = typeof effort === 'string' && effort.trim()
      ? { model, effort }
      : { model };
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/** The run settings `settings` holds, each one it leaves out at its default. */
export function runSettingsOf(settings: UserSettings): GlobalRunSettings {
  const out = { ...RUN_SETTINGS_DEFAULTS };
  for (const key of RUN_SETTING_KEYS) {
    if (settings[key] !== undefined) (out as Record<keyof GlobalRunSettings, unknown>)[key] = settings[key];
  }
  return out;
}

/** How many times a save is made afresh when another process keeps saving under it. */
const SAVE_TRIES = 5;

/**
 * A lock held this long belongs to a process that died between its check and
 * its swap: no live save holds it for more than a moment.
 */
const LOCK_STALE_MS = 2_000;
/** How long a save waits for a lock it cannot take before it gives up and says so. */
const LOCK_TIMEOUT_MS = 10_000;
const LOCK_POLL_MS = 5;
const LOCK_POLL_MAX_MS = 100;

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Runs `swap` holding `<file>.lock`, created exclusively, so no other process
 * that saves the file can swap it in between `swap`'s look at it and its
 * rename. Saves are synchronous, so the wait is too.
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
 * still be taken over, and the saves then overlap.
 */
function withFileLock<T>(file: string, swap: () => T): T {
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
      throw new Error(`Cannot save the settings file: ${lock} is still held after ${Math.round(LOCK_TIMEOUT_MS / 1000)} seconds by a process that is not finishing, or it cannot be removed. Check for a process stuck saving there, and delete the file if there is none.`);
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

/** Frees the lock this save holds, and leaves one another process has taken over. */
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

export class SettingsService {
  private filePath: string;
  private cache: UserSettings | null = null;
  private cachedStamp: string | null = null;

  constructor(filePath: string = getSettingsPath()) {
    this.filePath = filePath;
  }

  // Several processes share the settings file (VS Code extension host, web
  // server, CLI), so the cache is keyed on the file's identity: a write from any
  // other process invalidates it. A stale cache here previously meant an
  // allowlist set in one surface never reached another's planner.
  getAll(): UserSettings {
    const stamp = this.fileStamp();
    if (this.cache && stamp === this.cachedStamp) return this.cache;
    this.cache = this.load();
    this.cachedStamp = stamp;
    return this.cache;
  }

  /**
   * Every write replaces the file, so its inode changes with it; the mtime
   * alone cannot tell two writes apart on a filesystem whose timestamps are
   * coarse, and a write that shares the last one's tick stayed unseen.
   */
  private fileStamp(file: string = this.filePath): string | null {
    try {
      const stat = fs.statSync(file);
      return `${stat.ino}:${stat.mtimeMs}:${stat.size}`;
    } catch {
      return null;
    }
  }

  /**
   * What a change is applied to: the file as it is now, never a copy held since
   * an earlier read. Another process may have saved in between, and writing
   * the whole file back would silently undo it.
   */
  private current(): UserSettings {
    this.cache = null;
    return this.getAll();
  }

  /**
   * Calls `listener` when another process (or this one) saves the file. The
   * directory is watched, not the file: a write that swaps the file in leaves
   * a watch on the old one pointing at nothing.
   */
  watch(listener: () => void): { dispose(): void } {
    const dir = path.dirname(this.filePath);
    const name = path.basename(this.filePath);
    let seen = this.fileStamp();
    let timer: NodeJS.Timeout | undefined;
    let watcher: fs.FSWatcher;
    try {
      fs.mkdirSync(dir, { recursive: true });
      watcher = fs.watch(dir, (_event, changed) => {
        if (changed && changed !== name) return;
        // One save is several events; the stamp tells whether the file really moved.
        clearTimeout(timer);
        timer = setTimeout(() => {
          const stamp = this.fileStamp();
          if (stamp === seen) return;
          seen = stamp;
          listener();
        }, 50);
      });
    } catch {
      return { dispose() {} };
    }
    return { dispose: () => { clearTimeout(timer); watcher.close(); } };
  }

  getModelAllowlist(runner: string): string[] | undefined {
    return this.getAll().modelAllowlist?.[runner];
  }

  setModelAllowlist(runner: string, ids: string[] | undefined): void {
    this.save(() => {
      if (ids === undefined) {
        if (this.cache!.modelAllowlist) {
          delete this.cache!.modelAllowlist[runner];
          if (Object.keys(this.cache!.modelAllowlist).length === 0) {
            this.cache!.modelAllowlist = undefined;
          }
        }
      } else {
        if (!this.cache!.modelAllowlist) {
          this.cache!.modelAllowlist = {};
        }
        this.cache!.modelAllowlist[runner] = ids;
      }
    });
  }

  getPlannerModel(provider: string): { model: string; effort?: string } | undefined {
    return this.getAll().plannerModels?.[provider];
  }

  setPlannerModel(provider: string, entry: { model: string; effort?: string } | undefined): void {
    this.save(() => {
      if (entry === undefined) {
        if (this.cache!.plannerModels) {
          delete this.cache!.plannerModels[provider];
          if (Object.keys(this.cache!.plannerModels).length === 0) {
            this.cache!.plannerModels = undefined;
          }
        }
      } else {
        if (!this.cache!.plannerModels) {
          this.cache!.plannerModels = {};
        }
        this.cache!.plannerModels[provider] = entry.effort
          ? { model: entry.model, effort: entry.effort }
          : { model: entry.model };
      }
    });
  }

  getEnabledRunners(): string[] | undefined {
    return this.getAll().enabledRunners;
  }

  setEnabledRunners(ids: string[]): void {
    this.save(() => {
      this.cache!.enabledRunners = [...ids];
    });
  }

  /**
   * Change the list from what the file holds at this moment: the change is
   * handed the saved list (undefined when the user never chose) and its result
   * is saved in the same call. A list worked out from an earlier read would
   * save over what another surface set since. It may be handed the list again,
   * when another process saved before this one could (see {@link save}).
   */
  updateEnabledRunners(change: (saved: string[] | undefined) => string[]): string[] {
    return this.save(() => {
      const next = [...change(this.cache!.enabledRunners)];
      this.cache!.enabledRunners = next;
      return next;
    });
  }

  /** Save `ids` as the user's choice unless one is saved already, judged on the file as it is now. */
  setEnabledRunnersIfUnset(ids: string[]): boolean {
    return this.save(() => {
      if (this.cache!.enabledRunners !== undefined) return false;
      this.cache!.enabledRunners = [...ids];
      return true;
    });
  }

  /**
   * Full or Guarded (ADR-0001), as saved here (ADR-0030). A value set in the
   * environment wins, so a script or CI run can fix its own without touching
   * the user's file.
   */
  autonomousMode(): boolean {
    const env = process.env.ORDEWELL_AUTONOMOUS_MODE;
    if (this.autonomousModeOverridden()) return env !== 'false' && env !== '0';
    return this.getAll().autonomousMode ?? true;
  }

  /** Whether `ORDEWELL_AUTONOMOUS_MODE` decides the level, whatever this file says. */
  autonomousModeOverridden(): boolean {
    const env = process.env.ORDEWELL_AUTONOMOUS_MODE;
    return env !== undefined && env.trim() !== '';
  }

  setAutonomousMode(enabled: boolean): void {
    this.save(() => {
      this.cache!.autonomousMode = enabled;
    });
  }

  getRunSettings(): GlobalRunSettings {
    return runSettingsOf(this.getAll());
  }

  /** Checks every value before writing any, so a refused change saves nothing. */
  updateRunSettings(changes: Partial<GlobalRunSettings>): GlobalRunSettings {
    for (const key of RUN_SETTING_KEYS) {
      if (changes[key] !== undefined && !RUN_SETTING_CHECKS[key].valid(changes[key])) {
        throw new RunSettingsError(RUN_SETTING_CHECKS[key].refusal);
      }
    }
    this.save(() => {
      for (const key of RUN_SETTING_KEYS) {
        if (changes[key] !== undefined) (this.cache as Record<keyof GlobalRunSettings, unknown>)[key] = changes[key];
      }
    });
    return this.getRunSettings();
  }

  private load(): UserSettings {
    // A pre-`.ordewell` install keeps its settings in the old config dir; lift
    // them once before reading so the first read already sees the moved file.
    migrateOldConfigDir();
    try {
      if (fs.existsSync(this.filePath)) {
        const raw = JSON.parse(fs.readFileSync(this.filePath, 'utf-8'));
        // Only known keys are lifted, so the removed `tdd` (now a task skill)
        // and `verification` toggles and the `runnerTransport` setting of older
        // files are dropped on the next write.
        const settings: UserSettings = {};
        if (raw.modelAllowlist !== undefined) {
          settings.modelAllowlist = raw.modelAllowlist;
        }
        const plannerModels = readPlannerModels(raw.plannerModels);
        if (plannerModels) {
          settings.plannerModels = plannerModels;
        }
        if (Array.isArray(raw.enabledRunners)) {
          settings.enabledRunners = raw.enabledRunners.map(String);
        }
        if (typeof raw.autonomousMode === 'boolean') settings.autonomousMode = raw.autonomousMode;
        // A value it cannot use is left out, so its default stands.
        for (const key of RUN_SETTING_KEYS) {
          if (RUN_SETTING_CHECKS[key].valid(raw[key])) (settings as Record<keyof GlobalRunSettings, unknown>)[key] = raw[key];
        }
        return settings;
      }
    } catch {
      // corrupted file — use defaults
    }
    return {};
  }

  /**
   * Makes `change` to the file as it is now, and saves it. Another process can
   * save between that read and this write; the file is looked at again just
   * before ours replaces it, and when it moved the change is made afresh from
   * what that process saved, so neither save undoes the other. A file that
   * keeps moving is written over after {@link SAVE_TRIES} tries rather than
   * never. The look and the swap are one step under the file's lock
   * ({@link withFileLock}). A change that changes nothing writes nothing.
   */
  private save<T>(change: () => T): T {
    for (let tries = 1; ; tries++) {
      const before = JSON.stringify(this.current());
      const read = this.cachedStamp;
      const result = change();
      if (JSON.stringify(this.cache) === before || this.persist(tries < SAVE_TRIES ? read : undefined)) return result;
    }
  }

  /** False, saving nothing, when the file is no longer the one stamped `expected`. */
  private persist(expected?: string | null): boolean {
    const dir = path.dirname(this.filePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    // Written beside the file and renamed over it, so a process reading at that
    // moment sees the old file or the new one, never an empty one.
    const staging = `${this.filePath}.${process.pid}.tmp`;
    fs.writeFileSync(staging, JSON.stringify(this.cache, null, 2));
    // Stamped before the swap, which keeps all three: a save by another process
    // right after ours is then a different stamp, not mistaken for our own.
    const stamp = this.fileStamp(staging);
    const swapped = withFileLock(this.filePath, () => {
      if (expected !== undefined && this.fileStamp() !== expected) return false;
      fs.renameSync(staging, this.filePath);
      return true;
    });
    if (!swapped) {
      fs.rmSync(staging, { force: true });
      return false;
    }
    this.cachedStamp = stamp;
    return true;
  }
}
