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

/** A change from a message also has to know which ids are runners at all. */
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
 * Set one runner on or off, from the chat header's Runners block. The request
 * names the state it wants rather than flipping one, so a repeated or stale
 * click cannot undo a newer choice, and an id no manifest names is refused so a
 * message cannot write one into the shared file. Switching off the last runner
 * left in the saved list keeps it: an empty list leaves every surface with no
 * runner to assign (ADR-0043), and only the list as saved now can say which is last.
 */
export async function setRunnerEnabled(deps: EnableRunnerDeps, runnerId: RunnerId, on: boolean): Promise<string[] | null> {
  if (!deps.runnerRegistry.get(runnerId)) return null;
  return updateEnabled(deps, (enabled) => {
    if (on) return enabled.includes(runnerId) ? enabled : [...enabled, runnerId];
    const rest = enabled.filter((r) => r !== runnerId);
    return rest.length > 0 ? rest : enabled;
  });
}

/**
 * Turn a runner on or off, from the command palette. The last runner left in
 * the saved list stays on, as in {@link setRunnerEnabled}; `keptLast` says so.
 */
export async function toggleRunner(deps: EnabledRunnerDeps, runnerId: RunnerId): Promise<{ enabled: string[]; keptLast: boolean }> {
  let keptLast = false;
  const enabled = await updateEnabled(deps, (enabled) => {
    if (!enabled.includes(runnerId)) return [...enabled, runnerId];
    const rest = enabled.filter((r) => r !== runnerId);
    keptLast = rest.length === 0;
    return keptLast ? enabled : rest;
  });
  return { enabled, keptLast };
}
