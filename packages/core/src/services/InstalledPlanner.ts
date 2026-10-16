import type { PlannerBackendId } from '../interfaces/IConfig';
import { CLI_PROVIDERS, runnerForProvider } from './ProviderRegistry';
import type { RunnerInstallation } from './RunnerInstallation';

/**
 * The planner a host falls back to when the user chose none and no vendor key
 * is in the environment (ADR-0009): an installed coding agent, so a first run
 * needs no API key. Derived on each start and never saved, so a key added
 * later or a `/planner` pick still wins.
 *
 * Held per process because `BaseConfig.detectProvider` is sync, read on every
 * `aiProvider`, while finding an agent spawns its binary; a host probes once at
 * startup and every config it builds reads the answer here.
 */
let recorded: PlannerBackendId | null = null;
let pending: Promise<unknown> = Promise.resolve();
let answered = true;

/**
 * The first harness planner, in the order every planner picker lists them,
 * whose agent `plannerUsability` calls usable; null when none is. The agents
 * are asked together, so a start waits for the slowest of them rather than for
 * each in turn.
 */
export async function findInstalledPlanner(installation: Pick<RunnerInstallation, 'plannerUsability'>): Promise<PlannerBackendId | null> {
  const usable = await Promise.all(CLI_PROVIDERS.map(async (id) => {
    const runner = runnerForProvider(id);
    return runner !== null && (await installation.plannerUsability(runner)).usable;
  }));
  return CLI_PROVIDERS[usable.indexOf(true)] ?? null;
}

/**
 * Find the installed agent and record it, for a host to start at startup. A
 * goal can be typed before the probe answers, so every planner turn waits on
 * {@link installedPlannerDetected} rather than planning with openrouter.
 */
export function detectInstalledPlanner(installation: Pick<RunnerInstallation, 'plannerUsability'>): Promise<PlannerBackendId | null> {
  // A probe that throws is no agent found: the turn waiting on it must still
  // start, and say what the openrouter fallback is missing.
  const probe: Promise<PlannerBackendId | null> = findInstalledPlanner(installation).catch(() => null).then((id) => {
    recordInstalledPlanner(id);
    // Only the latest probe speaks for the recorded answer.
    if (pending === probe) answered = true;
    return id;
  });
  pending = probe;
  answered = false;
  return probe;
}

/** Settles once the latest probe has recorded its answer; at once when none was started. */
export async function installedPlannerDetected(): Promise<void> {
  await pending;
}

/**
 * Whether the latest probe has recorded its answer, for a check that must run
 * at once when it can: a planner preflight read while the probe is out would
 * judge the openrouter fallback the answer may replace.
 */
export function installedPlannerAnswered(): boolean {
  return answered;
}

export function recordInstalledPlanner(id: PlannerBackendId | null): void {
  recorded = id;
}

export function recordedInstalledPlanner(): PlannerBackendId | null {
  return recorded;
}

/** For tests: the recorded default is process-wide, so one case's must not decide the next's. */
export function resetInstalledPlanner(): void {
  recorded = null;
  pending = Promise.resolve();
  answered = true;
}
