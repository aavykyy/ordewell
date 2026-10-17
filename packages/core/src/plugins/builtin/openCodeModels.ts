import type { DiscoveredModel } from '../../models/Task';
import type { RunnerManifest } from '../types';

export function parseOpenCodeModels(stdout: string, manifest: RunnerManifest): DiscoveredModel[] {
  // The CLI output is the source of truth: accept ANY `provider/model` line
  // (custom providers included) rather than a hand-listed charset. Structure
  // required: a plain provider segment (no colon — excludes URLs), a slash,
  // and a whitespace-free remainder.
  const lines = stdout.split('\n').map((l) => l.trim()).filter((l) => /^[A-Za-z0-9._-]+\/[^\s"{}]+$/.test(l));
  if (lines.length === 0) return [];

  const preferred = manifest.modelDiscovery.preferredPatterns;
  const prefLabels = new Map<string, string>();
  if (preferred) {
    for (const { id, label } of preferred) {
      prefLabels.set(id, label);
    }
  }

  const seen = new Set<string>();
  const models: DiscoveredModel[] = [];

  for (const id of lines) {
    if (prefLabels.has(id) && !seen.has(id)) {
      seen.add(id);
      const provider = id.split('/')[0];
      models.push({ modelId: id, modelLabel: prefLabels.get(id)!, runnerProvider: provider, variants: [] });
    }
  }

  for (const id of lines) {
    if (!seen.has(id)) {
      seen.add(id);
      const provider = id.split('/')[0];
      models.push({ modelId: id, modelLabel: id.split('/').pop() || id, runnerProvider: provider, variants: [] });
    }
  }

  return models;
}

/**
 * Parse `opencode models --verbose` output.
 *
 * The format alternates between a `provider/model-id` line and a JSON block:
 *   opencode/claude-sonnet-4-6
 *   { "id": "claude-sonnet-4-6", ... "variants": { "low": {...}, "high": {...} } }
 *   opencode-go/deepseek-v4-pro
 *   { ... "variants": {} }
 *
 * Per-model variants are extracted directly from the JSON; models with no
 * variants get an empty array (the old static manifest variants are NOT applied).
 */
export function parseOpenCodeModelsVerbose(stdout: string, manifest: RunnerManifest): DiscoveredModel[] {
  // Ensure trailing newline so the last model-id line is always captured by the split regex.
  // The CLI output is the source of truth: accept ANY `provider/model` id line
  // (custom providers, uppercase, version pins, multi-segment models). The only
  // structure required is a plain provider segment (no colon — excludes URLs)
  // followed by a whitespace-free remainder; JSON block lines never match
  // because they start with `{`, `}`, `"` or indentation.
  const normalized = stdout.endsWith('\n') ? stdout : stdout + '\n';
  const parts = normalized.split(/^([A-Za-z0-9._-]+\/[^\s"{}]+)\n/m);

  const preferred = manifest.modelDiscovery.preferredPatterns;
  const prefLabels = new Map<string, string>();
  if (preferred) {
    for (const { id, label } of preferred) prefLabels.set(id, label);
  }

  const seen = new Set<string>();
  const models: DiscoveredModel[] = [];

  for (let i = 1; i < parts.length - 1; i += 2) {
    const fullId = parts[i].trim();
    const jsonText = parts[i + 1].trim();
    if (seen.has(fullId)) continue;

    let variantIds: string[] = [];
    let modelLabel = prefLabels.get(fullId) || fullId.split('/').pop() || fullId;
    // The provider IS the printed prefix before the first `/` — exactly as
    // the CLI lists it (`opencode/…`, `opencode-go/…`, `openrouter/…`, or any
    // future provider). The JSON's providerID never overrides it.
    const runnerProvider = fullId.split('/')[0];

    try {
      const data = JSON.parse(jsonText) as {
        name?: string;
        variants?: Record<string, unknown>;
      };
      if (data.name) modelLabel = prefLabels.get(fullId) || data.name;
      variantIds = Object.keys(data.variants ?? {});
    } catch {
      // No parseable JSON block — keep the id-derived label, no variants.
    }

    seen.add(fullId);
    models.push({
      modelId: fullId,
      modelLabel,
      runnerProvider,
      variants: variantIds.map((id) => ({ id, label: id.charAt(0).toUpperCase() + id.slice(1) })),
    });
  }

  return preferredFirst(models, manifest);
}

/** Preferred patterns first, then the rest alphabetically. */
function preferredFirst(models: DiscoveredModel[], manifest: RunnerManifest): DiscoveredModel[] {
  const prefOrder = manifest.modelDiscovery.preferredPatterns?.map((p) => p.id) ?? [];
  return [...models].sort((a, b) => {
    const ai = prefOrder.indexOf(a.modelId);
    const bi = prefOrder.indexOf(b.modelId);
    if (ai >= 0 && bi >= 0) return ai - bi;
    if (ai >= 0) return -1;
    if (bi >= 0) return 1;
    return a.modelId.localeCompare(b.modelId);
  });
}

interface OpenCodeApiModel {
  modelID?: unknown;
  providerID?: unknown;
  name?: unknown;
  enabled?: unknown;
  variants?: unknown;
}

/**
 * Parse `opencode api model.list` output (opencode v2, which dropped
 * `models --verbose`). The server answers `{ "data": [ { providerID, modelID,
 * name, enabled, variants: [{ id, settings }] } ] }`; the id Ordewell uses is
 * the same `providerID/modelID` that `opencode models` prints. A model the
 * server reports as not enabled is skipped, since the plain listing would
 * not offer it either.
 *
 * Anything that is not that shape — an HTTP error body, a v1 CLI that does
 * not know the subcommand — yields no models, so discovery falls through to
 * the plain `opencode models`.
 */
export function parseOpenCodeModelsApi(stdout: string, manifest: RunnerManifest): DiscoveredModel[] {
  let data: unknown;
  try {
    data = (JSON.parse(stdout) as { data?: unknown } | null)?.data;
  } catch {
    return [];
  }
  if (!Array.isArray(data)) return [];

  const prefLabels = new Map((manifest.modelDiscovery.preferredPatterns ?? []).map((p) => [p.id, p.label]));
  const seen = new Set<string>();
  const models: DiscoveredModel[] = [];

  for (const entry of data as OpenCodeApiModel[]) {
    if (!entry || typeof entry.providerID !== 'string' || typeof entry.modelID !== 'string') continue;
    if (entry.enabled === false) continue;
    const fullId = `${entry.providerID}/${entry.modelID}`;
    if (seen.has(fullId)) continue;
    seen.add(fullId);

    const variantIds = Array.isArray(entry.variants)
      ? entry.variants.flatMap((v: unknown) => {
          const id = (v as { id?: unknown } | null)?.id;
          return typeof id === 'string' && id ? [id] : [];
        })
      : [];
    models.push({
      modelId: fullId,
      modelLabel: prefLabels.get(fullId) || (typeof entry.name === 'string' && entry.name) || entry.modelID,
      runnerProvider: entry.providerID,
      variants: variantIds.map((id) => ({ id, label: id.charAt(0).toUpperCase() + id.slice(1) })),
    });
  }

  return preferredFirst(models, manifest);
}
