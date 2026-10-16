import { describe, it, expect, vi, afterEach } from 'vitest';
import { detectInstalledPlanner, resetInstalledPlanner, type PlannerUsability } from '@ordewell/core';
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
