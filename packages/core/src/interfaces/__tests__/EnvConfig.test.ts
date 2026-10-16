import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { createAiService } from '../../services/AiService';
import type { CliAgentAiServiceDeps } from '../../services/harness/CliAgentAiService';
import type { SpawnFn } from '../../services/harness/AgentAdapter';
import { getProviderMeta, PROVIDER_DETECT_PRIORITY } from '../../services/ProviderRegistry';
import { resetInstalledPlanner } from '../../services/InstalledPlanner';
import { fakeFileSystem } from '../../testing';
import { EnvConfig } from '../EnvConfig';

/**
 * The environment-only config is the one a headless host builds a planner
 * from with no settings of its own, so its model must come from the same rule
 * as every other host's: a coding agent named by AI_PROVIDER is never spawned
 * with an OpenRouter slug left in ORCHESTRATOR_MODEL.
 */
describe('EnvConfig plans with the model the planner rule resolves', () => {
  const saved = { ...process.env };
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'ordewell-env-config-'));
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

  /** The argv `claude` is spawned with for a one-shot plan; the process itself is never started. */
  async function generationArgv(): Promise<string[]> {
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
    const ai = createAiService(new EnvConfig(), {
      spawn,
      fetch: (async () => { throw new Error('no HTTP in this test'); }) as unknown as typeof fetch,
      resolvePath: async () => '/usr/bin',
      isDirectory: () => true,
      exists: () => true,
      workspaceRoot: () => dir,
      mcpServer,
    });
    await ai.researchAndPlan('Add a README', ['claude-code'], {}, fakeFileSystem(), () => {}).catch(() => {});
    if (!argv) throw new Error('claude was never spawned');
    return argv;
  }

  it.each(['openai/gpt-4o', 'deepseek/deepseek-v4-flash'])('spawns a named Claude Code without the leftover vendor model %s', async (leftover) => {
    process.env.AI_PROVIDER = 'claude-code';
    process.env.ORCHESTRATOR_MODEL = leftover;

    expect(await generationArgv()).not.toContain('--model');
  });

  it('spawns a named Claude Code with its own model and effort from the environment', async () => {
    process.env.AI_PROVIDER = 'claude-code';
    process.env.ORCHESTRATOR_MODEL = 'opus';
    process.env.ORDEWELL_PLANNER_EFFORT = 'high';

    const argv = await generationArgv();
    expect([argv[argv.indexOf('--model') + 1], argv[argv.indexOf('--effort') + 1]]).toEqual(['opus', 'high']);
  });

  it('keeps a vendor planner\'s model as configured', () => {
    process.env.AI_PROVIDER = 'openrouter';
    process.env.ORCHESTRATOR_MODEL = 'deepseek/deepseek-v4-flash';

    expect(new EnvConfig().orchestratorModel).toBe('deepseek/deepseek-v4-flash');
  });
});
