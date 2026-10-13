import * as vscode from 'vscode';
import {
  enabledRunners, listSessions, loadSession, knownModelId, runnerForProvider, getProviderMeta,
  ORCHESTRATOR_SHORTCUTS, parseAutonomyLevel,
  automergeSummary, autorunSummary, parseCount, parseSwitch, supervisorSummary, type GlobalRunSettings,
} from '@ordewell/core';
import type { AiProvider, IConfig, RunnerRegistry, ModelResolver, SettingsService, RunnerModeInfo, DiscoveredModel, PlannerModelRecall, PlannerSelectionChange } from '@ordewell/core';
import type { ApiProvider } from '../adapters/SecretStore';
import type { ChatViewProvider, PlannerBackend } from '../providers/ChatViewProvider';
import type { VendorModelOption } from '../plan/PlannerModelSwitch';
import { configureModelAllowlist } from './configureModelAllowlist';
import { confirmRisks } from './runSettings';
import { SLASH_COMMAND_NAMES, slashHelp } from './slashCommands';
import { resolveAutonomousQuickPickItems, applyAutonomousChoice } from '../SlashAutonomous';
import { runPlannerWizard } from './plannerWizard';

// A '/' text whose first word the table does not name is a discovered skill
// (or unknown) invocation: the caller routes it to handleSendMessage, so the
// Session's own /skill-name substitution gets to resolve it rather than it
// being swallowed here as "Unknown command".
export function isKnownSlashCommand(text: string): boolean {
  const name = text.trim().slice(1).split(/\s+/)[0]?.toLowerCase();
  return !!name && SLASH_COMMAND_NAMES.has(name);
}

export interface SlashDeps {
  config: { orchestratorModel: string; planningModel: string; enabledRunners: string[]; autonomousMode: boolean; apiKey: string; openAiBaseUrl: string; configuredProviders: ApiProvider[]; aiProvider: AiProvider; plannerThinkingEffort?: string };
  modelResolver: { pickerOptions(): Promise<{ id: string; label: string; provider: string; apiProvider?: AiProvider; description?: string; pricing?: string }[]>; refresh(): Promise<unknown>; invalidate(): void; refreshRunnerModels(): void; modelsForRunners(runners: string[]): Promise<Partial<Record<string, DiscoveredModel[]>>>; };
  /** Every planner the user could pick, with the reason an unusable one can't be (ADR-0009). */
  plannerBackends(): Promise<PlannerBackend[]>;
  /** Re-push planner provider/model/effort to the webview after a change. */
  refreshPlannerState(): Promise<void>;
  runnerRegistry: { list(): { manifest: { displayName: string; name: string } }[]; get(id: string): { manifest: { displayName: string } } | undefined; getManifest(id: string): { modes?: { id: string; label: string; description: string; cliValue?: string }[] } | undefined; };
  chatProvider: ChatViewProvider;
  settingsService: { getModelAllowlist(runner: string): string[] | undefined; setModelAllowlist(runner: string, ids: string[] | undefined): void; };
  sendRunnerAndModels(): Promise<void>;
  runApiKeyWizard(provider?: ApiProvider): Promise<void>;
  discoverOrchestratorModelOptions(): Promise<{ id: string; label: string; provider: string; apiProvider?: AiProvider; description?: string; pricing?: string }[]>;
  pickModelWithProvider(options: { id: string; label: string; provider: string; apiProvider?: AiProvider; description?: string; pricing?: string }[], configuredProviders: ApiProvider[], placeHolder: string): Promise<string | undefined>;
  updateConfig(key: string, value: unknown): Promise<void>;
  /** Change who plans through core's one rule (`selectPlanner`), saving, remembering and showing the result. */
  changePlanner(change: PlannerSelectionChange): Promise<void>;
  /** What the planner should land on for `provider`: its remembered model, else the catalog's first. */
  recallPlannerModel(provider: AiProvider, harnessModels: DiscoveredModel[] | undefined, vendorOptions: VendorModelOption[] | undefined): PlannerModelRecall;
  /** Switch backend, model and effort in one change and remember the pick. */
  applyPlannerChoice(provider: AiProvider, modelId: string, effort: string): Promise<void>;
  /** Saves Full or Guarded in the user's settings file, which every surface shares (ADR-0030). */
  saveAutonomy(enabled: boolean): void;
  /** The user's run settings (ADR-0030): `change` saves them and applies them at once to this window's run. */
  runSettings: { get(): GlobalRunSettings; change(changes: Partial<GlobalRunSettings>): void };
  log(msg: string): void;
}

/**
 * `/planner <id>` switches straight to that backend and its remembered model;
 * bare `/planner` walks harness, model and effort in one stepped quick pick
 * (ADR-0009). Unusable harness planners are listed with the preflight's reason
 * — a picker that hides a missing CLI leaves the user guessing why it vanished.
 */
async function pickPlanner(arg: string | undefined, deps: SlashDeps): Promise<void> {
  if (!arg) {
    await runPlannerWizard({
      current: () => ({
        provider: deps.config.aiProvider,
        model: deps.config.orchestratorModel,
        effort: deps.config.plannerThinkingEffort ?? '',
      }),
      plannerBackends: deps.plannerBackends,
      modelsForRunner: async (runner) => (await deps.modelResolver.modelsForRunners([runner]))[runner] ?? [],
      vendorModels: async (provider) => (await deps.modelResolver.pickerOptions()).filter((o) => o.apiProvider === provider),
      recall: deps.recallPlannerModel,
      applyChoice: deps.applyPlannerChoice,
    });
    return;
  }
  const chosen = (await deps.plannerBackends()).find((b) => b.id === arg.toLowerCase());
  if (!chosen) {
    vscode.window.showWarningMessage(`Unknown planner: ${arg}. Run /planner with no argument to see the list.`);
    return;
  }
  if (!chosen.usable) {
    vscode.window.showWarningMessage(chosen.reason ?? `${chosen.label} is not available.`);
    return;
  }
  await vscode.commands.executeCommand('ordewell.setPlanner', chosen.id);
}

/**
 * A vendor model named while a coding agent plans. The agent can't run it, and
 * showing the agent's own picker instead reads as the command being ignored, so
 * offer the one action that makes the request true. Switching who plans changes
 * what the user is billed, hence the explicit confirmation.
 */
async function switchPlannerToVendorModel(arg: string, runner: string, deps: SlashDeps): Promise<boolean> {
  const options = await deps.discoverOrchestratorModelOptions();
  const known = knownModelId(arg, options.map((o) => o.id), ORCHESTRATOR_SHORTCUTS);
  const provider = options.find((o) => o.id === known)?.apiProvider;
  if (!known || !provider) return false;
  const label = getProviderMeta(provider).label;
  const choice = await vscode.window.showInformationMessage(
    `${known} is a ${label} model, but the planner is ${runner}. Switch the planner to ${label}?`,
    'Switch planner',
  );
  if (choice !== 'Switch planner') return true;
  await deps.changePlanner({ provider, model: known, effort: '' });
  vscode.window.showInformationMessage(`Planner set to ${label}, model ${known}`);
  return true;
}

/** The planner's own model, from the coding agent's catalog rather than a vendor's. */
async function pickHarnessPlannerModel(runner: string, arg: string, deps: SlashDeps): Promise<void> {
  const models = (await deps.modelResolver.modelsForRunners([runner]))[runner] ?? [];
  let modelId = arg.trim() && models.some((m) => m.modelId === arg.trim()) ? arg.trim() : '';
  if (!modelId && arg.trim() && await switchPlannerToVendorModel(arg.trim(), runner, deps)) return;
  if (models.length === 0) {
    vscode.window.showWarningMessage(`No ${runner} models discovered yet. Run /refresh.`);
    return;
  }
  if (!modelId) {
    const picked = await vscode.window.showQuickPick(
      models.map((m) => ({
        label: m.modelLabel,
        description: m.modelId,
        detail: m.variants.length > 0
          ? `${m.variants.length} effort level${m.variants.length === 1 ? '' : 's'}`
          : 'runner default effort',
        modelId: m.modelId,
      })),
      { placeHolder: `Pick a ${runner} model for the planner` },
    );
    if (!picked) return;
    modelId = picked.modelId;
  }
  await deps.changePlanner({ model: modelId });
  vscode.window.showInformationMessage(`Planner model set to: ${modelId}`);
}

/** The planner agent's thinking effort — one of the selected model's own variants. */
async function pickPlannerEffort(arg: string | undefined, deps: SlashDeps): Promise<void> {
  const runner = runnerForProvider(deps.config.aiProvider);
  if (!runner) {
    vscode.window.showWarningMessage('Thinking effort applies to a coding-agent planner. Run /planner to pick one.');
    return;
  }
  const models = (await deps.modelResolver.modelsForRunners([runner]))[runner] ?? [];
  const current = models.find((m) => m.modelId === deps.config.orchestratorModel);
  const variants = current?.variants ?? [];
  if (variants.length === 0) {
    vscode.window.showWarningMessage(
      current
        ? `${current.modelLabel} exposes no effort levels — it always runs at the agent's default.`
        : 'Pick a planner model first with /model set.',
    );
    return;
  }
  if (arg) {
    const match = variants.find((v) => v.id === arg.toLowerCase());
    if (!match) {
      vscode.window.showWarningMessage(`Unknown effort: ${arg}. Available: ${variants.map((v) => v.id).join(', ')}.`);
      return;
    }
    await deps.changePlanner({ effort: match.id });
    vscode.window.showInformationMessage(`Planner effort set to: ${match.id}`);
    return;
  }
  const picked = await vscode.window.showQuickPick(
    [
      { label: 'Runner default', detail: "Let the agent choose", effort: '' },
      ...variants.map((v) => ({ label: v.label, detail: v.id === deps.config.plannerThinkingEffort ? 'current' : undefined, effort: v.id })),
    ],
    { placeHolder: `Thinking effort for ${current!.modelLabel}` },
  );
  if (!picked) return;
  await deps.changePlanner({ effort: picked.effort });
  vscode.window.showInformationMessage(`Planner effort set to: ${picked.effort || 'runner default'}`);
}

export async function handleSlashCommand(text: string, deps: SlashDeps): Promise<void> {
  const parts = text.trim().split(/\s+/);
  const cmd = parts[0];
  const args = parts.slice(1);

  if (cmd === '/refresh') {
    // Full refresh: drop every resolver cache (runner discovery + provider
    // catalogs) so the re-discovery below reflects the current environment.
    deps.modelResolver.invalidate();
    await deps.sendRunnerAndModels();
    vscode.window.showInformationMessage('Refreshed.');
    return;
  }
  if (cmd === '/model' && args.length === 0) {
    await vscode.commands.executeCommand('workbench.action.openSettings', 'ordewell.orchestratorModel');
    return;
  }
  if (cmd === '/model' && args[0] === 'set') {
    // A harness planner runs a coding agent, so its catalog is that agent's own
    // (ADR-0009) — sending it through the vendor picker would offer models it
    // cannot run, and refuse outright when the user holds no API key at all.
    const plannerRunner = runnerForProvider(deps.config.aiProvider);
    if (plannerRunner) {
      await pickHarnessPlannerModel(plannerRunner, args.slice(1).join(' '), deps);
      return;
    }
    const options = await deps.discoverOrchestratorModelOptions();
    const known = knownModelId(args.slice(1).join(' '), options.map((o) => o.id), ORCHESTRATOR_SHORTCUTS);
    if (known) {
      await deps.changePlanner({ model: known });
      vscode.window.showInformationMessage(`Planner model set to: ${known}`);
      return;
    }
    const picked = await deps.pickModelWithProvider(options, deps.config.configuredProviders, 'Pick the planner model');
    if (picked) {
      await deps.changePlanner({ model: picked });
      vscode.window.showInformationMessage(`Planner model set to: ${picked}`);
    }
    return;
  }
  if (cmd === '/planner') {
    await pickPlanner(args[0], deps);
    return;
  }
  if (cmd === '/planner-effort') {
    await pickPlannerEffort(args[0], deps);
    return;
  }
  if (cmd === '/key') {
    const allProviders = ['google', 'openrouter', 'openai_compatible', 'openai', 'xai', 'groq', 'deepseek', 'together', 'mistral', 'anthropic', 'fireworks', 'perplexity', 'zhipu', 'kimi', 'cerebras', 'deepinfra', 'doubao', 'qwen', 'hunyuan', 'baichuan', 'minimax', 'yi', 'stepfun', 'siliconflow', 'cohere', 'novita'];
    const provider = args.find((a) => allProviders.includes(a)) as ApiProvider | undefined;
    await deps.runApiKeyWizard(provider);
    return;
  }
  if (cmd === '/sessions') {
    const workspace = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || process.cwd();
    const sessions = listSessions(workspace);
    if (sessions.length === 0) {
      vscode.window.showInformationMessage('No saved sessions.');
      return;
    }
    const picked = await vscode.window.showQuickPick(
      sessions.slice(0, 20).map((s) => ({
        label: s.goal,
        description: `${s.taskCount} tasks · ${new Date(s.createdAt).toLocaleDateString()}`,
        detail: `Status: ${s.status} · Runners: ${s.runners.join(', ')}`,
        sessionId: s.id,
      })),
      { placeHolder: 'Select a session to load' },
    );
    if (picked) {
      const loaded = loadSession(picked.sessionId, workspace);
      if (!loaded) {
        vscode.window.showErrorMessage('Failed to load session.');
        return;
      }
      // The caller handles setting currentPlan/goal and updating the webview
      await vscode.commands.executeCommand('ordewell.loadSessionById', picked.sessionId);
    }
    return;
  }
  if (cmd === '/allowlist') {
    await configureModelAllowlist(
      deps.runnerRegistry as unknown as RunnerRegistry,
      deps.modelResolver as unknown as ModelResolver,
      deps.settingsService as unknown as SettingsService,
    );
    return;
  }
  if (cmd === '/help') {
    vscode.window.showInformationMessage(slashHelp());
    return;
  }
  if (cmd === '/parallel') {
    await vscode.commands.executeCommand('ordewell.setMaxParallel', args[0]);
    return;
  }
  if (cmd === '/fork') {
    await vscode.commands.executeCommand('ordewell.forkConversation');
    return;
  }
  if (cmd === '/rewind') {
    await vscode.commands.executeCommand('ordewell.rewindConversation', args[0]);
    return;
  }
  if (cmd === '/compact') {
    await vscode.commands.executeCommand('ordewell.compactConversation');
    return;
  }
  if (cmd === '/new') {
    await vscode.commands.executeCommand('ordewell.newSession');
    return;
  }
  if (cmd === '/auto') {
    const runners = enabledRunners(deps.config as unknown as IConfig).filter((r: string) => deps.runnerRegistry.get(r));
    const modesByRunner: Record<string, RunnerModeInfo[]> = {};
    for (const r of runners) {
      modesByRunner[r] = deps.runnerRegistry.getManifest(r)?.modes ?? [];
    }
    const direct = parseAutonomyLevel(args[0]);
    if (args[0] !== undefined && direct === null) {
      vscode.window.showWarningMessage('Usage: /auto [full|guarded]');
      return;
    }
    if (direct !== null) {
      deps.saveAutonomy(direct);
      vscode.window.showInformationMessage(applyAutonomousChoice(direct, runners, modesByRunner));
      return;
    }
    const items = resolveAutonomousQuickPickItems(runners, modesByRunner, deps.config.autonomousMode);
    const picked = await vscode.window.showQuickPick(items, { placeHolder: 'Autonomy level for new plans' });
    if (!picked) return;
    deps.saveAutonomy(picked.value);
    vscode.window.showInformationMessage(applyAutonomousChoice(picked.value, runners, modesByRunner));
    return;
  }
  if (cmd === '/settings') {
    deps.chatProvider.openSettings();
    return;
  }
  if (cmd === '/supervisor' || cmd === '/automerge' || cmd === '/autorun') {
    await runSettingsCommand(cmd, args, deps);
    return;
  }
  vscode.window.showWarningMessage(`Unknown command: ${cmd}. Type /help for available commands.`);
}

const RUN_SETTINGS_USAGE: Record<'/supervisor' | '/automerge' | '/autorun', string> = {
  '/supervisor': 'Usage: /supervisor [off|watch|act] · /supervisor retries <n> · /supervisor reads <n>',
  '/automerge': 'Usage: /automerge [on|off]',
  '/autorun': 'Usage: /autorun [on|off]',
};

/** The run settings (ADR-0030): a bare command says the value, an argument sets it; Act and autorun ask first. */
async function runSettingsCommand(cmd: '/supervisor' | '/automerge' | '/autorun', args: string[], deps: SlashDeps): Promise<void> {
  const run = deps.runSettings.get();
  const [arg, value] = args;
  if (arg === undefined) {
    const summary = cmd === '/supervisor' ? supervisorSummary(run) : cmd === '/automerge' ? automergeSummary(run) : autorunSummary(run);
    vscode.window.showInformationMessage(`${summary}. ${RUN_SETTINGS_USAGE[cmd].replace(/^Usage: /, '')}`);
    return;
  }
  const changes = runSettingsChange(cmd, arg, value);
  if (!changes) {
    vscode.window.showWarningMessage(RUN_SETTINGS_USAGE[cmd]);
    return;
  }
  if (!(await confirmRisks(changes))) return;
  deps.runSettings.change(changes);
}

function runSettingsChange(cmd: '/supervisor' | '/automerge' | '/autorun', arg: string, value: string | undefined): Partial<GlobalRunSettings> | null {
  if (cmd === '/supervisor') {
    if (arg === 'off' || arg === 'watch' || arg === 'act') return { supervisorLevel: arg };
    const n = parseCount(value, arg === 'reads' ? 1 : 0);
    if (n === null) return null;
    return arg === 'retries' ? { supervisorRetryLimit: n } : arg === 'reads' ? { wakeUpReadBudget: n } : null;
  }
  const enabled = parseSwitch(arg);
  if (enabled === null) return null;
  return cmd === '/automerge' ? { mergeAtGatesAutomatically: enabled } : { autorun: enabled };
}
