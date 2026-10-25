import * as vscode from 'vscode';
import { spawn as nodeSpawn } from 'child_process';
import { createSession, CodexSandboxAvailability, RunnerRegistry, removedPluginNotice, ModelResolver, RunnerInstallation, SettingsService, PlannerModelMemory, StructuredRunner, runnerForProvider, processLeaseHost } from '@ordewell/core';
import { ChatViewProvider } from './providers/ChatViewProvider';
import { VsCodeConfig, moveAutonomyFromVsCodeSetting, moveEnabledRunnersFromVsCodeSetting } from './adapters/VsCodeConfig';
import { VsCodeFileSystem } from './adapters/VsCodeFileSystem';
import { SecretStore } from './adapters/SecretStore';
import { VsCodeNotification } from './adapters/VsCodeNotification';
import { startExtensionVersionCheck } from './versionCheck';
import { createExtension, type ExtensionHost } from './ExtensionHost';

let activeHost: ExtensionHost | undefined;
let versionCheck: { dispose(): void } | undefined;

function logTo(outputChannel: vscode.OutputChannel, msg: string): void {
  outputChannel.appendLine(`[${new Date().toISOString()}] ${msg}`);
  console.log(`[Ordewell] ${msg}`);
}

/**
 * The composition root for real: build every adapter and service, then hand
 * them to the host, which owns the wiring and the lifecycle.
 */
export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const outputChannel = vscode.window.createOutputChannel('Ordewell');
  logTo(outputChannel, 'Ordewell extension activating...');
  const pluginNotice = removedPluginNotice();
  if (pluginNotice) logTo(outputChannel, pluginNotice);

  try {
    // What another host's refusal names this window as (ADR-0049).
    processLeaseHost().describe({ kind: 'vscode' });
    const secretStore = new SecretStore(context.secrets);
    await secretStore.load();
    // Bound once the resolver exists, which is itself built from this config.
    // eslint-disable-next-line prefer-const
    let modelResolver: ModelResolver | undefined;
    const config = new VsCodeConfig(secretStore, (provider) => {
      const runner = runnerForProvider(provider);
      return runner && modelResolver ? modelResolver.getCachedRunnerModels(runner).map((model) => model.modelId) : [];
    });
    const runnerRegistry = new RunnerRegistry();
    modelResolver = new ModelResolver(runnerRegistry, config);
    const settingsService = new SettingsService();
    await moveAutonomyFromVsCodeSetting(settingsService);
    await moveEnabledRunnersFromVsCodeSetting(settingsService);

    activeHost = createExtension({
      context,
      outputChannel,
      secretStore,
      config,
      runnerRegistry,
      runnerInstallation: new RunnerInstallation(runnerRegistry),
      codexSandbox: new CodexSandboxAvailability(
        runnerRegistry,
        { spawn: nodeSpawn, fetch: globalThis.fetch },
        { cwd: vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.cwd(), env: process.env },
      ),
      fsAdapter: new VsCodeFileSystem(),
      notifications: new VsCodeNotification(),
      // Tasks run on the structured transport (ADR-0018) as plain child processes.
      runner: new StructuredRunner(),
      settingsService,
      plannerModelMemory: new PlannerModelMemory(settingsService),
      modelResolver,
      chatProvider: new ChatViewProvider(context.extensionUri),
      sessionFactory: createSession,
    }, vscode);

    await activeHost.start();
    // After start, and not awaited: the check reads one small file and never
    // waits on the network, so it cannot hold the extension back.
    versionCheck = startExtensionVersionCheck(vscode, String(context.extension?.packageJSON?.version ?? 'unknown'));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logTo(outputChannel, `ACTIVATION ERROR: ${message}`);
    vscode.window.showErrorMessage(`Ordewell failed to activate: ${message}`);
  }
}

export function deactivate(): void {
  versionCheck?.dispose();
  versionCheck = undefined;
  activeHost?.dispose();
}
