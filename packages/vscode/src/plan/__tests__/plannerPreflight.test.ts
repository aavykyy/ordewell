import { describe, it, expect } from 'vitest';
import { plannerPreflightError } from '../PlanManager';
import type { PlannerBackendId } from '@ordewell/core';
import type { VsCodeConfig } from '../../adapters/VsCodeConfig';

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
      'No planner is ready. Pick one with /planner — Claude Code, Codex and OpenCode plan with no API key. ' +
      'To plan with OpenRouter instead, add OPENROUTER_API_KEY with /key.',
    );
  });

  it('asks an openai_compatible planner for its base URL, not a key', () => {
    expect(plannerPreflightError(config('openai_compatible', '', 'llama3'))).toContain('OPENAI_COMPATIBLE_BASE_URL');
  });

  it('still demands a model from a keyed vendor planner, in the chat\'s /model set spelling', () => {
    expect(plannerPreflightError(config('openrouter', 'sk-or', '')))
      .toBe('No planner model selected for OpenRouter. Pick one with /model set, or switch planner with /planner.');
  });

  it('passes a fully configured vendor planner', () => {
    expect(plannerPreflightError(config('openrouter', 'sk-or', 'openai/gpt-5'))).toBeNull();
  });
});
