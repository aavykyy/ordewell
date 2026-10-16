import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import http from 'http';
import type { AddressInfo } from 'net';
import { mkdtempSync, mkdirSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import WebSocket from 'ws';
import { DAEMON_SUBPROTOCOL, saveSession, type LegacyPlanState, type RunSnapshotFrame, type SessionFrame } from '@ordewell/core';
import { createWsHandler } from '../stream';
import { OrchestratorPool } from '../../pool/orchestratorPool';

function savedPlan(): LegacyPlanState {
  return {
    status: 'approved',
    runners: ['opencode'],
    generatedAt: '2026-10-13T09:00:00.000Z',
    lastUpdated: '2026-10-13T09:00:00.000Z',
    tasks: [
      { id: 't1', order: 1, title: 'Add the limiter', type: 'ai', status: 'completed', description: 'd', dependencies: [], assignedRunner: 'opencode', subtasks: [] },
      { id: 't2', order: 2, title: 'Wire it up', type: 'ai', status: 'pending', description: 'd', dependencies: ['t1'], assignedRunner: 'opencode', subtasks: [] },
    ],
  };
}

/** The first `count` frames a new socket on the session receives. */
function firstFrames(port: number, sessionId: string, count: number): Promise<unknown[]> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(`ws://127.0.0.1:${port}/ws/${sessionId}`, [DAEMON_SUBPROTOCOL]);
    const frames: unknown[] = [];
    const timer = setTimeout(() => { socket.terminate(); reject(new Error(`got ${frames.length} of ${count} frames`)); }, 5000);
    socket.on('message', (data) => {
      frames.push(JSON.parse(data.toString()));
      if (frames.length < count) return;
      clearTimeout(timer);
      socket.close();
      resolve(frames);
    });
    socket.on('error', reject);
  });
}

describe('the session socket', () => {
  let workspace: string;
  let pool: OrchestratorPool;
  let server: http.Server;
  let port: number;

  beforeEach(async () => {
    workspace = mkdtempSync(join(tmpdir(), 'ordewell-stream-'));
    mkdirSync(join(workspace, '.git'));
    pool = new OrchestratorPool();
    server = http.createServer();
    const upgrade = createWsHandler(pool);
    server.on('upgrade', upgrade);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    port = (server.address() as AddressInfo).port;
  });

  afterEach(async () => {
    pool.destroyAll();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(workspace, { recursive: true, force: true });
  });

  it('sends a joining client the run as it stands, right after connected', async () => {
    const meta = saveSession(savedPlan(), 'Rate limiting', workspace, 'session-saved');
    pool.adoptSavedSession(meta.id, workspace);

    const [connected, snapshot] = await firstFrames(port, meta.id, 2);

    expect(connected).toEqual({ type: 'connected', sessionId: meta.id });
    const frame = snapshot as RunSnapshotFrame;
    expect(frame.type).toBe('run_snapshot');
    expect(frame.sessionId).toBe(meta.id);
    expect(frame.view.tasks.map((t) => [t.id, t.title, t.status])).toEqual([['t1', 'Add the limiter', 'completed'], ['t2', 'Wire it up', 'pending']]);
    expect(frame.approvals).toEqual([]);
  });

  it('numbers every broadcast of a session, and greets with the number the snapshot accounts for', async () => {
    const meta = saveSession(savedPlan(), 'Rate limiting', workspace, 'session-saved');
    pool.adoptSavedSession(meta.id, workspace);
    await pool.session(meta.id).markTaskComplete('t2');

    const [, snapshot] = await firstFrames(port, meta.id, 2) as [unknown, RunSnapshotFrame];
    const later = firstFrames(port, meta.id, 3);
    await new Promise((resolve) => setTimeout(resolve, 50));
    await pool.session(meta.id).markTaskIncomplete('t2');
    const [, again, next] = await later as [unknown, RunSnapshotFrame, SessionFrame];

    expect(snapshot.seq).toBeGreaterThan(0);
    expect(again.seq).toBe(snapshot.seq);
    expect(next).toMatchObject({ stream: snapshot.stream, seq: snapshot.seq! + 1 });
  });
});
