import { type PlannerBackendId, BaseConfig, DEFAULT_RUNNERS, isApiProvider, normalizeGeminiModel } from '@ordewell/core';
import type { ProviderModelLists, ResolvedPlanner } from '@ordewell/core';

interface WebConfigOpts {
  enabledRunners?: string[];
  /**
   * The lists that route a model id to its vendor. A function is read on every
   * resolution, so a long-lived config (a session's) never routes on lists its
   * owner has since dropped for a removed key.
   */
  providerModelLists?: ProviderModelLists | (() => ProviderModelLists | undefined);
  modelOverride?: string;
}

export class WebConfig extends BaseConfig {
  private _enabledRunnersOverride: string[] | undefined;
  private _providerModelLists: () => ProviderModelLists | undefined;
  private _modelOverride: string | undefined;

  constructor(opts?: WebConfigOpts) {
    super();
    this._enabledRunnersOverride = opts?.enabledRunners;
    const lists = opts?.providerModelLists;
    this._providerModelLists = typeof lists === 'function' ? lists : () => lists;
    this._modelOverride = opts?.modelOverride;
  }

  setProviderModelLists(lists: ProviderModelLists): void {
    this._providerModelLists = () => lists;
  }

  /**
   * Read live, not fixed at construction: a session's WebConfig lives for the
   * whole session while /model, /planner and /key mutate process.env under
   * it. `routedProvider` keeps that cheap.
   */
  private get planner(): ResolvedPlanner {
    return this.resolvePlanner(this._modelOverride || process.env.ORCHESTRATOR_MODEL || '', this._providerModelLists());
  }

  get orchestratorModel(): string {
    return this.planner.model;
  }

  get aiProvider(): PlannerBackendId {
    return this.planner.provider;
  }

  get apiKey(): string {
    const provider = this.aiProvider;
    return isApiProvider(provider) ? this.getProviderApiKey(provider) : '';
  }

  get planningModel(): string {
    if (this.aiProvider === 'google')
      return normalizeGeminiModel(process.env.GEMINI_MODEL || process.env.ORCHESTRATOR_MODEL || super.geminiModel);
    return this.plannerModelFor(this.aiProvider, process.env.ORCHESTRATOR_MODEL || '');
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
