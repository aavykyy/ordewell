import * as fs from 'fs';
import * as path from 'path';
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
}

export const RUN_SETTINGS_DEFAULTS: Readonly<GlobalRunSettings> = {
  supervisorLevel: 'watch',
  mergeAtGatesAutomatically: false,
  autorun: false,
  supervisorRetryLimit: DEFAULT_SUPERVISOR_RETRY_LIMIT,
  wakeUpReadBudget: DEFAULT_WAKE_UP_READ_BUDGET,
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
};

const RUN_SETTING_KEYS = Object.keys(RUN_SETTING_CHECKS) as (keyof GlobalRunSettings)[];

export interface UserSettings {
  modelAllowlist?: Record<string, string[]>;
  /** Last model (and its thinking effort) the user chose for each planner backend, keyed by AiProvider id. */
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

export class SettingsService {
  private filePath: string;
  private cache: UserSettings | null = null;
  private cachedMtimeMs: number | null = null;

  constructor(filePath: string = getSettingsPath()) {
    this.filePath = filePath;
  }

  // Several processes share the settings file (VS Code extension host, web
  // server, CLI), so the cache is keyed on the file's mtime: a write from any
  // other process invalidates it. A stale cache here previously meant an
  // allowlist set in one surface never reached another's planner.
  getAll(): UserSettings {
    const mtime = this.fileMtimeMs();
    if (this.cache && mtime === this.cachedMtimeMs) return this.cache;
    this.cache = this.load();
    this.cachedMtimeMs = mtime;
    return this.cache;
  }

  private fileMtimeMs(): number | null {
    try {
      return fs.statSync(this.filePath).mtimeMs;
    } catch {
      return null;
    }
  }

  getModelAllowlist(runner: string): string[] | undefined {
    return this.getAll().modelAllowlist?.[runner];
  }

  setModelAllowlist(runner: string, ids: string[] | undefined): void {
    this.getAll();
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
    this.persist();
  }

  getPlannerModel(provider: string): { model: string; effort?: string } | undefined {
    return this.getAll().plannerModels?.[provider];
  }

  setPlannerModel(provider: string, entry: { model: string; effort?: string } | undefined): void {
    this.getAll();
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
    this.persist();
  }

  getEnabledRunners(): string[] | undefined {
    return this.getAll().enabledRunners;
  }

  setEnabledRunners(ids: string[]): void {
    this.getAll();
    this.cache!.enabledRunners = [...ids];
    this.persist();
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
    this.getAll();
    this.cache!.autonomousMode = enabled;
    this.persist();
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
    this.getAll();
    for (const key of RUN_SETTING_KEYS) {
      if (changes[key] !== undefined) (this.cache as Record<keyof GlobalRunSettings, unknown>)[key] = changes[key];
    }
    this.persist();
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

  private persist(): void {
    const dir = path.dirname(this.filePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(this.filePath, JSON.stringify(this.cache, null, 2));
    this.cachedMtimeMs = this.fileMtimeMs();
  }
}
