import { describe, it, expect, vi } from 'vitest';
import { RunnerRegistry, type RunnerAuth } from '@ordewell/core';
import { commandLine, loginPlanner, type PlannerLoginDeps } from '../PlannerLogin';

interface FakeTerminal {
  options: { name?: string; cwd?: string; env?: Record<string, string> };
  sent: string[];
  shown: number;
  exitStatus: { code: number | undefined } | undefined;
  sendText(text: string): void;
  show(): void;
  dispose(): void;
}

interface HarnessOptions {
  aiProvider?: string;
  /** What probe `n` answers; probe 1 is the verdict read before the terminal opens. */
  verdict?: (probe: number) => RunnerAuth | undefined;
  /** Runs right after each probe answers, so a test can close the terminal mid-flow. */
  afterProbe?: (probe: number, close: () => void) => void;
  timeoutMs?: number;
}

const SIGNED_OUT_CLAUDE: RunnerAuth = { state: 'signed-out', loginCommand: ['claude', 'auth', 'login'] };

function harness(options: HarnessOptions = {}) {
  let probe = 0;
  let clock = 0;
  const closeListeners: Array<(terminal: FakeTerminal) => void> = [];
  const terminal: FakeTerminal = {
    options: {},
    sent: [],
    shown: 0,
    exitStatus: undefined,
    sendText(text: string) { terminal.sent.push(text); },
    show() { terminal.shown += 1; },
    dispose() { close(); },
  };
  const createTerminal = vi.fn((opts: FakeTerminal['options']) => {
    terminal.options = opts;
    return terminal;
  });
  const close = (): void => {
    terminal.exitStatus = { code: 0 };
    for (const cb of [...closeListeners]) cb(terminal);
  };

  const verdict = options.verdict ?? (() => SIGNED_OUT_CLAUDE);
  const deps = {
    runnerInstallation: {
      plannerUsability: vi.fn(async () => {
        probe += 1;
        options.afterProbe?.(probe, close);
        return { usable: true, auth: verdict(probe) };
      }),
      refresh: vi.fn(),
    },
    // The real registry: the ids and labels a webview can name are its own.
    runnerRegistry: new RunnerRegistry(),
    config: { aiProvider: options.aiProvider ?? 'claude-code' },
    workspaceRoot: () => '/ws',
    env: async () => ({ CLAUDE_CONFIG_DIR: '/accounts/other' }),
    sendState: vi.fn(async () => {}),
    post: vi.fn(),
    notifications: { info: vi.fn(), warn: vi.fn() },
    window: {
      createTerminal,
      onDidCloseTerminal: vi.fn((cb: (t: FakeTerminal) => void) => {
        closeListeners.push(cb);
        return { dispose: vi.fn() };
      }),
    },
    // Instant, and a clock that moves with it: no real seconds, no fake timers.
    sleep: async (ms: number) => { clock += ms; },
    now: () => clock,
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
    log: vi.fn(),
  } as unknown as PlannerLoginDeps;

  return {
    deps,
    terminal,
    createTerminal,
    close,
    /** The last word the webview is told the login ended with. */
    ended: () => vi.mocked(deps.post).mock.calls.map(([msg]) => msg).filter((msg) => msg.type === 'plannerLoginEnded').at(-1),
  };
}

describe('loginPlanner', () => {
  it('signs in the active planner when the message names no runner, in its own terminal', async () => {
    // Signed out while it opens the terminal, signed in on the second poll.
    const h = harness({ verdict: (probe) => (probe >= 3 ? { ...SIGNED_OUT_CLAUDE, state: 'signed-in' } : SIGNED_OUT_CLAUDE) });

    await loginPlanner(h.deps);

    expect(h.deps.runnerInstallation.plannerUsability).toHaveBeenCalledWith('claude-code');
    expect(h.createTerminal).toHaveBeenCalledWith({
      name: 'Claude Code login',
      cwd: '/ws',
      env: { CLAUDE_CONFIG_DIR: '/accounts/other' },
    });
    expect(h.terminal.shown).toBe(1);
    // The manifest's own argv, typed into the terminal exactly once.
    expect(h.terminal.sent).toEqual(['claude auth login']);
    expect(h.deps.runnerInstallation.refresh).toHaveBeenCalled();
    expect(h.deps.sendState).toHaveBeenCalled();
    expect(h.ended()).toEqual({ type: 'plannerLoginEnded', runner: 'claude-code', ok: true });
    expect(h.deps.notifications.info).toHaveBeenCalledWith('Signed in to Claude Code.');
    expect(h.deps.notifications.warn).not.toHaveBeenCalled();
  });

  it('signs in a named runner without making it the planner', async () => {
    const h = harness({
      aiProvider: 'claude-code',
      verdict: (probe) => (probe >= 3
        ? { state: 'signed-in', loginCommand: ['codex', 'login'] }
        : { state: 'signed-out', loginCommand: ['codex', 'login'] }),
    });

    await loginPlanner(h.deps, 'codex');

    expect(h.deps.runnerInstallation.plannerUsability).toHaveBeenCalledWith('codex');
    expect(h.createTerminal).toHaveBeenCalledWith(expect.objectContaining({ name: 'Codex login' }));
    expect(h.terminal.sent).toEqual(['codex login']);
    expect(h.deps.config.aiProvider).toBe('claude-code');
    expect(h.ended()).toEqual({ type: 'plannerLoginEnded', runner: 'codex', ok: true });
    expect(h.deps.notifications.info).toHaveBeenCalledWith('Signed in to Codex.');
  });

  it('says so instead of opening a terminal for an agent it has no login for', async () => {
    const h = harness({ verdict: () => ({ state: 'unknown' }) });

    await loginPlanner(h.deps, 'opencode');

    expect(h.createTerminal).not.toHaveBeenCalled();
    expect(h.deps.notifications.info).toHaveBeenCalledWith('Ordewell has no login for OpenCode.');
    // Still answers the click, or the row's button would wait forever.
    expect(h.ended()).toEqual({
      type: 'plannerLoginEnded', runner: 'opencode', ok: false, message: 'Ordewell has no login for OpenCode.',
    });
  });

  it('tells the user when no terminal can be opened at all, and closes the pending state', async () => {
    const h = harness();
    h.createTerminal.mockImplementation(() => { throw new Error('no terminals'); });

    await loginPlanner(h.deps);

    expect(h.deps.runnerInstallation.plannerUsability).toHaveBeenCalledTimes(1);
    expect(h.ended()).toEqual({
      type: 'plannerLoginEnded', runner: 'claude-code', ok: false, message: 'The login terminal could not be opened.',
    });
    expect(h.deps.notifications.info).toHaveBeenCalledWith('Could not open a terminal to sign in to Claude Code.');
    expect(h.deps.log).toHaveBeenCalledWith(expect.stringContaining('no terminals'));
  });

  it('does nothing for an id no runner manifest owns', async () => {
    const h = harness();

    await loginPlanner(h.deps, 'not-a-runner');

    expect(h.deps.runnerInstallation.plannerUsability).not.toHaveBeenCalled();
    expect(h.createTerminal).not.toHaveBeenCalled();
    expect(h.deps.post).not.toHaveBeenCalled();
    expect(h.deps.log).toHaveBeenCalledWith(expect.stringContaining('not-a-runner'));
  });

  it('ends as a failure the moment the user closes the terminal, and stops polling', async () => {
    const h = harness({ afterProbe: (probe, close) => { if (probe === 2) close(); } });

    await loginPlanner(h.deps);

    expect(vi.mocked(h.deps.runnerInstallation.plannerUsability).mock.calls.length).toBe(2);
    expect(h.deps.sendState).not.toHaveBeenCalled();
    expect(h.ended()).toEqual({
      type: 'plannerLoginEnded', runner: 'claude-code', ok: false, message: 'The terminal closed before sign-in finished.',
    });
    expect(h.deps.notifications.warn).toHaveBeenCalledWith(expect.stringContaining('Claude Code'));
  });

  it('ends as a failure after the time limit, with the reason inline', async () => {
    const h = harness({ timeoutMs: 60_000, verdict: () => SIGNED_OUT_CLAUDE });

    await loginPlanner(h.deps);

    expect(h.deps.sendState).not.toHaveBeenCalled();
    expect(h.ended()).toEqual({
      type: 'plannerLoginEnded', runner: 'claude-code', ok: false, message: 'Sign-in did not finish in time.',
    });
  });

  it('does not report a signed-in agent as failed when the state push rejects', async () => {
    const h = harness({ verdict: (probe) => (probe >= 2 ? { ...SIGNED_OUT_CLAUDE, state: 'signed-in' } : SIGNED_OUT_CLAUDE) });
    vi.mocked(h.deps.sendState).mockRejectedValueOnce(new Error('probe failed'));

    await loginPlanner(h.deps);

    expect(h.ended()).toEqual({ type: 'plannerLoginEnded', runner: 'claude-code', ok: true });
    expect(h.deps.log).toHaveBeenCalledWith(expect.stringContaining('probe failed'));
  });
});

describe('commandLine', () => {
  it('quotes only what the shell would split', () => {
    expect(commandLine(['claude', 'auth', 'login'])).toBe('claude auth login');
    expect(commandLine(['/opt/My Agent/bin', '--config', '/a b/c'])).toBe(`'/opt/My Agent/bin' --config '/a b/c'`);
  });
});
