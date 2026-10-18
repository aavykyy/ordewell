import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Hono } from 'hono';
import { flattenTasks, saveSession, STOPPED_BEFORE_START, type IRunner, type LegacyPlanState, type RunnerSpawnOptions, type Session } from '@ordewell/core';
import { FakeRunnerSession } from '@ordewell/core/testing';
import { OrchestratorPool } from '../orchestratorPool';
import { plansRoute } from '../../routes/plans';

/**
 * The daemon's side of the one start claim (ADR-0029, ADR-0035): what the
 * TUI and the headless CLI send at once — a task's Run beside Stop, two Runs
 * for the last slot — reaches the real Session, command seam and scheduler
 * through these routes, and each answer says what really happened.
 */
describe('task starts and Stop sent to the daemon at once', () => {
  let dir: string;
  let workspace: string;
  const saved: Record<string, string | undefined> = {};
  let pools: OrchestratorPool[];

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ordewell-pool-claim-'));
    workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'ordewell-pool-claim-ws-'));
    fs.mkdirSync(path.join(workspace, '.git'));
    for (const key of ['ORDEWELL_SETTINGS_PATH', 'ORDEWELL_MAX_PARALLEL']) saved[key] = process.env[key];
    process.env.ORDEWELL_SETTINGS_PATH = path.join(dir, 'settings.json');
    // Full, and no supervisor: its wake-up turns would need a planner this test has no use for.
    fs.writeFileSync(process.env.ORDEWELL_SETTINGS_PATH, JSON.stringify({ autonomousMode: true, supervisorLevel: 'off' }));
    pools = [];
  });

  afterEach(() => {
    for (const pool of pools) pool.destroyAll();
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(workspace, { recursive: true, force: true });
  });

  function daemon() {
    const spawned: FakeRunnerSession[] = [];
    const runner: IRunner = {
      spawn: vi.fn(async (opts: RunnerSpawnOptions) => {
        const s = new FakeRunnerSession(`s${spawned.length + 1}`, opts.taskId);
        spawned.push(s);
        return s;
      }),
      stop: vi.fn(),
      stopAll: vi.fn(),
      activeCount: 0,
    };
    const pool = new OrchestratorPool({ runner });
    pools.push(pool);
    const app = new Hono();
    app.route('/api/plans', plansRoute(pool));
    const post = (sessionId: string, route: string) => app.request(`/api/plans/${sessionId}/${route}`, { method: 'POST' });
    return { pool, post, spawnedIds: () => spawned.map((s) => s.taskId) };
  }

  function approvedPlan(): LegacyPlanState {
    const at = '2026-10-16T10:00:00.000Z';
    return {
      status: 'approved',
      approved: true,
      approvedTasks: ['t1', 't2'],
      runners: ['claude-code'],
      generatedAt: at,
      lastUpdated: at,
      tasks: [
        { id: 't1', order: 1, title: 'Add the limiter', type: 'ai', status: 'pending', description: 'd', prompt: 'do it', dependencies: [], assignedRunner: 'claude-code', taskMode: 'acceptEdits', subtasks: [] },
        { id: 't2', order: 2, title: 'Wire it up', type: 'ai', status: 'pending', description: 'd', prompt: 'then this', dependencies: [], assignedRunner: 'claude-code', taskMode: 'acceptEdits', subtasks: [] },
      ],
    } as unknown as LegacyPlanState;
  }

  const status = (session: Session, taskId: string) => flattenTasks(session.planTasks).find((t) => t.id === taskId)?.status;

  function adopted(name: string) {
    const id = saveSession(approvedPlan(), 'Rate limiting', workspace, name).id;
    const d = daemon();
    d.pool.adoptSavedSession(id, workspace);
    return { ...d, id, session: d.pool.session(id) };
  }

  it('answers a Run sent beside Stop as not started, Stop as stopped, and leaves the task not started', async () => {
    const { post, id, session, spawnedIds } = adopted('session-run-stop');

    const [run, stop] = await Promise.all([post(id, 'tasks/t1/run'), post(id, 'stop')]);

    expect(stop.status).toBe(200);
    expect(await stop.json()).toMatchObject({ status: 'stopped', message: expect.stringContaining('Stopped the run') });
    expect(run.status).toBe(400);
    expect(await run.json()).toMatchObject({ error: STOPPED_BEFORE_START, code: 'refused' });
    await vi.waitFor(() => expect(session.isExecuting).toBe(false));
    expect(spawnedIds()).toEqual([]);
    expect(status(session, 't1')).toBe('pending');
  });

  it('starts one of two Runs sent at once for the last slot, and refuses the other', async () => {
    process.env.ORDEWELL_MAX_PARALLEL = '1';
    const { post, id, spawnedIds } = adopted('session-two-runs');

    const [first, second] = await Promise.all([post(id, 'tasks/t1/run'), post(id, 'tasks/t2/run')]);

    expect([first.status, second.status].sort()).toEqual([200, 400]);
    const refused = first.status === 400 ? first : second;
    expect(await refused.json()).toMatchObject({ error: '1 task is already running, the most this session runs at once. Wait for one to finish, or stop one first.' });
    expect(spawnedIds()).toHaveLength(1);
  });

  it('answers a Stop with nothing running and nothing about to start as stopped, a no-op', async () => {
    const { post, id, spawnedIds } = adopted('session-idle-stop');

    const stop = await post(id, 'stop');

    expect(stop.status).toBe(200);
    expect(await stop.json()).toEqual({ status: 'stopped', message: 'Nothing is running: there is nothing to stop.' });
    expect(spawnedIds()).toEqual([]);
  });
});
