import { describe, it, expect } from 'vitest';
import { McpAttachError, spawnAttached } from '../ordewellBinding';

/**
 * The ADR-0025 rule, once for every runner: a spawn reports the server
 * connected or is killed with its token, and one respawn is all it gets.
 */
function spawning(reports: boolean[]) {
  const adapters: Array<{ disposed: boolean; startedWith?: string; mcpAttached(): Promise<boolean>; dispose(): void }> = [];
  const issued: string[] = [];
  const revoked: string[] = [];
  const respawns: string[] = [];
  const spawn = () => spawnAttached({
    runner: 'claude-code',
    create: () => {
      const attached = reports[adapters.length] ?? false;
      const adapter = {
        disposed: false,
        startedWith: undefined as string | undefined,
        mcpAttached: async () => attached,
        dispose: () => { adapter.disposed = true; },
      };
      adapters.push(adapter);
      return adapter;
    },
    issueToken: async () => {
      const token = `tok-${issued.length + 1}`;
      issued.push(token);
      return { url: 'http://127.0.0.1:1/mcp', token };
    },
    revoke: (token) => { revoked.push(token); },
    start: async (adapter, credential) => { adapter.startedWith = credential.token; },
    onRespawn: (failure) => { respawns.push(failure); },
    failed: (first, second) => `Could not start. First spawn: ${first}. Respawn: ${second}.`,
  });
  return { spawn, adapters, issued, revoked, respawns };
}

describe('spawnAttached', () => {
  it('keeps the first spawn when its runner reports the server connected', async () => {
    const env = spawning([true]);

    const spawned = await env.spawn();

    expect(spawned?.token).toBe('tok-1');
    expect(spawned?.adapter).toBe(env.adapters[0]);
    expect(env.adapters[0]).toMatchObject({ disposed: false, startedWith: 'tok-1' });
    expect(env.revoked).toEqual([]);
    expect(env.respawns).toEqual([]);
  });

  it('kills a spawn that did not attach, takes its token back and keeps the respawn on a fresh token', async () => {
    const env = spawning([false, true]);

    const spawned = await env.spawn();

    expect(spawned?.token).toBe('tok-2');
    expect(spawned?.adapter).toBe(env.adapters[1]);
    expect(env.adapters[0].disposed).toBe(true);
    expect(env.adapters[1]).toMatchObject({ disposed: false, startedWith: 'tok-2' });
    expect(env.revoked).toEqual(['tok-1']);
    expect(env.respawns).toEqual(['claude-code did not report Ordewell\'s MCP server connected']);
  });

  it('throws McpAttachError when the respawn does not attach either, with both spawns killed and both tokens revoked', async () => {
    const env = spawning([false, false]);

    const spawned = env.spawn();

    await expect(spawned).rejects.toBeInstanceOf(McpAttachError);
    await expect(spawned).rejects.toThrow(
      'Could not start. First spawn: claude-code did not report Ordewell\'s MCP server connected. Respawn: claude-code did not report Ordewell\'s MCP server connected.',
    );
    expect(env.adapters).toHaveLength(2);
    expect(env.adapters.every((adapter) => adapter.disposed)).toBe(true);
    expect(env.revoked).toEqual(['tok-1', 'tok-2']);
  });
});
