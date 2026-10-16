import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  Session, getProviderMeta, PlannerNotReadyError, PlannerTurnDiscardedError, PROVIDER_DETECT_PRIORITY, resetInstalledPlanner,
  type LegacyPlanState, type PlannerBackendId, type PlannerUsability,
} from '@ordewell/core';
import { OrchestratorPool } from '../orchestratorPool';

/**
 * A first run with Claude Code installed and no API key (ADR-0009): the daemon
 * finds the agent at startup, and a goal typed before it has answered must
 * wait for it rather than plan with an openrouter key nobody set.
 */
describe('OrchestratorPool default planner', () => {
  const saved = { ...process.env };
  let dir: string;
  let workspace: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'ordewell-installed-planner-'));
    workspace = join(dir, 'ws');
    mkdirSync(join(workspace, '.git'), { recursive: true });
    process.env.ORDEWELL_SETTINGS_PATH = join(dir, 'settings.json');
    delete process.env.AI_PROVIDER;
    delete process.env.ORCHESTRATOR_MODEL;
    for (const provider of PROVIDER_DETECT_PRIORITY) {
      const meta = getProviderMeta(provider);
      for (const key of [...meta.detectEnvVars, meta.baseUrlEnvVar]) if (key) delete process.env[key];
    }
  });

  afterEach(() => {
    vi.restoreAllMocks();
    resetInstalledPlanner();
    process.env = { ...saved };
    rmSync(dir, { recursive: true, force: true });
  });

  /** An installation whose agents all answer when the test says so: Claude Code first in order. */
  function gatedInstallation(usable = true) {
    let answer!: (value: PlannerUsability) => void;
    const gate = new Promise<PlannerUsability>((resolve) => { answer = resolve; });
    return {
      installation: { plannerUsability: vi.fn(() => gate), filterInstalled: vi.fn(async () => []) },
      answer: () => answer(usable ? { usable: true } : { usable: false, reason: 'not installed' }),
    };
  }

  it('a goal typed before the startup probe answers waits for it, and plans with the agent', async () => {
    const { installation, answer } = gatedInstallation();
    const pool = new OrchestratorPool({ runnerInstallation: installation });
    void pool.detectInstalledPlanner();

    const planners: PlannerBackendId[] = [];
    const startSpy = vi.spyOn(Session.prototype, 'startPlanning').mockImplementation(async () => {
      planners.push(pool.getSettings().aiProvider);
      return {} as LegacyPlanState;
    });

    const planning = pool.startPlanning('s1', 'ship it', ['claude-code'], workspace);
    // Registered at once all the same, so a mid-research approval is answerable.
    expect(pool.hasSession('s1')).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(startSpy).not.toHaveBeenCalled();

    answer();
    await planning;
    expect(planners).toEqual(['claude-code']);
    pool.destroyAll();
  });

  it('judges the planner once the probe answers: with no agent installed, the keyless goal is refused and leaves no session', async () => {
    const { installation, answer } = gatedInstallation(false);
    const pool = new OrchestratorPool({ runnerInstallation: installation });
    void pool.detectInstalledPlanner();
    const startSpy = vi.spyOn(Session.prototype, 'startPlanning').mockResolvedValue({} as LegacyPlanState);

    const planning = pool.startPlanning('s1', 'ship it', ['claude-code'], workspace);
    answer();

    await expect(planning).rejects.toBeInstanceOf(PlannerNotReadyError);
    await expect(planning).rejects.toThrow('No planner is ready. Pick one with /planner');
    expect(startSpy).not.toHaveBeenCalled();
    expect(pool.hasSession('s1')).toBe(false);
  });

  it('a session closed while waiting for the probe never starts its planner turn', async () => {
    const { installation, answer } = gatedInstallation();
    const pool = new OrchestratorPool({ runnerInstallation: installation });
    void pool.detectInstalledPlanner();
    const startSpy = vi.spyOn(Session.prototype, 'startPlanning').mockResolvedValue({} as LegacyPlanState);

    const planning = pool.startPlanning('s1', 'ship it', ['claude-code'], workspace);
    pool.destroy('s1');
    answer();

    await expect(planning).rejects.toBeInstanceOf(PlannerTurnDiscardedError);
    expect(startSpy).not.toHaveBeenCalled();
  });

  it('Stop while waiting for the probe cancels the start: it answers true and no turn ever begins', async () => {
    const { installation, answer } = gatedInstallation();
    const pool = new OrchestratorPool({ runnerInstallation: installation });
    void pool.detectInstalledPlanner();
    const startSpy = vi.spyOn(Session.prototype, 'startPlanning').mockResolvedValue({} as LegacyPlanState);

    const planning = pool.startPlanning('s1', 'ship it', ['claude-code'], workspace);
    const settled = expect(planning).rejects.toBeInstanceOf(PlannerTurnDiscardedError);
    expect(pool.cancelPlanning('s1')).toBe(true);
    answer();

    await settled;
    expect(startSpy).not.toHaveBeenCalled();
    // Nothing is left to stop, so a second Stop has nothing to report.
    expect(pool.cancelPlanning('s1')).toBe(false);
    pool.destroyAll();
  });

  it('a goal sent after the Stop runs normally once detection resolves', async () => {
    const { installation, answer } = gatedInstallation();
    const pool = new OrchestratorPool({ runnerInstallation: installation });
    void pool.detectInstalledPlanner();
    const startSpy = vi.spyOn(Session.prototype, 'startPlanning').mockResolvedValue({} as LegacyPlanState);

    const first = pool.startPlanning('s1', 'ship it', ['claude-code'], workspace);
    const firstSettled = expect(first).rejects.toBeInstanceOf(PlannerTurnDiscardedError);
    pool.cancelPlanning('s1');
    const second = pool.startPlanning('s1', 'ship it differently', ['claude-code'], workspace);
    answer();

    await firstSettled;
    await second;
    expect(startSpy).toHaveBeenCalledTimes(1);
    expect(startSpy).toHaveBeenCalledWith('ship it differently', ['claude-code']);
    pool.destroyAll();
  });

  it('reports the detected agent as the planner in effect', async () => {
    const { installation, answer } = gatedInstallation();
    const pool = new OrchestratorPool({ runnerInstallation: installation });
    expect(pool.getSettings().aiProvider).toBe('openrouter');

    answer();
    await pool.detectInstalledPlanner();

    expect(pool.getSettings().aiProvider).toBe('claude-code');
    // Derived on each start, so a key installed later still wins.
    const settingsFile = join(dir, 'settings.json');
    expect(existsSync(settingsFile) ? readFileSync(settingsFile, 'utf8') : '').not.toContain('claude-code');
  });

  it('probes once at startup, not once for each planning turn', async () => {
    const installation = {
      plannerUsability: vi.fn(async (runner: string): Promise<PlannerUsability> => ({ usable: runner === 'codex' })),
      filterInstalled: vi.fn(async () => []),
    };
    const pool = new OrchestratorPool({ runnerInstallation: installation });
    await pool.detectInstalledPlanner();
    expect(pool.getSettings().aiProvider).toBe('codex');
    const callsAfterProbe = installation.plannerUsability.mock.calls.length;
    const startSpy = vi.spyOn(Session.prototype, 'startPlanning').mockResolvedValue({} as LegacyPlanState);

    await pool.startPlanning('s1', 'first', ['codex'], workspace);
    await pool.startPlanning('s2', 'second', ['codex'], workspace);

    expect(startSpy).toHaveBeenCalledTimes(2);
    expect(installation.plannerUsability).toHaveBeenCalledTimes(callsAfterProbe);
    pool.destroyAll();
  });

  it('a /planner pick wins over the detected agent', async () => {
    const { installation, answer } = gatedInstallation();
    const pool = new OrchestratorPool({ runnerInstallation: installation });
    answer();
    await pool.detectInstalledPlanner();

    const result = pool.updateSettings({ env: { AI_PROVIDER: 'codex' } });

    expect(result.aiProvider).toBe('codex');
    delete process.env.AI_PROVIDER;
    expect(pool.getSettings().aiProvider).toBe('claude-code');
  });
});
