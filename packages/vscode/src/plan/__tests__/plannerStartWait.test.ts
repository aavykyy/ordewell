import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  BufferedTaskOutputSource, createSession, createTask, detectInstalledPlanner, recordedInstalledPlanner, resetInstalledPlanner, RunnerRegistry,
  RUN_SETTINGS_DEFAULTS, type ConversationTurn, type IAiService, type IRunner, type LegacyPlanState, type ModelResolver, type PlannerUsability,
} from '@ordewell/core';
import { fakeConfig, fakeFileSystem } from '@ordewell/core/testing';
import { handleNewSession, handleStartPlanning, handleStopPlanning, type PlanManagerDeps } from '../PlanManager';

/**
 * A goal typed before the activation probe answers waits for it (ADR-0009).
 * Stop and New session land in that wait with no turn yet to abort, so they
 * must cancel the wait itself or the goal starts after the user left it.
 */
describe('a planner start waiting for the installed-agent probe', () => {
  afterEach(() => resetInstalledPlanner());

  function harness() {
    let answer!: (value: PlannerUsability) => void;
    const gate = new Promise<PlannerUsability>((resolve) => { answer = resolve; });
    void detectInstalledPlanner({ plannerUsability: () => gate });

    const startPlanning = vi.fn(async () => ({ tasks: [] }));
    const showError = vi.fn();
    const deps = {
      session: {
        startPlanning,
        abortPlannerTurn: vi.fn(() => false),
        reset: vi.fn(),
        aiServiceInstance: { reset: vi.fn() },
      },
      chatProvider: {
        showError, setState: vi.fn(), showPlan: vi.fn(),
        conversation: { stop: vi.fn(), reset: vi.fn() }, run: { reset: vi.fn() },
      },
      runnerRegistry: { get: vi.fn(() => ({})) },
      config: { aiProvider: 'claude-code', apiKey: '', planningModel: '', openaiCompatibleBaseUrl: '', enabledRunners: ['claude-code'] },
      fsAdapter: { getWorkspaceRoot: () => '/nonexistent-ordewell-test-root' },
      getCurrentPlan: () => ({ tasks: [], runners: [] }),
      setCurrentPlan: vi.fn(),
      setCurrentGoal: vi.fn(),
      saveCurrentSession: vi.fn(),
      log: vi.fn(),
    } as unknown as PlanManagerDeps;
    return { deps, startPlanning, showError, answer: () => answer({ usable: true }) };
  }

  it('does not start once Stop was pressed during the wait', async () => {
    const { deps, startPlanning, showError, answer } = harness();
    const starting = handleStartPlanning('ship it', deps);
    handleStopPlanning(deps);
    answer();
    await starting;
    expect(startPlanning).not.toHaveBeenCalled();
    expect(showError).not.toHaveBeenCalled();
  });

  it('does not start once the session was replaced during the wait', async () => {
    const { deps, startPlanning, answer } = harness();
    const starting = handleStartPlanning('ship it', deps);
    handleNewSession(deps);
    answer();
    await starting;
    expect(startPlanning).not.toHaveBeenCalled();
  });

  it('starts a goal sent after the Stop, and only that one', async () => {
    const { deps, startPlanning, answer } = harness();
    const first = handleStartPlanning('first goal', deps);
    handleStopPlanning(deps);
    const second = handleStartPlanning('second goal', deps);
    answer();
    await Promise.all([first, second]);
    expect(startPlanning).toHaveBeenCalledTimes(1);
    expect(startPlanning).toHaveBeenCalledWith('second goal', ['claude-code']);
  });

  it('lets a newer goal replace one still waiting', async () => {
    const { deps, startPlanning, answer } = harness();
    const first = handleStartPlanning('first goal', deps);
    const second = handleStartPlanning('second goal', deps);
    answer();
    await Promise.all([first, second]);
    expect(startPlanning).toHaveBeenCalledTimes(1);
    expect(startPlanning).toHaveBeenCalledWith('second goal', ['claude-code']);
  });
});

/**
 * A message restored from before a reload waits for the probe in the Session
 * itself, with no host start to cancel: Stop must reach it there, or the
 * agent found later answers it and autorun starts the plan the user stopped.
 */
describe('a restored message waiting for the installed-agent probe', () => {
  afterEach(() => resetInstalledPlanner());

  it('is stopped by Stop: once the agent is found, no planner turn opens and autorun spawns nothing', async () => {
    let answer!: (value: PlannerUsability) => void;
    const gate = new Promise<PlannerUsability>((resolve) => { answer = resolve; });
    void detectInstalledPlanner({ plannerUsability: () => gate });

    const submitted: ConversationTurn = { kind: 'plan', tasks: [createTask({ id: 'p1', order: 1, title: 'Use Postgres', prompt: 'use it', assignedRunner: 'claude-code' })], text: '1. Use Postgres', researchLog: [] };
    const planner = { startConversation: vi.fn(async () => submitted), continueConversation: vi.fn(async () => submitted), hasActiveConversation: () => false, reset: vi.fn() };
    const runner = { spawn: vi.fn(), stop: vi.fn(), stopAll: vi.fn(), activeCount: 0 } as unknown as IRunner;
    const config = fakeConfig({ getProviderApiKey: () => '', orchestratorModel: '', planningModel: '' });
    // No AI_PROVIDER and no key: the planner is whatever the probe records.
    Object.defineProperty(config, 'aiProvider', { get: () => recordedInstalledPlanner() ?? 'openrouter' });
    const session = createSession({
      config,
      notifications: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), confirm: vi.fn().mockResolvedValue(undefined) },
      runner,
      registry: new RunnerRegistry(),
      workspaceRoot: () => '/nonexistent-ordewell-test-root',
      fsAdapter: fakeFileSystem(),
      broadcast: vi.fn(),
      modelResolver: { getCachedRunnerModels: () => [], modelsForRunners: vi.fn().mockResolvedValue({}) } as unknown as ModelResolver,
      settings: () => ({ run: { ...RUN_SETTINGS_DEFAULTS, supervisorLevel: 'off', autorun: true } }),
      aiService: planner as unknown as IAiService,
      taskOutput: new BufferedTaskOutputSource(),
      saveSession: vi.fn(),
    });
    const now = new Date().toISOString();
    const saved: LegacyPlanState = {
      tasks: [], generatedAt: now, status: 'draft', runners: ['claude-code'], lastUpdated: now,
      conversationHistory: [{ role: 'user', content: 'ship it', timestamp: now }, { role: 'assistant', content: 'Which database?', timestamp: now }],
      pendingTurns: [{ id: 'turn-1', source: 'user', text: 'Postgres', timestamp: now }],
    };
    session.loadPlan(saved, 'ship it', '/nonexistent-ordewell-test-root');
    const log = vi.fn();
    const deps = { session, chatProvider: { conversation: { stop: vi.fn() } }, log } as unknown as PlanManagerDeps;

    handleStopPlanning(deps);
    answer({ usable: true });
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(log).toHaveBeenCalledWith('Research stopped');
    expect(planner.startConversation).not.toHaveBeenCalled();
    expect(planner.continueConversation).not.toHaveBeenCalled();
    expect(runner.spawn).not.toHaveBeenCalled();
    session.destroy();
  });
});

