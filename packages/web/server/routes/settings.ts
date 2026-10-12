import { Hono } from 'hono';
import { RunSettingsError, type GlobalRunSettings, type SettingsResponse, type SettingsUpdateResponse } from '@ordewell/core';
import type { OrchestratorPool } from '../pool/orchestratorPool';
import { refuse } from './errors';

export function settingsRoute(pool: OrchestratorPool) {
  const router = new Hono();

  router.get('/', (c) => {
    const settings: SettingsResponse = pool.getSettings();
    return c.json(settings);
  });

  router.patch('/', async (c) => {
    const body: unknown = await c.req.json();
    if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).length === 0) {
      return refuse(c, 400, 'At least one setting field is required');
    }
    // Run settings (ADR-0030) are named fields under `run`, never environment
    // variables; `sessionId` is the session the change was made in.
    const { run, sessionId, ...rest } = body as Record<string, unknown>;
    if (run !== undefined) {
      if (!run || typeof run !== 'object' || Array.isArray(run)) return refuse(c, 400, 'run must be an object of run settings');
      if (sessionId !== undefined && typeof sessionId !== 'string') return refuse(c, 400, 'sessionId must be a string');
      try {
        pool.updateRunSettings(run as Partial<GlobalRunSettings>, sessionId);
      } catch (err) {
        if (err instanceof RunSettingsError) return refuse(c, 400, err.message);
        throw err;
      }
    }
    const result: SettingsUpdateResponse = Object.keys(rest).length > 0 ? pool.updateSettings(rest) : pool.getSettings();
    return c.json(result);
  });

  return router;
}
