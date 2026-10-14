#!/usr/bin/env node
import { createApp, attachWsHandler } from './app';
import { createRequestListener } from './nodeAdapter';
import { OrchestratorPool } from './pool/orchestratorPool';
import { createServer } from 'http';
import { clearDaemonToken, mintDaemonToken, StructuredRunner } from '@ordewell/core';

const args = process.argv.slice(2);
let port = 3742;

const portIdx = args.indexOf('--port');
if (portIdx !== -1 && args[portIdx + 1]) {
  port = parseInt(args[portIdx + 1], 10) || 3742;
}

// Set only for a daemon owned by one CLI invocation (e.g. `ordewell tui`),
// which spawns it non-detached expecting it to die with the caller. A
// closed terminal delivers SIGHUP to both via the shared process group, but
// that misses a caller killed by PID directly or a multiplexer that doesn't
// relay the signal — this poll is the fallback so an owned daemon never
// outlives its CLI and orphans don't accumulate.
const watchParentIdx = args.indexOf('--watch-parent');
const watchParentPid = watchParentIdx !== -1 ? parseInt(args[watchParentIdx + 1], 10) : undefined;

// Tasks run on the structured transport (ADR-0018) as plain child processes,
// so one runner serves every plan whatever the host has.
const pool = new OrchestratorPool({ runner: new StructuredRunner() });
const server = createServer();
let ownsToken = false;

server.listen(port, '127.0.0.1', () => {
  // A losing startup must not replace the listening daemon's credential.
  // This callback installs admission before the event loop can serve a request.
  const { token, file: tokenFile } = mintDaemonToken(port);
  ownsToken = true;
  const admission = { port, token, tokenFile };
  const app = createApp(pool, admission);
  app.get('/', (c) => c.json({ message: 'Ordewell API', docs: '/api/workspaces' }));
  server.on('request', createRequestListener(app));
  attachWsHandler(server, pool, admission);
  pool.getProviderModels().catch((err) => {
    console.error(`[web] model discovery warmup failed: ${err?.message ?? err}`);
  });
  console.error(`[web] Ordewell API server: http://localhost:${port}`);
});

function shutdown(): void {
  if (ownsToken) clearDaemonToken(port);
  pool.destroyAll();
  server.close();
  process.exit(0);
}

// A stray rejection in one session's background work must not take every
// session's runners down with the daemon.
process.on('unhandledRejection', (reason) => {
  console.error(`[web] unhandled rejection: ${reason instanceof Error ? reason.stack ?? reason.message : String(reason)}`);
});

process.on('SIGINT', () => { shutdown(); });
process.on('SIGTERM', () => { shutdown(); });
process.on('SIGHUP', () => { shutdown(); });

if (watchParentPid) {
  const parentCheck = setInterval(() => {
    try {
      process.kill(watchParentPid, 0);
    } catch {
      clearInterval(parentCheck);
      shutdown();
    }
  }, 5000);
}
