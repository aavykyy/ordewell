import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { plannerPreflightError, recheckSignedOutPlanner, type PlanManagerDeps } from '../PlanManager';
import { getProviderMeta, PROVIDER_DETECT_PRIORITY, recordRunnerAuth, resetRunnerAuth, type PlannerBackendId } from '@ordewell/core';
import { VsCodeConfig } from '../../adapters/VsCodeConfig';
import { SecretStore } from '../../adapters/SecretStore';
import { __setConfig, __resetConfig } from '../../test/vscode.mock';

function config(aiProvider: PlannerBackendId, apiKey: string, planningModel: string, openaiCompatibleBaseUrl = ''): VsCodeConfig {
  return { aiProvider, getProviderApiKey: () => apiKey, planningModel, orchestratorModel: '', openaiCompatibleBaseUrl } as unknown as VsCodeConfig;
}

/**
 * ADR-0009: a harness planner is authenticated by the user's own coding-agent
 * subscription, so the API-key gate must not fire for it. The reported bug was
 * exactly this — Claude Code selected as planner, no key set, and the chat
 * answered "API key not configured" instead of planning.
 */
describe('plannerPreflightError', () => {
  for (const provider of ['claude-code', 'codex', 'opencode']) {
    it(`lets ${provider} plan with no API key`, () => {
      expect(plannerPreflightError(config(provider, '', 'sonnet'))).toBeNull();
    });

    it(`lets ${provider} plan with no model — the agent's default applies`, () => {
      expect(plannerPreflightError(config(provider, '', ''))).toBeNull();
    });
  }

  it('sends a vendor planner with no key to /planner first, then offers /key', () => {
    expect(plannerPreflightError(config('openrouter', '', 'openai/gpt-5'))).toBe(
      'No planner is ready. Pick one with /planner: Claude Code, Codex and OpenCode plan with no API key. ' +
      'To plan with OpenRouter instead, add OPENROUTER_API_KEY with /key.',
    );
  });

  it('asks an openai_compatible planner for its base URL, not a key', () => {
    expect(plannerPreflightError(config('openai_compatible', '', 'llama3'))).toContain('OPENAI_COMPATIBLE_BASE_URL');
  });

  it('still demands a model from a keyed vendor planner, in the chat\'s /planner spelling', () => {
    expect(plannerPreflightError(config('openrouter', 'sk-or', '')))
      .toBe('No planner model selected for OpenRouter. Pick one with /planner.');
  });

  it('passes a fully configured vendor planner', () => {
    expect(plannerPreflightError(config('openrouter', 'sk-or', 'openai/gpt-5'))).toBeNull();
  });
});

/**
 * The preflight must check the key the selected planner's transport will
 * read. A key held for another vendor passed it, and the turn then failed deep
 * in the transport with "OpenAI API key not configured" instead of the
 * /planner-first refusal.
 */
describe('plannerPreflightError on the extension\'s own config', () => {
  const vars = PROVIDER_DETECT_PRIORITY.flatMap((p) => {
    const meta = getProviderMeta(p);
    return [meta.apiKeyEnvVar, ...meta.detectEnvVars, ...(meta.baseUrlEnvVar ? [meta.baseUrlEnvVar] : [])];
  });
  const saved: Record<string, string | undefined> = {};
  beforeEach(() => { for (const k of vars) { saved[k] = process.env[k]; delete process.env[k]; } });
  afterEach(() => {
    for (const k of vars) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
    __resetConfig();
  });

  async function store(initial: Record<string, string>): Promise<SecretStore> {
    const map = new Map(Object.entries(initial));
    const s = new SecretStore({
      async get(k: string) { return map.get(k); },
      async store(k: string, v: string) { map.set(k, v); },
      async delete(k: string) { map.delete(k); },
      onDidChange() { return { dispose() {} }; },
    } as never);
    await s.load();
    return s;
  }

  it('refuses an OpenAI planner with no OpenAI key even when an OpenRouter key is stored', async () => {
    __setConfig({ aiProvider: 'openai', orchestratorModel: 'gpt-4o' });
    const config = new VsCodeConfig(await store({ openrouterKey: 'sk-or-secret' }));

    expect(plannerPreflightError(config)).toBe(
      'No planner is ready. Pick one with /planner: Claude Code, Codex and OpenCode plan with no API key. ' +
      'To plan with OpenAI instead, add OPENAI_API_KEY with /key.',
    );
  });

  it('refuses a Gemini planner with no Gemini key even when an OpenRouter key is stored', async () => {
    __setConfig({ aiProvider: 'google', orchestratorModel: 'gemini-2.5-pro' });
    const config = new VsCodeConfig(await store({ openrouterKey: 'sk-or-secret' }));

    expect(plannerPreflightError(config)).toContain('GEMINI_API_KEY');
    expect(config.apiKey).toBe('');
  });

  it('passes a planner whose own key is in the legacy setting', async () => {
    __setConfig({ aiProvider: 'google', orchestratorModel: 'gemini-2.5-pro', apiKey: 'g-legacy' });
    const config = new VsCodeConfig(await store({}));

    expect(plannerPreflightError(config)).toBeNull();
    expect(config.apiKey).toBe('g-legacy');
  });
});

/**
 * A signed-out refusal offers the runner's own login as a way back, and that
 * runs outside the extension host. The turn must ask the workspace's account
 * again rather than keep the verdict the last runner list read.
 */
describe('recheckSignedOutPlanner', () => {
  afterEach(() => resetRunnerAuth());

  function host(auth?: { state: 'signed-in' | 'signed-out' | 'unknown'; loginCommand?: string[] }) {
    const plannerUsability = vi.fn(async () => ({ usable: true }));
    const installation = { refresh: vi.fn(), plannerUsability };
    if (auth) recordRunnerAuth('claude-code', auth, '/repo');
    return {
      plannerUsability,
      installation,
      deps: {
        config: config('claude-code', '', 'sonnet'),
        fsAdapter: { getWorkspaceRoot: () => '/repo' } as unknown as PlanManagerDeps['fsAdapter'],
        runnerInstallation: installation,
      },
    };
  }

  it('asks the workspace account again after a signed-out verdict', async () => {
    const h = host({ state: 'signed-out', loginCommand: ['claude', 'auth', 'login'] });

    await recheckSignedOutPlanner(h.deps);

    expect(h.installation.refresh).toHaveBeenCalledTimes(1);
    expect(h.plannerUsability).toHaveBeenCalledWith('claude-code');
  });

  it('asks nothing when the verdict is signed in or unknown', async () => {
    for (const state of ['signed-in', 'unknown'] as const) {
      resetRunnerAuth();
      const h = host({ state });

      await recheckSignedOutPlanner(h.deps);

      expect(h.plannerUsability).not.toHaveBeenCalled();
    }
  });

  it('does not read another workspace\'s signed-out verdict', async () => {
    const h = host();
    recordRunnerAuth('claude-code', { state: 'signed-out', loginCommand: ['claude', 'auth', 'login'] }, '/elsewhere');

    await recheckSignedOutPlanner(h.deps);

    expect(h.plannerUsability).not.toHaveBeenCalled();
  });
});
