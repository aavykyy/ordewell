import { describe, expect, it, vi, type Mock, type Mocked } from 'vitest';
import { runEffect, type EffectDeps, type OrdewellApi } from '../effects';
import { initialState, reduce, type Action } from '../reducer';
import type { TuiState } from '../state';
import { messagesOf } from './chat';

/**
 * Adversarial: a planner turn on screen has to survive the controls around it
 * (ADR-0017, ADR-0029). Switching to another session — a fork, a load, a clear
 * — must never carry one session's turn or queued prompts into another, and a
 * plan refresh a task control causes must not end the turn or drain the queue.
 */

const enter = { type: 'key' as const, key: { name: 'enter' } };
const ctrlS = { type: 'key' as const, key: { name: 'ctrl-s' } };

function harness(api: Partial<OrdewellApi> = {}, over: Partial<EffectDeps> = {}) {
  const actions: Action[] = [];
  const deps: EffectDeps = {
    api: {
      execute: vi.fn().mockResolvedValue({ ok: true, message: 'Marked task #1 "Task t1" complete.' }),
      getSession: vi.fn().mockResolvedValue({ meta: { id: 's1', goal: 'g' }, plan: { tasks: [] }, run: { tasks: [], runMerge: null, handoff: null, mergeResult: null } }),
      ...api,
    } as OrdewellApi,
    workspace: '/ws',
    port: 3742,
    dispatch: (action) => actions.push(action),
    newSessionId: () => 'session-new',
    setEnvVar: () => {},
    saveAutonomy: () => ({ overridden: false }),
    setMouseCapture: vi.fn(),
    hasBin: () => true,
    pipeToClipboard: vi.fn(),
    writeTerminal: vi.fn(),
    reviveDaemon: vi.fn().mockResolvedValue(true),
    login: async () => ({ ok: true }),
    exit: vi.fn(),
    ...over,
  };
  return { deps, actions, api: deps.api as Mocked<OrdewellApi> };
}

/** A turn another client opened, as the socket announces it: the gate is open. */
const midTurn = (over: Partial<TuiState> = {}): TuiState =>
  reduce(initialState({ sessionId: 's1', planner: 'idle', ...over }), {
    type: 'sessionMessage',
    sessionId: 's1',
    message: { type: 'planner_turn_started', turnId: 't1', prompt: 'Research the repository' },
  }).state;

/** The TUI's own turn in flight, with a prompt queued behind it. */
const turnWithQueue = (): TuiState => reduce(withDraft(midTurn({ planner: 'planning' as const }), 'second prompt'), enter).state;

const withDraft = (state: TuiState, text: string): TuiState => ({
  ...state,
  editor: { ...state.editor, text, cursor: text.length },
});

describe('adversarial: switching session mid-turn', () => {
  it('a fork mid-turn holds the queued prompts: none of them goes to the fork', () => {
    expect(turnWithQueue().queuedPrompts).toHaveLength(1);

    const forked = reduce(turnWithQueue(), { type: 'sessionForked', sessionId: 's2', goal: 'g' }).state;

    expect(forked.queuedPrompts).toHaveLength(0);
    expect(forked.planner).toBe('idle');
    expect(forked.sessionId).toBe('s2');
  });

  it('the fork starts with no turn of its own: its gate is closed, so ctrl-s is the plain send enter is', () => {
    const forked = reduce(midTurn(), { type: 'sessionForked', sessionId: 's2', goal: 'g' }).state;

    expect(forked.turnGate.open).toBeNull();
    const sent = reduce(withDraft(forked, 'hello fork'), ctrlS);
    expect(sent.effects).toEqual([{ type: 'sendMessage', sessionId: 's2', message: 'hello fork' }]);
  });

  it('loading a session mid-turn closes the gate the old turn held', () => {
    const loaded = reduce(midTurn(), { type: 'sessionLoaded', sessionId: 's2', goal: 'g' }).state;

    expect(loaded.turnGate.open).toBeNull();
  });

  it('clearing a failed start mid-turn drops the queued prompts with the session', () => {
    expect(turnWithQueue().queuedPrompts).toHaveLength(1);

    const cleared = reduce(turnWithQueue(), { type: 'sessionCleared' }).state;

    expect(cleared.sessionId).toBeNull();
    expect(cleared.queuedPrompts).toHaveLength(0);
    expect(cleared.pendingApprovals).toHaveLength(0);
  });

  it('clearing a failed start mid-turn hands the queued prompts back to the editor, above a draft', () => {
    const cleared = reduce(withDraft(turnWithQueue(), 'a draft'), { type: 'sessionCleared' }).state;

    expect(cleared.editor.text).toBe('second prompt\na draft');
  });

  it.each([
    ['loading', { type: 'sessionLoaded', sessionId: 's2', goal: 'g' }],
    ['forking', { type: 'sessionForked', sessionId: 's2', goal: 'g' }],
  ] as [string, Action][])("%s a session after /stop does not silence the new session's turn failure", (_, switched) => {
    const stopped = reduce(withDraft(midTurn({ planner: 'planning' as const }), '/stop'), enter).state;
    expect(stopped.stopRequested).toBe(true);

    const other = reduce(stopped, switched).state;
    expect(other.stopRequested).toBe(false);
    const failed = reduce({ ...other, planner: 'planning' }, { type: 'failed', message: 'the turn broke', turn: true, sessionId: 's2' }).state;

    expect(messagesOf(failed).at(-1)).toMatchObject({ role: 'error', text: 'the turn broke' });
  });
});

describe('adversarial: a plan refresh a task control causes, mid-turn', () => {
  it('the task-control effect answers with a refresh, not a turn end', async () => {
    const h = harness();

    await runEffect({ type: 'taskAction', sessionId: 's1', taskId: 't1', action: 'complete' }, h.deps);

    const kinds = h.actions.map((a) => a.type);
    expect(kinds).not.toContain('planUpdated');
    expect(kinds).toContain('planRefreshed');
    // The run the refresh carries is the Session's own word on the run view.
    const snapshot = h.actions.find((a) => a.type === 'runSnapshot');
    expect(snapshot).toMatchObject({ sessionId: 's1' });
    expect((h.api.getSession as Mock).mock.calls[0]?.[0]).toBe('s1');
  });

  it('folding that refresh mid-turn keeps the turn on screen with the queue held', () => {
    expect(turnWithQueue().queuedPrompts).toHaveLength(1);

    const refreshed = reduce(turnWithQueue(), { type: 'planRefreshed', sessionId: 's1', plan: { tasks: [] } }).state;
    const snapshotted = reduce(refreshed, {
      type: 'runSnapshot',
      sessionId: 's1',
      view: { tasks: [], runMerge: null, handoff: null, mergeResult: null },
    }).state;

    expect(snapshotted.planner).toBe('planning');
    expect(snapshotted.queuedPrompts).toHaveLength(1);
    expect(snapshotted.turnGate.open).toBe('t1');
  });
});
