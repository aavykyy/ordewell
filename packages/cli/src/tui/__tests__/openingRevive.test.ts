import { describe, expect, it, vi } from 'vitest';
import type { SurfacePlan } from '@ordewell/core';
import { DaemonError, WorkspaceInitNeededError, type SessionFollow } from '../../apiClient';
import { runEffect, type EffectDeps, type OrdewellApi } from '../effects';
import { initialState, reduce, type Action, type Effect } from '../reducer';
import type { TuiState } from '../state';
import { messagesOf } from './chat';

/**
 * An opening turn whose connection was refused waits for the daemon to be
 * revived, and the user may load another session meanwhile. The retry belongs
 * to the welcome that asked for it: it must not take over the session on
 * screen, nor carry that session's queued prompt into the opening.
 */

const refused = (): Error => Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:3742'), { code: 'ECONNREFUSED' });

const B_PLAN = {
  tasks: [],
  conversationHistory: [
    { role: 'user', content: 'Plan B', timestamp: '2026-10-29T10:00:00.000Z' },
    { role: 'assistant', content: 'Working on B.', timestamp: '2026-10-29T10:00:01.000Z' },
  ],
} as unknown as SurfacePlan;

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}

/** The reducer and the effect runner wired as `app.ts` wires them: every effect a step returns is run. */
function tui(api: Partial<OrdewellApi>, over: Partial<EffectDeps> = {}) {
  let state: TuiState = initialState({ workspace: '/ws' });
  const running = new Set<Promise<void>>();
  const deps: EffectDeps = {
    api: {
      startConversation: vi.fn(async () => ({ tasks: [], conversationHistory: [] })),
      sendConversationMessage: vi.fn(async () => ({ tasks: [] })),
      adoptSession: vi.fn(async () => ({ plan: B_PLAN, goal: 'Plan B', plannerTurnId: 'turn-b' })),
      getSettings: vi.fn(async () => ({})),
      getRunners: vi.fn(async () => ({ runners: [] })),
      getIsolationPreview: vi.fn(async () => ({ preview: { status: 'none', repos: [], shared: [] } })),
      streamPlanning: vi.fn(() => ({ ready: Promise.resolve(), close: () => {} })),
      followSession: vi.fn(() => ({ ready: Promise.resolve(true), ended: new Promise(() => {}), close: () => {} }) as SessionFollow),
      ...api,
    } as unknown as OrdewellApi,
    workspace: '/ws',
    port: 3742,
    dispatch: (action: Action) => apply(action),
    newSessionId: () => 'session-opening',
    setEnvVar: () => {},
    saveAutonomy: () => ({ overridden: false }),
    setMouseCapture: () => {},
    hasBin: () => true,
    pipeToClipboard: () => {},
    writeTerminal: () => {},
    reviveDaemon: vi.fn().mockResolvedValue(true),
    login: async () => ({ ok: true }),
    exit: () => {},
    ...over,
  };
  function fire(effect: Effect): void {
    const run = runEffect(effect, deps).finally(() => running.delete(run));
    running.add(run);
  }
  function apply(action: Action): void {
    const step = reduce(state, action);
    state = step.state;
    for (const effect of step.effects) fire(effect);
  }
  return {
    deps,
    api: deps.api as unknown as Record<string, ReturnType<typeof vi.fn>>,
    get state() { return state; },
    type(text: string): void {
      state = { ...state, editor: { ...state.editor, text, cursor: text.length } };
      apply({ type: 'key', key: { name: 'enter' } });
    },
    fire,
    async settle(): Promise<void> {
      while (running.size > 0) await Promise.allSettled([...running]);
    },
  };
}

describe('an opening retried after a revived daemon', () => {
  it('leaves a session loaded meanwhile, and its queued prompt, alone', async () => {
    const revive = deferred<boolean>();
    const h = tui(
      { startConversation: vi.fn().mockRejectedValueOnce(refused()).mockResolvedValue({ tasks: [], conversationHistory: [] }) },
      { reviveDaemon: vi.fn(() => revive.promise) },
    );

    h.type('Opening goal');
    await vi.waitFor(() => expect(h.deps.reviveDaemon).toHaveBeenCalled());

    h.fire({ type: 'loadSession', sessionId: 'B' });
    await vi.waitFor(() => expect(h.state.sessionId).toBe('B'));
    expect(h.state.planner).toBe('joined');
    h.type("B's next prompt");
    expect(h.state.queuedPrompts).toEqual(["B's next prompt"]);
    const transcript = messagesOf(h.state).map((m) => [m.role, m.text]);

    revive.resolve(true);
    await h.settle();

    expect(h.state.sessionId).toBe('B');
    expect(h.state.goal).toBe('Plan B');
    expect(h.state.planner).toBe('joined');
    expect(h.state.turnGate.open).toBe('turn-b');
    expect(h.state.queuedPrompts).toEqual(["B's next prompt"]);
    expect(messagesOf(h.state).map((m) => [m.role, m.text]).slice(0, transcript.length)).toEqual(transcript);
    expect(messagesOf(h.state).some((m) => m.text === 'Opening goal')).toBe(false);
    expect(h.api.sendConversationMessage).not.toHaveBeenCalled();
    // The welcome that asked for it is gone, so the goal is not opened behind B's back.
    expect(h.api.startConversation).toHaveBeenCalledTimes(1);

    // B's own turn ending is what sends B's prompt, to B.
    h.deps.dispatch({ type: 'sessionMessage', sessionId: 'B', message: { type: 'planner_turn_ended', turnId: 'turn-b', outcome: 'message' } });
    await h.settle();
    expect(h.api.sendConversationMessage).toHaveBeenCalledTimes(1);
    expect(h.api.sendConversationMessage).toHaveBeenCalledWith('B', "B's next prompt");
  });

  it('retries an opening still on screen, in the same session, and drains what was typed behind it there', async () => {
    const revive = deferred<boolean>();
    const h = tui(
      { startConversation: vi.fn().mockRejectedValueOnce(refused()).mockResolvedValue({ tasks: [], conversationHistory: [] }) },
      { reviveDaemon: vi.fn(() => revive.promise) },
    );

    h.type('Opening goal');
    await vi.waitFor(() => expect(h.deps.reviveDaemon).toHaveBeenCalled());
    expect(h.state.sessionId).toBe('session-opening');
    h.type('and then this');
    expect(h.state.queuedPrompts).toEqual(['and then this']);

    revive.resolve(true);
    await h.settle();

    expect(h.api.startConversation).toHaveBeenCalledTimes(2);
    expect(h.api.startConversation.mock.calls.map((c) => c[0])).toEqual(['session-opening', 'session-opening']);
    expect(h.api.sendConversationMessage).toHaveBeenCalledWith('session-opening', 'and then this');
    expect(h.state.sessionId).toBe('session-opening');
    expect(messagesOf(h.state).map((m) => m.text)).toContain('The server had stopped; started a new one and retried.');
  });

  it('lets the opening go, onto the welcome, when the daemon does not come back', async () => {
    const h = tui(
      { startConversation: vi.fn().mockRejectedValue(refused()) },
      { reviveDaemon: vi.fn().mockResolvedValue(false) },
    );

    h.type('Opening goal');
    await h.settle();

    expect(h.state.sessionId).toBeNull();
    expect(h.state.planner).toBe('idle');
    expect(messagesOf(h.state).at(-1)).toMatchObject({ role: 'error' });
    expect(messagesOf(h.state).at(-1)?.text).toContain('No Ordewell server is listening on port 3742');
  });

  it('does not revive twice for one opening: a refused retry is reported on the welcome', async () => {
    const h = tui({ startConversation: vi.fn().mockRejectedValue(refused()) });

    h.type('Opening goal');
    await h.settle();

    expect(h.deps.reviveDaemon).toHaveBeenCalledTimes(1);
    expect(h.api.startConversation).toHaveBeenCalledTimes(2);
    expect(h.state.sessionId).toBeNull();
    expect(h.state.planner).toBe('idle');
    expect(messagesOf(h.state).at(-1)?.text).toContain('No Ordewell server is listening on port 3742');
  });

  it('does not send a goal stopped while the daemon was down', async () => {
    const revive = deferred<boolean>();
    const h = tui(
      {
        startConversation: vi.fn().mockRejectedValueOnce(refused()).mockResolvedValue({ tasks: [], conversationHistory: [] }),
        cancelPlanning: vi.fn().mockRejectedValue(new DaemonError('Session not found', 404, 'session_not_found')),
      },
      { reviveDaemon: vi.fn(() => revive.promise) },
    );

    h.type('Opening goal');
    await vi.waitFor(() => expect(h.deps.reviveDaemon).toHaveBeenCalled());
    h.type('/stop');

    revive.resolve(true);
    await h.settle();

    expect(h.api.startConversation).toHaveBeenCalledTimes(1);
    expect(h.state.sessionId).toBeNull();
    expect(h.state.planner).toBe('idle');
  });

  it('does not ask to initialize the workspace over a session loaded while the opening was refused', async () => {
    const answer = deferred<void>();
    const h = tui({
      startConversation: vi.fn(async () => {
        await answer.promise;
        throw new WorkspaceInitNeededError('not a project', '/ws');
      }),
    });

    h.type('Opening goal');
    await vi.waitFor(() => expect(h.api.startConversation).toHaveBeenCalled());
    h.fire({ type: 'loadSession', sessionId: 'B' });
    await vi.waitFor(() => expect(h.state.sessionId).toBe('B'));
    h.type("B's next prompt");

    answer.resolve();
    await h.settle();

    expect(h.state.sessionId).toBe('B');
    expect(h.state.overlay).toBeNull();
    expect(h.state.planner).toBe('joined');
    expect(h.state.queuedPrompts).toEqual(["B's next prompt"]);
  });

  it('still asks on the welcome when the opening is the one on screen', async () => {
    const h = tui({ startConversation: vi.fn().mockRejectedValue(new WorkspaceInitNeededError('not a project', '/ws')) });

    h.type('Opening goal');
    await h.settle();

    expect(h.state.sessionId).toBeNull();
    expect(h.state.overlay).toMatchObject({ kind: 'confirm', action: { kind: 'init-workspace', goal: 'Opening goal' } });
  });

  it("keeps the opening's read-back, after a lost reply, off a session loaded meanwhile", async () => {
    const readBack = deferred<void>();
    const h = tui({
      startConversation: vi.fn().mockRejectedValue(Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' })),
      adoptSession: vi.fn(async (id: string) => {
        if (id === 'B') return { plan: B_PLAN, goal: 'Plan B', plannerTurnId: 'turn-b' };
        await readBack.promise;
        throw new DaemonError('internal error', 500);
      }),
    });

    h.type('Opening goal');
    await vi.waitFor(() => expect(h.api.adoptSession).toHaveBeenCalledWith('session-opening', '/ws'));
    h.fire({ type: 'loadSession', sessionId: 'B' });
    await vi.waitFor(() => expect(h.state.sessionId).toBe('B'));
    const transcript = messagesOf(h.state).map((m) => [m.role, m.text]);

    readBack.resolve();
    await h.settle();

    expect(h.state.sessionId).toBe('B');
    expect(h.state.planner).toBe('joined');
    expect(messagesOf(h.state).map((m) => [m.role, m.text])).toEqual(transcript);
  });

  it('leaves a fork made while the daemon came back on screen, with the approval waiting in it', async () => {
    const revive = deferred<boolean>();
    const h = tui(
      {
        startConversation: vi.fn().mockRejectedValueOnce(refused()).mockResolvedValue({ tasks: [], conversationHistory: [] }),
        // /fork asks for an idle planner, so B has no turn running.
        adoptSession: vi.fn(async () => ({ plan: B_PLAN, goal: 'Plan B' })),
        forkConversation: vi.fn(async () => ({ sessionId: 'B2', goal: 'Plan B', plan: B_PLAN })),
      },
      { reviveDaemon: vi.fn(() => revive.promise) },
    );

    h.type('Opening goal');
    await vi.waitFor(() => expect(h.deps.reviveDaemon).toHaveBeenCalled());
    h.fire({ type: 'loadSession', sessionId: 'B' });
    await vi.waitFor(() => expect(h.state.sessionId).toBe('B'));
    h.type('/fork');
    await vi.waitFor(() => expect(h.state.sessionId).toBe('B2'));
    h.deps.dispatch({
      type: 'sessionMessage', sessionId: 'B2',
      message: { type: 'approval_request', id: 'ap-1', kind: 'shell_command', subject: 'npm test', scope: 'npm test' },
    });
    expect(h.state.overlay).toMatchObject({ kind: 'approval', request: { id: 'ap-1' } });

    revive.resolve(true);
    await h.settle();

    expect(h.api.forkConversation).toHaveBeenCalledWith('B');
    expect(h.api.startConversation).toHaveBeenCalledTimes(1);
    expect(h.state.sessionId).toBe('B2');
    expect(h.state.overlay).toMatchObject({ kind: 'approval', request: { id: 'ap-1' } });
  });
});
