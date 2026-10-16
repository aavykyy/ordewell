import { WebSocketServer, WebSocket } from 'ws';
import type { IncomingMessage } from 'http';
import type { Duplex } from 'stream';
import { DAEMON_SUBPROTOCOL, type RunSnapshotFrame } from '@ordewell/core';
import { OrchestratorPool } from '../pool/orchestratorPool';

export function createWsHandler(pool: OrchestratorPool) {
  const wss = new WebSocketServer({
    noServer: true,
    // Select the plain subprotocol explicitly. Left to itself `ws` echoes back
    // whichever was offered first, which would put the token in the 101
    // response; selecting nothing makes the client fail the handshake.
    handleProtocols: (protocols) => (protocols.has(DAEMON_SUBPROTOCOL) ? DAEMON_SUBPROTOCOL : false),
  });

  wss.on('connection', (ws: WebSocket, request: IncomingMessage) => {
    const url = new URL(request.url ?? '', `http://${request.headers.host}`);
    const sessionId = url.pathname.split('/').pop() || '';

    ws.on('close', () => {
      pool.unsubscribe(sessionId, ws);
    });

    ws.on('error', () => {
      pool.unsubscribe(sessionId, ws);
    });

    ws.send(JSON.stringify({ type: 'connected', sessionId }));
    // The stream reports changes only. Taken and subscribed in one turn, so no
    // broadcast can fall between the snapshot and the first message after it.
    const view = pool.runSnapshot(sessionId);
    if (view) {
      ws.send(JSON.stringify({
        type: 'run_snapshot', sessionId, view, approvals: pool.announcedApprovals(sessionId), ...pool.streamPosition(sessionId),
      } satisfies RunSnapshotFrame));
    }
    pool.subscribe(sessionId, ws);
  });

  return (request: IncomingMessage, socket: Duplex, head: Buffer) => {
    wss.handleUpgrade(request, socket, head, (ws) => {
      wss.emit('connection', ws, request);
    });
  };
}
