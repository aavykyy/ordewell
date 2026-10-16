import { type PlannerBackendId, BaseConfig, DEFAULT_RUNNERS, isApiProvider, isCliProvider, normalizeGeminiModel, recordedInstalledPlanner, resolveProvider } from '@ordewell/core';
import type { ProviderModelLists } from '@ordewell/core';

interface WebConfigOpts {
  enabledRunners?: string[];
  providerModelLists?: ProviderModelLists;
  modelOverride?: string;
}

export class WebConfig extends BaseConfig {
  private _provider: PlannerBackendId | null = null;
  private _providerCacheKey: string | null = null;
  private _providerCacheLists: ProviderModelLists | undefined = undefined;
  private _enabledRunnersOverride: string[] | undefined;
  private _providerModelLists: ProviderModelLists | undefined;
  private _modelOverride: string | undefined;

  constructor(opts?: WebConfigOpts) {
    super();
    this._enabledRunnersOverride = opts?.enabledRunners;
    this._providerModelLists = opts?.providerModelLists;
    this._modelOverride = opts?.modelOverride;
  }

  setProviderModelLists(lists: ProviderModelLists): void {
    this._providerModelLists = lists;
    this._provider = null;
  }

  get orchestratorModel(): string {
    return this._modelOverride || process.env.ORCHESTRATOR_MODEL || '';
  }

  get aiProvider(): PlannerBackendId {
    // Memoized by cache key rather than forever: a session's WebConfig lives
    // for the whole session, but /model and /planner switches mutate process.env
    // mid-session, so a permanent cache would strand the transport on the old
    // provider (mirrors the live-read behavior of `orchestratorModel` above).
    // The installed agent is in the key too: the daemon's startup probe can
    // answer after a config has already settled on the openrouter fallback.
    const explicitEnv = process.env.AI_PROVIDER;
    const model = this._modelOverride || process.env.ORCHESTRATOR_MODEL;
    const cacheKey = `${explicitEnv ?? ''}|${model ?? ''}|${recordedInstalledPlanner() ?? ''}`;
    if (
      this._provider &&
      this._providerCacheKey === cacheKey &&
      this._providerCacheLists === this._providerModelLists
    ) {
      return this._provider;
    }

    // An explicitly chosen harness planner (ADR-0009) wins over model-based
    // resolution: its model ids are the agent's own (`sonnet`, `gpt-5.6-sol`)
    // and can collide with a vendor catalog, which would silently route the
    // planner back to an API the user may not even have a key for.
    if (explicitEnv && isCliProvider(explicitEnv)) {
      this._provider = explicitEnv;
      this._providerCacheKey = cacheKey;
      this._providerCacheLists = this._providerModelLists;
      return this._provider;
    }

    if (model && this._providerModelLists) {
      const resolved = resolveProvider(model, this._providerModelLists);
      if (resolved) {
        this._provider = resolved;
        this._providerCacheKey = cacheKey;
        this._providerCacheLists = this._providerModelLists;
        return this._provider;
      }
    }

    this._provider = this.detectProvider();
    this._providerCacheKey = cacheKey;
    this._providerCacheLists = this._providerModelLists;
    return this._provider;
  }

  get apiKey(): string {
    const provider = this.aiProvider;
    return isApiProvider(provider) ? this.getProviderApiKey(provider) : '';
  }

  get planningModel(): string {
    if (this.aiProvider === 'google')
      return normalizeGeminiModel(process.env.GEMINI_MODEL || process.env.ORCHESTRATOR_MODEL || super.geminiModel);
    return process.env.ORCHESTRATOR_MODEL || '';
  }

  get enabledRunners(): string[] {
    if (this._enabledRunnersOverride) return this._enabledRunnersOverride;

    const envRunners = process.env.ORDEWELL_ENABLED_RUNNERS;
    if (envRunners) {
      const parsed = envRunners.split(',').map((s) => s.trim()).filter(Boolean);
      if (parsed.length > 0) return parsed;
    }

    // The per-runner toggles that predate ORDEWELL_ENABLED_RUNNERS: three fixed
    // variables, named by runner id on purpose; a newer runner is enabled
    // through the list above.
    const out: string[] = [];
    if (process.env.ORDEWELL_CLAUDE_CODE_ENABLED !== 'false' && process.env.ORDEWELL_CLAUDE_CODE_ENABLED !== '0') {
      out.push('claude-code');
    }
    if (process.env.ORDEWELL_CODEX_ENABLED === 'true' || process.env.ORDEWELL_CODEX_ENABLED === '1') {
      out.push('codex');
    }
    if (process.env.ORDEWELL_OPENCODE_ENABLED === 'true' || process.env.ORDEWELL_OPENCODE_ENABLED === '1') {
      out.push('opencode');
    }
    return out.length > 0 ? out : [...DEFAULT_RUNNERS];
  }

}
