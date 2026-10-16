import { BaseConfig } from './BaseConfig';
import { isApiProvider } from '../services/ProviderRegistry';
import type { PlannerBackendId } from './IConfig';

/**
 * A fully `process.env`-backed IConfig for headless callers (e.g. the CLI's
 * `ordewell models` command) that need provider keys/base URLs but have no
 * editor settings or secret store. All resolution lives in BaseConfig; this
 * subclass only supplies the abstract members from the environment.
 */
export class EnvConfig extends BaseConfig {
  get aiProvider(): PlannerBackendId {
    return this.detectProvider();
  }

  get apiKey(): string {
    const provider = this.aiProvider;
    return (isApiProvider(provider) ? this.getProviderApiKey(provider) : '') || this.openrouterKey || this.geminiKey || '';
  }

  get planningModel(): string {
    return this.orchestratorModel;
  }

  get enabledRunners(): string[] {
    const raw = process.env.ORDEWELL_RUNNERS || process.env.ENABLED_RUNNERS || '';
    return raw.split(',').map((s) => s.trim()).filter(Boolean);
  }

  // The CLI does not persist routing lists; resolution happens per-invocation.
  setProviderModelLists(): void {}
}
