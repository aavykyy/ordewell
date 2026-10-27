import { Hono } from 'hono';
import { RunSettingsError, installedPlannerDetected, type GlobalRunSettings, type SettingsResponse, type SettingsUpdateResponse } from '@ordewell/core';
import type { OrchestratorPool } from '../pool/orchestratorPool';
import { failure, jsonObject, refuse } from './errors';

export function settingsRoute(pool: OrchestratorPool) {
  const router = new Hono();

  // Both wait for the startup probe (ADR-0009): the TUI reads the planner from
  // here the moment it opens, and a /planner switch is judged against the
  // planner in effect, which the probe may be about to change.
  router.get('/', async (c) => {
    await installedPlannerDetected();
    // An open session answers with its own run settings; no id or an id it no
    // longer holds answers with the file's, which a new session starts from
    // (ADR-0030).
    const settings: SettingsResponse = pool.getSettings(c.req.query('sessionId') || undefined);
    return c.json(settings);
  });

  router.patch('/', async (c) => {
    try {
      await installedPlannerDetected();
      const body = await jsonObject(c);
      if (Object.keys(body).length === 0) {
        return refuse(c, 400, 'At least one setting field is required');
      }
      // Run settings (ADR-0030) are named fields under `run`, never environment
      // variables; `sessionId` is the session the change was made in.
      const { run, sessionId: namedSession, ...rest } = body;
      if (namedSession !== undefined && typeof namedSession !== 'string') return refuse(c, 400, 'sessionId must be a string');
      const sessionId = namedSession || undefined;
      if (run !== undefined) {
        if (!run || typeof run !== 'object' || Array.isArray(run)) return refuse(c, 400, 'run must be an object of run settings');
        try {
          pool.updateRunSettings(run as Partial<GlobalRunSettings>, sessionId);
        } catch (err) {
          if (err instanceof RunSettingsError) return refuse(c, 400, err.message);
          throw err;
        }
      }
      const result: SettingsUpdateResponse = Object.keys(rest).length > 0
        ? (sessionId ? pool.updateSettings(rest, sessionId) : pool.updateSettings(rest))
        : pool.getSettings(sessionId);
      return c.json(result);
    } catch (err) {
      return failure(c, err, 'settings update', { fallback: 400 });
    }
  });

  return router;
}
