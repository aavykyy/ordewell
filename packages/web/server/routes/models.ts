import { Hono } from 'hono';
import type { ModelsResponse } from '@ordewell/core';
import type { OrchestratorPool } from '../pool/orchestratorPool';

export function modelsRoute(pool: OrchestratorPool) {
  const router = new Hono();

  router.get('/', async (c) => {
    // The catalog of the workspace's own runner environment, as its login verdict is.
    const result: ModelsResponse = await pool.getProviderModels(c.req.query('workspace'));
    return c.json(result);
  });

  return router;
}
