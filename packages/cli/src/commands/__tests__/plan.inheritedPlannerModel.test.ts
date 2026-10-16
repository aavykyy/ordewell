import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import http from 'http';
import type { AddressInfo } from 'net';
import type { SpawnFn } from '@ordewell/core';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { basename, delimiter, join } from 'path';

// Core from source, so the process boundary below is the very `spawn` the
// planner's agent is started through; the built bundle's cannot be replaced.
vi.mock('@ordewell/core', () => import('../../../../core/src/index'));

const boundary = vi.hoisted(() => ({ claude: null as SpawnFn | null }));

vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('child_process')>();
  const spawn = ((command: string, args: string[], options: Parameters<SpawnFn>[2]) =>
    boundary.claude && basename(command) === 'claude'
      ? boundary.claude(command, args, options)
      : actual.spawn(command, args, options)) as typeof actual.spawn;
  return { ...actual, spawn, default: { ...actual, spawn } };
});

import {
  ModelResolver, SettingsService, clearAugmentedPathCache, getProviderMeta, mintDaemonToken, recordInstalledPlanner,
  resetInstalledPlanner, PROVIDER_DETECT_PRIORITY, type IConfig, type IRunner,
} from '@ordewell/core';
import { fakeSpawn, type FakeAgentProcess } from '../../../../core/src/services/__tests__/harnessTestKit';
import { attachWsHandler, createApp } from '../../../../web/server/app';
import { createRequestListener } from '../../../../web/server/nodeAdapter';
import { OrchestratorPool } from '../../../../web/server/pool/orchestratorPool';
import { ApiClient } from '../../apiClient';
import { handlePlan } from '../plan';

/** Discovery that never spawns a CLI or reaches the network. */
function inertResolver(): ModelResolver {
  const registry = { getManifest: () => undefined } as unknown as ConstructorParameters<typeof ModelResolver>[0];
  const keyless = { getProviderApiKey: () => '', getProviderBaseUrl: () => '', setProviderModelLists: () => {}, openaiCompatibleBaseUrl: '' } as unknown as IConfig;
  return new ModelResolver(registry, keyless);
}

/**
 * `claude` as far as a model goes: one it does not know fails the turn, as the
 * real CLI does; anything else ends the turn too, since no plan is needed here.
 */
function claudeAnswer(argv: string[]) {
  return (_written: string, proc: FakeAgentProcess) => {
    const at = argv.indexOf('--model');
    const model = at < 0 ? '' : argv[at + 1];
    proc.emitStderr(model && !['opus', 'sonnet', 'haiku', 'fable'].includes(model)
      ? `unknown Claude Code model ${model}`
      : 'stopped after the model was read');
    proc.exit(1);
  };
}

/**
 * A keyless first run from the headless CLI, end to end (ADR-0009): Claude
 * Code is installed, no planner is named, and ORCHESTRATOR_MODEL still holds
 * an OpenRouter slug from an old setup — in the shell or loaded from `.env`.
 * `ordewell plan` forwards that variable to an already-running daemon; it is
 * what the daemon would have inherited, not a pick, so it must neither reach
 * `claude --model` nor be saved as the agent's model.
 */
describe('ordewell plan with an inherited planner model', () => {
  const keys = ['HOME', 'PATH', 'ORDEWELL_SETTINGS_PATH', 'AI_PROVIDER', 'ORCHESTRATOR_MODEL', 'ORDEWELL_PLANNER_EFFORT'];
  const saved: Record<string, string | undefined> = {};
  let dir: string;
  let workspace: string;
  let pool: OrchestratorPool;
  let server: http.Server;
  let client: ApiClient;
  let argvs: string[][];

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'ordewell-inherited-model-'));
    workspace = join(dir, 'ws');
    mkdirSync(join(workspace, '.git'), { recursive: true });
    for (const key of keys) saved[key] = process.env[key];
    for (const provider of PROVIDER_DETECT_PRIORITY) {
      const meta = getProviderMeta(provider);
      for (const key of [...meta.detectEnvVars, meta.baseUrlEnvVar]) {
        if (!key) continue;
        saved[key] = process.env[key];
        delete process.env[key];
      }
    }
    process.env.HOME = dir;
    process.env.ORDEWELL_SETTINGS_PATH = join(dir, 'settings.json');
    delete process.env.AI_PROVIDER;
    delete process.env.ORDEWELL_PLANNER_EFFORT;
    process.env.ORCHESTRATOR_MODEL = 'openai/gpt-4o';

    // The spawn is faked, but the binary must still resolve on PATH first.
    const bin = join(dir, 'bin');
    mkdirSync(bin);
    writeFileSync(join(bin, 'claude'), '#!/bin/sh\nexit 1\n');
    chmodSync(join(bin, 'claude'), 0o755);
    process.env.PATH = `${bin}${delimiter}${process.env.PATH ?? ''}`;
    clearAugmentedPathCache();

    argvs = [];
    const fake = fakeSpawn([]);
    boundary.claude = (command, args, options) => {
      argvs.push(args);
      const proc = fake.spawn(command, args, options) as unknown as FakeAgentProcess;
      const answer = claudeAnswer(args);
      // The kit answers the control traffic; a user turn is answered here.
      proc.on('__written', (chunk: string) => {
        if (chunk.includes('"type":"user"')) answer(chunk, proc);
      });
      return proc;
    };

    recordInstalledPlanner('claude-code');
    const runner: IRunner = { activeCount: 0, spawn: vi.fn(), stop: vi.fn(), stopAll: vi.fn() } as unknown as IRunner;
    pool = new OrchestratorPool({
      modelResolver: inertResolver(),
      runner,
      runnerInstallation: { plannerUsability: async () => ({ usable: true as const }), filterInstalled: async (ids: string[]) => ids.filter((id) => id === 'claude-code') },
      codexSandbox: { ensure: async () => undefined, refresh: async () => undefined },
    } as unknown as ConstructorParameters<typeof OrchestratorPool>[0]);
    server = http.createServer();
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as AddressInfo).port;
    const { token, file } = mintDaemonToken(port);
    const admission = { port, token, tokenFile: file };
    server.on('request', createRequestListener(createApp(pool, admission)));
    attachWsHandler(server, pool, admission);
    client = new ApiClient(port, workspace);
  });

  afterEach(async () => {
    boundary.claude = null;
    pool.destroyAll();
    server.closeAllConnections();
    await new Promise<void>((resolve) => { server.close(() => resolve()); });
    resetInstalledPlanner();
    clearAugmentedPathCache();
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(dir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  /** Runs the command as `main` would, with `process.exit` turned into a value. */
  async function run(args: string[]): Promise<{ stderr: string; exitCode: number | null }> {
    const errs: string[] = [];
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.spyOn(console, 'error').mockImplementation((...parts: unknown[]) => { errs.push(parts.join(' ')); });
    vi.spyOn(process.stderr, 'write').mockImplementation((() => true) as never);
    vi.spyOn(process, 'exit').mockImplementation(((code?: number) => { throw new Error(`exit:${code}`); }) as never);
    let exitCode: number | null = null;
    try {
      await handlePlan(args, { api: client });
    } catch (err) {
      const match = /^exit:(\d+)$/.exec(err instanceof Error ? err.message : '');
      if (!match) throw err;
      exitCode = Number(match[1]);
    } finally {
      vi.restoreAllMocks();
    }
    return { stderr: errs.join('\n'), exitCode };
  }

  it('never spawns the detected agent with the inherited vendor model, nor saves it as the agent\'s pick', async () => {
    const { stderr } = await run(['--goal', 'Add a cache', '--runner', 'claude-code', '--no-chat', '--workspace', workspace]);

    expect(argvs.length).toBeGreaterThan(0);
    for (const argv of argvs) expect(argv).not.toContain('openai/gpt-4o');
    expect(stderr).not.toContain('unknown Claude Code model');
    expect(new SettingsService().getAll().plannerModels).toBeUndefined();
    expect(await client.getSettings()).toMatchObject({ aiProvider: 'claude-code', orchestratorModel: '', plannerThinkingEffort: '' });
  });

  it('the settings the daemon reports are the remembered model and effort the agent is spawned with', async () => {
    process.env.ORDEWELL_PLANNER_EFFORT = 'low';
    new SettingsService().setPlannerModel('claude-code', { model: 'sonnet', effort: 'high' });

    await run(['--goal', 'Add a cache', '--runner', 'claude-code', '--no-chat', '--workspace', workspace]);

    const argv = argvs.at(-1) ?? [];
    expect([argv[argv.indexOf('--model') + 1], argv[argv.indexOf('--effort') + 1]]).toEqual(['sonnet', 'high']);
    expect(await client.getSettings()).toMatchObject({ orchestratorModel: 'sonnet', plannerThinkingEffort: 'high' });
    expect(new SettingsService().getPlannerModel('claude-code')).toEqual({ model: 'sonnet', effort: 'high' });
  });

  it('a model picked in the running daemon is spawned as picked, though another surface remembers another', async () => {
    // `/model` in the TUI: the daemon takes the pick, then `.env` records it,
    // which is what the next `ordewell plan` inherits and forwards.
    await client.updateSettings({ orchestratorModel: 'claude-opus-5-5' });
    process.env.ORCHESTRATOR_MODEL = 'claude-opus-5-5';
    new SettingsService().setPlannerModel('claude-code', { model: 'sonnet', effort: 'low' });

    await run(['--goal', 'Add a cache', '--runner', 'claude-code', '--no-chat', '--workspace', workspace]);

    const argv = argvs.at(-1) ?? [];
    expect(argv[argv.indexOf('--model') + 1]).toBe('claude-opus-5-5');
    expect(argv).not.toContain('--effort');
  });

  it('a request\'s own model reaches the agent for that request and is never saved', async () => {
    new SettingsService().setPlannerModel('claude-code', { model: 'sonnet', effort: 'high' });

    await pool.generatePlan('session-override', 'Add a cache', ['claude-code'], workspace, 'haiku').catch(() => undefined);

    const argv = argvs.at(-1) ?? [];
    expect(argv[argv.indexOf('--model') + 1]).toBe('haiku');
    expect(argv).not.toContain('--effort');
    expect(new SettingsService().getPlannerModel('claude-code')).toEqual({ model: 'sonnet', effort: 'high' });
    expect(pool.getSettings().orchestratorModel).toBe('sonnet');
  });
});
