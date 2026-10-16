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
    const at = argv.indexOf('--model');
    return at < 0 ? '' : argv[at + 1];
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
});
