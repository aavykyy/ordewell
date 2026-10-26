import type { DiscoveredModel } from '../models/Task';

export interface RunnerManifest {
  name: string;
  displayName: string;
  runner: { command: string };
  features: RunnerFeatures;
  modelDiscovery: RunnerModelDiscovery;
  contextFile?: string;
  contextFileAltPath?: string;
  modes?: RunnerMode[];
  /** How to ask whether the user is signed in. Absent when the runner offers no status command. */
  auth?: RunnerAuthSpec;
}

/**
 * A runner's own answer to "is the user signed in?" — the CLI args that ask,
 * the args that log in, and how to read the answer. Declared here because a
 * surface must run the same login the runner's own CLI would, with no second
 * table to drift.
 */
export interface RunnerAuthSpec {
  /** The CLI args that answer whether the user is signed in, e.g. `auth status`. */
  statusArgs: string[];
  /** The CLI args that run the login, e.g. `auth login`. */
  loginArgs: string[];
  /**
   * Matched against the status command's stdout+stderr when it exits non-zero,
   * and against a failed turn's own words to tell a signed-out failure from an
   * unrelated one.
   */
  signedOut?: RegExp;
  /**
   * A runner-specific reader that overrides the exit-code/regex rule. `null`
   * means the output answered nothing, which stays `unknown` rather than
   * guessing from an exit code.
   */
  read?: (output: string, code: number) => 'signed-in' | 'signed-out' | null;
}

export interface RunnerFeatures {
  permissionModeValues?: Record<string, string>;
  modeSettings?: Record<string, Record<string, string>>;
}

/** A runner's own reader for its catalog's output, kept beside its manifest. */
export type ModelOutputParser = (output: string, manifest: RunnerManifest) => DiscoveredModel[];

/** How discovery output becomes models: one `id label` per line, or the runner's own reader. Absent means per line. */
export type ModelDiscoveryParser = 'line-by-line' | ModelOutputParser;

export interface DiscoveryCommand {
  command: string;
  args: string[];
  parser?: ModelDiscoveryParser;
}

export type ApiAuthMethod =
  | { type: 'env'; varName: string; header: string; prefix?: string }
  | { type: 'file'; path: string; jsonPath: string; header: string; prefix?: string };

export interface ApiDiscoveryConfig {
  url: string;
  headers?: Record<string, string>;
  auth: ApiAuthMethod[];
  parser: ModelDiscoveryParser;
}

export interface RunnerModelDiscovery {
  method: 'command' | 'hardcoded';
  command?: string;
  args?: string[];
  parser?: ModelDiscoveryParser;
  /**
   * Stdio JSON-RPC discovery (Codex `app-server`): spawn the command, send
   * `initialize` then `model/list`, and read the catalog from the response.
   * Tried BEFORE apiDiscovery and command discovery. When the call fails,
   * `cacheFile` (the runner's own on-disk catalog cache, `~` expanded) is
   * read before falling through to the remaining discovery methods.
   */
  appServer?: { command: string; args: string[]; cacheFile?: string };
  /**
   * Optional last-resort list for a CLI that cannot enumerate
   * models. Used only when command discovery fails entirely or the CLI is
   * unavailable. Built-in manifests must NOT use this: anything listed here is
   * shown to the user as available even when it isn't.
   */
  fallbackModels?: { modelId: string; modelLabel: string }[];
  /**
   * Stable `--model` aliases that the runner's CLI always accepts but its help
   * text may omit (e.g. Claude's 'haiku'). Merged into successful discovery
   * results to fill gaps — discovered models take precedence, missing aliases
   * are appended — and used as the last resort when discovery fails entirely.
   * Unlike `fallbackModels`, entries must be stable CLI-accepted aliases
   * (contracts that always resolve), not arbitrary model IDs.
   */
  canonicalAliases?: { modelId: string; modelLabel: string }[];
  /**
   * The runner names its models `provider/model` (OpenCode), so an id of that
   * shape can be its own rather than an OpenRouter slug left from a vendor
   * planner.
   */
  providerQualifiedIds?: boolean;
  /**
   * HTTP API discovery — tried BEFORE command discovery. When the runner's CLI
   * has no model-listing subcommand (Claude Code), an API endpoint can serve as
   * the authoritative source. Auth methods are tried in order; the first that
   * yields a token is used. If no auth method yields a token or the request
   * fails, discovery falls through to `discoveryCommands` + `canonicalAliases`.
   */
  apiDiscovery?: ApiDiscoveryConfig;
  preferredPatterns?: { id: string; label: string }[];
  variants?: { id: string; label: string }[];
  discoveryCommands?: DiscoveryCommand[];
}

export interface RunnerMode {
  id: string;
  label: string;
  description: string;
  /** CLI value passed to the runner's permission/mode flag. Defaults to id if omitted. */
  cliValue?: string;
  /** Marks this mode as the runner's most permissive mode — the resolved default when autonomous mode is ON. */
  autonomous?: boolean;
  /** Marks this mode as the runner's conservative build mode — the resolved default when autonomous mode is OFF. */
  safe?: boolean;
  /** Marks this mode as the runner's read-only mode — what a task the planner marks read-only runs in (ADR-0031). */
  readOnly?: boolean;
  /** The mode runs under an OS sandbox, so a host where the runner's sandbox cannot start cannot offer it. */
  sandboxed?: boolean;
  /**
   * Why this mode cannot be used on this host. Set by the registry from a host
   * probe, never by a manifest: a mode with a reason is listed, so the user is
   * told, but never assigned, kept or run.
   */
  unavailable?: string;
}

export interface RunnerEntry {
  manifest: RunnerManifest;
}
