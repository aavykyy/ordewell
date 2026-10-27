import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { RUN_SETTINGS_DEFAULTS, SettingsService, saveSession, type LegacyPlanState } from '@ordewell/core';
import { OrchestratorPool } from '../orchestratorPool';

function savedPlan(): LegacyPlanState {
  return {
    status: 'approved',
    runners: ['claude-code'],
    generatedAt: '2026-10-27T10:00:00.000Z',
    tasks: [
      { id: 't1', order: 1, title: 'Add the limiter', type: 'ai', status: 'pending', description: 'd', dependencies: [], assignedRunner: 'claude-code', subtasks: [], prompt: 'do it' },
    ],
  } as unknown as LegacyPlanState;
}

/** Every open session shows its own run settings; the file is the default the next one opens with (ADR-0030). */
describe('OrchestratorPool run settings', () => {
  let workspace: string;
  let settingsDir: string;
  let savedSettingsPath: string | undefined;
  let pool: OrchestratorPool;

  beforeEach(() => {
    workspace = mkdtempSync(join(tmpdir(), 'ordewell-pool-run-settings-'));
    mkdirSync(join(workspace, '.git'));
    settingsDir = mkdtempSync(join(tmpdir(), 'ordewell-pool-run-settings-file-'));
    savedSettingsPath = process.env.ORDEWELL_SETTINGS_PATH;
    process.env.ORDEWELL_SETTINGS_PATH = join(settingsDir, 'settings.json');
    pool = new OrchestratorPool();
  });

  afterEach(() => {
    pool.destroyAll();
    if (savedSettingsPath === undefined) delete process.env.ORDEWELL_SETTINGS_PATH;
    else process.env.ORDEWELL_SETTINGS_PATH = savedSettingsPath;
    rmSync(workspace, { recursive: true, force: true });
    rmSync(settingsDir, { recursive: true, force: true });
  });

  const adopt = (id: string): void => {
    const meta = saveSession(savedPlan(), id, workspace, id);
    pool.adoptSavedSession(meta.id, workspace);
  };

  it('keeps each live session’s values, writes the file, and seeds a session opened later from it', () => {
    adopt('session-a');
    adopt('session-b');

    expect(pool.getSettings('session-a').run).toMatchObject({ supervisorLevel: 'watch', autorun: false });

    // B is given a value of its own first, so A's change has something to not overwrite.
    pool.updateRunSettings({ supervisorLevel: 'off' }, 'session-b');
    pool.updateRunSettings({ supervisorLevel: 'act', autorun: true }, 'session-a');

    expect(pool.getSettings('session-a').run).toMatchObject({ supervisorLevel: 'act', autorun: true });
    expect(pool.getSettings('session-b').run).toMatchObject({ supervisorLevel: 'off', autorun: false });
    expect(new SettingsService().getRunSettings()).toMatchObject({ supervisorLevel: 'act', autorun: true });

    adopt('session-c');

    expect(pool.getSettings('session-c').run).toMatchObject({ supervisorLevel: 'act', autorun: true });
  });

  it('answers the file for a session it is not holding, and for no session at all', () => {
    new SettingsService().updateRunSettings({ supervisorLevel: 'off' });

    expect(pool.getSettings('closed').run).toEqual({ ...RUN_SETTINGS_DEFAULTS, supervisorLevel: 'off' });
    expect(pool.getSettings().run).toEqual({ ...RUN_SETTINGS_DEFAULTS, supervisorLevel: 'off' });
  });
});
