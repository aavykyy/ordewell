import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { RUN_SETTINGS_DEFAULTS,
  createTask, defaultEnabledRunners, RunnerRegistry, recordedInstalledPlanner, resetInstalledPlanner,
  type AiProvider, type DiscoveredModel, type IRunner, type LegacyPlanState, type PlannerUsability,
  type ModelResolver, type PlannerModelMemory, type RunnerInstallation,
  type RunView, type Session, type SessionDeps, type SettingsService,
  PendingApprovals, approvalScopes, type ApprovalRequestMessage,
} from '@ordewell/core';
import { ChatViewProvider as RealChatViewProvider } from '../providers/ChatViewProvider';
import { createExtension, type ExtensionServices } from '../ExtensionHost';
import type { ChatViewProvider } from '../providers/ChatViewProvider';
import type { SecretStore, ApiProvider } from '../adapters/SecretStore';
import type { VsCodeConfig } from '../adapters/VsCodeConfig';
import type { VsCodeFileSystem } from '../adapters/VsCodeFileSystem';
import type { VsCodeNotification } from '../adapters/VsCodeNotification';
import type { WebviewToHost } from '../shared/protocol';
import { __panels, __resetPanels, window } from '../test/vscode.mock';

const models: DiscoveredModel[] = [
  { modelId: 'claude-sonnet-4-5', modelLabel: 'Claude Sonnet 4.5', variants: [], runnerProvider: 'anthropic' },
];

function planWithOneTask(goal: string): LegacyPlanState {
  const at = '2026-01-01T00:00:00Z';
  return {
    tasks: [createTask({ id: 't1', order: 1, title: goal, prompt: goal, assignedRunner: 'claude-code', taskMode: 'default' })],
    generatedAt: at,
    status: 'draft',
    runners: ['claude-code'],
    lastUpdated: at,
  };
}

function fakeChat() {
  const messages = new vscode.EventEmitter<WebviewToHost>();
  const provider = {
    onMessage: messages.event,
    conversation: {
      receive: vi.fn(), note: vi.fn(), holdPrompt: vi.fn(), unsendPrompt: vi.fn(),
      nextPrompt: vi.fn(() => undefined), stop: vi.fn(), reset: vi.fn(), reload: vi.fn(), resync: vi.fn(), waiting: vi.fn(),
    },
    run: { receive: vi.fn(), adopt: vi.fn(), reset: vi.fn(), clearIsolation: vi.fn() },
    resendAllState: vi.fn(),
    restoreChat: vi.fn(),
    replaceConversation: vi.fn(),
    setState: vi.fn(),
    showError: vi.fn(),
    showPlan: vi.fn(),
    adoptRun: vi.fn(),
    planApproved: vi.fn(),
    setPlanDockHeight: vi.fn(),
    setRunSettings: vi.fn(),
    setSkills: vi.fn(),
    setTaskSkills: vi.fn(),
    setModels: vi.fn(),
    setModelsByRunner: vi.fn(),
    setRunnerList: vi.fn(),
    setEnabledRunnerIds: vi.fn(),
    setModesByRunner: vi.fn(),
    sendConfiguredProviders: vi.fn(),
    setModelConfig: vi.fn(),
    setModelOptions: vi.fn(),
    setModelDiscoveryErrors: vi.fn(),
    setPlannerBackends: vi.fn(),
    clearIsolationHandoff: vi.fn(),
    sendTaskOutput: vi.fn(),
    reveal: vi.fn(),
  };
  return { messages, provider };
}

function fakeVscodeApi() {
  const showWarningMessage = vi.fn();
  const api = {
    window: {
      registerWebviewViewProvider: vi.fn(() => ({ dispose: vi.fn() })),
      showWarningMessage,
      showInformationMessage: vi.fn(),
      showErrorMessage: vi.fn(),
      showInputBox: vi.fn(),
      createQuickPick: vi.fn(),
    },
    commands: {
      registerCommand: vi.fn(() => ({ dispose: vi.fn() })),
    },
    workspace: {
      onDidChangeWorkspaceFolders: vi.fn(() => ({ dispose: vi.fn() })),
    },
    QuickInputButtons: { Back: {} },
    ProgressLocation: { Notification: 15 },
  };
  return { api: api as unknown as typeof vscode, showWarningMessage };
}

function fakeConfig() {
  const listeners: Array<() => void> = [];
  const values: Record<string, unknown> = {
    aiProvider: 'openrouter',
    rawAiProvider: '',
    apiKey: 'sk-test',
    planningModel: 'vendor/model',
    orchestratorModel: 'vendor/model',
    rawOrchestratorModel: 'vendor/model',
    plannerThinkingEffort: '',
    enabledRunners: ['claude-code'],
    autonomousMode: true,
    openAiBaseUrl: '',
    openaiCompatibleBaseUrl: '',
    configuredProviders: ['openrouter'] as ApiProvider[],
    maxParallelSessions: 2,
  };
  const config = {
    get aiProvider() { return values.aiProvider as AiProvider; },
    get rawAiProvider() { return values.rawAiProvider as string; },
    get apiKey() { return values.apiKey as string; },
    getProviderApiKey: () => values.apiKey as string,
    get planningModel() { return values.planningModel as string; },
    get orchestratorModel() { return values.orchestratorModel as string; },
    get rawOrchestratorModel() { return values.rawOrchestratorModel as string; },
    get plannerThinkingEffort() { return values.plannerThinkingEffort as string; },
    get enabledRunners() { return values.enabledRunners as string[]; },
    get autonomousMode() { return values.autonomousMode as boolean; },
    get openAiBaseUrl() { return values.openAiBaseUrl as string; },
    get openaiCompatibleBaseUrl() { return values.openaiCompatibleBaseUrl as string; },
    get configuredProviders() { return values.configuredProviders as ApiProvider[]; },
    get maxParallelSessions() { return values.maxParallelSessions as number; },
    update: vi.fn(async (key: string, value: unknown) => { values[key] = value; }),
    onDidChange: vi.fn((listener: () => void) => { listeners.push(listener); return { dispose: vi.fn() }; }),
  };
  return { config: config as unknown as VsCodeConfig, listeners, values };
}

function fakeSession() {
  const spies = {
    sessionId: 's1',
    aiServiceInstance: { reset: vi.fn() },
    reschedule: vi.fn(async () => {}),
    applyRunSettings: vi.fn(),
    isExecuting: false,
    isConversationActive: false,
    isPlannerBusy: false,
    status: 'draft',
    planState: null,
    planTasks: [],
    runSnapshot: vi.fn(() => ({ tasks: [], runMerge: null, handoff: null, mergeResult: null })),
    isolationView: vi.fn(() => null),
    removeQueuedMessage: vi.fn(),
    reset: vi.fn(),
    abortPlannerTurn: vi.fn(() => false),
    loadPlan: vi.fn(),
    execute: vi.fn(async () => ({ ok: true, message: 'done' })),
    executePlan: vi.fn(async () => {}),
    stopExecution: vi.fn(),
    startPlanning: vi.fn(async (goal: string) => planWithOneTask(goal)),
    continueConversation: vi.fn(async () => planWithOneTask('continued')),
    cancelTask: vi.fn(async () => {}),
    retryTask: vi.fn(async () => {}),
    markTaskComplete: vi.fn(async () => {}),
    markTaskIncomplete: vi.fn(async () => {}),
    forceStartTask: vi.fn(async () => {}),
    runTask: vi.fn(async () => {}),
    announcedApprovals: vi.fn((): ApprovalRequestMessage[] => []),
  };
  return { session: spies as unknown as Session, spies };
}

function fakeResolver(modelsByRunner: Partial<Record<string, DiscoveredModel[]>> = { 'claude-code': models }) {
  return {
    refreshRunnerModels: vi.fn(),
    modelsForRunners: vi.fn(async (runners: string[]) => {
      const out: Partial<Record<string, DiscoveredModel[]>> = {};
      for (const r of runners) out[r] = modelsByRunner[r] ?? [];
      return out;
    }),
    pickerOptions: vi.fn(async () => []),
    refresh: vi.fn(async () => {}),
    invalidate: vi.fn(),
    getDiscoveryErrors: vi.fn(() => ({})),
    getCachedRunnerModels: vi.fn((runner: string) => modelsByRunner[runner] ?? []),
    getCachedPickerOptions: vi.fn(() => []),
    contextWindowFor: vi.fn(() => undefined),
  } satisfies Record<keyof ModelResolver, unknown>;
}

function fakeRunnerInstallation(installed: string[]) {
  return {
    filterInstalled: vi.fn(async (runners: string[]) => runners.filter((r) => installed.includes(r))),
    plannerUsability: vi.fn(async (_runner?: string): Promise<PlannerUsability> => ({ usable: true, reason: undefined })),
    // A discovery refresh asks again; the fake keeps no verdicts, so it is a no-op.
    refresh: vi.fn(),
  };
}

function fakeSettings() {
  let run = { ...RUN_SETTINGS_DEFAULTS };
  const watchers: Array<() => void> = [];
  return {
    watchers,
    /** Another surface saved the file. */
    saved: () => { for (const listener of watchers) listener(); },
    watch: vi.fn((listener: () => void) => { watchers.push(listener); return { dispose: vi.fn() }; }),
    getAll: vi.fn(() => ({})),
    getRunSettings: vi.fn(() => ({ ...run })),
    updateRunSettings: vi.fn((changes: Partial<typeof run>) => { run = { ...run, ...changes }; }),
    setAutonomousMode: vi.fn(),
  };
}

function harness(overrides: {
  modelResolver?: ReturnType<typeof fakeResolver>;
  runnerInstallation?: ReturnType<typeof fakeRunnerInstallation>;
  chatProvider?: ChatViewProvider;
} = {}) {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'ordewell-host-'));
  const vscodeApi = fakeVscodeApi();
  const chat = fakeChat();
  const config = fakeConfig();
  const session = fakeSession();
  const settings = fakeSettings();
  const sessionDeps: { current?: SessionDeps } = {};
  const resolver = overrides.modelResolver ?? fakeResolver();
  const installation = overrides.runnerInstallation ?? fakeRunnerInstallation(['claude-code']);
  const runnerRegistry = new RunnerRegistry();
  const stored = new Map<string, unknown>();
  const globalState = {
    get: (key: string) => stored.get(key),
    update: vi.fn(async (key: string, value: unknown) => { stored.set(key, value); }),
  };

  const services: ExtensionServices = {
    context: { subscriptions: [], extensionUri: { toString: () => 'file:///ext' }, globalState } as unknown as vscode.ExtensionContext,
    outputChannel: { appendLine: vi.fn() } as unknown as vscode.OutputChannel,
    secretStore: { set: vi.fn(), get: vi.fn() } as unknown as SecretStore,
    config: config.config,
    runnerRegistry,
    runnerInstallation: installation as unknown as RunnerInstallation,
    fsAdapter: { getWorkspaceRoot: () => workspace } as unknown as VsCodeFileSystem,
    notifications: {} as unknown as VsCodeNotification,
    runner: { stopAll: vi.fn() } as unknown as IRunner,
    settingsService: settings as unknown as SettingsService,
    plannerModelMemory: { remember: vi.fn(), recall: vi.fn(() => ({ model: '', effort: '', source: 'default' })) } as unknown as PlannerModelMemory,
    modelResolver: resolver as unknown as ModelResolver,
    chatProvider: overrides.chatProvider ?? chat.provider as unknown as ChatViewProvider,
    sessionFactory: (deps) => { sessionDeps.current = deps; return session.session; },
  };

  return {
    host: createExtension(services, vscodeApi.api),
    workspace,
    vscodeApi,
    chat,
    config,
    session,
    settings,
    resolver,
    installation,
    services,
    sessionDeps,
  };
}

describe('the extension host wires one state, one deps bag and one lifecycle', () => {
  let h: ReturnType<typeof harness>;

  beforeEach(() => {
    h = harness();
  });
  afterEach(() => {
    fs.rmSync(h.workspace, { recursive: true, force: true });
  });

  it('hands the session the shared settings as they are, enabled runners included, read at each call', () => {
    h.settings.getAll.mockReturnValue({ enabledRunners: ['opencode'] });
    expect(h.sessionDeps.current?.settings().enabledRunners).toEqual(['opencode']);

    h.settings.getAll.mockReturnValue({ enabledRunners: ['claude-code', 'codex'] });
    expect(h.sessionDeps.current?.settings().enabledRunners).toEqual(['claude-code', 'codex']);
  });

  it('leaves the session to the config\'s defaults while the user has chosen no runners', () => {
    h.settings.getAll.mockReturnValue({});

    expect(h.sessionDeps.current?.settings().enabledRunners).toBeUndefined();
  });

  it('draws the runner header again when another surface changes the settings file', async () => {
    await h.host.start();
    h.chat.provider.setEnabledRunnerIds.mockClear();
    h.config.values.enabledRunners = ['claude-code', 'codex'];
    h.installation.filterInstalled.mockImplementation(async (runners: string[]) => runners);

    h.settings.saved();

    await vi.waitFor(() => expect(h.chat.provider.setEnabledRunnerIds).toHaveBeenCalledWith(['claude-code', 'codex']));
  });

  it('does not rediscover models for a save that leaves the enabled runners as they were', async () => {
    await h.host.start();
    h.resolver.refreshRunnerModels.mockClear();

    h.settings.saved();
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(h.resolver.refreshRunnerModels).not.toHaveBeenCalled();
  });

  it('shows the run settings another surface saved', async () => {
    await h.host.start();
    h.chat.provider.setRunSettings.mockClear();

    h.settings.saved();

    expect(h.chat.provider.setRunSettings).toHaveBeenCalled();
  });

  it('registers the webview, the host commands and the webview listener through the given vscode api', async () => {
    await h.host.start();

    expect(h.vscodeApi.api.window.registerWebviewViewProvider).toHaveBeenCalledWith('ordewellChatView', h.chat.provider, expect.anything());
    expect(h.vscodeApi.api.commands.registerCommand).toHaveBeenCalledWith('ordewell.setPlanner', expect.any(Function));
    expect(h.vscodeApi.api.commands.registerCommand).toHaveBeenCalledWith('ordewell.setMaxParallel', expect.any(Function));
  });

  it('replays plan, planner state and models when the webview reconnects', async () => {
    await h.host.start();

    h.chat.messages.fire({ type: 'sendMessage', text: 'build a parser', typed: true });
    await vi.waitFor(() => expect(h.session.spies.startPlanning).toHaveBeenCalled());

    h.chat.provider.resendAllState.mockClear();
    h.chat.provider.showPlan.mockClear();
    h.chat.provider.setModels.mockClear();

    h.chat.messages.fire({ type: 'ready' });

    await vi.waitFor(() => expect(h.chat.provider.resendAllState).toHaveBeenCalled());
    expect(h.session.spies.startPlanning).toHaveBeenCalledWith('build a parser', ['claude-code']);
    expect(h.chat.provider.showPlan).toHaveBeenCalledWith(expect.objectContaining({
      tasks: [expect.objectContaining({ id: 't1' })],
    }));
    await vi.waitFor(() => expect(h.chat.provider.setModels).toHaveBeenCalledWith(models));
    expect(h.chat.provider.setRunSettings).toHaveBeenCalledWith(expect.any(Boolean), RUN_SETTINGS_DEFAULTS, 2);
    await vi.waitFor(() => expect(h.chat.provider.setPlannerBackends).toHaveBeenCalledWith(
      expect.arrayContaining([expect.objectContaining({ id: 'claude-code', usable: true })]),
      'openrouter', undefined, '',
    ));
  });

  it('seeds the run view when the webview reconnects, so a task waiting on a runner approval keeps its badge', async () => {
    await h.host.start();
    h.chat.messages.fire({ type: 'sendMessage', text: 'build a parser', typed: true });
    await vi.waitFor(() => expect(h.session.spies.startPlanning).toHaveBeenCalled());

    // A run is going and a task is blocked on a runner approval: nothing on the
    // wire will say so again until the user answers, so a recreated webview has
    // to be told now.
    (h.session.spies as unknown as { planState: unknown }).planState = {};
    const view: RunView = {
      tasks: [{
        id: 't1', order: 1, title: 'Parse JSON', type: 'ai', status: 'in_progress', description: '', dependencies: [],
        assignedRunner: 'claude-code', assignedModel: null, taskMode: 'build', prompt: 'do it', subtasks: [],
        userSteps: undefined, autonomy: undefined, sliceType: undefined, userStoriesCovered: undefined,
        verdict: null, awaitingApproval: 2,
      }],
      runMerge: null, handoff: null, mergeResult: null,
    };
    h.session.spies.runSnapshot = vi.fn(() => view);

    h.chat.messages.fire({ type: 'ready' });

    await vi.waitFor(() => expect(h.chat.provider.adoptRun).toHaveBeenCalledWith(view));
  });

  it('remembers the dragged plan dock height for the next webview to open', async () => {
    await h.host.start();
    h.chat.messages.fire({ type: 'ready' });
    await vi.waitFor(() => expect(h.chat.provider.setPlanDockHeight).toHaveBeenCalledWith(undefined));

    h.chat.messages.fire({ type: 'setPlanDockHeight', height: 340 });
    h.chat.provider.setPlanDockHeight.mockClear();
    h.chat.messages.fire({ type: 'ready' });

    await vi.waitFor(() => expect(h.chat.provider.setPlanDockHeight).toHaveBeenCalledWith(340));
  });

  it('resets the AI service, invalidates the resolver and reschedules on a config change', async () => {
    await h.host.start();
    h.resolver.invalidate.mockClear();
    h.resolver.refreshRunnerModels.mockClear();

    for (const listener of h.config.listeners) listener();

    expect(h.session.spies.reschedule).toHaveBeenCalled();
    expect(h.session.spies.aiServiceInstance.reset).toHaveBeenCalled();
    expect(h.resolver.invalidate).toHaveBeenCalled();
    await vi.waitFor(() => expect(h.resolver.refreshRunnerModels).toHaveBeenCalled());
  });

  it('logs a failed reschedule on a config change instead of leaving the rejection unhandled', async () => {
    await h.host.start();
    h.session.spies.reschedule.mockRejectedValueOnce(new Error('tick exploded'));

    for (const listener of h.config.listeners) listener();

    const appendLine = h.services.outputChannel.appendLine as unknown as ReturnType<typeof vi.fn>;
    await vi.waitFor(() => expect(appendLine).toHaveBeenCalledWith(expect.stringContaining('Reschedule failed: tick exploded')));
  });

  describe('the planner setting has no static enum, so the host checks it', () => {
    it('names an unknown value and the choices, once, at start and again only when the value changes', async () => {
      await h.config.config.update('rawAiProvider', 'nonesuch');
      await h.host.start();

      expect(h.vscodeApi.showWarningMessage).toHaveBeenCalledTimes(1);
      const message = h.vscodeApi.showWarningMessage.mock.calls[0][0] as string;
      expect(message).toContain('"nonesuch"');
      expect(message).toContain('ordewell.aiProvider');
      for (const id of ['claude-code', 'codex', 'opencode', 'openrouter']) expect(message).toContain(id);

      for (const listener of h.config.listeners) listener();
      expect(h.vscodeApi.showWarningMessage).toHaveBeenCalledTimes(1);

      await h.config.config.update('rawAiProvider', 'other');
      for (const listener of h.config.listeners) listener();
      expect(h.vscodeApi.showWarningMessage).toHaveBeenCalledTimes(2);
      expect(h.vscodeApi.showWarningMessage.mock.calls[1][0]).toContain('"other"');
    });

    it('says nothing for a blank value, a vendor or a runner that can plan', async () => {
      for (const value of ['', 'google', 'codex']) {
        await h.config.config.update('rawAiProvider', value);
        await h.host.start();
      }
      expect(h.vscodeApi.showWarningMessage).not.toHaveBeenCalled();
    });
  });

  it('warns once when an installed runner discovers no models, and throttles repeats', async () => {
    const resolver = fakeResolver({});
    const local = harness({ modelResolver: resolver });
    try {
      await local.host.start();

      expect(local.vscodeApi.showWarningMessage).toHaveBeenCalledTimes(1);
      expect(local.vscodeApi.showWarningMessage.mock.calls[0][0]).toContain('claude-code');

      local.chat.messages.fire({ type: 'refreshModels' });
      await vi.waitFor(() => expect(local.chat.provider.setModels).toHaveBeenCalledTimes(2));

      expect(local.vscodeApi.showWarningMessage).toHaveBeenCalledTimes(1);
    } finally {
      fs.rmSync(local.workspace, { recursive: true, force: true });
    }
  });

  it('routes approve-plan, send-message and system commands to the Session', async () => {
    await h.host.start();

    h.chat.messages.fire({ type: 'sendMessage', text: 'build a parser', typed: true });
    await vi.waitFor(() => expect(h.session.spies.startPlanning).toHaveBeenCalled());

    h.chat.messages.fire({ type: 'sendSystemCommand', command: 'executePlan' });
    await vi.waitFor(() => expect(h.session.spies.execute).toHaveBeenCalledWith({ command: 'run_plan' }, { kind: 'user' }));
    // The plan's own status is not the host's to set: the run_plan above is the approval, and the Session keeps it.
    expect(h.session.spies.loadPlan).toHaveBeenCalledWith(
      expect.objectContaining({ tasks: [expect.objectContaining({ id: 't1', status: 'approved' })] }),
      'build a parser',
      h.services.fsAdapter.getWorkspaceRoot(),
    );

    h.chat.messages.fire({ type: 'sendSystemCommand', command: 'cancel', taskId: 't1' });
    await vi.waitFor(() => expect(h.session.spies.execute).toHaveBeenCalledWith({ command: 'stop_task', task: 't1' }, { kind: 'user' }));
  });

  it('persists and stops runners on dispose', async () => {
    const stopAll = h.services.runner.stopAll as unknown as ReturnType<typeof vi.fn>;
    await h.host.start();
    h.chat.messages.fire({ type: 'sendMessage', text: 'build a parser', typed: true });
    await vi.waitFor(() => expect(h.session.spies.startPlanning).toHaveBeenCalled());

    h.host.dispose();

    expect(stopAll).toHaveBeenCalled();
    // A goal still waiting for the probe is stopped with the host's runners.
    expect(h.session.spies.abortPlannerTurn).toHaveBeenCalled();
  });

  it('opens a task log tab on request, through the one registry', async () => {
    await h.host.start();
    __resetPanels();
    (h.session.spies as unknown as { planTasks: unknown[] }).planTasks = [
      createTask({ id: 't1', order: 1, title: 'Parse JSON', assignedRunner: 'claude-code' }),
    ];

    h.chat.messages.fire({ type: 'openTaskLog', taskId: 't1' });

    await vi.waitFor(() => expect(__panels).toHaveLength(1));
    expect(__panels[0].viewType).toBe('ordewellTaskLog');
    expect(__panels[0].title).toBe('Task 1 · Parse JSON');
  });
});

describe('the planner with no planner chosen and no API key (ADR-0009)', () => {
  afterEach(() => resetInstalledPlanner());

  // The wait itself is the session's planner gate, so a prompt typed during it
  // is held as one typed during the turn (plannerStartWait.test.ts).
  it('a goal typed before the activation probe answers goes to the session at once, unrefused, and plans with the agent found', async () => {
    let answer!: (value: PlannerUsability) => void;
    const gate = new Promise<PlannerUsability>((resolve) => { answer = resolve; });
    const installation = fakeRunnerInstallation(['claude-code']);
    installation.plannerUsability.mockImplementation(() => gate);
    const h = harness({ runnerInstallation: installation });
    try {
      // Not awaited: activation's own model discovery asks the same gated
      // installation. The webview listener is registered before that.
      const starting = h.host.start();

      h.chat.messages.fire({ type: 'sendMessage', text: 'build a parser', typed: true });
      // No runners yet: which are enabled by default is the probe's answer, so
      // the session reads them once its gate opens.
      await vi.waitFor(() => expect(h.session.spies.startPlanning).toHaveBeenCalledWith('build a parser', undefined));
      expect(h.chat.provider.showError.mock.calls).toEqual([]);

      answer({ usable: true });
      await vi.waitFor(() => expect(recordedInstalledPlanner()).toBe('claude-code'));
      expect(h.chat.provider.showError.mock.calls).toEqual([]);
      await starting;
    } finally {
      fs.rmSync(h.workspace, { recursive: true, force: true });
    }
  });
});

describe('the runner header with no saved runner choice', () => {
  afterEach(() => resetInstalledPlanner());

  it('waits for the activation probe, then shows the installed agent enabled', async () => {
    let answer!: () => void;
    const gate = new Promise<void>((resolve) => { answer = resolve; });
    const installation = fakeRunnerInstallation(['codex']);
    installation.plannerUsability.mockImplementation(async (runner?: string) => { await gate; return { usable: runner === 'codex' }; });
    const h = harness({ runnerInstallation: installation });
    // As VsCodeConfig answers when nothing is saved.
    Object.defineProperty(h.config.config, 'enabledRunners', { get: () => defaultEnabledRunners() });
    try {
      const starting = h.host.start();
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(h.chat.provider.setEnabledRunnerIds).not.toHaveBeenCalled();

      answer();
      await starting;
      await vi.waitFor(() => expect(h.chat.provider.setEnabledRunnerIds).toHaveBeenCalled());
      expect(h.chat.provider.setEnabledRunnerIds.mock.calls).toEqual([[['codex']]]);
    } finally {
      fs.rmSync(h.workspace, { recursive: true, force: true });
    }
  });
});

describe("the Settings panel's Run block", () => {
  let h: ReturnType<typeof harness>;
  const warning = window.showWarningMessage as unknown as ReturnType<typeof vi.fn>;
  const lastPush = () => h.chat.provider.setRunSettings.mock.calls.at(-1);

  beforeEach(async () => {
    h = harness();
    await h.host.start();
    warning.mockReset();
    h.chat.provider.setRunSettings.mockClear();
  });
  afterEach(() => {
    fs.rmSync(h.workspace, { recursive: true, force: true });
  });

  it('saves Full or Guarded and pushes the settings back', async () => {
    h.chat.messages.fire({ type: 'changeSettings', change: { autonomous: false } });

    await vi.waitFor(() => expect(h.settings.setAutonomousMode).toHaveBeenCalledWith(false));
    expect(h.chat.provider.setRunSettings).toHaveBeenCalled();
  });

  it('saves a run setting, applies it to this window\'s run and pushes it back', async () => {
    h.chat.messages.fire({ type: 'changeSettings', change: { run: { wakeUpReadBudget: 20 } } });

    await vi.waitFor(() => expect(h.settings.updateRunSettings).toHaveBeenCalledWith({ wakeUpReadBudget: 20 }));
    expect(h.session.spies.applyRunSettings).toHaveBeenCalledWith({ wakeUpReadBudget: 20 });
    expect(lastPush()).toEqual([true, { ...RUN_SETTINGS_DEFAULTS, wakeUpReadBudget: 20 }, 2]);
  });

  it.each([
    [{ supervisorLevel: 'act' as const }, /ops tasks included/],
    [{ autorun: true }, /without review/],
  ])('%j asks first; declined, it saves nothing and pushes the unchanged value', async (run, risk) => {
    warning.mockResolvedValue(undefined);
    h.chat.messages.fire({ type: 'changeSettings', change: { run } });

    await vi.waitFor(() => expect(h.chat.provider.setRunSettings).toHaveBeenCalled());
    expect(JSON.stringify(warning.mock.calls[0])).toMatch(risk);
    expect(h.settings.updateRunSettings).not.toHaveBeenCalled();
    expect(lastPush()).toEqual([true, RUN_SETTINGS_DEFAULTS, 2]);

    warning.mockReset().mockImplementation(async (...args: unknown[]) => args.at(-1));
    h.chat.messages.fire({ type: 'changeSettings', change: { run } });
    await vi.waitFor(() => expect(h.settings.updateRunSettings).toHaveBeenCalledWith(run));
  });

  it('saves the parallel limit, and refuses one below 1', async () => {
    h.chat.messages.fire({ type: 'changeSettings', change: { maxParallel: 0 } });
    await vi.waitFor(() => expect(h.chat.provider.setRunSettings).toHaveBeenCalled());
    expect(h.config.config.update).not.toHaveBeenCalledWith('maxParallelSessions', expect.anything());

    h.chat.messages.fire({ type: 'changeSettings', change: { maxParallel: 17 } });
    await vi.waitFor(() => expect(h.config.config.update).toHaveBeenCalledWith('maxParallelSessions', 17));
  });

  it('pushes the parallel limit whenever the configuration changes (/parallel, the command, settings.json)', async () => {
    await h.config.config.update('maxParallelSessions', 9);
    for (const listener of h.config.listeners) listener();

    expect(lastPush()).toEqual([true, RUN_SETTINGS_DEFAULTS, 9]);
  });
});

describe('the task skill chips in a repo group', () => {
  let h: ReturnType<typeof harness>;
  let home: string;

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'ordewell-host-home-'));
    vi.stubEnv('HOME', home);
    vi.stubEnv('USERPROFILE', home);
    h = harness();
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    fs.rmSync(h.workspace, { recursive: true, force: true });
    fs.rmSync(home, { recursive: true, force: true });
  });

  it('offers a task skill committed inside a repo of the group, as a spawn there reads it', async () => {
    const skill = path.join(h.workspace, 'api', '.ordewell', 'skills', 'api-check');
    fs.mkdirSync(path.join(h.workspace, 'api', '.git'), { recursive: true });
    fs.mkdirSync(skill, { recursive: true });
    fs.writeFileSync(path.join(skill, 'SKILL.md'), '---\nname: api-check\ndescription: Checks the API\napplies-to: task\n---\n\nbody');

    await h.host.start();

    expect(h.chat.provider.setTaskSkills).toHaveBeenLastCalledWith(
      expect.arrayContaining([{ name: 'api-check', description: 'Checks the API' }]),
    );
  });
});

/** The chat as VS Code hosts it, on a webview that can be reloaded: what it was sent, and a way to talk back. */
function liveChat() {
  const provider = new RealChatViewProvider({ toString: () => 'file:///ext' } as unknown as vscode.Uri);
  let receive: (msg: WebviewToHost) => void = () => {};
  const open = (): void => {
    provider.resolveWebviewView({
      show: vi.fn(),
      onDidDispose: () => ({ dispose() {} }),
      webview: {
        options: {}, html: '', cspSource: 'vscode-resource:', asWebviewUri: (u: unknown) => u,
        onDidReceiveMessage: (fn: (msg: WebviewToHost) => void) => { receive = fn; return { dispose() {} }; },
        postMessage: () => Promise.resolve(true),
      },
    } as unknown as vscode.WebviewView, {} as never, {} as never);
  };
  open();
  return {
    provider,
    /** The webview is torn down and comes back, as on a window reload: it says `ready`. */
    reload: () => { open(); receive({ type: 'ready' }); },
    send: (msg: WebviewToHost) => receive(msg),
    cards: () => provider.conversation.blocks.flatMap((b) => (b.type === 'approval' ? [[b.approvalId, b.status]] : [])),
  };
}

describe('a chat webview reloaded while the planner waits for an answer', () => {
  let h: ReturnType<typeof harness>;
  let chat: ReturnType<typeof liveChat>;
  let approvals: PendingApprovals;
  let announced: Map<string, ApprovalRequestMessage>;
  let resolveApproval: ReturnType<typeof vi.fn<(id: string, granted: boolean) => boolean>>;

  beforeEach(async () => {
    chat = liveChat();
    h = harness({ chatProvider: chat.provider });
    await h.host.start();
    // The Session's own approval record, announcing on the broadcast seam the host listens to.
    announced = new Map();
    approvals = new PendingApprovals({
      onRequest: ({ id, request }) => {
        const message: ApprovalRequestMessage = { type: 'approval_request', id, kind: request.kind, subject: request.subject, scope: approvalScopes(request).join(', ') };
        announced.set(id, message);
        h.sessionDeps.current!.broadcast(message);
      },
      onSettled: (id, granted) => {
        announced.delete(id);
        h.sessionDeps.current!.broadcast({ type: 'approval_settled', id, granted });
      },
    });
    resolveApproval = vi.fn((id: string, granted: boolean) => approvals.resolve(id, granted));
    Object.assign(h.session.spies, {
      outstandingApprovals: () => approvals.outstanding(),
      resolveApproval,
      announcedApprovals: () => [...announced.values()],
    });
  });
  afterEach(() => {
    fs.rmSync(h.workspace, { recursive: true, force: true });
  });

  const startAsked = () => approvals.ask({ kind: 'task_start', subject: 'Start #3 "Add a cache"', scope: 'task_start', detail: 'Approves #3' } as never, { noTimeout: true });

  it('keeps the card of a request still waiting, answerable from the new webview', async () => {
    const answer = startAsked();
    const [{ id }] = approvals.outstanding();
    expect(chat.cards()).toEqual([[id, 'pending']]);

    chat.reload();

    expect(chat.cards()).toEqual([[id, 'pending']]);
    chat.send({ type: 'resolveApproval', id, granted: true });
    await expect(answer).resolves.toBe(true);
  });

  it('keeps the preview of an edit the planner holds, outside a turn this window started', async () => {
    chat.send({ type: 'sendMessage', text: 'build a parser', typed: true });
    await vi.waitFor(() => expect(h.session.spies.startPlanning).toHaveBeenCalled());
    // A supervisor's wake-up turn holds an edit: this window has no turn of its own out.
    const task = createTask({ id: 't9', order: 2, title: 'Add a cache', prompt: 'add a cache', assignedRunner: 'claude-code' });
    const heldEdit = { turnId: 'wake-1', tasks: [{ label: '2', mark: 'added' as const, task: { ...task, subtasks: [] } }] };
    (h.session.spies as unknown as { planState: unknown }).planState = {};
    h.session.spies.runSnapshot = vi.fn(() => ({ tasks: [], runMerge: null, handoff: null, mergeResult: null, heldEdit } as unknown as RunView));

    chat.reload();

    await vi.waitFor(() => expect(chat.provider.run.current.heldEdit?.tasks.map((t) => t.task.title)).toEqual(['Add a cache']));
  });

  it('drops the card of a request answered elsewhere while the webview was away, and does not answer it again', async () => {
    const answer = startAsked();
    const [{ id }] = approvals.outstanding();
    approvals.resolve(id, false);

    chat.reload();
    expect(chat.cards()).toEqual([]);
    // A click the old webview still sent arrives late: the request is already settled.
    chat.send({ type: 'resolveApproval', id, granted: true });

    await expect(answer).resolves.toBe(false);
    expect(resolveApproval).toHaveReturnedWith(false);
    expect(chat.cards()).toEqual([]);
  });
});
