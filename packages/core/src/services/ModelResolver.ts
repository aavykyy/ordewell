import { ModelDiscovery, clearGeminiCache, type ExecImpl } from './ModelDiscovery';
import { ModelCatalog } from './ModelCatalog';
import type { RunnerRegistry } from '../plugins/RunnerRegistry';
import type { RunnerEnv } from '../plugins/types';
import type { IConfig } from '../interfaces/IConfig';
import type { DiscoveredModel, RunnerId } from '../models/Task';
import { fetchAllProviderModels, collectProviderCredentials, toOrchestratorOptions, type OrchestratorOption, type ProviderModelLists } from './ProviderRouting';
import { ORCHESTRATOR_SHORTCUTS } from './ModelShortcuts';
import { PROVIDER_PRIORITY, isApiProvider, prefixModelId, stripModelPrefix } from './ProviderRegistry';

export interface ModelResolverDeps {
  fetchImpl?: typeof fetch;
  execImpl?: ExecImpl;
  /** The environment runners are launched with, which can move a runner's own files (`CLAUDE_CONFIG_DIR`). Defaults to this process's. */
  env?: () => Promise<RunnerEnv>;
}

export class ModelResolver {
  private discovery: ModelDiscovery;
  private fetchImpl?: typeof fetch;
  private cachedPickerOptions: OrchestratorOption[] | null = null;
  /** A catalog load under way: a second ask, or a warm-up, shares it rather than fetching again. */
  private pickerLoad: Promise<OrchestratorOption[]> | null = null;
  private lastDiscoveryErrors: Record<string, string> = {};

  constructor(
    private registry: RunnerRegistry,
    private config: IConfig,
    deps: ModelResolverDeps = {}
  ) {
    this.discovery = new ModelDiscovery(registry, deps.execImpl, deps.fetchImpl, undefined, undefined, undefined, deps.env);
    this.fetchImpl = deps.fetchImpl;
  }

  static builtinOptions(): OrchestratorOption[] {
    return toOrchestratorOptions({}, ORCHESTRATOR_SHORTCUTS);
  }

  async modelsForRunners(runners: RunnerId[]): Promise<Partial<Record<RunnerId, DiscoveredModel[]>>> {
    // Each runner's discovery can spawn a slow CLI, so they run together rather
    // than in series: one cold backend must not hold up the others' catalogs.
    // Deduped, because two concurrent discoveries of one runner would spawn it
    // twice with no shared in-flight guard.
    const unique = [...new Set(runners)];
    const discovered = await Promise.all(unique.map(async (runner) => {
      try {
        return [runner, await this.discovery.discover(runner)] as const;
      } catch {
        return [runner, [] as DiscoveredModel[]] as const;
      }
    }));
    return Object.fromEntries(discovered) as Partial<Record<RunnerId, DiscoveredModel[]>>;
  }

  async pickerOptions(): Promise<OrchestratorOption[]> {
    if (this.cachedPickerOptions) return this.cachedPickerOptions;
    if (!this.pickerLoad) {
      const load = this.loadPickerOptions();
      this.pickerLoad = load;
      void load.finally(() => { if (this.pickerLoad === load) this.pickerLoad = null; }).catch(() => {});
    }
    return this.pickerLoad;
  }

  /**
   * Start loading the vendor catalogs without waiting for them, unless they
   * are held or loading already: an API planner whose model's window is not
   * known yet reads it from them on a later call, never waiting on the fetch.
   */
  warmPickerOptions(): void {
    if (this.cachedPickerOptions || this.pickerLoad) return;
    this.pickerOptions().catch(() => {});
  }

  private async loadPickerOptions(): Promise<OrchestratorOption[]> {
    // Which endpoints to probe is one policy shared with every other surface —
    // see collectProviderCredentials (only key-configured providers, plus an
    // explicitly-pointed openai_compatible endpoint).
    const { apiKeys, baseUrls } = collectProviderCredentials(this.config);

    const { models, errors } = await fetchAllProviderModels({
      apiKeys,
      baseUrls,
      fetchImpl: this.fetchImpl,
    });
    this.lastDiscoveryErrors = errors;
    this.cachedPickerOptions = toOrchestratorOptions(models, ORCHESTRATOR_SHORTCUTS);
    return this.cachedPickerOptions;
  }

  /**
   * Per-provider failures from the most recent `pickerOptions()` fetch, keyed
   * by provider id. Empty when every configured provider's catalog loaded (or
   * before the first fetch). Surfaces consume this to flag a provider whose
   * key/endpoint is set but whose catalog could not be reached.
   */
  getDiscoveryErrors(): Record<string, string> {
    return this.lastDiscoveryErrors;
  }

  async refresh(): Promise<ProviderModelLists> {
    const options = await this.pickerOptions();
    const lists: ProviderModelLists = {};
    for (const provider of PROVIDER_PRIORITY) {
      lists[provider] = options.filter((o) => o.apiProvider === provider).map((o) => o.id);
    }
    this.config.setProviderModelLists(lists);
    return lists;
  }

  refreshRunnerModels(): void {
    this.discovery.clear();
  }

  /**
   * Synchronous reads of whatever the last `modelsForRunners`/`pickerOptions`
   * call already cached — never trigger discovery or a fetch. For callers
   * (e.g. a settings write) that need a catalog without going async.
   */
  getCachedRunnerModels(runner: string): DiscoveredModel[] {
    return this.discovery.getCached(runner) ?? [];
  }

  getCachedPickerOptions(): OrchestratorOption[] {
    return this.cachedPickerOptions ?? [];
  }

  /**
   * A model's context window from whatever catalog is already cached (#49),
   * for a usage record whose reporter stated none: a vendor's model from the
   * picker catalog (its own `/models` endpoint), a runner's model from that
   * runner's own discovered listing. `source` is the record's reporter, and
   * `model` the id it named. Reads only — never triggers a fetch or discovery
   * of its own, so an unknown window stays unknown and context fill is
   * omitted rather than guessed.
   */
  contextWindowFor(source: string, model: string): number | undefined {
    if (!model) return undefined;
    const window = isApiProvider(source)
      ? this.cachedPickerOptions?.find((o) => o.apiProvider === source && o.id === prefixModelId(source, stripModelPrefix(model, source)))?.contextWindow
      : this.discovery.getCached(source)?.find((m) => m.modelId === model)?.contextWindow;
    return window && window > 0 ? window : undefined;
  }

  /**
   * The longest reply a vendor's model is served with, from the picker
   * catalog already held, when that catalog states one. Reads only, like
   * {@link contextWindowFor}.
   */
  maxOutputTokensFor(source: string, model: string): number | undefined {
    if (!model || !isApiProvider(source)) return undefined;
    const cap = this.cachedPickerOptions?.find((o) => o.apiProvider === source && o.id === prefixModelId(source, stripModelPrefix(model, source)))?.maxOutputTokens;
    return cap && cap > 0 ? cap : undefined;
  }

  invalidate(): void {
    this.discovery.clear();
    this.cachedPickerOptions = null;
    this.pickerLoad = null;
    this.lastDiscoveryErrors = {};
    if (!this.fetchImpl) {
      for (const provider of PROVIDER_PRIORITY) {
        const baseUrl = this.config.getProviderBaseUrl(provider);
        if (baseUrl) ModelCatalog.clearCache(baseUrl);
      }
      clearGeminiCache(this.config.geminiKey);
    }
  }
}
