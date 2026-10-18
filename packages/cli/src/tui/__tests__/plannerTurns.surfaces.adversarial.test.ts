import { describe, expect, it } from 'vitest';
import { createTask, serializeTask, type RunView } from '@ordewell/core';
import { initialState, reduce, type Action } from '../reducer';
import type { TuiState } from '../state';

/**
 * Adversarial: a planner turn on screen belongs to one session (ADR-0017,
 * ADR-0029). Every way the TUI leaves a session — a fork, a load, a clear and
 * a new session — has to drop the turn gate and the prompts held behind it, or
 * the next session inherits the old turn's gate and ctrl-s sends now behind a
 * turn that no longer exists.
 */

const enter = { type: 'key' as const, key: { name: 'enter' } };

/** A turn another client opened, as the socket announces it: the gate is open. */
const midTurn = (): TuiState =>
  reduce(initialState({ sessionId: 's1', planner: 'planning' }), {
    type: 'sessionMessage',
    sessionId: 's1',
    message: { type: 'planner_turn_started', turnId: 't1', prompt: 'Research the repository' },
  }).state;

const withDraft = (state: TuiState, text: string): TuiState => ({
  ...state,
  editor: { ...state.editor, text, cursor: text.length },
});

/** The TUI's own turn in flight, with a prompt queued behind it. */
const turnWithQueue = (): TuiState => reduce(withDraft(midTurn(), 'second prompt'), enter).state;

const quiet = (state: TuiState) => [state.turnGate.open, state.queuedPrompts.length, state.planner];

describe('adversarial: leaving a session drops its turn gate and queue', () => {
  it('a load, a fork and a deleted session all start with no turn', () => {
    expect(quiet(midTurn())).toEqual(['t1', 0, 'planning']);

    for (const action of [
      { type: 'sessionLoaded', sessionId: 's2', goal: 'g' },
      { type: 'sessionForked', sessionId: 's2', goal: 'g' },
      { type: 'sessionDeleted', sessionId: 's1' },
    ] as Action[]) {
      expect(quiet(reduce(midTurn(), action).state)).toEqual([null, 0, 'idle']);
    }
  });

  // ADVERSARIAL FINDING (TUI planner turns): packages/cli/src/tui/reducer.ts:79-91 `sessionCleared` (the failed-start path) drops the queued prompts and pending approvals but not `turnGate`, unlike `sessionLoaded` (line 68), `sessionForked` (line 316) and `newSession` (reducers/commands.ts:218); the `failed` action that follows resets `planner` but never the gate. A start that failed after its `planner_turn_started` arrived leaves the old turn's gate open with no session, and the next goal's `sessionStarted` does not reset it, so the dead turn's gate survives into the new session — the state a fork was fixed to avoid. Expected: clearing a failed start resets `turnGate` to `NO_TURN` (as load, fork and new session do).
  it.skip('clearing a failed start mid-turn drops the turn gate with the prompts', () => {
    const cleared = reduce(turnWithQueue(), { type: 'sessionCleared' }).state;

    expect(cleared.turnGate.open).toBeNull();
  });
});

describe('adversarial: the run closed is the Session\'s to say (ADR-0013, ADR-0020)', () => {
  /** A run whose one task carries a conflict mark and whose handoff card is up. */
  const runWithCards = (): TuiState => {
    const task = serializeTask(createTask({ id: 't1', order: 1, title: 'Deploy', prompt: 'deploy', status: 'completed' }));
    const view: RunView = {
      tasks: [{
        ...task,
        isolation: { state: 'conflict', branch: 'ordewell/r1/1-deploy', worktree: '/wt/1', repos: ['.'], conflictRepo: '.', conflictFiles: ['x.ts'] },
      }],
      runMerge: null,
      handoff: { repos: [{ path: '.', integrationBranch: 'ordewell/r1/integration', baseRef: 'abc123', landed: [] }], landed: [] },
      mergeResult: null,
    };
    return reduce(initialState({ sessionId: 's1' }), { type: 'runSnapshot', sessionId: 's1', view }).state;
  };

  it('a Merge all while the run goes on keeps the marks and takes the handoff card it merged', () => {
    const merged = reduce(runWithCards(), { type: 'isolationMerged', sessionId: 's1', result: { outcome: 'merged' } }).state;

    expect(merged.tasks[0]?.isolation).toMatchObject({ state: 'conflict' });
    expect(merged.handoff).toBeNull();
  });

  it('the Session\'s run_closed is what clears the marks', () => {
    const closed = reduce(runWithCards(), { type: 'runClosed', sessionId: 's1' }).state;

    expect(closed.tasks[0]?.isolation).toBeUndefined();
    expect(closed.handoff).toBeNull();
  });
});
