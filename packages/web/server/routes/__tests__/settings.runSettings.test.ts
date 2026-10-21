import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { SettingsService, type SettingsResponse } from '@ordewell/core';
import { OrchestratorPool } from '../../pool/orchestratorPool';
import { settingsRoute } from '../settings';
import { plansRoute } from '../plans';

/** Run settings are the user's, saved machine-wide and changed through this route (ADR-0030). */
describe('run settings over /api/settings', () => {
  let dir: string;
  let pool: OrchestratorPool;
  let app: Hono;
  const savedPath = process.env.ORDEWELL_SETTINGS_PATH;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ordewell-run-settings-'));
    process.env.ORDEWELL_SETTINGS_PATH = path.join(dir, 'settings.json');
    pool = new OrchestratorPool();
    app = new Hono().route('/api/settings', settingsRoute(pool)).route('/api/plans', plansRoute(pool));
  });

  afterEach(() => {
    pool.destroyAll();
    if (savedPath === undefined) delete process.env.ORDEWELL_SETTINGS_PATH;
    else process.env.ORDEWELL_SETTINGS_PATH = savedPath;
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const patch = (body: unknown) => app.request('/api/settings', {
    method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });

  it('answers the run settings, each at its default until the user sets it', async () => {
    const body = await (await app.request('/api/settings')).json() as SettingsResponse;

    expect(body.run).toEqual({ supervisorLevel: 'watch', mergeAtGatesAutomatically: false, autorun: false, supervisorRetryLimit: 2, wakeUpReadBudget: 12, researchMaxParallel: 2, researchMaxPerMessage: 4 });
  });

  it('saves a change for every session and answers the settings as they now stand', async () => {
    const res = await patch({ run: { supervisorLevel: 'act', autorun: true, researchMaxParallel: 1, researchMaxPerMessage: 3 } });

    expect(res.status).toBe(200);
    expect((await res.json() as SettingsResponse).run).toMatchObject({ supervisorLevel: 'act', autorun: true, researchMaxParallel: 1, researchMaxPerMessage: 3 });
    expect(new SettingsService().getRunSettings()).toMatchObject({ supervisorLevel: 'act', autorun: true, researchMaxParallel: 1, researchMaxPerMessage: 3 });
  });

  it('applies the change to the named session\'s run at once', async () => {
    const applyRunSettings = vi.fn();
    (pool as unknown as { sessions: Map<string, unknown> }).sessions.set('s1', { applyRunSettings, destroy: vi.fn() });

    await patch({ run: { mergeAtGatesAutomatically: true }, sessionId: 's1' });

    expect(applyRunSettings).toHaveBeenCalledWith({ mergeAtGatesAutomatically: true });
  });

  it('refuses a value outside its range, saving nothing and applying nothing', async () => {
    const applyRunSettings = vi.fn();
    (pool as unknown as { sessions: Map<string, unknown> }).sessions.set('s1', { applyRunSettings, destroy: vi.fn() });

    const res = await patch({ run: { supervisorLevel: 'act', supervisorRetryLimit: -1 }, sessionId: 's1' });

    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toMatch(/retry limit/i);
    expect(new SettingsService().getRunSettings().supervisorLevel).toBe('watch');
    expect(applyRunSettings).not.toHaveBeenCalled();
  });

  it('has no per-plan settings route any more', async () => {
    (pool as unknown as { sessions: Map<string, unknown> }).sessions.set('s1', { destroy: vi.fn() });
    const settings = await app.request('/api/plans/s1/settings', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: '{"supervisorLevel":"act"}' });
    const lower = await app.request('/api/plans/s1/supervisor/lower', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"level":"off"}' });

    expect([settings.status, lower.status]).toEqual([404, 404]);
  });
});
