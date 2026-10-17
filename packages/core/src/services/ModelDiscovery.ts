import * as path from 'path';
import { exec, spawn } from 'child_process';
import { promisify } from 'util';
import * as fsSync from 'fs';
import * as osMod from 'os';
import { DiscoveredModel } from '../models/Task';
import type { RunnerRegistry } from '../plugins/RunnerRegistry';
import type { RunnerManifest, DiscoveryCommand, ApiDiscoveryConfig, ApiAuthMethod, ModelDiscoveryParser } from '../plugins/types';
import { augmentedPath, withPath } from '../utils/shellPath';
import { globalDataDir } from '../utils/globalDataDir';
import { planDirectLaunch } from '../utils/launch';
import { killTree } from '../utils/processTree';

const execAsync = promisify(exec);

/**
 * Injectable command runner. Defaults to the real `child_process` exec wrapper;
 * tests pass a fake so discovery never spawns a process.
 */
export type ExecImpl = (
  command: string,
  options?: { timeout?: number }
) => Promise<{ stdout: string }>;

// Discovery must find `claude`/`opencode` wherever the user installed them,
// even when the host process (GUI-launched VS Code, service-launched web
// server) inherits a minimal PATH — hence the augmented PATH.
const defaultExec: ExecImpl = async (command, options) => {
  const PATH = await augmentedPath();
  // `opencode models --verbose` emits a JSON block per model and grows with
  // every provider the user enables (~0.5MB with three providers today);
  // node's default 1MB maxBuffer would kill the child mid-stream and silently
  // degrade discovery to the variant-less plain parser.
  const { stdout } = await execAsync(command, { ...options, maxBuffer: 32 * 1024 * 1024, env: withPath(process.env, PATH) });
  return { stdout: String(stdout) };
};

/**
 * One raw model entry from an app-server `model/list` response (Codex's stdio
 * JSON-RPC protocol). Field names are the protocol's, not Ordewell's.
 */
export interface AppServerModel {
  id: string;
  displayName?: string;
  hidden?: boolean;
  defaultReasoningEffort?: string;
  supportedReasoningEfforts?: { reasoningEffort: string; description?: string }[];
}

/**
 * Injectable app-server JSON-RPC client: spawn the command, drive
 * `initialize` → `model/list` over stdio, return the raw model list. Returns
 * null on any failure (spawn error, timeout, malformed response) so discovery
 * falls through to the on-disk cache file. Tests inject a fake so discovery
 * never spawns a real app-server.
 */
export type AppServerClientImpl = (
  command: string,
  args: string[],
  options?: { timeout?: number }
) => Promise<AppServerModel[] | null>;

const defaultAppServerClient: AppServerClientImpl = async (command, args, options) => {
  const PATH = await augmentedPath();
  // No shell here, so on Windows the command has to be resolved against
  // PATHEXT first — `codex` alone is a `.cmd` shim that CreateProcess cannot
  // start. A resolution failure returns the command unchanged, and the spawn's
  // own error still routes discovery to the on-disk cache.
  const launch = await planDirectLaunch(command, args).catch(() => null);
  if (!launch) return null;
  return new Promise((resolve) => {
    let child: import('child_process').ChildProcess;
    try {
      child = spawn(launch.file, launch.args, {
        env: withPath(process.env, PATH),
        stdio: ['pipe', 'pipe', 'ignore'],
        windowsVerbatimArguments: launch.verbatim,
      });
    } catch {
      resolve(null);
      return;
    }
    let settled = false;
    const finish = (value: AppServerModel[] | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      // Tree-wide, for the same reason every other dispose path is: when
      // `codex` resolved to a shim the direct child is the interpreter, and
      // killing it leaves the app-server alive — holding its port, and
      // outliving the discovery call that started it.
      killTree(child);
      resolve(value);
    };
    const timer = setTimeout(() => finish(null), options?.timeout ?? 20000);
    child.on('error', () => finish(null));
    child.on('exit', () => finish(null));

    let buffer = '';
    const send = (id: number, method: string, params: unknown) => {
      try {
        child.stdin!.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
      } catch {
        finish(null);
      }
    };
    child.stdout!.on('data', (chunk: Buffer) => {
      buffer += chunk.toString();
      let newline: number;
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        let msg: { id?: number; result?: { data?: AppServerModel[] } };
        try { msg = JSON.parse(line); } catch { continue; }
        if (msg.id === 1) {
          send(2, 'model/list', {});
        } else if (msg.id === 2) {
          finish(Array.isArray(msg.result?.data) ? msg.result!.data! : null);
        }
      }
    });
    send(1, 'initialize', { clientInfo: { name: 'ordewell', title: 'Ordewell', version: '0.1.0' } });
  });
};

function effortVariant(effort: string): { id: string; label: string } {
  return { id: effort, label: effort.charAt(0).toUpperCase() + effort.slice(1) };
}

/** Map app-server `model/list` entries to DiscoveredModels, dropping hidden ones. */
export function parseAppServerModels(raw: AppServerModel[]): DiscoveredModel[] {
  return raw
    .filter((m) => m.id && !m.hidden)
    .map((m) => ({
      modelId: m.id,
      modelLabel: m.displayName || m.id,
      runnerProvider: 'openai',
      variants: (m.supportedReasoningEfforts ?? []).map((e) => effortVariant(e.reasoningEffort)),
    }));
}

/**
 * Parse the runner's own on-disk catalog cache (Codex `models_cache.json`).
 * Same catalog as `model/list` but in the cache file's snake_case shape, with
 * `visibility: "hide"` in place of the protocol's `hidden` flag.
 */
export function parseCodexModelsCache(content: string): DiscoveredModel[] {
  try {
    const data = JSON.parse(content) as {
      models?: Array<{
        slug?: string;
        display_name?: string;
        visibility?: string;
        supported_reasoning_levels?: { effort: string; description?: string }[];
      }>;
    };
    if (!Array.isArray(data.models)) return [];
    return data.models
      .filter((m) => m.slug && m.visibility !== 'hide')
      .map((m) => ({
        modelId: m.slug!,
        modelLabel: m.display_name || m.slug!,
        runnerProvider: 'openai',
        variants: (m.supported_reasoning_levels ?? []).map((l) => effortVariant(l.effort)),
      }));
  } catch {
    return [];
  }
}

const GEMINI_MODELS_CACHE_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * How long a degraded runner discovery (a manifest fallback list, or an empty
 * one because the CLI failed) is remembered before the next lookup re-runs it.
 * The failure that goes stale while a host runs is a cold or misconfigured CLI;
 * without this, every planner switch and every runner-list refresh re-pays a
 * slow or failing spawn — an empty `opencode models` costs ~20s in the field.
 * Bounded the same way `RunnerInstallation`'s negative verdict is, and a refresh
 * asks again at once.
 */
const NEGATIVE_TTL_MS = 60_000;

interface GeminiApiModel {
  name: string;
  displayName: string;
  supportedGenerationMethods?: string[];
}

function geminiDiscoveryCacheKey(apiKey: string): { key: string; dir: string; file: string } {
  const dir = globalDataDir();
  const hash = apiKey.slice(-8);
  return {
    key: `gemini-models:${hash}`,
    dir,
    file: path.join(dir, `gemini_models_${hash}.json`),
  };
}

function readGeminiCache(apiKey: string): DiscoveredModel[] | null {
  try {
    const { file } = geminiDiscoveryCacheKey(apiKey);
    if (!fsSync.existsSync(file)) return null;
    const raw = fsSync.readFileSync(file, 'utf8');
    const data = JSON.parse(raw);
    if (Date.now() - data.cachedAt > GEMINI_MODELS_CACHE_TTL_MS) return null;
    return data.models as DiscoveredModel[];
  } catch {
    return null;
  }
}

function writeGeminiCache(apiKey: string, models: DiscoveredModel[]): void {
  try {
    const { dir, file } = geminiDiscoveryCacheKey(apiKey);
    fsSync.mkdirSync(dir, { recursive: true });
    fsSync.writeFileSync(
      file,
      JSON.stringify({ models, cachedAt: Date.now() }, null, 2)
    );
  } catch { /* empty */ }
}

/**
 * Delete the on-disk Gemini discovery cache for an API key so the next
 * discovery re-runs. Used by the resolver's `invalidate()` in production (no
 * injected fetch); best-effort — a missing file is a no-op.
 */
export function clearGeminiCache(apiKey: string): void {
  if (!apiKey) return;
  try {
    const { file } = geminiDiscoveryCacheKey(apiKey);
    if (fsSync.existsSync(file)) fsSync.rmSync(file);
  } catch { /* empty */ }
}

export async function discoverGeminiModels(apiKey: string, baseUrl?: string, fetchImpl?: typeof fetch): Promise<DiscoveredModel[]> {
  if (!apiKey) return [];

  // An injected fetch means the resolver owns caching — bypass the file cache.
  const useFileCache = !fetchImpl;
  if (useFileCache) {
    const cached = readGeminiCache(apiKey);
    if (cached && cached.length > 0) return cached;
  }

  const url = (baseUrl || 'https://generativelanguage.googleapis.com').replace(/\/+$/, '');

  try {
    const models: DiscoveredModel[] = [];
    let pageToken: string | undefined;

    do {
      const params = new URLSearchParams({ key: apiKey });
      if (pageToken) params.set('pageToken', pageToken);
      const response = await (fetchImpl ?? fetch)(`${url}/v1beta/models?${params}`, {
        headers: { 'Content-Type': 'application/json' },
      });

      if (!response.ok) return [];

      const data = (await response.json()) as { models?: GeminiApiModel[]; nextPageToken?: string };
      for (const m of data.models ?? []) {
        const methods = m.supportedGenerationMethods ?? [];
        if (methods.includes('generateContent')) {
          const modelId = m.name.replace(/^models\//, '');
          models.push({
            modelId,
            modelLabel: m.displayName || modelId,
            runnerProvider: 'gemini',
            variants: [],
          });
        }
      }

      pageToken = data.nextPageToken || undefined;
    } while (pageToken);

    models.sort((a, b) => {
      const aPro = a.modelId.includes('-pro');
      const bPro = b.modelId.includes('-pro');
      if (aPro && !bPro) return -1;
      if (!aPro && bPro) return 1;
      return b.modelId.localeCompare(a.modelId);
    });

    if (useFileCache && models.length > 0) writeGeminiCache(apiKey, models);
    return models;
  } catch {
    return [];
  }
}

function applyVariants(models: DiscoveredModel[], manifest: RunnerManifest): DiscoveredModel[] {
  const variants = manifest.modelDiscovery.variants;
  if (!variants || variants.length === 0) return models;
  // Only fill in models whose variants are empty (e.g. --help parsing or
  // canonical-alias fallback). Models that already carry per-model variants
  // from the API must keep them — the static list is a fallback, not an override.
  return models.map((m) => (m.variants.length > 0 ? m : { ...m, variants }));
}

/**
 * Resolve an auth token from a manifest's `apiDiscovery.auth` list. Each method
 * is tried in order; the first that yields a non-empty token wins.
 *
 * - `env`: reads `process.env[varName]`
 * - `file`: reads a JSON file at `path` (with `~` expansion) and extracts the
 *   value at `jsonPath` (dot-notation, e.g. `claudeAiOauth.accessToken`)
 *
 * Returns `{ header, value }` ready to set on the fetch `headers` object, or
 * `null` when no auth method yields a token.
 */
function resolveApiAuth(authMethods: ApiAuthMethod[]): { header: string; value: string } | null {
  for (const method of authMethods) {
    try {
      let token: string | undefined;
      if (method.type === 'env') {
        token = process.env[method.varName];
      } else {
        const filePath = method.path.replace(/^~/, osMod.homedir());
        if (!fsSync.existsSync(filePath)) continue;
        const data = JSON.parse(fsSync.readFileSync(filePath, 'utf8'));
        token = method.jsonPath.split('.').reduce((obj: unknown, key: string) => {
          if (obj && typeof obj === 'object') return (obj as Record<string, unknown>)[key] as unknown;
          return undefined;
        }, data) as string | undefined;
      }
      if (token) {
        const value = method.prefix ? `${method.prefix}${token}` : token;
        return { header: method.header, value };
      }
    } catch { /* try next auth method */ }
  }
  return null;
}

/**
 * Query an HTTP API endpoint for the model list. Used when the runner's CLI
 * has no model-listing subcommand (Claude Code). Returns the parsed models, or
 * `null` when no auth token is available or the request fails — in both cases
 * the caller falls through to command-based discovery.
 */
async function discoverFromApi(
  manifest: RunnerManifest,
  config: ApiDiscoveryConfig,
  fetchImpl?: typeof fetch
): Promise<DiscoveredModel[] | null> {
  const auth = resolveApiAuth(config.auth);
  if (!auth) return null;

  try {
    const headers: Record<string, string> = { ...config.headers, [auth.header]: auth.value };
    const response = await (fetchImpl ?? fetch)(config.url, { headers });
    if (!response.ok) return null;
    const data = await response.json();
    const text = JSON.stringify(data);
    return parseModelOutput(text, config.parser, manifest);
  } catch {
    return null;
  }
}

/**
 * Whether a discovery command was killed by its own timeout — the cold-CLI
 * signal (the server is still starting, the catalog is not fetched yet). A
 * non-zero exit is not this: the binary is missing, a flag was rejected, or a
 * port is busy, and none of those heal on a retry. `child_process.exec` rejects
 * a timed-out child with `killed: true`.
 */
function wasKilled(err: unknown): boolean {
  return !!err && typeof err === 'object' && (err as { killed?: unknown }).killed === true;
}

async function discoverFromCommand(manifest: RunnerManifest, execImpl: ExecImpl): Promise<{ models: DiscoveredModel[]; fromFallback: boolean }> {
  const discovery = manifest.modelDiscovery;
  const commands: DiscoveryCommand[] = discovery.discoveryCommands ?? [
    { command: discovery.command!, args: discovery.args || [], parser: discovery.parser },
  ];

  const runCommands = async (): Promise<{ models: DiscoveredModel[] | null; timedOut: boolean }> => {
    let timedOut = false;
    for (const cmd of commands) {
      try {
        // Generous timeout: a cold runner CLI may spawn its server, install
        // extensions, and fetch its catalog on first invocation after boot.
        const { stdout } = await execImpl(`${cmd.command} ${cmd.args.join(' ')}`, { timeout: 45000 });
        const models = parseModelOutput(stdout, cmd.parser, manifest);
        if (models.length > 0) return { models: applyVariants(mergeCanonicalAliases(models, manifest), manifest), timedOut };
      } catch (err) {
        // A killed command is the cold-start shape a warm retry can recover;
        // anything else is an answer, not a warm-up.
        if (wasKilled(err)) timedOut = true;
      }
    }
    return { models: null, timedOut };
  };

  // First pass. Retry once only when a command was killed by its timeout — the
  // CLI was cold and the server is warm by the second pass. A command that
  // exited non-zero said something real, and repeating it only doubles the wait.
  const first = await runCommands();
  if (first.models) return { models: first.models, fromFallback: false };
  if (first.timedOut) {
    const second = await runCommands();
    if (second.models) return { models: second.models, fromFallback: false };
  }

  return { models: applyVariants(buildFallbackModels(manifest), manifest), fromFallback: true };
}

/**
 * Merge `manifest.modelDiscovery.canonicalAliases` into a successful discovery
 * result. Discovered models take precedence (they reflect the installed CLI);
 * any canonical alias NOT already present is appended, so stable `--model`
 * contracts that the CLI's help text omits (e.g. Claude's 'haiku') are always
 * offered. Only applies when `canonicalAliases` is declared.
 */
function mergeCanonicalAliases(discovered: DiscoveredModel[], manifest: RunnerManifest): DiscoveredModel[] {
  const canonical = manifest.modelDiscovery.canonicalAliases;
  if (!canonical || canonical.length === 0) return discovered;
  const seen = new Set(discovered.map((m) => m.modelId));
  const gaps = canonical
    .filter((f) => !seen.has(f.modelId))
    .map((f) => ({
      modelId: f.modelId,
      modelLabel: f.modelLabel,
      runnerProvider: f.modelId.includes('/') ? f.modelId.split('/')[0] : undefined,
      variants: [],
    }));
  return gaps.length > 0 ? [...discovered, ...gaps] : discovered;
}

function buildFallbackModels(manifest: RunnerManifest): DiscoveredModel[] {
  const list = manifest.modelDiscovery.canonicalAliases ?? manifest.modelDiscovery.fallbackModels ?? [];
  return list.map((m) => ({
    modelId: m.modelId,
    modelLabel: m.modelLabel,
    runnerProvider: m.modelId.includes('/') ? m.modelId.split('/')[0] : undefined,
    variants: manifest.modelDiscovery.variants || [],
  }));
}

function parseModelOutput(stdout: string, parser: ModelDiscoveryParser | undefined, manifest: RunnerManifest): DiscoveredModel[] {
  return typeof parser === 'function' ? parser(stdout, manifest) : parseLineByLine(stdout);
}

function parseLineByLine(stdout: string): DiscoveredModel[] {
  return stdout
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .slice(0, 50)
    .map((line) => {
      const parts = line.split(/\s+/);
      const id = parts[0];
      const label = parts.slice(1).join(' ') || id;
      return { modelId: id, modelLabel: label, runnerProvider: id.includes('/') ? id.split('/')[0] : undefined, variants: [] };
    });
}

/**
 * @internal Per-runner executor-model discovery. This is the *implementation*
 * behind ModelResolver, not part of the public package API — construct it only
 * through ModelResolver (see CONTEXT.md "ModelResolver"). The resolver owns the
 * cache lifecycle via `discover()` + `clear()`.
 */
export class ModelDiscovery {
  private cache: Map<string, DiscoveredModel[]> = new Map();
  /**
   * Degraded results (a fallback list, or empty) remembered for
   * {@link NEGATIVE_TTL_MS}. They are deliberately not cached — a transient
   * failure must heal — but re-running a failing CLI on every lookup is the
   * other extreme.
   */
  private misses: Map<string, { models: DiscoveredModel[]; at: number }> = new Map();
  private registry: RunnerRegistry;
  private execImpl: ExecImpl;
  private fetchImpl?: typeof fetch;
  private appServerClient: AppServerClientImpl;
  private readFileImpl: (path: string) => string | null;
  private now: () => number;

  constructor(
    registry: RunnerRegistry,
    execImpl: ExecImpl = defaultExec,
    fetchImpl?: typeof fetch,
    appServerClient: AppServerClientImpl = defaultAppServerClient,
    readFileImpl?: (path: string) => string | null,
    now: () => number = Date.now,
  ) {
    this.registry = registry;
    this.execImpl = execImpl;
    this.fetchImpl = fetchImpl;
    this.appServerClient = appServerClient;
    this.now = now;
    this.readFileImpl = readFileImpl ?? ((filePath: string) => {
      try {
        return fsSync.readFileSync(filePath.replace(/^~/, osMod.homedir()), 'utf8');
      } catch {
        return null;
      }
    });
  }

  /**
   * App-server discovery chain (ADR-0004): live `model/list` over stdio
   * JSON-RPC first, the runner's own on-disk catalog cache second. Returns
   * null when both fail so `discover()` falls through to the remaining
   * methods.
   */
  private async discoverFromAppServer(manifest: RunnerManifest): Promise<DiscoveredModel[] | null> {
    const config = manifest.modelDiscovery.appServer;
    if (!config) return null;

    const raw = await this.appServerClient(config.command, config.args);
    if (raw) {
      const models = parseAppServerModels(raw);
      if (models.length > 0) return models;
    }

    if (config.cacheFile) {
      const content = this.readFileImpl(config.cacheFile);
      if (content) {
        const models = parseCodexModelsCache(content);
        if (models.length > 0) return models;
      }
    }

    return null;
  }

  /**
   * Every model this runner offers, each stamped with the runner it came from.
   * The stamp lives here rather than in the parsers because this is the only
   * place that knows both — a parser sees output, not which agent produced it.
   */
  async discover(runner: string): Promise<DiscoveredModel[]> {
    const models = await this.discoverRaw(runner);
    const manifest = this.registry.getManifest(runner);
    if (!manifest) return models;
    const runnerLabel = manifest.displayName || runner;
    return models.map((m) => ({ ...m, runnerId: runner, runnerLabel }));
  }

  private async discoverRaw(runner: string): Promise<DiscoveredModel[]> {
    const cached = this.cache.get(runner);
    if (cached) return cached;

    const remembered = this.misses.get(runner);
    if (remembered && this.now() - remembered.at < NEGATIVE_TTL_MS) return remembered.models;

    const manifest = this.registry.getManifest(runner);
    if (!manifest) {
      return [];
    }

    let models: DiscoveredModel[];
    let cacheable = true;
    const discovery = manifest.modelDiscovery;

    // 0. App-server JSON-RPC discovery (Codex). Live catalog first, the
    //    runner's own cache file second; falls through on total failure.
    if (discovery.appServer) {
      const appServerModels = await this.discoverFromAppServer(manifest);
      if (appServerModels && appServerModels.length > 0) {
        this.cache.set(runner, appServerModels);
        return appServerModels;
      }
      // Both live and cache-file sources failed — whatever the remaining
      // methods produce is a degraded fallback; don't cache it, so a
      // transient failure heals on the next lookup.
      cacheable = false;
    }

    // 1. Try API discovery first (e.g. Anthropic Models API for Claude Code).
    //    Returns null when no auth token is available or the request fails —
    //    in both cases we fall through to command-based discovery.
    if (discovery.apiDiscovery) {
      const apiModels = await discoverFromApi(manifest, discovery.apiDiscovery, this.fetchImpl);
      if (apiModels && apiModels.length > 0) {
        models = applyVariants(mergeCanonicalAliases(apiModels, manifest), manifest);
        if (cacheable && models.length > 0) this.cache.set(runner, models);
        return models;
      }
    }

    // 2. Command-based discovery (CLI subcommand or --help parsing).
    if (discovery.method === 'command' && (discovery.command || discovery.discoveryCommands?.length)) {
      const result = await discoverFromCommand(manifest, this.execImpl);
      models = result.models;
      // A fallback-only result means the CLI wasn't reachable — don't cache
      // it, so a transient failure (PATH, network, cold start) heals on the
      // next lookup instead of persisting until an explicit refresh.
      cacheable = !result.fromFallback;
    } else {
      models = buildFallbackModels(manifest);
    }

    if (cacheable && models.length > 0) this.cache.set(runner, models);
    else this.misses.set(runner, { models, at: this.now() });
    return models;
  }

  clear(): void {
    this.cache.clear();
    this.misses.clear();
  }

  /** Whatever `discover()` has already cached for `runner` — never triggers discovery. */
  getCached(runner: string): DiscoveredModel[] | undefined {
    return this.cache.get(runner);
  }
}
