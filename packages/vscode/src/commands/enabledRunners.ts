import { installedPlannerDetected, type RunnerId, type RunnerRegistry, type SettingsService } from '@ordewell/core';
import type { VsCodeConfig } from '../adapters/VsCodeConfig';

/**
 * What both ways of changing the enabled runners need: the settings file every
 * surface shares, and the re-discovery that tells this window what it now holds.
 */
export interface EnabledRunnerDeps {
  settingsService: Pick<SettingsService, 'updateEnabledRunners'>;
  config: Pick<VsCodeConfig, 'enabledRunners'>;
  sendRunnerAndModels: () => Promise<void>;
}

/** Enabling from a message also has to know which ids are runners at all. */
export interface EnableRunnerDeps extends EnabledRunnerDeps {
  runnerRegistry: Pick<RunnerRegistry, 'get'>;
}

async function updateEnabled(
  deps: EnabledRunnerDeps,
  change: (enabled: string[]) => string[],
): Promise<string[]> {
  // With no saved choice the defaults come from the install probe, so saving
  // before it answers would pin a list that predates the agents it found.
  await installedPlannerDetected();
  const saved = deps.settingsService.updateEnabledRunners((saved) => change(saved ?? deps.config.enabledRunners));
  await deps.sendRunnerAndModels();
  return saved;
}

/**
 * Add an installed runner to the enabled set, from the chat header's Runners
 * block. It only ever adds: a repeated or stale click must not switch a runner
 * off, and an id no manifest names is refused so a message cannot write one
 * into the shared file.
 */
export async function enableRunner(deps: EnableRunnerDeps, runnerId: RunnerId): Promise<string[] | null> {
  if (!deps.runnerRegistry.get(runnerId)) return null;
  return updateEnabled(deps, (enabled) => (enabled.includes(runnerId) ? enabled : [...enabled, runnerId]));
}

/** Turn a runner on or off, from the command palette. */
export async function toggleRunner(deps: EnabledRunnerDeps, runnerId: RunnerId): Promise<string[]> {
  return updateEnabled(deps, (enabled) => (
    enabled.includes(runnerId) ? enabled.filter((r) => r !== runnerId) : [...enabled, runnerId]
  ));
}
