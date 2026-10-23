import type * as vscode from 'vscode';
import { startVersionCheck, type VersionCheck, type VersionCheckOptions } from '@ordewell/core';

type Vscode = Pick<typeof vscode, 'env' | 'window'>;

/**
 * The daily version check (ADR-0048) for one extension host. VS Code's own
 * telemetry setting is the off switch: off means no notice, no file and no
 * ping, and turning it off mid-session stops the daily re-check. There is no
 * update line here: the Marketplace updates the extension.
 */
export function startExtensionVersionCheck(
  host: Vscode,
  version: string,
  options: Partial<Omit<VersionCheckOptions, 'version' | 'onNotice' | 'onUpdate' | 'telemetryEnabled'>> = {},
): { dispose(): void } {
  const check: VersionCheck = startVersionCheck({
    version,
    telemetryEnabled: host.env.isTelemetryEnabled,
    onNotice: (text) => { void host.window.showInformationMessage(text); },
    onUpdate: () => {},
    ...options,
  });
  const subscription = host.env.onDidChangeTelemetryEnabled((enabled) => {
    if (!enabled) check.stop();
  });
  return {
    dispose() {
      subscription.dispose();
      check.stop();
    },
  };
}
