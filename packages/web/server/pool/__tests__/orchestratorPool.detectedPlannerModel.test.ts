import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  CliAgentAiService, SettingsService, getProviderMeta, PROVIDER_DETECT_PRIORITY, recordInstalledPlanner, resetInstalledPlanner,
  type CliAgentAiServiceDeps, type SpawnFn,
} from '@ordewell/core';
import { fakeFileSystem } from '@ordewell/core/testing';
import { WebConfig } from '../../adapters/WebConfig';
import { OrchestratorPool } from '../orchestratorPool';

/**
 * What the settings route reports for a detected coding agent with a model
 * left over from an old vendor setup (ADR-0009) is the model the agent is
 * spawned with, and a settings write never turns that leftover into the
 * agent's own remembered pick.
 */
describe('OrchestratorPool settings for a detected coding agent', () => {
  const saved = { ...process.env };
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'ordewell-detected-settings-'));
    process.env.ORDEWELL_SETTINGS_PATH = join(dir, 'settings.json');
    delete process.env.AI_PROVIDER;
    delete process.env.ORCHESTRATOR_MODEL;
    delete process.env.ORDEWELL_PLANNER_EFFORT;
    for (const provider of PROVIDER_DETECT_PRIORITY) {
      const meta = getProviderMeta(provider);
      for (const key of [...meta.detectEnvVars, meta.baseUrlEnvVar]) if (key) delete process.env[key];
    }
    recordInstalledPlanner('claude-code');
    process.env.ORCHESTRATOR_MODEL = 'openai/gpt-4o';
  });

  afterEach(() => {
    vi.restoreAllMocks();
    resetInstalledPlanner();
    process.env = { ...saved };
    rmSync(dir, { recursive: true, force: true });
  });

  function pool(): OrchestratorPool {
    return new OrchestratorPool({
      runnerInstallation: { plannerUsability: vi.fn(async () => ({ usable: true as const })), filterInstalled: vi.fn(async () => []) },
      codexSandbox: { ensure: vi.fn(async () => undefined), refresh: vi.fn(async () => undefined) },
    } as unknown as ConstructorParameters<typeof OrchestratorPool>[0]);
  }

  /** The `--model` Claude Code is spawned with from a fresh config, blank when none is passed. */
  async function spawnedModel(): Promise<string> {
    return (await spawned()).model;
  }

  /** The `--model` and `--effort` Claude Code is spawned with from a fresh config, each blank when not passed. */
  async function spawned(): Promise<{ model: string; effort: string }> {
    let argv: string[] = [];
    const spawn: SpawnFn = (_command, args) => {
      argv = args;
      throw new Error('stopped at the process boundary');
    };
    const svc = new CliAgentAiService(new WebConfig(), {
      spawn,
      fetch: (async () => { throw new Error('no HTTP in this test'); }) as unknown as typeof fetch,
      resolvePath: async () => '/usr/bin',
      isDirectory: () => true,
      exists: () => true,
      workspaceRoot: () => dir,
      mcpServer: {
        issuePlannerToken: async () => ({ url: 'http://127.0.0.1:1/mcp', token: 'tok' }),
        revoke: () => {},
      } as unknown as CliAgentAiServiceDeps['mcpServer'],
    });
    await svc.startConversation({
      plannerTools: { sessionId: 's1', handler: {} },
      goal: 'Add a cache', runners: ['claude-code'], modelsByRunner: {}, fs: fakeFileSystem(), onProgress: () => {},
    }).catch(() => {});
    const flag = (name: string) => {
      const at = argv.indexOf(name);
      return at < 0 ? '' : argv[at + 1];
    };
    return { model: flag('--model'), effort: flag('--effort') };
  }

  it('reports no model when the agent will be spawned with its own default', async () => {
    const settings = pool().getSettings();

    expect(settings.aiProvider).toBe('claude-code');
    expect(settings.orchestratorModel).toBe('');
    expect(settings.orchestratorModel).toBe(await spawnedModel());
  });

  it('reports the remembered model the agent will be spawned with', async () => {
    new SettingsService().setPlannerModel('claude-code', { model: 'sonnet' });

    const settings = pool().getSettings();

    expect(settings.orchestratorModel).toBe('sonnet');
    expect(settings.orchestratorModel).toBe(await spawnedModel());
    expect(pool().getRunnerState().orchestratorModel).toBe('sonnet');
  });

  it('an effort change does not save the leftover vendor model as the agent\'s pick', () => {
    const response = pool().updateSettings({ env: { ORDEWELL_PLANNER_EFFORT: 'high' } });

    expect(new SettingsService().getPlannerModel('claude-code')?.model).not.toBe('openai/gpt-4o');
    expect(response.orchestratorModel).toBe('');
  });

  it('reports the remembered model and effort the agent will be spawned with', async () => {
    process.env.ORDEWELL_PLANNER_EFFORT = 'low';
    new SettingsService().setPlannerModel('claude-code', { model: 'sonnet', effort: 'high' });

    const settings = pool().getSettings();

    expect({ model: settings.orchestratorModel, effort: settings.plannerThinkingEffort }).toEqual({ model: 'sonnet', effort: 'high' });
    expect(await spawned()).toEqual({ model: 'sonnet', effort: 'high' });
  });

  it('an effort change for the remembered model is remembered, and leaves the configured model for a later key', async () => {
    new SettingsService().setPlannerModel('claude-code', { model: 'sonnet' });

    const response = pool().updateSettings({ env: { ORDEWELL_PLANNER_EFFORT: 'high' } });

    expect({ model: response.orchestratorModel, effort: response.plannerThinkingEffort }).toEqual({ model: 'sonnet', effort: 'high' });
    expect(await spawned()).toEqual({ model: 'sonnet', effort: 'high' });
    expect(new SettingsService().getPlannerModel('claude-code')).toEqual({ model: 'sonnet', effort: 'high' });
    expect(process.env.ORCHESTRATOR_MODEL).toBe('openai/gpt-4o');
  });

  it('an effort change for an inherited model of the agent\'s own applies without saving that model', async () => {
    process.env.ORCHESTRATOR_MODEL = 'opus';

    const response = pool().updateSettings({ env: { ORDEWELL_PLANNER_EFFORT: 'high' } });

    expect({ model: response.orchestratorModel, effort: response.plannerThinkingEffort }).toEqual({ model: 'opus', effort: 'high' });
    expect(await spawned()).toEqual({ model: 'opus', effort: 'high' });
    expect(new SettingsService().getAll().plannerModels).toBeUndefined();
  });

  it('an effort change does not forget a saved model the read set aside', () => {
    new SettingsService().setPlannerModel('claude-code', { model: 'openai/gpt-4o' });

    pool().updateSettings({ env: { ORDEWELL_PLANNER_EFFORT: 'high' } });

    expect(new SettingsService().getPlannerModel('claude-code')).toEqual({ model: 'openai/gpt-4o' });
  });

  it('an inherited environment is applied as it stands and nothing in it is remembered', async () => {
    const response = pool().updateSettings({ env: { ORCHESTRATOR_MODEL: 'opus', ORDEWELL_PLANNER_EFFORT: 'high' }, inherited: true });

    expect({ model: response.orchestratorModel, effort: response.plannerThinkingEffort }).toEqual({ model: 'opus', effort: 'high' });
    expect(await spawned()).toEqual({ model: 'opus', effort: 'high' });
    expect(new SettingsService().getAll().plannerModels).toBeUndefined();
  });

  it('a planner switch with its own model still remembers that pick', () => {
    pool().updateSettings({ env: { AI_PROVIDER: 'claude-code', ORCHESTRATOR_MODEL: 'opus', ORDEWELL_PLANNER_EFFORT: 'high' } });

    expect(new SettingsService().getPlannerModel('claude-code')).toEqual({ model: 'opus', effort: 'high' });
  });

  it('a model picked in this daemon stays the planner\'s model when another surface remembers a different one', () => {
    const daemon = pool();
    daemon.updateSettings({ orchestratorModel: 'claude-opus-5-5' });
    new SettingsService().setPlannerModel('claude-code', { model: 'sonnet', effort: 'low' });

    expect(daemon.getSettings()).toMatchObject({ orchestratorModel: 'claude-opus-5-5', plannerThinkingEffort: '' });
  });

  it('reports a model typed for the detected agent as typed, so the turn fails on it rather than ignoring it', () => {
    const daemon = pool();
    daemon.updateSettings({ orchestratorModel: 'gemini:gemini-2.5-pro' });

    expect(daemon.getSettings().orchestratorModel).toBe('gemini:gemini-2.5-pro');
  });

  it('an inherited model that later replaces a pick is judged as inherited', () => {
    const daemon = pool();
    daemon.updateSettings({ orchestratorModel: 'claude-opus-5-5' });
    daemon.updateSettings({ env: { ORCHESTRATOR_MODEL: 'openai/gpt-4o' }, inherited: true });

    expect(daemon.getSettings().orchestratorModel).toBe('claude-opus-5-5');
    expect(process.env.ORCHESTRATOR_MODEL).toBe('openai/gpt-4o');
  });

  it('a model picked for the detected agent is remembered and spawned', async () => {
    const response = pool().updateSettings({ orchestratorModel: 'claude-opus-5-5', plannerThinkingEffort: 'max' });

    expect(response.orchestratorModel).toBe('claude-opus-5-5');
    expect(await spawned()).toEqual({ model: 'claude-opus-5-5', effort: 'max' });
    expect(new SettingsService().getPlannerModel('claude-code')).toEqual({ model: 'claude-opus-5-5', effort: 'max' });
  });

  /** `ordewell plan` under AI_PROVIDER=<agent>: the switch, then the environment the CLI inherited. */
  function forwardNamedPlanner(daemon: OrchestratorPool, provider: string, model: string) {
    daemon.updateSettings({ env: { AI_PROVIDER: provider } });
    return daemon.updateSettings({ env: { ORCHESTRATOR_MODEL: model }, inherited: true });
  }

  for (const leftover of ['openai/gpt-4o', 'deepseek/deepseek-v4-flash']) {
    it(`a named Claude Code is never spawned with the inherited vendor slug ${leftover}, nor saves it`, async () => {
      const response = forwardNamedPlanner(pool(), 'claude-code', leftover);

      expect(response).toMatchObject({ aiProvider: 'claude-code', orchestratorModel: '' });
      expect(await spawnedModel()).toBe('');
      expect(new SettingsService().getAll().plannerModels).toBeUndefined();
    });

    it(`a named Codex reports no model for the inherited vendor slug ${leftover}`, () => {
      const response = forwardNamedPlanner(pool(), 'codex', leftover);

      expect(response).toMatchObject({ aiProvider: 'codex', orchestratorModel: '' });
      expect(new SettingsService().getAll().plannerModels).toBeUndefined();
    });
  }

  it('a named Claude Code with an inherited vendor slug plans with its remembered model and effort', async () => {
    new SettingsService().setPlannerModel('claude-code', { model: 'sonnet', effort: 'high' });

    forwardNamedPlanner(pool(), 'claude-code', 'openai/gpt-4o');

    expect(await spawned()).toEqual({ model: 'sonnet', effort: 'high' });
  });

  /** A daemon whose discovery has already listed OpenCode's own models. */
  function poolWithOpenCodeCatalog(ids: string[]): OrchestratorPool {
    const modelResolver = {
      cachedPlannerCatalog: (provider: string) => (provider === 'opencode' ? ids.map((id) => ({ id })) : []),
    };
    return new OrchestratorPool({
      modelResolver,
      runnerInstallation: { plannerUsability: vi.fn(async () => ({ usable: true as const })), filterInstalled: vi.fn(async () => []) },
      codexSandbox: { ensure: vi.fn(async () => undefined), refresh: vi.fn(async () => undefined) },
    } as unknown as ConstructorParameters<typeof OrchestratorPool>[0]);
  }

  it('a named OpenCode is not given an inherited slug its discovered catalog does not list', () => {
    const response = forwardNamedPlanner(poolWithOpenCodeCatalog(['anthropic/claude-sonnet-4-5']), 'opencode', 'deepseek/deepseek-v4-flash');

    expect(response).toMatchObject({ aiProvider: 'opencode', orchestratorModel: '' });
  });

  it('a named OpenCode keeps an inherited provider/model id its discovered catalog lists', () => {
    const response = forwardNamedPlanner(poolWithOpenCodeCatalog(['anthropic/claude-sonnet-4-5', 'openai/gpt-4o']), 'opencode', 'openai/gpt-4o');

    expect(response).toMatchObject({ aiProvider: 'opencode', orchestratorModel: 'openai/gpt-4o' });
  });
});
