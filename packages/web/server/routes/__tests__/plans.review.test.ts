import { describe, it, expect, vi } from 'vitest';
import { Hono } from 'hono';
import {
  createSession, createTask, ModelResolver, RunnerRegistry,
  type IRunner, type LegacyPlanState, type Session,
} from '@ordewell/core';
import { fakeConfig, fakeFileSystem } from '@ordewell/core/testing';
import type { OrchestratorPool } from '../../pool/orchestratorPool';
import { plansRoute } from '../plans';

/**
 * The review route is the one place a plan gets signed off after it was
 * presented, without executing it. Signing off is the user's approval of every
 * task in the plan (ADR-0029), so the planner's own starts must be allowed
 * afterwards.
 */
describe('POST /:sessionId/review/approve', () => {
  it('approves every task in the plan, so the planner may start them', async () => {
    const registry = new RunnerRegistry();
    const config = fakeConfig();
    const runner = { spawn: vi.fn(), stop: vi.fn(), stopAll: vi.fn(), activeCount: 0 } as unknown as IRunner;
    const session: Session = createSession({
      config, registry, runner,
      notifications: { info() {}, warn() {}, error() {}, async confirm() { return undefined; } },
      workspaceRoot: () => process.cwd(),
      fsAdapter: fakeFileSystem(),
      broadcast: () => {},
      modelResolver: new ModelResolver(registry, config, { execImpl: async () => ({ stdout: '' }) }),
      settings: () => ({}),
      saveSession: () => {},
      openTaskLog: () => ({ attempt: 1, append() {} }),
    });
    // The shape the review route sees: an approved plan whose approval ledger was never filled.
    const plan: LegacyPlanState = {
      tasks: [
        createTask({ id: 'u1', order: 1, title: 'Do it by hand', type: 'user', prompt: undefined }),
        createTask({ id: 't2', order: 2, title: 'Then this', prompt: 'do it', assignedRunner: 'claude-code', dependencies: ['u1'] }),
      ],
      runners: ['claude-code'], status: 'approved', approvedTasks: [],
      generatedAt: '2026-10-11T18:00:00Z', lastUpdated: '2026-10-11T18:00:00Z',
    };
    session.loadPlan(plan, 'build it', process.cwd(), { persist: false });

    const pool = { session: () => session } as unknown as OrchestratorPool;
    const app = new Hono().route('/api/plans', plansRoute(pool));
    const res = await app.request('/api/plans/s1/review/approve', { method: 'POST' });

    expect(res.status).toBe(200);
    expect(session.planState!.approvedTasks).toEqual(['u1', 't2']);
    // The planner's start of t2 is refused for its unmet dependency, not for approval:
    // the approval check comes first in the seam.
    const outcome = await session.execute({ command: 'run_task', task: 't2' }, { kind: 'planner-turn' });
    expect(outcome.message).toContain('depends on');
    expect(outcome.message).not.toContain('not approved');
    session.destroy();
  });
});
