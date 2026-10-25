import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { LeaseHost, SessionHeldError, saveSession, type LegacyPlanState } from '@ordewell/core';
import { OrchestratorPool } from '../orchestratorPool';
import { withReadyPlanner } from '../../__tests__/readyPlanner';

withReadyPlanner();

function savedPlan(): LegacyPlanState {
  return {
    status: 'approved',
    runners: ['opencode'],
    generatedAt: '2026-10-23T23:12:07.000Z',
    tasks: [
      {
        id: 't1', order: 1, title: 'Fix the run engine', type: 'ai', status: 'pending',
        description: 'd', prompt: 'fix it', dependencies: [], assignedRunner: 'opencode', subtasks: [],
      },
    ],
  } as unknown as LegacyPlanState;
}

/**
 * The incident's shape: a second daemon — a TUI's private one — adopting the
 * session file a first daemon is running, in the same checkout (ADR-0049).
 */
describe('two pools over one workspace', () => {
  let workspace: string;
  let hostA: LeaseHost;
  let hostB: LeaseHost;
  let poolA: OrchestratorPool;
  let poolB: OrchestratorPool;

  beforeEach(() => {
    workspace = mkdtempSync(join(tmpdir(), 'ordewell-pool-lease-'));
    mkdirSync(join(workspace, '.git'));
    hostA = new LeaseHost({ id: 'host-a', kind: () => ({ kind: 'daemon', port: 3742 }) });
    hostB = new LeaseHost({ id: 'host-b', kind: () => ({ kind: 'daemon', port: 49558, ownerPid: 76271 }) });
    poolA = new OrchestratorPool({ leaseHost: hostA });
    poolB = new OrchestratorPool({ leaseHost: hostB });
    saveSession(savedPlan(), 'Improve the codebase', workspace, 'session-fe9e75df');
  });

  afterEach(() => {
    poolA.destroyAll();
    poolB.destroyAll();
    hostA.releaseAll();
    hostB.releaseAll();
    rmSync(workspace, { recursive: true, force: true });
  });

  it('refuses the second adoption while the first pool holds the session, naming the holder', () => {
    poolA.adoptSavedSession('session-fe9e75df', workspace);

    let refused: unknown;
    try {
      poolB.adoptSavedSession('session-fe9e75df', workspace);
    } catch (err) {
      refused = err;
    }

    expect(refused).toBeInstanceOf(SessionHeldError);
    const held = (refused as SessionHeldError).held;
    expect(held.holder).toMatchObject({ pid: process.pid, host: { kind: 'daemon', port: 3742 } });
    expect((refused as Error).message).toContain(`the Ordewell daemon on port 3742 (pid ${process.pid})`);
    expect(poolB.hasSession('session-fe9e75df')).toBe(false);
    expect(poolA.hasSession('session-fe9e75df')).toBe(true);
  });

  it('lets the second pool adopt once the first closes the session', () => {
    poolA.adoptSavedSession('session-fe9e75df', workspace);
    poolA.destroy('session-fe9e75df');

    poolB.adoptSavedSession('session-fe9e75df', workspace);

    expect(poolB.hasSession('session-fe9e75df')).toBe(true);
  });
});
