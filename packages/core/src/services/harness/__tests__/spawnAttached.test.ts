import { describe, it, expect, vi } from 'vitest';
import { MCP_ATTACH_TIMEOUT_MS, McpAttachError, McpAttachTimeout, awaitAttach, spawnAttached, type AttachState } from '../ordewellBinding';

/**
 * The ADR-0025 rule, once for every runner: a spawn reports the server
 * connected or is killed with its token, and one respawn is all it gets.
 */
function spawning(reports: Array<boolean | AttachState>) {
  const adapters: Array<{ disposed: boolean; startedWith?: string; mcpAttached(): Promise<boolean | AttachState>; dispose(): void }> = [];
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

  it('keeps waiting while its runner stays pending past ten seconds, then connects', async () => {
    vi.useFakeTimers();
    try {
      const started = Date.now();
      const disposed: string[] = [];
      const spawned = spawnAttached({
        runner: 'claude-code',
        create: () => {
          const id = `adapter-${disposed.length + 1}`;
          return {
            dispose: () => { disposed.push(id); },
            mcpAttached: () => awaitAttach(
              async () => (Date.now() - started >= 11_000 ? 'connected' : 'pending'),
              MCP_ATTACH_TIMEOUT_MS,
              1_000,
            ),
          };
        },
        issueToken: async () => ({ url: 'http://127.0.0.1:1/mcp', token: 'tok-1' }),
        revoke: () => {},
        start: async () => {},
        failed: (first, second) => `${first} ${second}`,
      });

      await vi.advanceTimersByTimeAsync(12_000);
      const attached = await spawned;

      expect(attached?.token).toBe('tok-1');
      expect(disposed).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('takes a runner back at once when the attempt is cancelled while it is still starting', async () => {
    const cancel = new AbortController();
    const disposed: string[] = [];
    const revoked: string[] = [];
    const spawned = spawnAttached({
      runner: 'opencode',
      create: () => ({ dispose: () => { disposed.push('adapter'); }, mcpAttached: async () => 'connected' as const }),
      issueToken: async () => ({ url: 'http://127.0.0.1:1/mcp', token: 'tok-1' }),
      revoke: (token) => { revoked.push(token); },
      start: () => new Promise<void>(() => {}),
      cancelled: cancel.signal,
      failed: (first, second) => `${first} ${second}`,
    });
    await Promise.resolve();
    cancel.abort();

    await expect(spawned).resolves.toBeNull();
    expect(disposed).toEqual(['adapter']);
    expect(revoked).toEqual(['tok-1']);
  });

  it('kills a spawn that did not attach, takes its token back and keeps the respawn on a fresh token', async () => {
    const env = spawning(['pending', true]);

    const spawned = await env.spawn();

    expect(spawned?.token).toBe('tok-2');
    expect(spawned?.adapter).toBe(env.adapters[1]);
    expect(env.adapters[0].disposed).toBe(true);
    expect(env.adapters[1]).toMatchObject({ disposed: false, startedWith: 'tok-2' });
    expect(env.revoked).toEqual(['tok-1']);
    expect(env.respawns).toEqual(['claude-code did not report Ordewell\'s MCP server connected']);
  });

  it('respawns once when the runner reported the server failed, and keeps a later connection', async () => {
    const env = spawning(['failed', 'connected']);

    const spawned = await env.spawn();

    expect(spawned?.token).toBe('tok-2');
    expect(env.adapters[0].disposed).toBe(true);
  });

  it('throws McpAttachTimeout when the respawn never connects, with both spawns killed and both tokens revoked', async () => {
    const env = spawning(['pending', 'pending']);

    const spawned = env.spawn();

    await expect(spawned).rejects.toBeInstanceOf(McpAttachTimeout);
    await expect(spawned).rejects.toThrow(
      'Could not start. First spawn: claude-code did not report Ordewell\'s MCP server connected. Respawn: claude-code did not report Ordewell\'s MCP server connected.',
    );
    expect(env.adapters).toHaveLength(2);
    expect(env.adapters.every((adapter) => adapter.disposed)).toBe(true);
    expect(env.revoked).toEqual(['tok-1', 'tok-2']);
  });

  it('throws McpAttachError when the respawn reports the server failed, so a configuration problem is never a hold', async () => {
    const env = spawning(['failed', 'failed']);

    const spawned = env.spawn();

    await expect(spawned).rejects.toBeInstanceOf(McpAttachError);
    expect(env.adapters).toHaveLength(2);
    expect(env.adapters.every((adapter) => adapter.disposed)).toBe(true);
    expect(env.revoked).toEqual(['tok-1', 'tok-2']);
  });
});

describe('awaitAttach', () => {
  it('keeps waiting past ten seconds while the runner is alive and still pending', async () => {
    vi.useFakeTimers();
    try {
      const started = Date.now();
      // A runner on a loaded machine may stay pending well past the ten
      // seconds that used to end the wait, then connect without ever failing.
      const attached = awaitAttach(
        async () => (Date.now() - started >= 11_000 ? 'connected' : 'pending'),
        MCP_ATTACH_TIMEOUT_MS,
        1_000,
      );

      await vi.advanceTimersByTimeAsync(12_000);

      expect(await attached).toBe('connected');
    } finally {
      vi.useRealTimers();
    }
  });

  it('stops at once when the runner reports the server failed', async () => {
    vi.useFakeTimers();
    try {
      const started = Date.now();
      const attached = awaitAttach(
        async () => (Date.now() - started >= 1_000 ? 'failed' : 'pending'),
        60_000,
        1_000,
      );

      await vi.advanceTimersByTimeAsync(5_000);

      expect(await attached).toBe('failed');
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not let a probe that never answers outlast the cap', async () => {
    vi.useFakeTimers();
    try {
      const attached = awaitAttach(() => new Promise<AttachState>(() => {}), 5_000, 1_000);

      await vi.advanceTimersByTimeAsync(6_000);

      expect(await attached).toBe('pending');
    } finally {
      vi.useRealTimers();
    }
  });

  it('is failed as soon as the process ends under a probe that never answers', async () => {
    vi.useFakeTimers();
    try {
      let exit!: () => void;
      const ended = new Promise<void>((resolve) => { exit = resolve; });
      const attached = awaitAttach(() => new Promise<AttachState>(() => {}), 60_000, 1_000, ended);

      await vi.advanceTimersByTimeAsync(1_000);
      exit();

      expect(await attached).toBe('failed');
    } finally {
      vi.useRealTimers();
    }
  });

  it('is pending when the cap passes with the runner still starting', async () => {
    vi.useFakeTimers();
    try {
      const attached = awaitAttach(async () => 'pending', 5_000, 1_000);

      await vi.advanceTimersByTimeAsync(6_000);

      expect(await attached).toBe('pending');
    } finally {
      vi.useRealTimers();
    }
  });
});
