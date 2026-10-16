import { afterEach, describe, expect, it, vi } from 'vitest';
import { RunnerInstallation } from '../RunnerInstallation';
import type { ExecImpl } from '../ModelDiscovery';
import type { RunnerRegistry } from '../../plugins/RunnerRegistry';
import { CLAUDE_CODE_MANIFEST } from '../../plugins/builtin/claude-code.manifest';
import { CODEX_MANIFEST } from '../../plugins/builtin/codex.manifest';
import { OPENCODE_MANIFEST } from '../../plugins/builtin/opencode.manifest';
import {
  detectInstalledPlanner, findInstalledPlanner, installedPlannerDetected, recordedInstalledPlanner, resetInstalledPlanner,
} from '../InstalledPlanner';

const ALL = [CLAUDE_CODE_MANIFEST, CODEX_MANIFEST, OPENCODE_MANIFEST];

function registryWith(...manifests: Array<{ name: string; runner: { command: string } }>): RunnerRegistry {
  const byName = new Map(manifests.map((m) => [m.name, m]));
  return { getManifest: (id: string) => byName.get(id) } as unknown as RunnerRegistry;
}

/** An exec that answers `--version` only for the given commands. */
function installedOnly(...commands: string[]): ExecImpl {
  return vi.fn(async (command: string) => {
    if (commands.some((c) => command === `${c} --version`)) return { stdout: '1.0.0' };
    throw new Error('command not found');
  });
}

describe('findInstalledPlanner', () => {
  it('picks the first harness planner in display order when several are installed', async () => {
    const inst = new RunnerInstallation(registryWith(...ALL), installedOnly('claude', 'codex', 'opencode'));
    expect(await findInstalledPlanner(inst)).toBe('claude-code');
  });

  it('skips an agent that is not installed', async () => {
    const inst = new RunnerInstallation(registryWith(...ALL), installedOnly('opencode'));
    expect(await findInstalledPlanner(inst)).toBe('opencode');
  });

  it('skips an agent with no manifest registered', async () => {
    const inst = new RunnerInstallation(registryWith(CODEX_MANIFEST), installedOnly('claude', 'codex'));
    expect(await findInstalledPlanner(inst)).toBe('codex');
  });

  it('answers null when no coding agent is installed', async () => {
    const inst = new RunnerInstallation(registryWith(...ALL), installedOnly());
    expect(await findInstalledPlanner(inst)).toBeNull();
  });
});

describe('detectInstalledPlanner', () => {
  afterEach(() => resetInstalledPlanner());

  it('records the agent it finds, for detectProvider to read', async () => {
    const inst = new RunnerInstallation(registryWith(...ALL), installedOnly('codex'));
    await detectInstalledPlanner(inst);
    expect(recordedInstalledPlanner()).toBe('codex');
  });

  it('lets a planner turn wait for a probe still in flight', async () => {
    let answer!: (value: { usable: boolean }) => void;
    const gate = new Promise<{ usable: boolean }>((resolve) => { answer = resolve; });
    const slow = { plannerUsability: vi.fn(() => gate) };
    void detectInstalledPlanner(slow);

    let settled = false;
    const waiting = installedPlannerDetected().then(() => { settled = true; });
    await Promise.resolve();
    expect(settled).toBe(false);

    answer({ usable: true });
    await waiting;
    expect(recordedInstalledPlanner()).toBe('claude-code');
  });

  it('does not hold a turn up when no probe was started', async () => {
    await expect(installedPlannerDetected()).resolves.toBeUndefined();
  });

  it('records no agent when the probe itself fails, rather than failing the turn that waits', async () => {
    const broken = { plannerUsability: vi.fn(async () => { throw new Error('boom'); }) };
    await expect(detectInstalledPlanner(broken)).resolves.toBeNull();
    await expect(installedPlannerDetected()).resolves.toBeUndefined();
    expect(recordedInstalledPlanner()).toBeNull();
  });
});
