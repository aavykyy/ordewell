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
    // (ADR-0030). The planner's model is judged against the runner catalog of
    // the session's workspace, else of the one the client is in, waited for
    // only where it decides that model (ADR-0040).
    const sessionId = c.req.query('sessionId') || undefined;
    const workspace = c.req.query('workspace') || undefined;
    await pool.discoverPlannerCatalogs(sessionId, workspace);
    const settings: SettingsResponse = pool.getSettings(sessionId, workspace);
    return c.json(settings);
  });

  router.patch('/', async (c) => {
    try {
      await installedPlannerDetected();
      const body = await jsonObject(c);
      // Every client names its workspace, which is not itself a change.
      if (Object.keys(body).every((key) => key === 'workspace')) {
        return refuse(c, 400, 'At least one setting field is required');
      }
      // Run settings (ADR-0030) are named fields under `run`, never environment
      // variables; `sessionId` is the session the change was made in, and
      // `workspace` the one the client is in, whose catalog a pick is judged by.
      const { run, sessionId: namedSession, workspace: namedWorkspace, ...rest } = body;
      if (namedSession !== undefined && typeof namedSession !== 'string') return refuse(c, 400, 'sessionId must be a string');
      if (namedWorkspace !== undefined && typeof namedWorkspace !== 'string') return refuse(c, 400, 'workspace must be a string');
      const sessionId = namedSession || undefined;
      const workspace = namedWorkspace || undefined;
      if (run !== undefined) {
        if (!run || typeof run !== 'object' || Array.isArray(run)) return refuse(c, 400, 'run must be an object of run settings');
        try {
          pool.updateRunSettings(run as Partial<GlobalRunSettings>, sessionId, workspace);
        } catch (err) {
          if (err instanceof RunSettingsError) return refuse(c, 400, err.message);
          throw err;
        }
      }
      // Only a planner switch waits for a catalog, the one it is judged
      // against, which no client has asked for yet when it switches (ADR-0040).
      const result: SettingsUpdateResponse = Object.keys(rest).length > 0
        ? await pool.writeSettings(rest, sessionId, workspace)
        : pool.getSettings(sessionId, workspace);
      return c.json(result);
    } catch (err) {
      return failure(c, err, 'settings update', { fallback: 400 });
    }
  });

  return router;
}
