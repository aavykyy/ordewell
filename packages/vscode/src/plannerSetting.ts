import { CLI_PROVIDERS, PROVIDER_PRIORITY, isPlannerBackend } from '@ordewell/core';

/**
 * Why a value of `ordewell.aiProvider` is not usable, or undefined when it is.
 * The setting declares no `enum`: a static list in package.json would have to be
 * edited with every runner that can plan, so the registry is asked here instead,
 * and VS Code's own settings UI can no longer refuse a typo.
 */
export function plannerSettingProblem(value: string): string | undefined {
  if (value === '' || isPlannerBackend(value)) return undefined;
  const choices = [...CLI_PROVIDERS, ...PROVIDER_PRIORITY].join(', ');
  return `"ordewell.aiProvider" is "${value}", which is not a planner Ordewell knows, so the planner is detected from your API keys instead. Use one of: ${choices} — or leave it blank.`;
}
