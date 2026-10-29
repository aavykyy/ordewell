import { readFileSync } from 'fs';
import { homedir } from 'os';
import { join, resolve } from 'path';
import type { RunnerManifest } from '../types';
import { parseToml } from '../../services/harness/toml';

const NOT_LOGGED_IN = /^\s*not logged in\s*$/im;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Whether `codex login status` saying "Not logged in" is not this user's
 * answer. That command only knows the credentials Codex itself stores. Codex
 * authenticates some working setups another way: `OPENAI_API_KEY` on the
 * default provider, or any custom `model_provider` that does not delegate to
 * Codex's login (Azure, an enterprise gateway, a credential-less local server).
 *
 * Read from the probe's own environment, not `process.env`: a workspace can
 * point `CODEX_HOME` or `HOME` at another account (ADR-0016). Real codex
 * resolves the config at `$HOME/.codex/config.toml` when `CODEX_HOME` is
 * unset — an empty one counts as unset — so the fallback walks the probe's
 * HOME, not the daemon's.
 */
function statusCannotJudgeLogin(env: NodeJS.ProcessEnv): boolean {
  if (env.OPENAI_API_KEY) return true;
  let config: Record<string, unknown>;
  try {
    const home = env.CODEX_HOME ? resolve(env.CODEX_HOME) : join(env.HOME ?? homedir(), '.codex');
    config = parseToml(readFileSync(join(home, 'config.toml'), 'utf8'));
  } catch {
    // No readable config is no declared provider, so the status is the answer.
    return false;
  }
  const id = typeof config.model_provider === 'string' ? config.model_provider : undefined;
  const providers = isRecord(config.model_providers) ? config.model_providers : {};
  const provider = id !== undefined && isRecord(providers[id]) ? providers[id] : undefined;
  if (!provider) return false;
  // This provider delegates to Codex's own login, which is what the status
  // command asked about, so its answer stands.
  return provider.requires_openai_auth !== true;
}

export const CODEX_MANIFEST: RunnerManifest = {
  name: 'codex',
  displayName: 'Codex',

  runner: { command: 'codex' },

  features: {
    permissionModeValues: {
      'agent': 'workspace-write',
      'plan': 'read-only',
      'fullAccess': 'danger-full-access',
      // Legacy alias used by older tasks
      'build': 'workspace-write',
    },
    modeSettings: {
      approvalPolicy: {
        'agent': 'on-request',
        'plan': 'never',
        'fullAccess': 'never',
        'build': 'on-request',
      },
      approvalsReviewer: {
        'agent': 'auto_review',
        'build': 'auto_review',
      },
    },
  },

  modelDiscovery: {
    // Codex has no `codex models` subcommand (see ADR-0004). Discovery
    // tries three sources in order, each falling through to the next:
    //
    // 1. `codex app-server` stdio JSON-RPC (`initialize` → `model/list`) —
    //    the live catalog: ids, display names, hidden flags, and per-model
    //    supported reasoning efforts (the variants).
    // 2. `~/.codex/models_cache.json` — the same catalog, written by Codex
    //    itself on its own runs; fresh as of the user's last Codex session.
    // 3. canonicalAliases — stable `-m` slugs as the last resort, with the
    //    static common-denominator variants below.
    method: 'hardcoded',
    appServer: {
      command: 'codex',
      args: ['app-server'],
      // CODEX_HOME moves all of Codex's own files from `~/.codex`.
      cacheFile: (env) => `${env.CODEX_HOME?.trim() || '~/.codex'}/models_cache.json`,
    },
    canonicalAliases: [
      { modelId: 'gpt-5.6-sol', modelLabel: 'GPT-5.6-Sol' },
      { modelId: 'gpt-5.6-terra', modelLabel: 'GPT-5.6-Terra' },
      { modelId: 'gpt-5.6-luna', modelLabel: 'GPT-5.6-Luna' },
      { modelId: 'gpt-5.5', modelLabel: 'GPT-5.5' },
      { modelId: 'gpt-5.4', modelLabel: 'GPT-5.4' },
      { modelId: 'gpt-5.4-mini', modelLabel: 'GPT-5.4-Mini' },
    ],
    // Fallback-only common denominator: every current Codex model supports at
    // least these four rungs. Live discovery replaces them with each model's
    // real supportedReasoningEfforts (which may add max/ultra).
    variants: [
      { id: 'low', label: 'Low' },
      { id: 'medium', label: 'Medium' },
      { id: 'high', label: 'High' },
      { id: 'xhigh', label: 'Xhigh' },
    ],
  },

  auth: {
    statusArgs: ['login', 'status'],
    loginArgs: ['login'],
    // `codex login status` prints "Not logged in" and exits 1 when signed out;
    // a clean exit is the only other answer it gives. Anchored to its own line:
    // a failure can quote another tool that is not logged in.
    signedOut: NOT_LOGGED_IN,
    // But it only knows the credentials Codex stores itself. A key or a custom
    // provider that authenticates another way is not signed out in any sense
    // this command can see, so leave that answer unknown rather than wall it.
    read: ({ output, code, env }) => {
      if (code === 0) return 'signed-in';
      if (!NOT_LOGGED_IN.test(output)) return null;
      return statusCannotJudgeLogin(env) ? null : 'signed-out';
    },
  },

  contextFile: 'AGENTS.md',

  modes: [
    { id: 'agent', label: 'Agent', description: 'Workspace-write sandbox: edits files inside the workspace, and Codex\'s reviewer subagent assesses each approval request', cliValue: 'workspace-write', safe: true, sandboxed: true },
    { id: 'plan', label: 'Read-only', description: 'Ordewell commands with the native shell off; lands nothing', cliValue: 'read-only', readOnly: true },
    { id: 'fullAccess', label: 'Full access', description: 'No sandbox: full disk and network access for autonomous runs', cliValue: 'danger-full-access', autonomous: true },
  ],
};
