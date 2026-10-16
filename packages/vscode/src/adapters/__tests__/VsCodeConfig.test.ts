import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { __setConfig, __resetConfig, configUpdates } from '../../test/vscode.mock';
import { VsCodeConfig, moveAutonomyFromVsCodeSetting } from '../VsCodeConfig';
import { SecretStore } from '../SecretStore';
import { DEFAULT_WEB_READ_BUDGET, getProviderMeta, PROVIDER_DETECT_PRIORITY, recordInstalledPlanner, resetInstalledPlanner, SettingsService } from '@ordewell/core';

/** Build a loaded SecretStore backed by an in-memory map. */
async function makeStore(initial: Record<string, string> = {}) {
  const map = new Map<string, string>(Object.entries(initial));
  const store = new SecretStore({
    async get(k: string) {
      return map.get(k);
    },
    async store(k: string, v: string) {
      map.set(k, v);
    },
    async delete(k: string) {
      map.delete(k);
    },
    onDidChange() {
      return { dispose() {} };
    },
  } as never);
  await store.load();
  return store;
}

// Every ORDEWELL_* var BaseConfig or VsCodeConfig reads, so a developer shell
// (the local .envrc exports several) cannot leak in and move a default.
const ENV_KEYS = ['ORDEWELL_WORKTREE_ISOLATION', 'ORDEWELL_WORKTREE_SETUP', 'ORDEWELL_CONFLICT_REPAIR_ATTEMPTS', 'ORDEWELL_WORKSPACE_REPOS', 'ORDEWELL_WORKTREE_LINKS', 'ORDEWELL_MAX_PARALLEL', 'ORDEWELL_RESEARCH_ENABLED', 'ORDEWELL_RESEARCH_MAX_STEPS', 'ORDEWELL_RESEARCH_MAX_FILE_SIZE', 'ORDEWELL_PLAN_MAP_ENABLED', 'ORDEWELL_AUTONOMOUS_MODE', 'ORDEWELL_APPROVAL_MODE', 'ORDEWELL_APPROVAL_ALLOW', 'ORDEWELL_WEB_READ_BUDGET', 'ORDEWELL_SUBAGENT_MODEL', 'ORDEWELL_PLANNER_EFFORT', 'OPENROUTER_API_KEY', 'OPENAI_API_KEY', 'GEMINI_API_KEY', 'ORCHESTRATOR_MODEL', 'AI_PROVIDER'];
let savedEnv: Record<string, string | undefined>;

beforeEach(() => {
  savedEnv = {};
  for (const k of ENV_KEYS) {
    savedEnv[k] = process.env[k];
    delete process.env[k];
  }
  __resetConfig();
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  __resetConfig();
});

describe('VsCodeConfig.worktreeIsolation', () => {
  it('defaults to on with no setup command', async () => {
    const store = await makeStore({});
    __setConfig({});
    const cfg = new VsCodeConfig(store);
    expect(cfg.worktreeIsolation).toBe(true);
    expect(cfg.worktreeSetupCommand).toBeUndefined();
  });

  it('reflects the ordewell settings', async () => {
    const store = await makeStore({});
    __setConfig({ worktreeIsolation: false, worktreeSetupCommand: 'pnpm i' });
    const cfg = new VsCodeConfig(store);
    expect(cfg.worktreeIsolation).toBe(false);
    expect(cfg.worktreeSetupCommand).toBe('pnpm i');
  });

  it('reads workspace repos and worktree links, trimming blanks', async () => {
    const store = await makeStore({});
    __setConfig({ workspaceRepos: ['libs/core', ' '], worktreeLinks: ['*.tfstate'] });
    const cfg = new VsCodeConfig(store);
    expect(cfg.workspaceRepos).toEqual(['libs/core']);
    expect(cfg.worktreeLinks).toEqual(['*.tfstate']);
  });

  it('falls back to the environment when the lists are not set', async () => {
    const store = await makeStore({});
    __setConfig({});
    process.env.ORDEWELL_WORKSPACE_REPOS = 'a/b';
    process.env.ORDEWELL_WORKTREE_LINKS = '.terraform/';
    const cfg = new VsCodeConfig(store);
    expect(cfg.workspaceRepos).toEqual(['a/b']);
    expect(cfg.worktreeLinks).toEqual(['.terraform/']);
  });

  it('lets ORDEWELL_WORKTREE_ISOLATION override the setting', async () => {
    const store = await makeStore({});
    __setConfig({ worktreeIsolation: true });
    process.env.ORDEWELL_WORKTREE_ISOLATION = 'false';
    expect(new VsCodeConfig(store).worktreeIsolation).toBe(false);
  });
});

describe('VsCodeConfig.conflictRepairAttempts', () => {
  it('allows two repairs by default', async () => {
    __setConfig({});
    expect(new VsCodeConfig(await makeStore({})).conflictRepairAttempts).toBe(2);
  });

  it('reads the setting, where 0 turns repair off', async () => {
    __setConfig({ conflictRepairAttempts: 0 });
    expect(new VsCodeConfig(await makeStore({})).conflictRepairAttempts).toBe(0);
  });

  it('keeps the default for a setting that is not a non-negative integer', async () => {
    __setConfig({ conflictRepairAttempts: -1 });
    expect(new VsCodeConfig(await makeStore({})).conflictRepairAttempts).toBe(2);
  });

  it('lets ORDEWELL_CONFLICT_REPAIR_ATTEMPTS override the setting', async () => {
    __setConfig({ conflictRepairAttempts: 3 });
    process.env.ORDEWELL_CONFLICT_REPAIR_ATTEMPTS = '0';
    expect(new VsCodeConfig(await makeStore({})).conflictRepairAttempts).toBe(0);
  });
});

describe('VsCodeConfig.webReadBudget', () => {
  it('reads the setting, and keeps the default for one that is not a non-negative integer', async () => {
    __setConfig({ plannerWebReadBudget: 12 });
    expect(new VsCodeConfig(await makeStore({})).webReadBudget).toBe(12);
    __setConfig({ plannerWebReadBudget: -3 });
    expect(new VsCodeConfig(await makeStore({})).webReadBudget).toBe(DEFAULT_WEB_READ_BUDGET);
  });

  it('lets ORDEWELL_WEB_READ_BUDGET override the setting', async () => {
    __setConfig({ plannerWebReadBudget: 12 });
    process.env.ORDEWELL_WEB_READ_BUDGET = '0';
    expect(new VsCodeConfig(await makeStore({})).webReadBudget).toBe(0);
  });
});

describe('the autonomy level (ADR-0030)', () => {
  const savedPath = process.env.ORDEWELL_SETTINGS_PATH;
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ordewell-vscode-autonomy-'));
    process.env.ORDEWELL_SETTINGS_PATH = path.join(dir, 'settings.json');
  });
  afterEach(() => {
    if (savedPath === undefined) delete process.env.ORDEWELL_SETTINGS_PATH;
    else process.env.ORDEWELL_SETTINGS_PATH = savedPath;
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('is the level saved in the user\'s settings, which every surface shares', async () => {
    const config = new VsCodeConfig(await makeStore({}));
    expect(config.autonomousMode).toBe(true);

    new SettingsService().setAutonomousMode(false);

    expect(config.autonomousMode).toBe(false);
  });

  it('copies a level set in the old VS Code setting once, then clears that setting', async () => {
    __setConfig({ autonomousMode: false });

    await moveAutonomyFromVsCodeSetting(new SettingsService());

    expect(new SettingsService().getAll().autonomousMode).toBe(false);
    expect(configUpdates).toContainEqual({ key: 'autonomousMode', value: undefined });
  });

  it('keeps a level already saved over the old VS Code setting', async () => {
    new SettingsService().setAutonomousMode(true);
    __setConfig({ autonomousMode: false });

    await moveAutonomyFromVsCodeSetting(new SettingsService());

    expect(new SettingsService().autonomousMode()).toBe(true);
  });
});

describe('VsCodeConfig.openrouterKey resolution chain', () => {
  it('prefers the SecretStore value over VS Config and env', async () => {
    const store = await makeStore({ openrouterKey: 'sk-secret' });
    __setConfig({ openAiApiKey: 'sk-config' });
    process.env.OPENROUTER_API_KEY = 'sk-env';

    const config = new VsCodeConfig(store);

    expect(config.openrouterKey).toBe('sk-secret');
  });

  it('falls back to VS Config when SecretStore has no key', async () => {
    const store = await makeStore({});
    __setConfig({ openAiApiKey: 'sk-config' });
    process.env.OPENROUTER_API_KEY = 'sk-env';

    expect(new VsCodeConfig(store).openrouterKey).toBe('sk-config');
  });

  it('falls back to env when neither SecretStore nor VS Config is set', async () => {
    const store = await makeStore({});
    process.env.OPENROUTER_API_KEY = 'sk-env';

    expect(new VsCodeConfig(store).openrouterKey).toBe('sk-env');
  });
});

describe('VsCodeConfig.geminiKey resolution chain', () => {
  it('prefers SecretStore, then VS Config (apiKey), then env', async () => {
    const secret = await makeStore({ geminiKey: 'g-secret' });
    __setConfig({ apiKey: 'g-config' });
    process.env.GEMINI_API_KEY = 'g-env';
    expect(new VsCodeConfig(secret).geminiKey).toBe('g-secret');

    const noSecret = await makeStore({});
    __setConfig({ apiKey: 'g-config' });
    expect(new VsCodeConfig(noSecret).geminiKey).toBe('g-config');

    __setConfig({});
    expect(new VsCodeConfig(noSecret).geminiKey).toBe('g-env');
  });
});

describe('VsCodeConfig.configuredProviders', () => {
  it('reflects which keys resolve to a non-empty value', async () => {
    expect(new VsCodeConfig(await makeStore({})).configuredProviders).toEqual([]);
    expect(new VsCodeConfig(await makeStore({ openrouterKey: 'sk' })).configuredProviders).toEqual(['openrouter']);
    expect(new VsCodeConfig(await makeStore({ geminiKey: 'g' })).configuredProviders).toEqual(['google']);
    expect(new VsCodeConfig(await makeStore({ openrouterKey: 'sk', geminiKey: 'g' })).configuredProviders).toEqual(['openrouter', 'google']);

    // openai_compatible is detected from its base URL config setting, not just key
    __setConfig({ openaiCompatibleBaseUrl: 'http://localhost:11434/v1' });
    expect(new VsCodeConfig(await makeStore({})).configuredProviders).toEqual(['openai_compatible']);
    __setConfig({});
  });
});

describe('VsCodeConfig.planningModel fallback chain', () => {
  it('falls back to orchestratorModel config key (not just env ORCHESTRATOR_MODEL)', async () => {
    const store = await makeStore({ openrouterKey: 'sk-or' });
    const config = new VsCodeConfig(store);
    config.setProviderModelLists({ openrouter: [], google: [], openai_compatible: [] });

    // planningModel should be empty when nothing is set
    expect(config.planningModel).toBe('');

    // Set orchestratorModel via /model set path
    __setConfig({ orchestratorModel: 'openai/gpt-5' });
    expect(config.planningModel).toBe('openai/gpt-5');
  });

  it('still prefers explicit planningModel over orchestratorModel', async () => {
    const store = await makeStore({ openrouterKey: 'sk-or' });
    const config = new VsCodeConfig(store);
    config.setProviderModelLists({ openrouter: [], google: [], openai_compatible: [] });

    __setConfig({ planningModel: 'openai/gpt-5-plan', orchestratorModel: 'openai/gpt-5-orch' });
    expect(config.planningModel).toBe('openai/gpt-5-plan');
  });
});

describe('VsCodeConfig.openAiApiKey resolution', () => {
  it('checks SecretStore in addition to VS Config and env', async () => {
    const store = await makeStore({ openrouterKey: 'sk-secret' });
    const config = new VsCodeConfig(store);

    // empty when nothing is set
    expect(config.openAiApiKey).toBe('sk-secret');

    // prefers SecretStore over VS Config
    __setConfig({ openAiApiKey: 'sk-config' });
    expect(config.openAiApiKey).toBe('sk-secret');
  });

  it('falls back to VS Config when SecretStore is empty', async () => {
    const store = await makeStore({});
    const config = new VsCodeConfig(store);
    __setConfig({ openAiApiKey: 'sk-config' });
    expect(config.openAiApiKey).toBe('sk-config');
  });

  it('falls back to env when neither SecretStore nor Config is set', async () => {
    const store = await makeStore({});
    const config = new VsCodeConfig(store);
    process.env.OPENROUTER_API_KEY = 'sk-env';
    expect(config.openAiApiKey).toBe('sk-env');
    delete process.env.OPENROUTER_API_KEY;
  });
});

describe('VsCodeConfig.apiKey', () => {
  afterEach(() => resetInstalledPlanner());

  it('uses the OpenRouter key when the active provider is openrouter', async () => {
    const store = await makeStore({ openrouterKey: 'sk-or', geminiKey: 'g' });
    // A stored key is a vendor key, so even with an agent installed nothing moves the planner off openrouter.
    recordInstalledPlanner('claude-code');
    const config = new VsCodeConfig(store);
    expect(config.aiProvider).toBe('openrouter');
    expect(config.apiKey).toBe('sk-or');
  });

  it('resolves the Gemini key from the orchestrator model provider', async () => {
    const store = await makeStore({ openrouterKey: 'sk-or', geminiKey: 'g-key' });
    __setConfig({ orchestratorModel: 'gemini-2.5-pro' });
    const config = new VsCodeConfig(store);
    config.setProviderModelLists({ openrouter: [], google: ['gemini-2.5-pro'], openai_compatible: [] });

    expect(config.apiKey).toBe('g-key');
  });

  it('falls back to the other provider key when the active provider has none', async () => {
    // active provider resolves to google, but only an OpenRouter key is set
    const store = await makeStore({ openrouterKey: 'sk-or' });
    __setConfig({ orchestratorModel: 'gemini-2.5-pro' });
    const config = new VsCodeConfig(store);
    config.setProviderModelLists({ openrouter: [], google: ['gemini-2.5-pro'], openai_compatible: [] });

    expect(config.apiKey).toBe('sk-or');
  });
});

describe('Full user workflow: SecretStore + /model set + planningModel + openAiApiKey', () => {
  it('end-to-end: key in SecretStore, model set via config.update, both getters resolve', async () => {
    // Simulate user having configured an API key via "Ordewell: Configure API Key"
    const realKey = 'sk-or-v1-test-key-do-not-use';
    const store = await makeStore({ openrouterKey: realKey });
    const config = new VsCodeConfig(store);
    config.setProviderModelLists({ openrouter: [], google: [], openai_compatible: [] });

    // Phase 1: user has NOT set a model yet
    // openAiApiKey resolves from SecretStore (Bug 2 fix verified)
    expect(config.openAiApiKey).toBe(realKey);
    // apiKey also resolves (early guard in handleGeneratePlan / handleModifyPlan)
    expect(config.apiKey).toBe(realKey);
    // planningModel is empty — would trigger "No orchestrator model selected" (Bug 1)
    expect(config.planningModel).toBe('');

    // Phase 2: user runs /model set openai/gpt-5 (writes to orchestratorModel config key)
    __setConfig({ orchestratorModel: 'openai/gpt-5' });

    // After /model set: planningModel now falls back to orchestratorModel (Bug 1 fix verified)
    expect(config.planningModel).toBe('openai/gpt-5');
    // openAiApiKey still resolves (would fail in OpenAiService without Bug 2 fix)
    expect(config.openAiApiKey).toBe(realKey);
    // apiKey still resolves
    expect(config.apiKey).toBe(realKey);

    // Phase 3: switched to google provider with orchestratorModel still set
    __setConfig({ orchestratorModel: '', planningModel: 'gemini-2.5-pro' });
    config.setProviderModelLists({ openrouter: [], google: ['gemini-2.5-pro'], openai_compatible: [] });
    // With Google provider, planningModel falls back through the Google-specific chain
    expect(config.planningModel).toBe('gemini-2.5-pro');
  });

  it('no key configured → both guards fail', async () => {
    const store = await makeStore({});
    const config = new VsCodeConfig(store);
    config.setProviderModelLists({ openrouter: [], google: [], openai_compatible: [] });

    expect(config.apiKey).toBe('');
    expect(config.openAiApiKey).toBe('');
    expect(config.planningModel).toBe('');
  });
});

describe('VsCodeConfig.aiProvider with an installed coding agent (ADR-0009)', () => {
  const saved: Record<string, string | undefined> = {};
  // Every variable detection reads, so a key in the developer's own shell cannot decide a case.
  const keys = PROVIDER_DETECT_PRIORITY.flatMap((p) => {
    const meta = getProviderMeta(p);
    return [...meta.detectEnvVars, ...(meta.baseUrlEnvVar ? [meta.baseUrlEnvVar] : [])];
  });
  beforeEach(() => { for (const k of keys) { saved[k] = process.env[k]; delete process.env[k]; } });
  afterEach(() => {
    for (const k of keys) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
    resetInstalledPlanner();
  });

  it('plans with the installed agent when no key is held anywhere', async () => {
    recordInstalledPlanner('claude-code');
    expect(new VsCodeConfig(await makeStore({})).aiProvider).toBe('claude-code');
  });

  it('does not keep an openrouter answer read before the activation probe recorded the agent', async () => {
    const config = new VsCodeConfig(await makeStore({}));
    expect(config.aiProvider).toBe('openrouter');

    recordInstalledPlanner('claude-code');

    expect(config.aiProvider).toBe('claude-code');
  });

  it('the aiProvider setting wins over the installed agent', async () => {
    recordInstalledPlanner('claude-code');
    __setConfig({ aiProvider: 'codex' });
    expect(new VsCodeConfig(await makeStore({})).aiProvider).toBe('codex');
  });
});
