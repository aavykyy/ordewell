import { Hono } from 'hono';
import { installedPlannerDetected, type OkResponse, type RunnersResponse } from '@ordewell/core';
import { OrchestratorPool } from '../pool/orchestratorPool';

export function runnersRoute(pool: OrchestratorPool) {
  const router = new Hono();

  router.get('/', async (c) => {
    // getInstalledRunners re-probes the host first, so the state read after it
    // reflects the fresh answer rather than the stale default.
    const runners = await pool.getInstalledRunners();
    const state = pool.getRunnerState();
    return c.json({
      runners,
      orchestratorModel: state.orchestratorModel,
    } satisfies RunnersResponse);
  });

  router.put('/:id', async (c) => {
    // A toggle saves the enabled set it changes; built on the stale default,
    // it would save claude-code over the installed agents the probe finds.
    await installedPlannerDetected();
    const id = c.req.param('id');
    const body = await c.req.json();
    pool.setRunnerEnabled(id, body.enabled);
    return c.json({ ok: true } satisfies OkResponse);
  });

  return router;
}
