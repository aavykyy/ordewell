import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  CliAgentAiService, OpenAiService, Session, getProviderMeta, PlannerNotReadyError, PlannerTurnDiscardedError, PlannerTurnStoppedError, PROVIDER_DETECT_PRIORITY,
  createTask, resetInstalledPlanner, saveSession, type ConversationTurn, type IRunner, type LegacyPlanState,
  type PlannerUsability, type RunnerSpawnOptions,
} from '@ordewell/core';
import { FakeRunnerSession } from '@ordewell/core/testing';
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

  const reply: ConversationTurn = { kind: 'message', text: 'Noted.', researchLog: [] };

  /** The detected agent's transport, answering every turn and recording what it was sent. */
  function agentTransport() {
    const asked: string[] = [];
    vi.spyOn(CliAgentAiService.prototype, 'startConversation').mockImplementation(async (req) => {
      asked.push(req.goal);
      return { kind: 'message', text: 'Which database?', researchLog: [] };
    });
    vi.spyOn(CliAgentAiService.prototype, 'continueConversation').mockImplementation(async (message: string) => {
      asked.push(message);
      return { kind: 'message', text: 'Noted.', researchLog: [] };
    });
    vi.spyOn(CliAgentAiService.prototype, 'hasActiveConversation').mockReturnValue(true);
    return asked;
  }

  it('a goal typed before the startup probe answers waits for it, and plans with the agent', async () => {
    const { installation, answer } = gatedInstallation();
    const pool = new OrchestratorPool({ runnerInstallation: installation });
    void pool.detectInstalledPlanner();

    const vendor = vi.spyOn(OpenAiService.prototype, 'startConversation').mockResolvedValue(reply);
    const asked = agentTransport();

    const planning = pool.startPlanning('s1', 'ship it', ['claude-code'], workspace);
    // Registered at once all the same, so a mid-research approval is answerable.
    expect(pool.hasSession('s1')).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(asked).toEqual([]);

    answer();
    await planning;
    expect(asked).toEqual(['ship it']);
    expect(vendor).not.toHaveBeenCalled();
    pool.destroyAll();
  });

  it('judges the planner once the probe answers: with no agent installed, the keyless goal is refused and leaves no session', async () => {
    const { installation, answer } = gatedInstallation(false);
    const pool = new OrchestratorPool({ runnerInstallation: installation });
    void pool.detectInstalledPlanner();
    const vendor = vi.spyOn(OpenAiService.prototype, 'startConversation').mockResolvedValue(reply);
    const asked = agentTransport();

    const planning = pool.startPlanning('s1', 'ship it', ['claude-code'], workspace);
    answer();

    await expect(planning).rejects.toBeInstanceOf(PlannerNotReadyError);
    await expect(planning).rejects.toThrow('No planner is ready. Pick one with /planner');
    expect(asked).toEqual([]);
    expect(vendor).not.toHaveBeenCalled();
    expect(pool.hasSession('s1')).toBe(false);
  });

  it('a session closed while waiting for the probe never starts its planner turn', async () => {
    const { installation, answer } = gatedInstallation();
    const pool = new OrchestratorPool({ runnerInstallation: installation });
    void pool.detectInstalledPlanner();
    const asked = agentTransport();

    const planning = pool.startPlanning('s1', 'ship it', ['claude-code'], workspace);
    pool.destroy('s1');
    answer();

    await expect(planning).rejects.toBeInstanceOf(PlannerTurnDiscardedError);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(asked).toEqual([]);
  });

  /** A saved session holding a message no planner turn answered before the daemon stopped. */
  function savedWithPendingMessage(id: string): void {
    const now = new Date().toISOString();
    const plan: LegacyPlanState = {
      tasks: [],
      generatedAt: now,
      status: 'draft',
      runners: ['claude-code'],
      lastUpdated: now,
      conversationHistory: [
        { role: 'user', content: 'ship it', timestamp: now },
        { role: 'assistant', content: 'Which database?', timestamp: now },
      ],
      pendingTurns: [{ id: 'turn-1', source: 'user', text: 'Postgres', timestamp: now }],
    };
    saveSession(plan, 'ship it', workspace, id);
  }


  it('a restored message adopted before the probe answers waits for it, then is answered by the agent', async () => {
    const { installation, answer } = gatedInstallation();
    const pool = new OrchestratorPool({ runnerInstallation: installation });
    void pool.detectInstalledPlanner();
    const vendor = vi.spyOn(OpenAiService.prototype, 'startConversation').mockResolvedValue(reply);
    const agent = vi.spyOn(CliAgentAiService.prototype, 'startConversation').mockResolvedValue(reply);
    savedWithPendingMessage('restored');

    pool.adoptSavedSession('restored', workspace);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(pool.session('restored').planState!.pendingTurns!.map((t) => t.text)).toEqual(['Postgres']);

    answer();
    await vi.waitFor(() => expect(agent).toHaveBeenCalledTimes(1));
    expect(vendor).not.toHaveBeenCalled();
    pool.destroyAll();
  });

  it('a restored message stays queued when no agent is installed and no key is set', async () => {
    const { installation, answer } = gatedInstallation(false);
    const pool = new OrchestratorPool({ runnerInstallation: installation });
    void pool.detectInstalledPlanner();
    const vendor = vi.spyOn(OpenAiService.prototype, 'startConversation').mockResolvedValue(reply);
    savedWithPendingMessage('refused');

    pool.adoptSavedSession('refused', workspace);
    answer();
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(vendor).not.toHaveBeenCalled();
    expect(pool.session('refused').planState!.pendingTurns!.map((t) => t.text)).toEqual(['Postgres']);
    pool.destroyAll();
  });

  it('Stop while waiting for the probe cancels the start: it answers true and no turn ever begins', async () => {
    const { installation, answer } = gatedInstallation();
    const pool = new OrchestratorPool({ runnerInstallation: installation });
    void pool.detectInstalledPlanner();
    const asked = agentTransport();

    const planning = pool.startPlanning('s1', 'ship it', ['claude-code'], workspace);
    const settled = expect(planning).rejects.toBeInstanceOf(PlannerTurnDiscardedError);
    expect(pool.cancelPlanning('s1')).toBe(true);
    answer();

    await settled;
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(asked).toEqual([]);
    // Nothing is left to stop, so a second Stop has nothing to report.
    expect(pool.cancelPlanning('s1')).toBe(false);
    pool.destroyAll();
  });

  it('a goal sent after the Stop runs normally once detection resolves', async () => {
    const { installation, answer } = gatedInstallation();
    const pool = new OrchestratorPool({ runnerInstallation: installation });
    void pool.detectInstalledPlanner();
    const asked = agentTransport();

    const first = pool.startPlanning('s1', 'ship it', ['claude-code'], workspace);
    const firstSettled = expect(first).rejects.toBeInstanceOf(PlannerTurnDiscardedError);
    pool.cancelPlanning('s1');
    const second = pool.startPlanning('s1', 'ship it differently', ['claude-code'], workspace);
    answer();

    await firstSettled;
    await second;
    expect(asked).toEqual(['ship it differently']);
    pool.destroyAll();
  });

  it('Stop while a restored message waits for the probe answers true, and autorun spawns nothing once the agent is found', async () => {
    const { installation, answer } = gatedInstallation();
    const runner = { spawn: vi.fn(async (opts: RunnerSpawnOptions) => new FakeRunnerSession('s1', opts.taskId)), stop: vi.fn(), stopAll: vi.fn(), activeCount: 0 } satisfies IRunner;
    const pool = new OrchestratorPool({ runnerInstallation: installation, runner });
    pool.updateRunSettings({ autorun: true, supervisorLevel: 'off' });
    void pool.detectInstalledPlanner();
    const submitted: ConversationTurn = { kind: 'plan', tasks: [createTask({ id: 'p1', order: 1, title: 'Use Postgres', prompt: 'use it', assignedRunner: 'claude-code' })], text: '1. Use Postgres', researchLog: [] };
    const agent = vi.spyOn(CliAgentAiService.prototype, 'startConversation').mockResolvedValue(submitted);
    savedWithPendingMessage('stopped');
    pool.adoptSavedSession('stopped', workspace);
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(pool.cancelPlanning('stopped')).toBe(true);
    answer();
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(agent).not.toHaveBeenCalled();
    expect(runner.spawn).not.toHaveBeenCalled();
    expect(pool.cancelPlanning('stopped')).toBe(false);
    pool.destroyAll();
  });

  it('a reply sent during the first turn\'s wait for the probe is answered after the goal, which it does not replace', async () => {
    const { installation, answer } = gatedInstallation();
    const pool = new OrchestratorPool({ runnerInstallation: installation });
    void pool.detectInstalledPlanner();
    const asked = agentTransport();

    const planning = pool.startPlanning('s1', 'Build an inventory service', ['claude-code'], workspace);
    await new Promise((resolve) => setTimeout(resolve, 10));
    const reply = pool.continuePlanning('s1', 'Use Postgres');
    answer();
    await planning;
    const plan = await reply;

    expect(asked[0]).toBe('Build an inventory service');
    expect(asked).toHaveLength(2);
    expect(asked[1]).toContain('Use Postgres');
    expect((plan.conversationHistory ?? []).filter((m) => m.role === 'user').map((m) => m.content)).toEqual(['Build an inventory service', 'Use Postgres']);
    expect(pool.session('s1').currentGoal).toBe('Build an inventory service');
    pool.destroyAll();
  });

  it('Stop during the first turn\'s wait cancels the goal and the reply sent behind it', async () => {
    const { installation, answer } = gatedInstallation();
    const pool = new OrchestratorPool({ runnerInstallation: installation });
    void pool.detectInstalledPlanner();
    const asked = agentTransport();

    const planning = pool.startPlanning('s1', 'Build an inventory service', ['claude-code'], workspace);
    const planningSettled = expect(planning).rejects.toBeInstanceOf(PlannerTurnDiscardedError);
    await new Promise((resolve) => setTimeout(resolve, 10));
    const reply = pool.continuePlanning('s1', 'Use Postgres');
    const replySettled = expect(reply).rejects.toBeInstanceOf(PlannerTurnStoppedError);
    expect(pool.cancelPlanning('s1')).toBe(true);
    await planningSettled;
    await replySettled;
    answer();
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(asked).toEqual([]);
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
