import { describe, it, expect, vi } from 'vitest';
import { window, commands, __quickPicks, __resetQuickPicks } from '../../test/vscode.mock';
import { handleSlashCommand, isKnownSlashCommand, type SlashDeps } from '../SlashParser';
import { RUN_SETTINGS_DEFAULTS, type DiscoveredModel, type GlobalRunSettings } from '@ordewell/core';

function harnessModel(modelId: string, variantIds: string[] = []): DiscoveredModel {
  return { modelId, modelLabel: modelId, variants: variantIds.map((id) => ({ id, label: id })) };
}

/** Every SlashDeps field the parser can reach, defaulted to a no-op so each test only overrides what it exercises. */
function makeDeps(overrides: Partial<SlashDeps> = {}): SlashDeps {
  return {
    config: {
      orchestratorModel: '', planningModel: '', enabledRunners: [], autonomousMode: true, apiKey: '',
      openAiBaseUrl: '', configuredProviders: [], aiProvider: 'claude-code', plannerThinkingEffort: '',
    },
    modelResolver: {
      pickerOptions: async () => [],
      refresh: async () => undefined,
      invalidate: () => {},
      refreshRunnerModels: () => {},
      modelsForRunners: async () => ({}),
    },
    plannerBackends: async () => [],
    refreshPlannerState: async () => {},
    runnerRegistry: { list: () => [], get: () => undefined, getManifest: () => undefined },
    chatProvider: {} as SlashDeps['chatProvider'],
    settingsService: { getModelAllowlist: () => undefined, setModelAllowlist: () => {} },
    sendRunnerAndModels: async () => {},
    runApiKeyWizard: async () => {},
    discoverOrchestratorModelOptions: async () => [],
    pickModelWithProvider: async () => undefined,
    updateConfig: async () => {},
    recordPlannerModel: () => {},
    recallPlannerModel: () => ({ model: '', effort: '', source: 'none' }),
    applyPlannerChoice: async () => {},
    runSettings: { get: () => ({ ...RUN_SETTINGS_DEFAULTS }), change: () => {} },
    maxParallel: () => 5,
    saveAutonomy: () => {},
    log: () => {},
    ...overrides,
  };
}

describe('/model set records the pick against the current provider', () => {
  it('records a harness planner model chosen by exact id', async () => {
    const recordPlannerModel = vi.fn();
    const deps = makeDeps({
      config: { orchestratorModel: '', planningModel: '', enabledRunners: [], autonomousMode: true, apiKey: '', openAiBaseUrl: '', configuredProviders: [], aiProvider: 'claude-code', plannerThinkingEffort: '' },
      modelResolver: {
        pickerOptions: async () => [],
        refresh: async () => undefined,
        invalidate: () => {},
        refreshRunnerModels: () => {},
        modelsForRunners: async () => ({ 'claude-code': [harnessModel('claude-sonnet-4-5', ['low', 'high'])] }),
      },
      recordPlannerModel,
    });

    await handleSlashCommand('/model set claude-sonnet-4-5', deps);

    expect(recordPlannerModel).toHaveBeenCalledWith('claude-sonnet-4-5', undefined);
  });

  it('drops a stale effort and records the model without it', async () => {
    const recordPlannerModel = vi.fn();
    const deps = makeDeps({
      config: { orchestratorModel: '', planningModel: '', enabledRunners: [], autonomousMode: true, apiKey: '', openAiBaseUrl: '', configuredProviders: [], aiProvider: 'claude-code', plannerThinkingEffort: 'xhigh' },
      modelResolver: {
        pickerOptions: async () => [],
        refresh: async () => undefined,
        invalidate: () => {},
        refreshRunnerModels: () => {},
        modelsForRunners: async () => ({ 'claude-code': [harnessModel('claude-haiku-4-5', ['low'])] }),
      },
      recordPlannerModel,
    });

    await handleSlashCommand('/model set claude-haiku-4-5', deps);

    expect(recordPlannerModel).toHaveBeenCalledWith('claude-haiku-4-5', undefined);
  });

  it('records a vendor model chosen by a known shortcut', async () => {
    const recordPlannerModel = vi.fn();
    const deps = makeDeps({
      config: { orchestratorModel: '', planningModel: '', enabledRunners: [], autonomousMode: true, apiKey: '', openAiBaseUrl: '', configuredProviders: [], aiProvider: 'openrouter', plannerThinkingEffort: '' },
      discoverOrchestratorModelOptions: async () => [{ id: 'z-ai/glm-4.6', label: 'GLM 4.6', provider: 'openrouter' }],
      recordPlannerModel,
    });

    await handleSlashCommand('/model set z-ai/glm-4.6', deps);

    expect(recordPlannerModel).toHaveBeenCalledWith('z-ai/glm-4.6');
  });

  it('records a vendor model picked from the quick pick when no shortcut matches', async () => {
    const recordPlannerModel = vi.fn();
    window.showQuickPick = vi.fn() as never;
    const deps = makeDeps({
      config: { orchestratorModel: '', planningModel: '', enabledRunners: [], autonomousMode: true, apiKey: '', openAiBaseUrl: '', configuredProviders: [], aiProvider: 'openrouter', plannerThinkingEffort: '' },
      discoverOrchestratorModelOptions: async () => [{ id: 'z-ai/glm-4.6', label: 'GLM 4.6', provider: 'openrouter' }],
      pickModelWithProvider: async () => 'z-ai/glm-4.6',
      recordPlannerModel,
    });

    await handleSlashCommand('/model set nonsense', deps);

    expect(recordPlannerModel).toHaveBeenCalledWith('z-ai/glm-4.6');
  });
});

describe('/model set with a vendor model while a coding agent plans', () => {
  const vendorDeps = (over: Partial<SlashDeps> = {}) => makeDeps({
    modelResolver: {
      pickerOptions: async () => [], refresh: async () => undefined, invalidate: () => {}, refreshRunnerModels: () => {},
      modelsForRunners: async () => ({ 'claude-code': [harnessModel('opus')] }),
    },
    discoverOrchestratorModelOptions: async () => [{ id: 'deepseek/deepseek-v4-flash', label: 'DeepSeek V4 Flash', provider: 'deepseek', apiProvider: 'openrouter' }],
    ...over,
  });

  it('switches the planner to the vendor and sets the model once confirmed', async () => {
    const recordPlannerModel = vi.fn();
    const updateConfig = vi.fn(async () => {});
    window.showQuickPick = vi.fn() as never;
    window.showInformationMessage = vi.fn(async () => 'Switch planner') as never;
    (commands.executeCommand as unknown as ReturnType<typeof vi.fn>).mockClear();

    await handleSlashCommand('/model set deepseek/deepseek-v4-flash', vendorDeps({ recordPlannerModel, updateConfig }));

    expect(commands.executeCommand).toHaveBeenCalledWith('ordewell.setPlanner', 'openrouter');
    expect(updateConfig).toHaveBeenCalledWith('orchestratorModel', 'deepseek/deepseek-v4-flash');
    expect(recordPlannerModel).toHaveBeenCalledWith('deepseek/deepseek-v4-flash');
    expect(window.showQuickPick).not.toHaveBeenCalled();
  });

  it('leaves the planner and its model alone when the switch is declined', async () => {
    const updateConfig = vi.fn(async () => {});
    window.showQuickPick = vi.fn() as never;
    window.showInformationMessage = vi.fn(async () => undefined) as never;
    (commands.executeCommand as unknown as ReturnType<typeof vi.fn>).mockClear();

    await handleSlashCommand('/model set deepseek/deepseek-v4-flash', vendorDeps({ updateConfig }));

    expect(commands.executeCommand).not.toHaveBeenCalled();
    expect(updateConfig).not.toHaveBeenCalled();
    expect(window.showQuickPick).not.toHaveBeenCalled();
  });
});

describe('/planner', () => {
  const backend = { id: 'claude-code', label: 'Claude Code', kind: 'harness' as const, runner: 'claude-code', usable: true };

  it('with no argument walks the stepped picker and applies the choice once', async () => {
    __resetQuickPicks();
    const applyPlannerChoice = vi.fn(async () => {});
    const deps = makeDeps({
      plannerBackends: async () => [backend],
      modelResolver: { ...makeDeps().modelResolver, modelsForRunners: async () => ({ 'claude-code': [harnessModel('claude-opus-5-5', ['high'])] }) },
      applyPlannerChoice,
    });

    const done = handleSlashCommand('/planner', deps);
    for (const index of [0, 0, 1]) {
      await new Promise((resolve) => setImmediate(resolve));
      __quickPicks[0].__accept(index);
    }
    await done;

    expect(applyPlannerChoice).toHaveBeenCalledOnce();
    expect(applyPlannerChoice).toHaveBeenCalledWith('claude-code', 'claude-opus-5-5', 'high');
  });

  it('with a backend id switches straight to it, without opening the picker', async () => {
    __resetQuickPicks();
    const executeCommand = commands.executeCommand as unknown as ReturnType<typeof vi.fn>;
    executeCommand.mockClear();

    await handleSlashCommand('/planner claude-code', makeDeps({ plannerBackends: async () => [backend] }));

    expect(executeCommand).toHaveBeenCalledWith('ordewell.setPlanner', 'claude-code');
    expect(__quickPicks).toHaveLength(0);
  });
});

describe('/planner-effort records the effort against the current model', () => {
  it('records the model with the newly chosen effort by exact id', async () => {
    const recordPlannerModel = vi.fn();
    const deps = makeDeps({
      config: { orchestratorModel: 'claude-sonnet-4-5', planningModel: '', enabledRunners: [], autonomousMode: true, apiKey: '', openAiBaseUrl: '', configuredProviders: [], aiProvider: 'claude-code', plannerThinkingEffort: '' },
      modelResolver: {
        pickerOptions: async () => [],
        refresh: async () => undefined,
        invalidate: () => {},
        refreshRunnerModels: () => {},
        modelsForRunners: async () => ({ 'claude-code': [harnessModel('claude-sonnet-4-5', ['low', 'high'])] }),
      },
      recordPlannerModel,
    });

    await handleSlashCommand('/planner-effort high', deps);

    expect(recordPlannerModel).toHaveBeenCalledWith('claude-sonnet-4-5', 'high');
  });
});

describe('isKnownSlashCommand', () => {
  it('recognizes every extension slash command regardless of case', () => {
    expect(isKnownSlashCommand('/model set foo')).toBe(true);
    expect(isKnownSlashCommand('/PLANNER')).toBe(true);
    expect(isKnownSlashCommand('/refresh')).toBe(true);
  });

  it('recognizes the conversation-editing commands', () => {
    expect(isKnownSlashCommand('/fork')).toBe(true);
    expect(isKnownSlashCommand('/rewind')).toBe(true);
    expect(isKnownSlashCommand('/rewind 3')).toBe(true);
    expect(isKnownSlashCommand('/COMPACT')).toBe(true);
  });

  it('rejects a discovered-skill invocation so it falls through to the message path', () => {
    expect(isKnownSlashCommand('/grilling')).toBe(false);
    expect(isKnownSlashCommand('/to-spec')).toBe(false);
  });
});

describe('conversation-editing slash commands', () => {
  const executeCommand = commands.executeCommand as unknown as ReturnType<typeof vi.fn>;

  it('/fork runs the fork command', async () => {
    executeCommand.mockClear();
    await handleSlashCommand('/fork', makeDeps());
    expect(executeCommand).toHaveBeenCalledWith('ordewell.forkConversation');
  });

  it('/rewind with no argument leaves the choice to the picker', async () => {
    executeCommand.mockClear();
    await handleSlashCommand('/rewind', makeDeps());
    expect(executeCommand).toHaveBeenCalledWith('ordewell.rewindConversation', undefined);
  });

  it('/rewind <n> hands the message number on', async () => {
    executeCommand.mockClear();
    await handleSlashCommand('/rewind 3', makeDeps());
    expect(executeCommand).toHaveBeenCalledWith('ordewell.rewindConversation', '3');
  });

  it('/parallel hands its number, or nothing for the input box, to the Set Parallel Tasks command', async () => {
    expect(isKnownSlashCommand('/parallel 8')).toBe(true);
    executeCommand.mockClear();
    await handleSlashCommand('/parallel 8', makeDeps());
    await handleSlashCommand('/parallel', makeDeps());
    expect(executeCommand.mock.calls).toEqual([['ordewell.setMaxParallel', '8'], ['ordewell.setMaxParallel', undefined]]);
  });

  describe('/auto', () => {
    const mocked = (name: 'showInformationMessage' | 'showWarningMessage' | 'showQuickPick') =>
      window[name] as unknown as ReturnType<typeof vi.fn>;

    it.each([
      ['full', true, 'Full'],
      ['guarded', false, 'Guarded'],
      ['auto', false, 'Guarded'],
      ['on', true, 'Full'],
      ['off', false, 'Guarded'],
    ])('/auto %s stores %s and names the level %s', async (arg, stored, label) => {
      const saveAutonomy = vi.fn();
      mocked('showInformationMessage').mockClear();
      await handleSlashCommand(`/auto ${arg}`, makeDeps({ saveAutonomy }));
      expect(saveAutonomy).toHaveBeenCalledWith(stored);
      expect(mocked('showInformationMessage').mock.calls[0][0]).toContain(`Autonomy level: ${label}.`);
    });

    it('a bare /auto offers the two levels by name, picking the current one', async () => {
      const saveAutonomy = vi.fn();
      mocked('showQuickPick').mockReset().mockResolvedValue(undefined);
      await handleSlashCommand('/auto', makeDeps({ saveAutonomy }));
      const items = mocked('showQuickPick').mock.calls[0][0] as { label: string; picked: boolean }[];
      expect(items.map((i) => i.label)).toEqual(['Full (recommended)', 'Guarded']);
      expect(items.map((i) => i.picked)).toEqual([true, false]);
      expect(saveAutonomy).not.toHaveBeenCalled();
    });

    it('an unknown level warns with the usage and changes nothing', async () => {
      const saveAutonomy = vi.fn();
      mocked('showWarningMessage').mockClear();
      await handleSlashCommand('/auto maybe', makeDeps({ saveAutonomy }));
      expect(mocked('showWarningMessage').mock.calls[0][0]).toBe('Usage: /auto [full|guarded]');
      expect(saveAutonomy).not.toHaveBeenCalled();
    });
  });

  describe('run settings (ADR-0030)', () => {
    const mocked = (name: 'showInformationMessage' | 'showWarningMessage') =>
      window[name] as unknown as ReturnType<typeof vi.fn>;
    const settingsWith = (run: Partial<GlobalRunSettings> = {}) => {
      const change = vi.fn();
      return { change, deps: makeDeps({ runSettings: { get: () => ({ ...RUN_SETTINGS_DEFAULTS, ...run }), change } }) };
    };

    it.each([
      ['/supervisor watch', { supervisorLevel: 'watch' }],
      ['/supervisor off', { supervisorLevel: 'off' }],
      ['/supervisor retries 3', { supervisorRetryLimit: 3 }],
      ['/supervisor reads 20', { wakeUpReadBudget: 20 }],
      ['/automerge on', { mergeAtGatesAutomatically: true }],
      ['/autorun off', { autorun: false }],
    ])('%s saves and applies %j', async (line, changes) => {
      const { change, deps } = settingsWith();
      await handleSlashCommand(line, deps);
      expect(change).toHaveBeenCalledWith(changes);
    });

    it.each([
      ['/supervisor act', { supervisorLevel: 'act' }, /ops tasks included/],
      ['/autorun on', { autorun: true }, /without review, ops tasks included/],
    ])('%s asks first, and changes nothing when declined', async (line, changes, risk) => {
      const { change, deps } = settingsWith();
      mocked('showWarningMessage').mockReset().mockResolvedValue(undefined);
      await handleSlashCommand(line, deps);
      expect(change).not.toHaveBeenCalled();
      expect(JSON.stringify(mocked('showWarningMessage').mock.calls[0])).toMatch(risk);

      const confirm = String(mocked('showWarningMessage').mock.calls[0].at(-1));
      mocked('showWarningMessage').mockReset().mockResolvedValue(confirm);
      await handleSlashCommand(line, deps);
      expect(change).toHaveBeenCalledWith(changes);
    });

    it.each(['/supervisor boss', '/supervisor reads 0', '/supervisor retries many', '/automerge maybe', '/autorun yes'])('%s warns with the usage and changes nothing', async (line) => {
      const { change, deps } = settingsWith();
      mocked('showWarningMessage').mockReset();
      await handleSlashCommand(line, deps);
      expect(String(mocked('showWarningMessage').mock.calls[0][0])).toMatch(/^Usage: \//);
      expect(change).not.toHaveBeenCalled();
    });

    it('a bare command says what the setting is', async () => {
      const { deps } = settingsWith({ supervisorLevel: 'act', mergeAtGatesAutomatically: true });
      mocked('showInformationMessage').mockClear();
      await handleSlashCommand('/supervisor', deps);
      await handleSlashCommand('/automerge', deps);
      await handleSlashCommand('/autorun', deps);
      const said = mocked('showInformationMessage').mock.calls.map((c) => String(c[0]));
      expect(said[0]).toContain('Supervisor: Act, 2 retries per task, 12 reads per wake-up');
      expect(said[1]).toContain('Merge automatically (gates, end of run): on');
      expect(said[2]).toContain('Autorun: off');
    });

    it('are known commands', () => {
      for (const name of ['/supervisor act', '/automerge', '/autorun on']) expect(isKnownSlashCommand(name)).toBe(true);
    });
  });

  it('/compact runs the compact command', async () => {
    executeCommand.mockClear();
    await handleSlashCommand('/compact', makeDeps());
    expect(executeCommand).toHaveBeenCalledWith('ordewell.compactConversation');
  });

  it('/help lists them', async () => {
    const info = window.showInformationMessage as unknown as ReturnType<typeof vi.fn>;
    info.mockClear();
    await handleSlashCommand('/help', makeDeps());
    const text = info.mock.calls[0][0] as string;
    expect(text).toContain('/fork');
    expect(text).toContain('/rewind');
    expect(text).toContain('/compact');
  });

  it('/help lists every command it answers', async () => {
    const info = window.showInformationMessage as unknown as ReturnType<typeof vi.fn>;
    info.mockClear();
    await handleSlashCommand('/help', makeDeps());
    const text = info.mock.calls[0][0] as string;
    for (const command of ['/refresh', '/model', '/planner', '/planner-effort', '/key', '/sessions', '/allowlist', '/help', '/new', '/auto', '/fork', '/rewind', '/compact', '/parallel']) {
      expect(isKnownSlashCommand(command)).toBe(true);
      expect(text).toContain(command);
    }
  });
});
