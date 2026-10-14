import type { RunnerManifest, RunnerEntry } from './types';
import { CLAUDE_CODE_MANIFEST } from './builtin/claude-code.manifest';
import { CODEX_MANIFEST } from './builtin/codex.manifest';
import { OPENCODE_MANIFEST } from './builtin/opencode.manifest';
import type { IConfig } from '../interfaces/IConfig';

// Insertion order is picker order on every surface.
const BUILTIN_MANIFESTS: RunnerManifest[] = [
  CLAUDE_CODE_MANIFEST,
  CODEX_MANIFEST,
  OPENCODE_MANIFEST,
];

export class RunnerRegistry {
  private readonly runners = new Map<string, RunnerEntry>(
    BUILTIN_MANIFESTS.map((manifest) => [manifest.name, { manifest }]),
  );

  // What a host probe found out about a runner's modes. Kept beside the
  // manifests rather than written into them: manifests are shared constants,
  // and a probe's answer belongs to one host and can change.
  private readonly unavailableModes = new Map<string, Record<string, string>>();

  /** Mark modes of a runner unusable on this host, by mode id and reason; an empty record clears them. */
  setUnavailableModes(id: string, reasons: Record<string, string>): void {
    if (Object.keys(reasons).length === 0) this.unavailableModes.delete(id);
    else this.unavailableModes.set(id, reasons);
  }

  get(id: string): RunnerEntry | undefined {
    const entry = this.runners.get(id);
    const reasons = this.unavailableModes.get(id);
    if (!entry || !reasons || !entry.manifest.modes) return entry;
    const modes = entry.manifest.modes.map((m) => (reasons[m.id] ? { ...m, unavailable: reasons[m.id] } : m));
    return { ...entry, manifest: { ...entry.manifest, modes } };
  }

  getManifest(id: string): RunnerManifest | undefined {
    return this.get(id)?.manifest;
  }

  list(): RunnerEntry[] {
    return [...this.runners.keys()].map((id) => this.get(id)!);
  }

  listEnabled(config: IConfig): RunnerEntry[] {
    return this.list().filter((entry) => config.enabledRunners.includes(entry.manifest.name));
  }

  listEnabledIds(config: IConfig): string[] {
    return this.listEnabled(config).map((entry) => entry.manifest.name);
  }
}
