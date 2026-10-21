import { describe, it, expect } from 'vitest';
import { CodexSandboxAvailability } from '../harness/codexSandbox';
import { RunnerRegistry } from '../../plugins/RunnerRegistry';
import { runnerModesFrom } from '../ModeResolver';
import type { AgentProcessDeps } from '../harness/AgentAdapter';
import { fakeSpawn } from './harnessTestKit';

const BWRAP_FAILURE = 'bwrap: loopback: Failed RTM_NEWADDR: Operation not permitted\n';

function host(probe: (args: string[]) => { code: number; output?: string }) {
  const spawned = fakeSpawn([], { probe });
  const deps: AgentProcessDeps = {
    spawn: spawned.spawn,
    fetch: (async () => { throw new Error('no HTTP in this test'); }) as unknown as typeof fetch,
    platform: 'linux',
    resolvePath: async () => '/usr/bin',
  };
  const registry = new RunnerRegistry();
  return { registry, availability: new CodexSandboxAvailability(registry, deps, { cwd: '/repo', env: {} }), probes: spawned.probeArgs };
}

const codexModes = (registry: RunnerRegistry) => runnerModesFrom(registry, ['codex']).codex;
const unavailableIds = (registry: RunnerRegistry) => codexModes(registry).filter((m) => m.unavailable).map((m) => m.id);

describe('CodexSandboxAvailability', () => {
  it('marks the sandboxed Codex modes unavailable, with a reason, and keeps Full access', async () => {
    const { registry, availability } = host(() => ({ code: 1, output: BWRAP_FAILURE }));

    await availability.refresh();

    expect(unavailableIds(registry)).toEqual(['agent']);
    const plan = codexModes(registry).find((m) => m.id === 'plan');
    expect(plan?.unavailable).toBeUndefined();
    expect(codexModes(registry).find((m) => m.id === 'fullAccess')?.unavailable).toBeUndefined();
  });

  it('changes nothing when the sandbox starts', async () => {
    const { registry, availability } = host(() => ({ code: 0 }));

    await availability.refresh();

    expect(unavailableIds(registry)).toEqual([]);
  });

  it('probes once per daemon, and again only when asked', async () => {
    let broken = true;
    const { registry, availability, probes } = host(() => (broken ? { code: 1, output: BWRAP_FAILURE } : { code: 0 }));

    await availability.ensure();
    await availability.ensure();
    expect(probes()).toHaveLength(2); // bubblewrap, then the Landlock fallback — one probe round
    expect(unavailableIds(registry)).toEqual(['agent']);

    broken = false;
    await availability.refresh();
    expect(unavailableIds(registry)).toEqual([]);
  });
});
