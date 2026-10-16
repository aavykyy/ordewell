import { describe, it, expect, vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { OpenAiService, PlannerTurnDiscardedError, Session, type ConversationTurn, type LegacyPlanState } from '@ordewell/core';
import { OrchestratorPool } from '../orchestratorPool';
import { withReadyPlanner } from '../../__tests__/readyPlanner';

withReadyPlanner();

/** A planner whose first turn never answers, so it is still in flight when the session goes. */
function hangingPlanner() {
  return vi.spyOn(OpenAiService.prototype, 'startConversation').mockReturnValue(new Promise<ConversationTurn>(() => {}));
}

describe('closing a session', () => {
  it('closes the session it is still planning in, which abandons its planner turn', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'ordewell-destroy-'));
    mkdirSync(join(workspace, '.git'));
    // The session's runners are the user's settings: not the developer's own.
    vi.stubEnv('ORDEWELL_SETTINGS_PATH', join(workspace, 'settings.json'));
    const pool = new OrchestratorPool();
    const planner = hangingPlanner();
    const destroySpy = vi.spyOn(Session.prototype, 'destroy');

    try {
      const turn = pool.startPlanning('s1', 'ship it', ['claude-code'], workspace);
      const session = pool.session('s1');
      expect(session.isPlannerBusy).toBe(true);

      pool.destroy('s1');

      expect(destroySpy.mock.contexts).toContain(session);
      expect(pool.hasSession('s1')).toBe(false);
      expect(pool.cancelPlanning('s1')).toBe(false);
      await expect(turn).rejects.toBeInstanceOf(PlannerTurnDiscardedError);
    } finally {
      planner.mockRestore();
      destroySpy.mockRestore();
      pool.destroyAll();
      rmSync(workspace, { recursive: true, force: true });
    }
  });
});

describe('re-planning under a live session id', () => {
  it('destroys the previous session rather than orphaning its turn', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'ordewell-replan-'));
    mkdirSync(join(workspace, '.git'));
    // The session's runners are the user's settings: not the developer's own.
    vi.stubEnv('ORDEWELL_SETTINGS_PATH', join(workspace, 'settings.json'));
    const pool = new OrchestratorPool();
    const destroySpy = vi.spyOn(Session.prototype, 'destroy');
    const planner = hangingPlanner();

    try {
      const firstTurn = pool.startPlanning('s1', 'first', ['claude-code'], workspace);
      const first = pool.session('s1');

      void pool.startPlanning('s1', 'second', ['claude-code'], workspace);

      expect(destroySpy.mock.contexts).toContain(first);
      expect(pool.session('s1')).not.toBe(first);
      // The first session's turn is abandoned with it, not left running unheard.
      await expect(firstTurn).rejects.toBeInstanceOf(PlannerTurnDiscardedError);
      expect(first.isPlannerBusy).toBe(false);
      expect(pool.session('s1').isPlannerBusy).toBe(true);
    } finally {
      planner.mockRestore();
      destroySpy.mockRestore();
      pool.destroyAll();
      rmSync(workspace, { recursive: true, force: true });
    }
  });
});

describe('subscribing to a session', () => {
  it('sends a new socket nothing of the transcript: every client reads the conversation over REST, and a turn opens a socket each time', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'ordewell-subscribe-'));
    mkdirSync(join(workspace, '.git'));
    const pool = new OrchestratorPool();
    const history = [{ role: 'user' as const, content: 'ship it', timestamp: '2026-01-01T00:00:00Z' }];
    const planSpy = vi.spyOn(Session.prototype, 'planState', 'get').mockReturnValue({ conversationHistory: history } as unknown as LegacyPlanState);
    const startSpy = vi.spyOn(Session.prototype, 'startPlanning').mockResolvedValue({} as LegacyPlanState);

    try {
      await pool.startPlanning('s1', 'ship it', ['claude-code'], workspace);
      const ws = { OPEN: 1, readyState: 1, send: vi.fn() };
      pool.subscribe('s1', ws as unknown as Parameters<OrchestratorPool['subscribe']>[1]);

      expect(ws.send).not.toHaveBeenCalled();
    } finally {
      planSpy.mockRestore();
      startSpy.mockRestore();
      pool.destroyAll();
      rmSync(workspace, { recursive: true, force: true });
    }
  });
});
