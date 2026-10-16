import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { __setConfig, __resetConfig } from '../../test/vscode.mock';
import { getProviderMeta, PROVIDER_DETECT_PRIORITY, resetInstalledPlanner } from '@ordewell/core';
import { VsCodeConfig } from '../VsCodeConfig';
import { SecretStore } from '../SecretStore';

async function emptyStore(): Promise<SecretStore> {
  const store = new SecretStore({
    async get() { return undefined; },
    async store() {},
    async delete() {},
    onDidChange() { return { dispose() {} }; },
  } as never);
  await store.load();
  return store;
}

/** What OpenCode's discovery listed: its own `provider/model` ids, the shape an OpenRouter slug has too. */
const OPENCODE_CATALOG = ['opencode/deepseek-v4.1-flash', 'opencode-go/claude-haiku-5-5'];

/**
 * OpenCode named as the planner in the editor, with `ordewell.orchestratorModel`
 * left from an old OpenRouter setup: only the agent's discovered catalog tells
 * that slug from one of its own ids, so the extension judges the model against it.
 */
describe('VsCodeConfig judges a named OpenCode planner\'s model against its discovered catalog', () => {
  const saved = { ...process.env };
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'ordewell-vscode-agent-catalog-'));
    process.env.ORDEWELL_SETTINGS_PATH = join(dir, 'settings.json');
    delete process.env.AI_PROVIDER;
    delete process.env.ORCHESTRATOR_MODEL;
    delete process.env.ORDEWELL_PLANNER_EFFORT;
    for (const provider of PROVIDER_DETECT_PRIORITY) {
      const meta = getProviderMeta(provider);
      for (const key of [...meta.detectEnvVars, meta.baseUrlEnvVar]) if (key) delete process.env[key];
    }
    __resetConfig();
  });

  afterEach(() => {
    resetInstalledPlanner();
    __resetConfig();
    process.env = { ...saved };
    rmSync(dir, { recursive: true, force: true });
  });

  const catalog = (provider: string) => (provider === 'opencode' ? OPENCODE_CATALOG : []);

  it.each(['openai/gpt-4o', 'deepseek/deepseek-v4-flash'])('plans with OpenCode\'s own default, not the leftover %s', async (leftover) => {
    __setConfig({ aiProvider: 'opencode', orchestratorModel: leftover });
    const config = new VsCodeConfig(await emptyStore(), catalog);

    expect(config.orchestratorModel).toBe('');
    expect(config.planningModel).toBe('');
  });

  it('keeps a model OpenCode\'s catalog lists', async () => {
    __setConfig({ aiProvider: 'opencode', orchestratorModel: 'opencode-go/claude-haiku-5-5' });
    const config = new VsCodeConfig(await emptyStore(), catalog);

    expect(config.orchestratorModel).toBe('opencode-go/claude-haiku-5-5');
  });
});
