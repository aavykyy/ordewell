import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ModelResolver } from '../ModelResolver';
import { RunnerRegistry } from '../../plugins/RunnerRegistry';
import type { ExecImpl } from '../ModelDiscovery';
import { expandRunnerHome, runnerHomeDir } from '../../utils/runnerHome';
import type { IConfig } from '../../interfaces/IConfig';
import { createTask, type DiscoveredModel } from '../../models/Task';
import { SessionCatalog } from '../SessionCatalog';
import { resolveAssignment } from '../TaskAssignment';
import { claudeManagedSettingsDir, readClaudeSettingsModels } from '../../plugins/builtin/claudeModels';
import type { RunnerEnv } from '../../plugins/types';

// Gateway models a user registers in Claude Code's own picker
// (`modelPicker.options` in ~/.claude/settings.json) join every discovery
// path. Each test runs under a fresh HOME, with no CLAUDE_CONFIG_DIR and the
// machine's managed settings hidden, so no real settings or credentials are
// read.
vi.mock('fs', async (importOriginal) =>
  (await import('./claudeManagedSettings')).hidingClaudeManagedSettings(await importOriginal<typeof import('fs')>()));

const CLAUDE_HELP = "  --model <model>   Model for the session (e.g. 'sonnet', 'opus')\n";
const STATIC_VARIANTS = ['adaptive', 'low', 'medium', 'high', 'xhigh', 'max'];

type Source = 'api' | 'help' | 'fallback';

let home: string;
const saved: Record<string, string | undefined> = {};
const ENV = ['HOME', 'USERPROFILE', 'ANTHROPIC_API_KEY', 'CLAUDE_CONFIG_DIR'];

beforeEach(() => {
  for (const key of ENV) saved[key] = process.env[key];
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'ordewell-claude-settings-'));
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.CLAUDE_CONFIG_DIR;
  fs.mkdirSync(path.join(home, '.claude'));
});

afterEach(() => {
  for (const key of ENV) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
  fs.rmSync(home, { recursive: true, force: true });
});

function writeSettings(content: unknown, dir = path.join(home, '.claude')): void {
  const text = typeof content === 'string' ? content : JSON.stringify(content);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'settings.json'), text);
}

function resolverFor(source: Source, env?: () => Promise<RunnerEnv>) {
  if (source === 'api') process.env.ANTHROPIC_API_KEY = 'synthetic-test-key';
  const calls = { exec: 0, fetch: 0 };
  const execImpl: ExecImpl = async () => {
    calls.exec++;
    if (source === 'fallback') throw new Error('claude: not found');
    return { stdout: CLAUDE_HELP };
  };
  const fetchImpl = (async () => {
    calls.fetch++;
    return {
      ok: true,
      json: async () => ({ data: [{
        id: 'claude-sonnet-5', display_name: 'Claude Sonnet 5',
        capabilities: { effort: { supported: true, high: { supported: true } } },
      }] }),
    };
  }) as unknown as typeof fetch;
  const resolver = new ModelResolver(new RunnerRegistry(), {} as IConfig, { execImpl, fetchImpl, ...(env ? { env } : {}) });
  return { resolver, calls };
}

async function claudeModels(resolver: ModelResolver): Promise<DiscoveredModel[]> {
  return (await resolver.modelsForRunners(['claude-code']))['claude-code'] ?? [];
}

const SOURCES: Source[] = ['api', 'help', 'fallback'];

// The Claude catalog each source yields with no settings file, as the
// manifest and the fixtures above define it.
const BASELINE: Record<Source, string[]> = {
  api: ['sonnet', 'opus', 'haiku', 'fable'],
  help: ['sonnet', 'opus', 'haiku', 'fable'],
  fallback: ['opus', 'sonnet', 'haiku', 'fable'],
};

const GATEWAY_SETTINGS = {
  modelPicker: {
    options: [
      { model: 'gproxy/default', label: 'Gateway default' },
      { model: 'gproxy/default', label: 'A later duplicate' },
      { model: 'gproxy/unlabelled' },
      { model: 'sonnet', label: 'Settings Sonnet' },
      null, false, 'gproxy/bare-string', {}, { model: 17 }, { model: '  ' },
    ],
  },
};

describe('Claude Code discovery — modelPicker.options in settings.json', () => {
  describe.each(SOURCES)('%s', (source) => {
    it('appends the settings models after the discovered catalog', async () => {
      writeSettings(GATEWAY_SETTINGS);
      const { resolver } = resolverFor(source);

      const models = await claudeModels(resolver);

      expect(models.map((m) => m.modelId)).toEqual([...BASELINE[source], 'gproxy/default', 'gproxy/unlabelled']);
      expect(models.find((m) => m.modelId === 'gproxy/default')).toEqual({
        modelId: 'gproxy/default',
        modelLabel: 'Gateway default',
        runnerProvider: 'gproxy',
        runnerId: 'claude-code',
        runnerLabel: 'Claude Code',
        variants: STATIC_VARIANTS.map((id) => expect.objectContaining({ id })),
      });
      expect(models.find((m) => m.modelId === 'gproxy/unlabelled')?.modelLabel).toBe('gproxy/unlabelled');
    });

    it('keeps the discovered entry for an ID the settings repeat', async () => {
      writeSettings(GATEWAY_SETTINGS);
      const { resolver, calls } = resolverFor(source);

      const sonnet = (await claudeModels(resolver)).filter((m) => m.modelId === 'sonnet');

      expect(sonnet).toHaveLength(1);
      expect(sonnet[0].modelLabel).toBe(source === 'api' ? 'Claude Sonnet 5' : 'Sonnet');
      expect(sonnet[0].variants.map((v) => v.id)).toEqual(source === 'api' ? ['high'] : STATIC_VARIANTS);
      expect(calls).toEqual(source === 'api' ? { exec: 0, fetch: 1 } : { exec: 1, fetch: 0 });
    });

    it.each([
      ['no settings file', undefined],
      ['malformed JSON', '{"modelPicker":'],
      ['a non-object root', 'null'],
      ['no modelPicker', '{"theme":"dark"}'],
      ['a null modelPicker', '{"modelPicker":null}'],
      ['options that are not a list', '{"modelPicker":{"options":{"model":"gproxy/default"}}}'],
      ['only invalid rows', '{"modelPicker":{"options":[null,"gproxy/x",{},{"model":1},{"model":""}]}}'],
    ])('leaves the catalog as it was with %s', async (_name, content) => {
      if (content !== undefined) writeSettings(content);
      const { resolver } = resolverFor(source);

      expect((await claudeModels(resolver)).map((m) => m.modelId)).toEqual(BASELINE[source]);
    });
  });

  it('trims the padding around a row\'s model and label', async () => {
    writeSettings({ modelPicker: { options: [{ model: ' gproxy/default ', label: '  Gateway  ' }, { model: 'gproxy/default' }] } });
    const { resolver } = resolverFor('help');

    const added = (await claudeModels(resolver)).filter((m) => m.modelId.includes('gproxy'));

    expect(added).toEqual([expect.objectContaining({ modelId: 'gproxy/default', modelLabel: 'Gateway', runnerProvider: 'gproxy' })]);
  });

  it('reads the settings CLAUDE_CONFIG_DIR moves, not the ones in ~/.claude', async () => {
    const moved = path.join(home, 'work-account');
    writeSettings({ modelPicker: { options: [{ model: 'gproxy/work' }] } }, moved);
    writeSettings({ modelPicker: { options: [{ model: 'gproxy/personal' }] } });
    process.env.CLAUDE_CONFIG_DIR = moved;
    const { resolver } = resolverFor('help');

    expect((await claudeModels(resolver)).map((m) => m.modelId)).toEqual([...BASELINE.help, 'gproxy/work']);
  });

  it('reads the config dir of the environment runners are launched with, over this process\'s', async () => {
    const workspace = path.join(home, 'workspace-account');
    writeSettings({ modelPicker: { options: [{ model: 'gproxy/workspace' }] } }, workspace);
    writeSettings({ modelPicker: { options: [{ model: 'gproxy/daemon' }] } });
    const { resolver } = resolverFor('help', async () => ({ ...process.env, CLAUDE_CONFIG_DIR: workspace }));

    expect((await claudeModels(resolver)).map((m) => m.modelId)).toEqual([...BASELINE.help, 'gproxy/workspace']);
  });

  it('keeps a catalog per runner environment, so one workspace\'s account never serves another\'s', async () => {
    const workspace = path.join(home, 'workspace-account');
    writeSettings({ modelPicker: { options: [{ model: 'gproxy/workspace' }] } }, workspace);
    writeSettings({ modelPicker: { options: [{ model: 'gproxy/daemon' }] } });
    const { resolver, calls } = resolverFor('help');
    const view = resolver.withRunnerEnv(workspace, async () => ({ ...process.env, CLAUDE_CONFIG_DIR: workspace }));

    expect((await claudeModels(resolver)).map((m) => m.modelId)).toEqual([...BASELINE.help, 'gproxy/daemon']);
    expect((await claudeModels(view)).map((m) => m.modelId)).toEqual([...BASELINE.help, 'gproxy/workspace']);
    expect(view.getCachedRunnerModels('claude-code').map((m) => m.modelId)).toContain('gproxy/workspace');
    expect(resolver.getCachedRunnerModels('claude-code').map((m) => m.modelId)).not.toContain('gproxy/workspace');
    expect(calls.exec).toBe(2);
  });

  // A workspace's `.ordewell/env` may set HOME (USERPROFILE on Windows), and
  // the runner's `claude` finds `~/.claude` under that home, not the daemon's.
  it('reads ~/.claude under the home of the environment runners are launched with', async () => {
    const runnerHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ordewell-claude-runner-home-'));
    try {
      writeSettings({ modelPicker: { options: [{ model: 'gproxy/runner-home' }] } }, path.join(runnerHome, '.claude'));
      writeSettings({ modelPicker: { options: [{ model: 'gproxy/daemon-home' }] } });
      const { resolver } = resolverFor('help', async () => ({ ...process.env, HOME: runnerHome, USERPROFILE: runnerHome }));

      expect((await claudeModels(resolver)).map((m) => m.modelId)).toEqual([...BASELINE.help, 'gproxy/runner-home']);
    } finally {
      fs.rmSync(runnerHome, { recursive: true, force: true });
    }
  });

  // Node's os.homedir() returns an empty HOME as it is, so that runner has no
  // ~/.claude to read; the daemon's account is not its stand-in.
  it('reads nothing under ~ when the environment runners are launched with sets an empty home', async () => {
    writeSettings({ modelPicker: { options: [{ model: 'gproxy/daemon-home' }] } });
    const { resolver } = resolverFor('help', async () => ({ ...process.env, HOME: '', USERPROFILE: '' }));

    expect((await claudeModels(resolver)).map((m) => m.modelId)).toEqual(BASELINE.help);
  });

  it('signs the catalog request in with the login under the runner environment\'s home', async () => {
    const runnerHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ordewell-claude-runner-home-'));
    try {
      for (const [dir, token] of [[runnerHome, 'runner-home-token'], [home, 'daemon-home-token']]) {
        fs.mkdirSync(path.join(dir, '.claude'), { recursive: true });
        fs.writeFileSync(path.join(dir, '.claude', '.credentials.json'), JSON.stringify({ claudeAiOauth: { accessToken: token } }));
      }
      const seen: Array<Record<string, string>> = [];
      const fetchImpl = (async (_url: string, init: { headers: Record<string, string> }) => {
        seen.push(init.headers);
        return { ok: true, json: async () => ({ data: [{ id: 'claude-sonnet-5', display_name: 'Claude Sonnet 5' }] }) };
      }) as unknown as typeof fetch;
      const signed = new ModelResolver(new RunnerRegistry(), {} as IConfig, {
        execImpl: async () => ({ stdout: CLAUDE_HELP }),
        fetchImpl,
        env: async () => ({ ...process.env, HOME: runnerHome, USERPROFILE: runnerHome }),
      });

      expect((await claudeModels(signed)).map((m) => m.modelId)).toEqual(BASELINE.api);
      expect(seen.map((h) => h.Authorization)).toEqual(['Bearer runner-home-token']);
    } finally {
      fs.rmSync(runnerHome, { recursive: true, force: true });
    }
  });

  it('signs the catalog request in with the login CLAUDE_CONFIG_DIR moves', async () => {
    const moved = path.join(home, 'work-account');
    fs.mkdirSync(moved);
    fs.writeFileSync(path.join(moved, '.credentials.json'), JSON.stringify({ claudeAiOauth: { accessToken: 'moved-token' } }));
    process.env.CLAUDE_CONFIG_DIR = moved;
    const seen: Array<Record<string, string>> = [];
    const fetchImpl = (async (_url: string, init: { headers: Record<string, string> }) => {
      seen.push(init.headers);
      return { ok: true, json: async () => ({ data: [{ id: 'claude-sonnet-5', display_name: 'Claude Sonnet 5' }] }) };
    }) as unknown as typeof fetch;
    const signed = new ModelResolver(new RunnerRegistry(), {} as IConfig, { execImpl: async () => ({ stdout: CLAUDE_HELP }), fetchImpl });

    expect((await claudeModels(signed)).map((m) => m.modelId)).toEqual(BASELINE.api);
    expect(seen.map((h) => h.Authorization)).toEqual(['Bearer moved-token']);
  });

  it('serves a cached catalog until a refresh, which reads an edited settings file', async () => {
    writeSettings({ modelPicker: { options: [{ model: 'gproxy/default' }] } });
    const { resolver, calls } = resolverFor('help');
    await claudeModels(resolver);

    writeSettings({ modelPicker: { options: [{ model: 'gproxy/default' }, { model: 'gproxy/large' }] } });
    expect((await claudeModels(resolver)).map((m) => m.modelId)).not.toContain('gproxy/large');
    expect(calls.exec).toBe(1);

    resolver.refreshRunnerModels();
    expect((await claudeModels(resolver)).map((m) => m.modelId)).toContain('gproxy/large');
  });

  it('a gateway model can be assigned by the planner and by the user', async () => {
    writeSettings(GATEWAY_SETTINGS);
    const { resolver } = resolverFor('fallback');
    const catalog = new SessionCatalog({
      config: { enabledRunners: ['claude-code'], autonomousMode: true, aiProvider: 'claude-code' },
      registry: new RunnerRegistry(),
      modelResolver: resolver,
      settings: () => ({ enabledRunners: ['claude-code'] }),
      planRunners: () => ['claude-code'],
    });

    const planning = await catalog.planning(['claude-code']);
    expect(planning.filteredModels['claude-code']?.map((m) => m.modelId)).toContain('gproxy/default');

    const before = createTask({
      id: 't1', title: 'Gateway task', assignedRunner: 'claude-code',
      assignedModel: { modelId: 'opus', modelLabel: 'Opus' },
    });
    const task = { ...before, assignedModel: { modelId: 'gproxy/default', modelLabel: 'Gateway default' } };
    for (const writer of ['user', 'plan'] as const) {
      const outcome = resolveAssignment({ writer, before, task, catalog: catalog.edit() });
      expect(outcome.ok && outcome.task.assignedModel?.modelId).toBe('gproxy/default');
    }
  });
});

describe('Claude Code\'s modelPicker precedence', () => {
  /** Settings files by path, with the user's under `~/.claude`. */
  function filesOf(byPath: Record<string, unknown>, env: RunnerEnv = {}) {
    const text = (v: unknown) => (typeof v === 'string' ? v : JSON.stringify(v));
    return {
      read: (file: string) => (file in byPath ? text(byPath[file]) : null),
      list: (dir: string) => Object.keys(byPath).filter((f) => path.posix.dirname(f) === dir).map((f) => path.posix.basename(f)),
      env,
    };
  }
  const managed = claudeManagedSettingsDir('linux');
  const picker = (...models: string[]) => ({ modelPicker: { options: models.map((model) => ({ model })) } });
  const ids = (files: ReturnType<typeof filesOf>) => readClaudeSettingsModels(files, 'linux').map((m) => m.modelId);

  it('takes the whole lineup from managed settings over the user\'s, never combining them', () => {
    expect(ids(filesOf({
      [`${managed}/managed-settings.json`]: picker('corp/approved'),
      '~/.claude/settings.json': picker('gproxy/mine'),
    }))).toEqual(['corp/approved']);
  });

  it('lets a later drop-in replace an earlier managed lineup', () => {
    expect(ids(filesOf({
      [`${managed}/managed-settings.json`]: picker('corp/base'),
      [`${managed}/managed-settings.d/10-models.json`]: picker('corp/ten'),
      [`${managed}/managed-settings.d/20-models.json`]: picker('corp/twenty'),
      [`${managed}/managed-settings.d/30-other.json`]: { theme: 'dark' },
      [`${managed}/managed-settings.d/.40-hidden.json`]: picker('corp/hidden'),
      [`${managed}/managed-settings.d/50-notes.txt`]: picker('corp/text'),
    }))).toEqual(['corp/twenty']);
  });

  it('falls to the user\'s lineup when no managed file sets one, reading it where CLAUDE_CONFIG_DIR moves it', () => {
    expect(ids(filesOf({
      [`${managed}/managed-settings.json`]: { permissions: { deny: [] } },
      '~/.claude/settings.json': picker('gproxy/home'),
      '/accounts/work/settings.json': picker('gproxy/work'),
    }, { CLAUDE_CONFIG_DIR: '/accounts/work' }))).toEqual(['gproxy/work']);
  });

  it('offers nothing of the user\'s when a managed lineup is set but has no usable row', () => {
    expect(ids(filesOf({
      [`${managed}/managed-settings.json`]: { modelPicker: { options: [] } },
      '~/.claude/settings.json': picker('gproxy/mine'),
    }))).toEqual([]);
  });
});

describe('the home a runner resolves ~ against', () => {
  // As Node's os.homedir() reads it inside the runner: HOME on POSIX,
  // USERPROFILE on Windows, whose variable names ignore case.
  it.each([
    ['linux', { HOME: '/home/work', USERPROFILE: 'C:\\Users\\other' }, '/home/work'],
    ['darwin', { HOME: '/Users/work' }, '/Users/work'],
    ['win32', { HOME: '/home/other', USERPROFILE: 'C:\\Users\\work' }, 'C:\\Users\\work'],
    ['win32', { USERPROFILE: 'C:\\Users\\daemon', UserProfile: 'C:\\Users\\work' }, 'C:\\Users\\work'],
  ] as const)('on %s, from %j', (platform, env, expected) => {
    expect(runnerHomeDir(env, platform)).toBe(expected);
  });

  it.each(['linux', 'win32'] as const)('on %s, falls back to this process\'s home only when the environment names none', (platform) => {
    expect(runnerHomeDir({}, platform)).toBe(os.homedir());
    expect(runnerHomeDir({ HOME: '', USERPROFILE: '' }, platform)).toBe('');
  });

  it('expands no ~ for a runner whose home is empty', () => {
    expect(expandRunnerHome('~/.claude/settings.json', { HOME: '', USERPROFILE: '' })).toBeNull();
    expect(expandRunnerHome('/etc/claude-code/managed-settings.json', { HOME: '', USERPROFILE: '' })).toBe('/etc/claude-code/managed-settings.json');
  });
});
