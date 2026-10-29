import * as path from 'path';
import type { DiscoveredModel } from '../../models/Task';
import type { RunnerEnv, RunnerSettingsFiles } from '../types';

// Claude Code's model sources, as its manifest reads them: the Anthropic
// Models API, the `--model` option of `claude --help` when no credential
// reaches the API, and the picker entries the user added in its settings.

/**
 * Parse the Anthropic Models API response (`GET /v1/models`). The API returns
 * full model IDs (e.g. `claude-haiku-4-5-20251001`) sorted most-recent first.
 * We derive the short family alias (`haiku`, `opus`, `sonnet`, `fable`) that
 * the Claude Code CLI's `--model` flag accepts, deduplicating by family to
 * keep only the latest (first in the API's ordering).
 *
 * Per-model thinking variants come from two independent capabilities:
 * `capabilities.thinking.types.adaptive` (the model reasons without being told
 * how hard) and `capabilities.effort.{level}` (the rungs `--effort` accepts).
 * They are read separately because they are separate axes — the current model
 * line reports `thinking.types.enabled: false` alongside all five effort rungs,
 * so treating `enabled` as the gate for effort hid every rung on exactly the
 * models a user is most likely to plan with. A model with no capabilities gets
 * an empty variants array — the caller's static fallback fills in only when
 * variants are empty (see `applyVariants`).
 */
const ANTHROPIC_EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
const ANTHROPIC_VARIANT_LABELS: Record<string, string> = {
  adaptive: 'Adaptive',
  low: 'Low effort',
  medium: 'Medium effort',
  high: 'High effort',
  xhigh: 'Extra high effort',
  max: 'Max effort',
};

function anthropicCapabilitiesToVariants(
  caps?:
    | {
        thinking?: {
          supported?: boolean;
          types?: {
            adaptive?: { supported?: boolean };
            enabled?: { supported?: boolean };
          };
        };
        effort?: {
          supported?: boolean;
          low?: { supported?: boolean };
          medium?: { supported?: boolean };
          high?: { supported?: boolean };
          xhigh?: { supported?: boolean };
          max?: { supported?: boolean };
        };
      }
    | undefined,
): { id: string; label: string }[] {
  const variants: { id: string; label: string }[] = [];
  if (caps?.thinking?.supported && caps.thinking.types?.adaptive?.supported) {
    variants.push({ id: 'adaptive', label: ANTHROPIC_VARIANT_LABELS.adaptive });
  }
  if (caps?.effort?.supported) {
    for (const level of ANTHROPIC_EFFORT_LEVELS) {
      if (caps.effort[level]?.supported) {
        variants.push({ id: level, label: ANTHROPIC_VARIANT_LABELS[level] });
      }
    }
  }
  return variants;
}

export function parseAnthropicModels(stdout: string): DiscoveredModel[] {
  try {
    const data = JSON.parse(stdout) as {
      data?: Array<{
        id: string;
        display_name?: string;
        capabilities?: Parameters<typeof anthropicCapabilitiesToVariants>[0];
      }>;
    };
    const models = data.data;
    if (!Array.isArray(models)) return [];

    const seen = new Set<string>();
    const result: DiscoveredModel[] = [];

    for (const m of models) {
      if (!m.id || typeof m.id !== 'string') continue;
      if (!m.id.startsWith('claude-')) continue;
      const segments = m.id.split('-');
      const family = segments[1];
      if (!family || !['opus', 'sonnet', 'haiku', 'fable'].includes(family)) continue;
      if (seen.has(family)) continue;
      seen.add(family);
      const label = m.display_name || family.charAt(0).toUpperCase() + family.slice(1);
      result.push({
        modelId: family,
        modelLabel: label,
        runnerProvider: 'anthropic',
        variants: anthropicCapabilitiesToVariants(m.capabilities),
      });
    }

    return result;
  } catch {
    return [];
  }
}

export function parseClaudeHelp(stdout: string): DiscoveredModel[] {
  const models: DiscoveredModel[] = [];
  const seen = new Set<string>();

  const extractIds = (text: string) => {
    for (const line of text.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const words = trimmed.split(/\s+/);
      for (const w of words) {
        const cleaned = w.replace(/[",()]/g, '');
        if (cleaned.length < 5) continue;
        if (cleaned.includes('-') && cleaned.length > 10 && !seen.has(cleaned)) {
          seen.add(cleaned);
          let label = cleaned.replace(/-20\d{6}/, '').replace(/-/g, ' ');
          label = label.replace(/\b\w/g, (c) => c.toUpperCase());
          if (cleaned.includes('sonnet')) label = 'Sonnet';
          else if (cleaned.includes('opus')) label = 'Opus';
          else if (cleaned.includes('haiku')) label = 'Haiku';
          models.push({ modelId: cleaned, modelLabel: label, variants: [] });
        }
      }
    }
  };

  // Prefer an explicit enumeration of model IDs when present, e.g.
  //   --model <model>   Available values: claude-opus-..., claude-sonnet-...
  const modelMatch = stdout.match(/--model\s+<model>\s+(?:.*?\n)*?\s*(?:Available|valid)(?:\s+values?|:\s*options?)\s*:\s*([\s\S]*?)(?:\n\s*\n|$)/i);

  if (modelMatch) {
    extractIds(modelMatch[1]);
  }
  if (models.length > 0) return models;

  // Modern `claude --help` describes --model in prose with quoted example
  // aliases: "Provide an alias for the latest model (e.g. 'fable', 'opus', or
  // 'sonnet') or a model's full name (e.g. 'claude-fable-5')." Those aliases
  // are the CLI's own contract for what --model accepts, so they ARE the model
  // list — extracted from the installed binary, never hardcoded here.
  // The option block: the `--model` line plus its indented continuation lines
  // (a line whose first non-space char is `-` starts the next option).
  const optionBlock = stdout.match(/--model\s+<model>[^\n]*(?:\n(?!\s*-)[^\n]*)*/);
  if (optionBlock) {
    const quoted = [...optionBlock[0].matchAll(/'([a-z][a-z0-9._/-]*)'/gi)].map((m) => m[1]);
    // Aliases (no separator, e.g. 'opus') resolve to the latest model of their
    // family and are always valid; full-name examples (e.g. 'claude-fable-5')
    // duplicate an alias, so only use them when no alias was found.
    const aliases = quoted.filter((q) => /^[a-z][a-z0-9]{2,19}$/.test(q));
    const chosen = aliases.length > 0 ? aliases : quoted.filter((q) => q.length >= 5);
    for (const id of chosen) {
      if (seen.has(id)) continue;
      seen.add(id);
      const label = id.replace(/-20\d{6}$/, '').split(/[-_]/).map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
      models.push({ modelId: id, modelLabel: label, variants: [] });
    }
  }

  return models;
}

/** Where Claude Code keeps its user settings and login: `CLAUDE_CONFIG_DIR` moves them from `~/.claude`. */
export function claudeConfigDir(env: RunnerEnv): string {
  return env.CLAUDE_CONFIG_DIR?.trim() || '~/.claude';
}

/** The system directory of Claude Code's file-based managed settings. */
export function claudeManagedSettingsDir(platform: NodeJS.Platform = process.platform): string {
  if (platform === 'darwin') return '/Library/Application Support/ClaudeCode';
  if (platform === 'win32') return 'C:\\Program Files\\ClaudeCode';
  return '/etc/claude-code';
}

/**
 * The rows of Claude Code's model picker, gateway IDs most often, resolved as
 * Claude resolves `modelPicker`: the highest source that sets it supplies the
 * whole lineup, and rows from two sources never combine. The managed settings
 * file and its `managed-settings.d/` drop-ins rank above user settings, and a
 * later drop-in replaces an earlier lineup. Project files cannot set it, and
 * Ordewell's `--settings` never does. Server-managed, MDM and registry policy
 * are out of reach here, so a lineup only they set is not offered, and one
 * they set above these files is not seen to override them.
 */
export function readClaudeSettingsModels(files: RunnerSettingsFiles, platform: NodeJS.Platform = process.platform): DiscoveredModel[] {
  const managed = claudeManagedSettingsDir(platform);
  const join = platform === 'win32' ? path.win32.join : path.posix.join;
  const dropIns = files.list(join(managed, 'managed-settings.d'))
    .filter((name) => name.endsWith('.json') && !name.startsWith('.'))
    .sort()
    .map((name) => join(managed, 'managed-settings.d', name));
  const ranked = [...dropIns.reverse(), join(managed, 'managed-settings.json'), join(claudeConfigDir(files.env), 'settings.json')];
  for (const file of ranked) {
    const content = files.read(file);
    const lineup = content === null ? null : parseClaudeSettingsModels(content);
    if (lineup) return lineup;
  }
  return [];
}

/**
 * Parse the `modelPicker.options` of one Claude Code settings file: `{ model,
 * label? }` rows. Null when the file does not set a lineup, so a lower source
 * may; a row without a usable `model` string is skipped. A hand-edited file
 * must never break discovery.
 */
export function parseClaudeSettingsModels(content: string): DiscoveredModel[] | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return null;
  }
  const picker = parsed && typeof parsed === 'object' ? (parsed as { modelPicker?: unknown }).modelPicker : undefined;
  const options = picker && typeof picker === 'object' ? (picker as { options?: unknown }).options : undefined;
  if (!Array.isArray(options)) return null;

  const seen = new Set<string>();
  const models: DiscoveredModel[] = [];
  for (const row of options as unknown[]) {
    if (!row || typeof row !== 'object') continue;
    const { model: raw, label } = row as { model?: unknown; label?: unknown };
    // Hand-typed padding would reach `--model` and the picker's provider group.
    const model = typeof raw === 'string' ? raw.trim() : '';
    if (!model || seen.has(model)) continue;
    seen.add(model);
    models.push({
      modelId: model,
      modelLabel: typeof label === 'string' && label.trim() ? label.trim() : model,
      runnerProvider: model.includes('/') ? model.split('/')[0] : undefined,
      variants: [],
    });
  }
  return models;
}
