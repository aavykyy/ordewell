import { RunnerRegistry } from '@ordewell/core';

/**
 * The runners help and error text names, read from the registry on each call
 * so that text lists what is registered instead of a copy of it that goes
 * stale when a runner is added.
 */
function manifests() {
  return new RunnerRegistry().list().map((entry) => entry.manifest);
}

/** Runner ids in picker order, as a comma-separated list. */
export function runnerIdList(): string {
  return manifests().map((m) => m.name).join(', ');
}

/** Runner ids in picker order, as a `|`-separated choice, as a usage line writes one. */
export function runnerIdChoice(): string {
  return manifests().map((m) => m.name).join('|');
}

/** Runner display names in picker order, as "A, B or C". */
export function runnerNamesOr(): string {
  const names = manifests().map((m) => m.displayName);
  if (names.length < 2) return names.join('');
  return `${names.slice(0, -1).join(', ')} or ${names[names.length - 1]}`;
}
