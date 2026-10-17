import { describe, it, expect, vi } from 'vitest';
import * as vscode from 'vscode';
import { registerCommands, type CommandDeps } from '../CommandRegistry';

const registerCommand = vscode.commands.registerCommand as unknown as ReturnType<typeof vi.fn>;

describe('ordewell.toggleRunner', () => {
  it('saves the enabled runners in the settings file every surface shares, not in a VS Code setting', async () => {
    registerCommand.mockClear();
    const settingsService = { setEnabledRunners: vi.fn() };
    const config = { enabledRunners: ['claude-code'], update: vi.fn() };
    const sendRunnerAndModels = vi.fn(async () => {});
    registerCommands({ subscriptions: [] } as unknown as vscode.ExtensionContext, { settingsService, config, sendRunnerAndModels } as unknown as CommandDeps);
    const toggle = registerCommand.mock.calls.find(([id]) => id === 'ordewell.toggleRunner')![1] as (runner?: string) => Promise<void>;

    await toggle('codex');

    expect(settingsService.setEnabledRunners).toHaveBeenCalledWith(['claude-code', 'codex']);
    expect(config.update).not.toHaveBeenCalled();
    expect(sendRunnerAndModels).toHaveBeenCalled();
  });
});
