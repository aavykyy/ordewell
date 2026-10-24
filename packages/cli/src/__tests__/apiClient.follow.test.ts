import { describe, it, expect, vi } from 'vitest';
import { WebSocketServer, type WebSocket } from 'ws';
import { ApiClient } from '../apiClient';

async function server(onConnection: (ws: WebSocket) => void = () => {}) {
  const wss = new WebSocketServer({ port: 0 });
  await new Promise<void>((resolve) => wss.once('listening', () => resolve()));
  wss.on('connection', onConnection);
  return { wss, client: new ApiClient((wss.address() as { port: number }).port) };
}

describe('ApiClient.followSession', () => {
  it('stays open past a run\'s end, so the next run is heard whoever starts it', async () => {
    const sockets: WebSocket[] = [];
    const { wss, client } = await server((ws) => { sockets.push(ws); });
    const events: string[] = [];

    const follow = client.followSession('s1', (e) => events.push(e.type));
    await expect(follow.ready).resolves.toBe(true);
    await vi.waitFor(() => expect(sockets).toHaveLength(1));
    sockets[0].send(JSON.stringify({ type: 'execution_complete', summary: { total: 1, completed: 1, failed: 0 } }));
    sockets[0].send(JSON.stringify({ type: 'task_started', taskId: 'a', order: 1, title: 'A', runner: 'claude-code' }));
    await vi.waitFor(() => expect(events).toEqual(['execution_complete', 'task_started']));

    follow.close();
    await expect(follow.ended).resolves.toBeUndefined();
    wss.close();
  });

  it('ends lost when the daemon goes away', async () => {
    const { wss, client } = await server((ws) => { setTimeout(() => ws.terminate(), 20); });

    const follow = client.followSession('s1', () => {});
    await follow.ready;

    await expect(follow.ended).resolves.toBe('lost');
    wss.close();
  });

  it('settles ready, never rejects, when nothing is listening', async () => {
    const { wss, client } = await server();
    await new Promise<void>((resolve) => wss.close(() => resolve()));

    const follow = client.followSession('s1', () => {});
    await expect(follow.ready).resolves.toBe(false);
    await expect(follow.ended).resolves.toBe('lost');
  });
});
