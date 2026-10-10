import { describe, it, expect } from 'vitest';
import { plannerProviderLabel } from '../ModelDiscovery';

const options = [
  { id: 'deepseek/deepseek-v4-flash', apiProvider: 'openrouter' as const },
  { id: 'openai:gpt-5', apiProvider: 'openai' as const },
];

describe('plannerProviderLabel', () => {
  it.each([
    ['claude-code', 'Claude Code'],
    ['codex', 'Codex'],
    ['opencode', 'OpenCode'],
  ] as const)('names the harness for a %s planner, never OpenRouter', (provider, label) => {
    expect(plannerProviderLabel(provider, 'sonnet', options)).toBe(label);
    expect(plannerProviderLabel(provider, '', options)).toBe(label);
  });

  it('uses the discovered option apiProvider for a vendor planner', () => {
    expect(plannerProviderLabel('openrouter', 'deepseek/deepseek-v4-flash', options)).toBe('OpenRouter');
    expect(plannerProviderLabel('openai', 'openai:gpt-5', options)).toBe('OpenAI');
  });

  it('says nothing for an unknown or empty model id', () => {
    expect(plannerProviderLabel('openrouter', 'mystery/model', options)).toBe('');
    expect(plannerProviderLabel('openrouter', '', options)).toBe('');
    expect(plannerProviderLabel('openrouter', 'deepseek/deepseek-v4-flash', [])).toBe('');
  });
});
