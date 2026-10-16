import { describe, it, expect } from 'vitest';
import { plannerNotReady, describePlannerNotReady, TERMINAL_UI_COMMANDS, HEADLESS_CLI_COMMANDS, type PlannerReadinessConfig } from '../plannerReadiness';

function config(over: Partial<PlannerReadinessConfig> & { key?: string }): PlannerReadinessConfig {
  const { key = '', ...rest } = over;
  return {
    aiProvider: 'openrouter',
    planningModel: 'openai/gpt-5',
    openaiCompatibleBaseUrl: '',
    getProviderApiKey: () => key,
    ...rest,
  };
}

describe('plannerNotReady', () => {
  for (const provider of ['claude-code', 'codex', 'opencode']) {
    it(`lets ${provider} plan with no key and no model — its subscription is the credential`, () => {
      expect(plannerNotReady(config({ aiProvider: provider, planningModel: '' }))).toBeNull();
    });
  }

  it('refuses a vendor with no key, naming the provider and its key variable', () => {
    expect(plannerNotReady(config({ aiProvider: 'openrouter' }))).toEqual({
      code: 'no_key',
      provider: 'openrouter',
      label: 'OpenRouter',
      keyEnvVar: 'OPENROUTER_API_KEY',
    });
  });

  it('refuses openai_compatible with no base URL even when a key is set', () => {
    expect(plannerNotReady(config({ aiProvider: 'openai_compatible', key: 'k' }))).toMatchObject({
      code: 'no_base_url',
      provider: 'openai_compatible',
      baseUrlEnvVar: 'OPENAI_COMPATIBLE_BASE_URL',
    });
  });

  it('lets a keyless openai_compatible endpoint plan once it has a base URL and a model', () => {
    expect(plannerNotReady(config({ aiProvider: 'openai_compatible', openaiCompatibleBaseUrl: 'http://localhost:11434/v1' }))).toBeNull();
  });

  it('refuses a keyed vendor with no model', () => {
    expect(plannerNotReady(config({ key: 'sk', planningModel: '' }))).toMatchObject({ code: 'no_model', provider: 'openrouter' });
  });

  it('passes a fully configured vendor', () => {
    expect(plannerNotReady(config({ key: 'sk' }))).toBeNull();
  });
});

describe('describePlannerNotReady', () => {
  const noKey = plannerNotReady(config({ aiProvider: 'openrouter' }))!;

  it('leads a terminal user to /planner, naming the agents from the registry, and offers /key for the vendor', () => {
    expect(describePlannerNotReady(noKey, TERMINAL_UI_COMMANDS)).toBe(
      'No planner is ready. Pick one with /planner — Claude Code, Codex and OpenCode plan with no API key. ' +
      'To plan with OpenRouter instead, add OPENROUTER_API_KEY with /key.',
    );
  });

  it('spells the same message with the headless CLI commands', () => {
    expect(describePlannerNotReady(noKey, HEADLESS_CLI_COMMANDS)).toBe(
      'No planner is ready. Pick one with ordewell planner <id> — Claude Code, Codex and OpenCode plan with no API key. ' +
      'To plan with OpenRouter instead, add OPENROUTER_API_KEY with ordewell key set openrouter <key>.',
    );
  });

  it('points a missing base URL at the same escape hatch', () => {
    const reason = plannerNotReady(config({ aiProvider: 'openai_compatible' }))!;
    const text = describePlannerNotReady(reason, TERMINAL_UI_COMMANDS);
    expect(text).toContain('/planner');
    expect(text).toContain('OPENAI_COMPATIBLE_BASE_URL');
  });

  it('tells a model-less vendor to pick a model, in the surface\'s spelling', () => {
    const reason = plannerNotReady(config({ key: 'sk', planningModel: '' }))!;
    expect(describePlannerNotReady(reason, TERMINAL_UI_COMMANDS)).toBe('No planner model selected for OpenRouter. Pick one with /model, or switch planner with /planner.');
    expect(describePlannerNotReady(reason, HEADLESS_CLI_COMMANDS)).toContain('ordewell model set <id>');
  });
});
