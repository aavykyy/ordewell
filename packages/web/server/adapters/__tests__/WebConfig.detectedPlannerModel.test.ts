import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  CliAgentAiService, SettingsService, getProviderMeta, PROVIDER_DETECT_PRIORITY, recordInstalledPlanner, resetInstalledPlanner,
  type CliAgentAiServiceDeps, type SpawnFn,
} from '@ordewell/core';
import { fakeFileSystem } from '@ordewell/core/testing';
import { WebConfig } from '../WebConfig';

/**
 * A keyless first run with Claude Code installed and a model left over from
 * an old OpenRouter setup (ADR-0009): the planner is the agent, so the model
 * it is spawned with must be one the agent can run, not the vendor slug.
 * Driven from the real config to the real adapter's argv, because a stubbed
 * planner start is what hid the slug reaching `--model`.
 */
describe('a detected coding agent is never handed a stale vendor model', () => {
  const saved = { ...process.env };
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'ordewell-detected-model-'));
    process.env.ORDEWELL_SETTINGS_PATH = join(dir, 'settings.json');
    delete process.env.AI_PROVIDER;
    delete process.env.ORCHESTRATOR_MODEL;
    delete process.env.ORDEWELL_PLANNER_EFFORT;
    for (const provider of PROVIDER_DETECT_PRIORITY) {
      const meta = getProviderMeta(provider);
      for (const key of [...meta.detectEnvVars, meta.baseUrlEnvVar]) if (key) delete process.env[key];
    }
  });

  afterEach(() => {
    resetInstalledPlanner();
    process.env = { ...saved };
    rmSync(dir, { recursive: true, force: true });
  });

  /** The argv `claude` would be spawned with for a conversation's first turn; the process itself is never started. */
  async function plannerArgv(config: WebConfig): Promise<string[]> {
    let argv: string[] | undefined;
    const spawn: SpawnFn = (_command, args) => {
      argv = args;
      throw new Error('stopped at the process boundary');
    };
    const mcpServer = {
      issuePlannerToken: async () => ({ url: 'http://127.0.0.1:1/mcp', token: 'tok' }),
      issueTaskToken: async () => ({ url: 'http://127.0.0.1:1/mcp', token: 'tok' }),
      revoke: () => {},
    } as unknown as CliAgentAiServiceDeps['mcpServer'];
    const svc = new CliAgentAiService(config, {
      spawn,
      fetch: (async () => { throw new Error('no HTTP in this test'); }) as unknown as typeof fetch,
      resolvePath: async () => '/usr/bin',
      isDirectory: () => true,
      exists: () => true,
      workspaceRoot: () => dir,
      mcpServer,
    });
    await svc.startConversation({
      plannerTools: { sessionId: 's1', handler: {} },
      goal: 'Add a cache', runners: ['claude-code'], modelsByRunner: {}, fs: fakeFileSystem(), onProgress: () => {},
    }).catch(() => {});
    if (!argv) throw new Error('claude was never spawned');
    return argv;
  }

  function modelArg(argv: string[]): string | undefined {
    const at = argv.indexOf('--model');
    return at < 0 ? undefined : argv[at + 1];
  }

  it('spawns Claude Code without the leftover OpenRouter model', async () => {
    recordInstalledPlanner('claude-code');
    process.env.ORCHESTRATOR_MODEL = 'openai/gpt-4o';
    const config = new WebConfig();
    expect(config.aiProvider).toBe('claude-code');

    const argv = await plannerArgv(config);

    expect(argv).not.toContain('openai/gpt-4o');
    expect(modelArg(argv)).toBeUndefined();
  });

  it('spawns Claude Code with its own remembered model in place of the leftover one', async () => {
    recordInstalledPlanner('claude-code');
    new SettingsService().setPlannerModel('claude-code', { model: 'sonnet' });
    process.env.ORCHESTRATOR_MODEL = 'openai/gpt-4o';

    const argv = await plannerArgv(new WebConfig());

    expect(modelArg(argv)).toBe('sonnet');
  });

  it('keeps an explicit Claude Code choice\'s own model', async () => {
    recordInstalledPlanner('claude-code');
    process.env.AI_PROVIDER = 'claude-code';
    process.env.ORCHESTRATOR_MODEL = 'opus';

    const argv = await plannerArgv(new WebConfig());

    expect(modelArg(argv)).toBe('opus');
  });

  it('keeps a model an explicit agent was given even when the agent did not remember it', async () => {
    recordInstalledPlanner('claude-code');
    new SettingsService().setPlannerModel('claude-code', { model: 'sonnet' });
    process.env.AI_PROVIDER = 'claude-code';
    process.env.ORCHESTRATOR_MODEL = 'claude-haiku-5-5';

    expect(new WebConfig().orchestratorModel).toBe('claude-haiku-5-5');
  });

  it('a vendor with its key keeps its vendor model', () => {
    recordInstalledPlanner('claude-code');
    process.env.OPENROUTER_API_KEY = 'sk-or-test';
    process.env.ORCHESTRATOR_MODEL = 'openai/gpt-4o';
    const config = new WebConfig({ providerModelLists: { openrouter: ['openai/gpt-4o'], google: [], openai_compatible: [] } });

    expect(config.aiProvider).toBe('openrouter');
    expect(config.orchestratorModel).toBe('openai/gpt-4o');
    expect(config.planningModel).toBe('openai/gpt-4o');
  });

  it('never writes the replacement anywhere: the configured model is there for a later key', () => {
    recordInstalledPlanner('claude-code');
    process.env.ORCHESTRATOR_MODEL = 'openai/gpt-4o';
    const lists = { openrouter: ['openai/gpt-4o'], google: [], openai_compatible: [] };
    const config = new WebConfig({ providerModelLists: lists });
    expect(config.orchestratorModel).toBe('');

    process.env.OPENROUTER_API_KEY = 'sk-or-test';

    expect(config.aiProvider).toBe('openrouter');
    expect(config.orchestratorModel).toBe('openai/gpt-4o');
    expect(process.env.ORCHESTRATOR_MODEL).toBe('openai/gpt-4o');
    expect(new SettingsService().getPlannerModel('claude-code')).toBeUndefined();
  });
});
