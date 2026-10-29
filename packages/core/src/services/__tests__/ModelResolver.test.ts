import { describe, it, expect, vi } from 'vitest';
import { ModelResolver } from '../ModelResolver';
import type { ExecImpl } from '../ModelDiscovery';
import type { RunnerRegistry } from '../../plugins/RunnerRegistry';
import type { RunnerManifest } from '../../plugins/types';
import type { IConfig } from '../../interfaces/IConfig';
import { resolveProvider, type ProviderModelLists } from '../ProviderRouting';
import { getProviderMeta } from '../ProviderRegistry';
import { OPENCODE_MANIFEST } from '../../plugins/builtin/opencode.manifest';

function configWith(over: Partial<IConfig> = {}): IConfig {
  const base = {
    // OpenRouter now needs a key like every preset, so the picker tests below
    // supply one by default to exercise catalog fetching.
    openrouterKey: 'sk-or',
    geminiKey: '',
    openAiBaseUrl: 'https://openrouter.ai/api/v1',
    openaiCompatibleBaseUrl: '',
    openaiCompatibleApiKey: '',
    ...over,
  };
  return {
    ...base,
    getProviderBaseUrl: (p: unknown) => p === 'openrouter' ? base.openAiBaseUrl : '',
    getProviderApiKey: (p: unknown) => {
      if (p === 'google') return base.geminiKey;
      if (p === 'openrouter') return base.openrouterKey;
      return '';
    },
  } as IConfig;
}

/** Routes injected-fetch calls by URL substring; unmatched URLs 404. */
function fakeFetch(routes: Array<[string, unknown]>): typeof fetch {
  return (async (input: Parameters<typeof fetch>[0]) => {
    const url = String(input);
    for (const [match, body] of routes) {
      if (url.includes(match)) return new Response(JSON.stringify(body), { status: 200 });
    }
    return new Response('not found', { status: 404 });
  }) as typeof fetch;
}

function manifest(name: string, over: Partial<RunnerManifest['modelDiscovery']> = {}): RunnerManifest {
  return {
    name,
    displayName: name,
    runner: { command: name, args: [] },
    modelDiscovery: {
      method: 'command',
      discoveryCommands: [{ command: name, args: ['models'], parser: 'line-by-line' }],
      fallbackModels: [{ modelId: `${name}/fallback`, modelLabel: 'Fallback' }],
      ...over,
    },
  } as unknown as RunnerManifest;
}

function fakeRegistry(manifests: Record<string, RunnerManifest>): RunnerRegistry {
  return {
    getManifest: (id: string) => manifests[id],
  } as unknown as RunnerRegistry;
}

const config = {} as IConfig;

describe('ModelResolver.modelsForRunners', () => {
  it('discovers models per runner via the manifest command + parser', async () => {
    const exec: ExecImpl = vi.fn().mockResolvedValue({ stdout: 'foo/one One\nfoo/two Two\n' });
    const resolver = new ModelResolver(fakeRegistry({ foo: manifest('foo') }), config, { execImpl: exec });

    const result = await resolver.modelsForRunners(['foo']);

    expect(result.foo?.map((m) => m.modelId)).toEqual(['foo/one', 'foo/two']);
  });

  it('falls back to manifest fallbackModels when discovery yields nothing', async () => {
    const exec: ExecImpl = vi.fn().mockResolvedValue({ stdout: '   \n' });
    const resolver = new ModelResolver(fakeRegistry({ foo: manifest('foo') }), config, { execImpl: exec });

    const result = await resolver.modelsForRunners(['foo']);

    expect(result.foo?.map((m) => m.modelId)).toEqual(['foo/fallback']);
  });

  it('caches discovery per runner within a resolver instance', async () => {
    const exec = vi.fn().mockResolvedValue({ stdout: 'foo/one One\n' });
    const resolver = new ModelResolver(fakeRegistry({ foo: manifest('foo') }), config, { execImpl: exec as ExecImpl });

    await resolver.modelsForRunners(['foo']);
    await resolver.modelsForRunners(['foo']);

    expect(exec).toHaveBeenCalledTimes(1);
  });

  it('refreshRunnerModels clears the runner cache so the next discovery re-runs', async () => {
    const exec = vi.fn().mockResolvedValue({ stdout: 'foo/one One\n' });
    const resolver = new ModelResolver(fakeRegistry({ foo: manifest('foo') }), config, { execImpl: exec as ExecImpl });

    await resolver.modelsForRunners(['foo']);
    resolver.refreshRunnerModels();
    await resolver.modelsForRunners(['foo']);

    expect(exec).toHaveBeenCalledTimes(2);
  });

  it('discovers runners concurrently so one cold backend does not gate the others', async () => {
    let started = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const exec: ExecImpl = vi.fn(async () => {
      started++;
      if (started === 2) release();
      await gate;
      return { stdout: 'x/one One\n' };
    });
    const resolver = new ModelResolver(fakeRegistry({ foo: manifest('foo'), bar: manifest('bar') }), config, { execImpl: exec });

    // Sequential discovery would await `foo` before spawning `bar`, and the gate
    // would never open — so reaching the assertion proves both ran at once.
    const result = await resolver.modelsForRunners(['foo', 'bar']);

    expect(exec).toHaveBeenCalledTimes(2);
    expect(Object.keys(result).sort()).toEqual(['bar', 'foo']);
  });
});

describe('ModelResolver.pickerOptions', () => {
  it('returns only fetched catalog models, shortcut-matched ones first with curated labels', async () => {
    const fetchImpl = fakeFetch([
      ['/models', { data: [
        { id: 'vendor/new-model', name: 'New Model' },
        { id: 'deepseek/deepseek-v4-flash', name: 'DeepSeek dup' }, // matches a shortcut
      ] }],
    ]);
    const resolver = new ModelResolver(fakeRegistry({}), configWith(), { fetchImpl });

    const opts = await resolver.pickerOptions();
    const ids = opts.map((o) => o.id);

    // Only what the catalog actually offers — no injected shortcut entries.
    expect(ids).toEqual(['deepseek/deepseek-v4-flash', 'vendor/new-model']);
    // The matched shortcut supplies the curated label.
    expect(opts[0].label).toBe('DeepSeek V4 Flash');
  });

  it('converts OpenRouter per-token pricing to per-MTok', async () => {
    const fetchImpl = fakeFetch([
      ['/models', { data: [
        { id: 'vendor/priced', name: 'Priced', pricing: { prompt: '0.00000089', completion: '0.00000089' } },
      ] }],
    ]);
    const resolver = new ModelResolver(fakeRegistry({}), configWith(), { fetchImpl });

    const opts = await resolver.pickerOptions();

    expect(opts.find((o) => o.id === 'vendor/priced')?.pricing).toBe('0.89/0.89');
  });

  it('tags apiProvider: google for native Gemini ids, openrouter for catalog ids', async () => {
    const fetchImpl = fakeFetch([
      ['/v1beta/models', { models: [
        { name: 'models/gemini-2.5-pro', displayName: 'Gemini 2.5 Pro', supportedGenerationMethods: ['generateContent'] },
      ] }],
      ['/models', { data: [{ id: 'vendor/catalog', name: 'Catalog' }] }],
    ]);
    const resolver = new ModelResolver(
      fakeRegistry({}),
      configWith({ geminiKey: 'gem-key' }),
      { fetchImpl },
    );

    const opts = await resolver.pickerOptions();

    expect(opts.find((o) => o.id === 'gemini:gemini-2.5-pro')?.apiProvider).toBe('google');
    expect(opts.find((o) => o.id === 'vendor/catalog')?.apiProvider).toBe('openrouter');
  });

  it('caches the catalog so repeated reads do not re-fetch', async () => {
    const fetchImpl = vi.fn(fakeFetch([['/models', { data: [] }]]));
    const resolver = new ModelResolver(fakeRegistry({}), configWith(), { fetchImpl: fetchImpl as unknown as typeof fetch });

    await resolver.pickerOptions();
    await resolver.pickerOptions();

    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('shares the vendor catalog with a view for another runner environment', async () => {
    const fetchImpl = vi.fn(fakeFetch([['/models', { data: [{ id: 'vendor/catalog', name: 'Catalog' }] }]]));
    const resolver = new ModelResolver(fakeRegistry({}), configWith(), { fetchImpl: fetchImpl as unknown as typeof fetch });
    const view = resolver.withRunnerEnv('elsewhere', async () => ({ CLAUDE_CONFIG_DIR: '/elsewhere' }));

    await resolver.pickerOptions();
    expect(view.getCachedPickerOptions().map((o) => o.id)).toContain('vendor/catalog');
    await view.pickerOptions();
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    view.invalidate();
    expect(resolver.getCachedPickerOptions()).toEqual([]);
  });

  it('records a per-provider fetch failure in getDiscoveryErrors', async () => {
    // OpenRouter catalog 500s; Gemini succeeds. The picker still yields the
    // Gemini option, and the OpenRouter failure is flagged for the surfaces.
    const fetchImpl = (async (input: Parameters<typeof fetch>[0]) => {
      const url = String(input);
      if (url.includes('/v1beta/models')) {
        return new Response(JSON.stringify({ models: [
          { name: 'models/gemini-2.5-pro', displayName: 'Gemini 2.5 Pro', supportedGenerationMethods: ['generateContent'] },
        ] }), { status: 200 });
      }
      return new Response('boom', { status: 500, statusText: 'Internal Server Error' });
    }) as typeof fetch;
    const resolver = new ModelResolver(fakeRegistry({}), configWith({ geminiKey: 'gem-key' }), { fetchImpl });

    const opts = await resolver.pickerOptions();

    expect(opts.some((o) => o.id === 'gemini:gemini-2.5-pro')).toBe(true);
    expect(resolver.getDiscoveryErrors().openrouter).toMatch(/500|Internal Server Error/);
    expect(resolver.getDiscoveryErrors().google).toBeUndefined();
  });

  // --- discovery fan-out gating (regression) ---
  // The resolver must never probe preset provider endpoints that the user has
  // not configured. With registry-default base URLs (as real BaseConfig
  // supplies), only keyed presets (OpenRouter included) and an explicitly
  // pointed openai_compatible endpoint may be fetched.

  /** Mirrors BaseConfig: registry-default base URLs + keys from an override map. */
  function registryConfig(keys: Record<string, string> = {}, openaiCompatibleBaseUrl = ''): IConfig {
    return {
      openrouterKey: keys.openrouter ?? '',
      geminiKey: keys.google ?? '',
      openaiCompatibleBaseUrl,
      openaiCompatibleApiKey: '',
      getProviderApiKey: (p: string) => keys[p] ?? '',
      getProviderBaseUrl: (p: string) => {
        const meta = getProviderMeta(p as never);
        if (!meta) return '';
        if (p === 'openai_compatible' && openaiCompatibleBaseUrl) return openaiCompatibleBaseUrl;
        return meta.defaultBaseUrl;
      },
    } as unknown as IConfig;
  }

  function fetchedHosts(fetchImpl: ReturnType<typeof vi.fn>): string[] {
    return fetchImpl.mock.calls.map((c) => new URL(String(c[0])).host);
  }

  it('probes nothing when no provider is configured (OpenRouter now needs a key too)', async () => {
    const fetchImpl = vi.fn(fakeFetch([['/models', { data: [] }]]));
    const resolver = new ModelResolver(fakeRegistry({}), registryConfig(), { fetchImpl: fetchImpl as unknown as typeof fetch });

    await resolver.pickerOptions();

    // No key anywhere → no catalog fetch at all, including OpenRouter.
    expect(fetchedHosts(fetchImpl)).toEqual([]);
  });

  it('discovers keyed presets but still skips unconfigured ones', async () => {
    const fetchImpl = vi.fn(fakeFetch([['/models', { data: [] }]]));
    const resolver = new ModelResolver(fakeRegistry({}), registryConfig({ openrouter: 'sk-or', openai: 'sk-openai' }), { fetchImpl: fetchImpl as unknown as typeof fetch });

    await resolver.pickerOptions();

    const hosts = fetchedHosts(fetchImpl);
    expect(hosts).toContain('openrouter.ai');
    expect(hosts).toContain('api.openai.com');
    expect(hosts).not.toContain('api.mistral.ai');
    expect(hosts).not.toContain('api.x.ai');
  });

  it('discovers openai_compatible only when an explicit endpoint is set', async () => {
    const fetchImpl = vi.fn(fakeFetch([['/models', { data: [] }]]));
    const resolver = new ModelResolver(
      fakeRegistry({}),
      registryConfig({}, 'http://localhost:11434/v1'),
      { fetchImpl: fetchImpl as unknown as typeof fetch },
    );

    await resolver.pickerOptions();

    expect(fetchedHosts(fetchImpl)).toContain('localhost:11434');
  });
});

/** Config that records the lists the resolver pushes in via setProviderModelLists. */
function capturingConfig(over: Partial<IConfig> = {}): IConfig & { pushed: ProviderModelLists | null } {
  const base = {
    openrouterKey: 'sk-or',
    geminiKey: '',
    openAiBaseUrl: 'https://openrouter.ai/api/v1',
    ...over,
  };
  const cfg = {
    ...base,
    getProviderBaseUrl: (p: unknown) => p === 'openrouter' ? base.openAiBaseUrl : '',
    getProviderApiKey: (p: unknown) => {
      if (p === 'google') return base.geminiKey;
      if (p === 'openrouter') return base.openrouterKey;
      return '';
    },
    pushed: null as ProviderModelLists | null,
    setProviderModelLists(lists: ProviderModelLists) { cfg.pushed = lists; },
  };
  return cfg as unknown as IConfig & { pushed: ProviderModelLists | null };
}

describe('ModelResolver.contextWindowFor', () => {
  it('reads a Gemini model\'s window from the inputTokenLimit Gemini\'s own models endpoint reports', async () => {
    const fetchImpl = fakeFetch([
      ['/v1beta/models', { models: [
        { name: 'models/gemini-2.5-pro', displayName: 'Gemini 2.5 Pro', supportedGenerationMethods: ['generateContent'], inputTokenLimit: 1048576, outputTokenLimit: 65536 },
      ] }],
    ]);
    const resolver = new ModelResolver(fakeRegistry({}), configWith({ geminiKey: 'gem-key', openrouterKey: '' }), { fetchImpl });
    await resolver.pickerOptions();

    // A Gemini usage record names the bare model, as the API was called with it.
    expect(resolver.contextWindowFor('google', 'gemini-2.5-pro')).toBe(1048576);
  });

  it('reads a vendor model\'s window from the context_length its /models endpoint reports, and no other', async () => {
    const fetchImpl = fakeFetch([['/models', { data: [
      { id: 'anthropic/claude-sonnet', name: 'Claude Sonnet', context_length: 200000 },
      { id: 'vendor/unsized', name: 'Unsized' },
    ] }]]);
    const resolver = new ModelResolver(fakeRegistry({}), configWith(), { fetchImpl });
    expect(resolver.contextWindowFor('openrouter', 'anthropic/claude-sonnet')).toBeUndefined();

    await resolver.pickerOptions();

    expect(resolver.contextWindowFor('openrouter', 'anthropic/claude-sonnet')).toBe(200000);
    expect(resolver.contextWindowFor('openrouter', 'vendor/unsized')).toBeUndefined();
    expect(resolver.contextWindowFor('openrouter', 'vendor/unlisted')).toBeUndefined();
  });

  it('reads a runner model\'s window from that runner\'s own listing, once it was discovered', async () => {
    const exec: ExecImpl = vi.fn(async (cmd: string) => {
      if (cmd.includes('api model.list')) {
        return { stdout: JSON.stringify({ data: [{ modelID: 'big-pickle', providerID: 'opencode', enabled: true, limit: { context: 400000, output: 32000 } }] }) };
      }
      throw Object.assign(new Error('Unrecognized flag'), { code: 1 });
    });
    const resolver = new ModelResolver(fakeRegistry({ opencode: OPENCODE_MANIFEST }), configWith({ openrouterKey: '' }), { execImpl: exec });
    expect(resolver.contextWindowFor('opencode', 'opencode/big-pickle')).toBeUndefined();

    await resolver.modelsForRunners(['opencode']);

    expect(resolver.contextWindowFor('opencode', 'opencode/big-pickle')).toBe(400000);
    expect(resolver.contextWindowFor('claude-code', 'opencode/big-pickle')).toBeUndefined();
  });

});

describe('ModelResolver.builtinOptions', () => {
  it('is empty before any catalog fetch — shortcuts never surface models that were not fetched', () => {
    expect(ModelResolver.builtinOptions()).toEqual([]);
  });
});

describe('ModelResolver.invalidate', () => {
  it('clears runner-discovery and the catalog/Gemini cache so the next read re-runs', async () => {
    const exec = vi.fn().mockResolvedValue({ stdout: 'foo/one One\n' });
    const fetchImpl = vi.fn(fakeFetch([['/models', { data: [] }]]));
    const resolver = new ModelResolver(
      fakeRegistry({ foo: manifest('foo') }),
      configWith(),
      { execImpl: exec as ExecImpl, fetchImpl: fetchImpl as unknown as typeof fetch },
    );

    await resolver.modelsForRunners(['foo']);
    await resolver.pickerOptions();
    resolver.invalidate();
    await resolver.modelsForRunners(['foo']);
    await resolver.pickerOptions();

    expect(exec).toHaveBeenCalledTimes(2);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
});

describe('ModelResolver.refresh', () => {
  it('mints native Gemini ids with the gemini: qualifier and pushes the lists into config', async () => {
    const fetchImpl = fakeFetch([
      ['/v1beta/models', { models: [
        { name: 'models/gemini-2.5-pro', displayName: 'Gemini 2.5 Pro', supportedGenerationMethods: ['generateContent'] },
      ] }],
      ['/models', { data: [{ id: 'google/gemini-2.5-pro', name: 'Gemini via OpenRouter' }] }],
    ]);
    const config = capturingConfig({ geminiKey: 'gem-key' });
    const resolver = new ModelResolver(fakeRegistry({}), config, { fetchImpl });

    const lists = await resolver.refresh();

    expect(lists.google).toContain('gemini:gemini-2.5-pro');
    expect(lists.openrouter).toContain('google/gemini-2.5-pro');
    expect(config.pushed).toEqual(lists);
  });

  it('produces lists where a stored gemini:<id> routes to google and google/<id> to openrouter', async () => {
    const fetchImpl = fakeFetch([
      ['/v1beta/models', { models: [
        { name: 'models/gemini-2.5-pro', displayName: 'Gemini 2.5 Pro', supportedGenerationMethods: ['generateContent'] },
      ] }],
      ['/models', { data: [{ id: 'google/gemini-2.5-pro', name: 'Gemini via OpenRouter' }] }],
    ]);
    const config = capturingConfig({ geminiKey: 'gem-key' });
    const resolver = new ModelResolver(fakeRegistry({}), config, { fetchImpl });

    const lists = await resolver.refresh();

    expect(resolveProvider('gemini:gemini-2.5-pro', lists)).toBe('google');
    expect(resolveProvider('google/gemini-2.5-pro', lists)).toBe('openrouter');
  });
});

describe('ModelResolver.maxOutputTokensFor', () => {
  it('keeps the reply cap OpenRouter states for a model\'s serving provider, and none it did not state', async () => {
    const fetchImpl = fakeFetch([['/models', { data: [
      { id: 'vendor/capped', name: 'Capped', context_length: 131072, top_provider: { max_completion_tokens: 8192 } },
      { id: 'vendor/uncapped', name: 'Uncapped', context_length: 131072, top_provider: { max_completion_tokens: null } },
    ] }]]);
    const resolver = new ModelResolver(fakeRegistry({}), configWith(), { fetchImpl });
    await resolver.pickerOptions();

    expect(resolver.maxOutputTokensFor('openrouter', 'vendor/capped')).toBe(8192);
    expect(resolver.maxOutputTokensFor('openrouter', 'vendor/uncapped')).toBeUndefined();
    expect(resolver.maxOutputTokensFor('openrouter', 'vendor/unlisted')).toBeUndefined();
  });

  it('keeps the outputTokenLimit Gemini\'s own models endpoint states, and none it did not state', async () => {
    const fetchImpl = fakeFetch([
      ['/v1beta/models', { models: [
        { name: 'models/gemini-2.5-pro', displayName: 'Gemini 2.5 Pro', supportedGenerationMethods: ['generateContent'], inputTokenLimit: 1048576, outputTokenLimit: 65536 },
        { name: 'models/gemini-unsized', displayName: 'Unsized', supportedGenerationMethods: ['generateContent'] },
      ] }],
    ]);
    const resolver = new ModelResolver(fakeRegistry({}), configWith({ geminiKey: 'gem-key', openrouterKey: '' }), { fetchImpl });
    await resolver.pickerOptions();

    expect(resolver.maxOutputTokensFor('google', 'gemini-2.5-pro')).toBe(65536);
    expect(resolver.maxOutputTokensFor('google', 'gemini-unsized')).toBeUndefined();
    expect(resolver.contextWindowFor('google', 'gemini-unsized')).toBeUndefined();
  });
});

describe('ModelResolver.warmPickerOptions', () => {
  function countingFetch(): { fetchImpl: typeof fetch; calls: () => number } {
    let calls = 0;
    const inner = fakeFetch([['/models', { data: [{ id: 'vendor/model', name: 'Model', context_length: 64000 }] }]]);
    return { fetchImpl: ((...args: Parameters<typeof fetch>) => { calls++; return inner(...args); }) as typeof fetch, calls: () => calls };
  }

  it('loads the catalogs in the background once, sharing a load already under way, and never again once held', async () => {
    const { fetchImpl, calls } = countingFetch();
    const resolver = new ModelResolver(fakeRegistry({}), configWith(), { fetchImpl });

    resolver.warmPickerOptions();
    resolver.warmPickerOptions();
    const asked = resolver.pickerOptions();
    expect(resolver.contextWindowFor('openrouter', 'vendor/model')).toBeUndefined();
    await asked;

    expect(calls()).toBe(1);
    expect(resolver.contextWindowFor('openrouter', 'vendor/model')).toBe(64000);
    resolver.warmPickerOptions();
    expect(calls()).toBe(1);
  });

  it('raises nothing from a load that failed in the background', async () => {
    const fetchImpl = (async () => { throw new Error('offline'); }) as typeof fetch;
    const resolver = new ModelResolver(fakeRegistry({}), configWith(), { fetchImpl });

    resolver.warmPickerOptions();
    await new Promise((r) => setTimeout(r, 0));

    expect(resolver.contextWindowFor('openrouter', 'vendor/model')).toBeUndefined();
  });
});


describe('ModelResolver — one catalog family across runner environments', () => {
  /** An exec that lists `<runner>/<account>`, the account being the env's CLAUDE_CONFIG_DIR, and counts each listing per account. */
  function accountExec() {
    const listed: string[] = [];
    const exec: ExecImpl = vi.fn(async (command: string, options?: { env?: Record<string, string | undefined> }) => {
      const account = options?.env?.CLAUDE_CONFIG_DIR ?? 'daemon';
      listed.push(account);
      return { stdout: `${command.split(' ')[0]}/${account} Model\n` };
    });
    return { exec, listed };
  }

  function gatedFetch(stale: string, fresh: string) {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let calls = 0;
    const fetchImpl = (async (input: Parameters<typeof fetch>[0]) => {
      if (!String(input).includes('/models')) return new Response('not found', { status: 404 });
      const id = calls++ === 0 ? stale : fresh;
      if (id === stale) await gate;
      return new Response(JSON.stringify({ data: [{ id, name: id }] }), { status: 200 });
    }) as typeof fetch;
    return { fetchImpl, release };
  }

  it('keeps one view per key, each with a runner catalog of its own', async () => {
    const { exec, listed } = accountExec();
    const resolver = new ModelResolver(fakeRegistry({ foo: manifest('foo') }), config, { execImpl: exec });
    const b = resolver.withRunnerEnv('b', async () => ({ CLAUDE_CONFIG_DIR: 'b' }));

    expect(resolver.withRunnerEnv('b', async () => ({ CLAUDE_CONFIG_DIR: 'elsewhere' }))).toBe(b);
    expect(resolver.withRunnerEnv('c', async () => ({ CLAUDE_CONFIG_DIR: 'c' }))).not.toBe(b);
    expect((await resolver.modelsForRunners(['foo'])).foo?.map((m) => m.modelId)).toEqual(['foo/daemon']);
    expect((await b.modelsForRunners(['foo'])).foo?.map((m) => m.modelId)).toEqual(['foo/b']);
    await b.modelsForRunners(['foo']);
    expect(listed).toEqual(['daemon', 'b']);
  });

  it('reaches every runner environment from one invalidate or runner refresh, made on any of them', async () => {
    const { exec, listed } = accountExec();
    const resolver = new ModelResolver(fakeRegistry({ foo: manifest('foo') }), configWith(), { execImpl: exec, fetchImpl: fakeFetch([]) });
    const b = resolver.withRunnerEnv('b', async () => ({ CLAUDE_CONFIG_DIR: 'b' }));
    const both = () => Promise.all([resolver.modelsForRunners(['foo']), b.modelsForRunners(['foo'])]);

    await both();
    resolver.invalidate();
    await both();
    b.refreshRunnerModels();
    await both();

    expect(listed.filter((account) => account === 'daemon')).toHaveLength(3);
    expect(listed.filter((account) => account === 'b')).toHaveLength(3);
  });

  it('leaves the vendor cache to the load after invalidate() when one begun before it ends last', async () => {
    const { fetchImpl, release } = gatedFetch('vendor/stale', 'vendor/fresh');
    const resolver = new ModelResolver(fakeRegistry({}), configWith(), { fetchImpl });

    const before = resolver.pickerOptions();
    resolver.invalidate();
    const after = await resolver.pickerOptions();
    release();

    expect((await before).map((o) => o.id)).toEqual(['vendor/stale']);
    expect(after.map((o) => o.id)).toEqual(['vendor/fresh']);
    expect(resolver.getCachedPickerOptions().map((o) => o.id)).toEqual(['vendor/fresh']);
    expect((await resolver.pickerOptions()).map((o) => o.id)).toEqual(['vendor/fresh']);
  });

  it('leaves a view\'s runner cache to the discovery after invalidate() when one begun before it ends last', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let call = 0;
    const exec: ExecImpl = vi.fn(async () => {
      if (call++ === 0) { await gate; return { stdout: 'foo/stale Stale\n' }; }
      return { stdout: 'foo/fresh Fresh\n' };
    });
    const resolver = new ModelResolver(fakeRegistry({ foo: manifest('foo') }), configWith(), { execImpl: exec, fetchImpl: fakeFetch([]) });
    const view = resolver.withRunnerEnv('b', async () => ({}));

    const before = view.modelsForRunners(['foo']);
    resolver.invalidate();
    await view.modelsForRunners(['foo']);
    release();
    await before;

    expect(view.getCachedRunnerModels('foo').map((m) => m.modelId)).toEqual(['foo/fresh']);
  });
});

describe('ModelResolver.plannerCatalog', () => {
  it('judges a harness planner by its own runner catalog, variants included, discovering it if not held', async () => {
    const exec: ExecImpl = vi.fn().mockResolvedValue({ stdout: 'claude-a Claude A\n' });
    const variants = [{ id: 'high', label: 'High' }];
    const resolver = new ModelResolver(fakeRegistry({ 'claude-code': manifest('claude-code', { variants }) }), config, { execImpl: exec });

    expect(resolver.cachedPlannerCatalog('claude-code')).toEqual([]);
    expect(await resolver.plannerCatalog('claude-code')).toEqual([{ id: 'claude-a', variants }]);
    expect(resolver.cachedPlannerCatalog('claude-code')).toEqual([{ id: 'claude-a', variants }]);
    await resolver.plannerCatalog('claude-code');
    expect(exec).toHaveBeenCalledTimes(1);
  });

  it('judges a vendor planner by the picker catalog, which every runner environment shares', async () => {
    const fetchImpl = vi.fn(fakeFetch([['/models', { data: [{ id: 'vendor/catalog', name: 'Catalog' }] }]]));
    const resolver = new ModelResolver(fakeRegistry({}), configWith(), { fetchImpl: fetchImpl as unknown as typeof fetch });
    const view = resolver.withRunnerEnv('b', async () => ({}));

    expect(resolver.cachedPlannerCatalog('openrouter')).toEqual([]);
    expect(await resolver.plannerCatalog('openrouter')).toEqual([{ id: 'vendor/catalog' }]);
    expect(view.cachedPlannerCatalog('openrouter')).toEqual([{ id: 'vendor/catalog' }]);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('answers an empty catalog, never a throw, when nothing can be discovered', async () => {
    const exec: ExecImpl = vi.fn().mockRejectedValue(new Error('not installed'));
    const fetchImpl = (async () => { throw new Error('offline'); }) as typeof fetch;
    const resolver = new ModelResolver(fakeRegistry({ codex: manifest('codex', { fallbackModels: [] }) }), configWith(), { execImpl: exec, fetchImpl });

    expect(await resolver.plannerCatalog('codex')).toEqual([]);
    expect(await resolver.plannerCatalog('openrouter')).toEqual([]);
  });
});
