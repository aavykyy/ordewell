import { describe, it, expect } from 'vitest';
import { EMPTY_RUN, type LegacyPlanState, type RunTask, type RunView } from '@ordewell/core';
import { reduceHost, resetSession, INITIAL_HOST_STATE, type HostState, type HostMessage } from '../hostState';

const NOW = 1_000;
const msg = (m: { type: HostMessage['type'] } & Record<string, unknown>): HostMessage => ({ now: NOW, ...m }) as HostMessage;

function planWith(status: string): LegacyPlanState {
  return { status, tasks: [] } as unknown as LegacyPlanState;
}

function runWith(tasks: Partial<RunTask>[], over: Partial<RunView> = {}): RunView {
  return { ...EMPTY_RUN, ...over, tasks: tasks.map((t) => ({ subtasks: [], ...t })) as RunTask[] };
}

function staleSession(): HostState {
  return {
    ...INITIAL_HOST_STATE,
    plan: planWith('running'),
    isExecuting: true,
    isResearchActive: true,
    error: 'boom',
    run: runWith([{ id: 't1', awaitingApproval: 2, idleSince: '2026-01-01T00:00:00Z', mergeGate: ['t0'] }]),
    dockExpanded: true,
  };
}

describe('resetSession', () => {
  it('clears the run and the plan on restore', () => {
    const next = reduceHost(staleSession(), msg({ type: 'restoreChat' }));
    expect(next.run).toEqual(EMPTY_RUN);
    expect(next.plan).toBeNull();
    expect(next.checkpoint).toBeNull();
    expect(next.isResearchActive).toBe(false);
    expect(next.isExecuting).toBe(false);
  });

  it("'empty' clears the run but leaves running flags and held prompts alone", () => {
    const held = { ...INITIAL_HOST_STATE.held };
    const next = resetSession({ ...staleSession(), held, stopped: true }, 'empty');
    expect(next.run).toEqual(EMPTY_RUN);
    expect(next.error).toBe('');
    expect(next.isResearchActive).toBe(true);
    expect(next.held).toBe(held);
    expect(next.stopped).toBe(true);
  });

  it("'restore' opens the gates and 'new' closes them", () => {
    const gated = { ...staleSession(), stopped: true, sessionCleared: true };
    const restored = resetSession(gated, 'restore');
    expect(restored.stopped).toBe(false);
    expect(restored.sessionCleared).toBe(false);
    const fresh = resetSession(staleSession(), 'new');
    expect(fresh.stopped).toBe(true);
    expect(fresh.sessionCleared).toBe(true);
  });

  it('is not undone by a conversation reset: the conversation stays the host\'s', () => {
    const before = staleSession();
    expect(resetSession(before, 'new').conversation).toBe(before.conversation);
  });
});

describe('reduceHost gates', () => {
  it('drops planUpdated while stopped until a planner turn opens', () => {
    const stopped = reduceHost(staleSession(), { type: 'turnStopped' });
    const dropped = reduceHost(stopped, msg({ type: 'planUpdated', plan: planWith('draft') }));
    expect(dropped).toBe(stopped);
    const reopened = reduceHost(stopped, msg({ type: 'plannerTurn', active: true }));
    expect(reduceHost(reopened, msg({ type: 'planUpdated', plan: planWith('draft') })).plan?.status).toBe('draft');
  });

  it('drops showError after a new session until the next send', () => {
    const cleared = reduceHost(staleSession(), { type: 'resetSession', kind: 'new' });
    expect(reduceHost(cleared, msg({ type: 'showError', error: 'late' })).error).toBe('');
    const sent = reduceHost(cleared, { type: 'turnRequested' });
    expect(reduceHost(sent, msg({ type: 'showError', error: 'real' })).error).toBe('real');
  });
});

describe('reduceHost runView', () => {
  const checkpointTask = { id: 't1', title: 'Add rate limiting', status: 'awaiting_user' as const, awaitingReason: 'checkpoint' as const, checkpoint: 'ready for review' };

  it('adopts the run as sent', () => {
    const view = runWith([{ id: 't1', awaitingApproval: 2, idleSince: '2026-01-01T00:00:00Z' }]);
    const next = reduceHost(INITIAL_HOST_STATE, msg({ type: 'runView', view }));
    expect(next.run).toBe(view);
  });

  it('stamps a checkpoint question that arrives on the run view', () => {
    const next = reduceHost(INITIAL_HOST_STATE, msg({ type: 'runView', view: runWith([checkpointTask]) }));
    expect(next.checkpoint?.pausedAt).toBe(NOW);
    expect(next.checkpoint?.taskTitle).toBe('Add rate limiting');
    expect(next.checkpoint?.summary).toBe('ready for review');
  });

  it('keeps the paused clock across a re-sent view, and clears the panel when the question is gone', () => {
    const waiting = msg({ type: 'runView', view: runWith([checkpointTask]) });
    const first = reduceHost(INITIAL_HOST_STATE, { ...waiting, now: 500 });
    const again = reduceHost(first, { ...waiting, now: 9_000 });
    expect(again.checkpoint?.pausedAt).toBe(500);

    expect(reduceHost(again, msg({ type: 'runView', view: EMPTY_RUN })).checkpoint).toBeNull();
  });

  it('forgets the answered question with the session, and re-opens a different one', () => {
    const asked = reduceHost(INITIAL_HOST_STATE, msg({ type: 'runView', view: runWith([checkpointTask]) }));
    const answered = reduceHost(asked, { type: 'checkpointAnswered' });
    expect(answered.checkpoint).toBeNull();
    expect(reduceHost(answered, msg({ type: 'runView', view: runWith([checkpointTask]) })).checkpoint).toBeNull();

    expect(resetSession(answered, 'restore').answeredCheckpoint).toBeNull();

    const different = reduceHost(answered, msg({ type: 'runView', view: runWith([{ ...checkpointTask, checkpoint: 'another review' }]) }));
    expect(different.checkpoint?.summary).toBe('another review');
  });
});

describe('reduceHost runView isolation', () => {
  const landed = [{ taskId: 't1', order: 1, title: 'A' }];
  const repos = [{ path: '.', integrationBranch: 'ordewell/r/integration', baseRef: 'abc', landed }];

  it('keeps the supervisor deferral on the handoff', () => {
    const next = reduceHost(INITIAL_HOST_STATE, msg({ type: 'runView', view: runWith([], { handoff: { repos, landed, deferredTo: 'supervisor' } }) }));

    expect(next.run.handoff).toEqual({ repos, landed, deferredTo: 'supervisor' });
  });

  it('replaces a deferred handoff with the unmarked one that follows it', () => {
    const deferred = reduceHost(INITIAL_HOST_STATE, msg({ type: 'runView', view: runWith([], { handoff: { repos, landed, deferredTo: 'supervisor' } }) }));

    const next = reduceHost(deferred, msg({ type: 'runView', view: runWith([], { handoff: { repos, landed } }) }));

    expect(next.run.handoff).toEqual({ repos, landed });
  });
});

describe('setModesByRunner', () => {
  it('keeps the host\'s one-line notice for a runner whose modes are off, and drops it once they are back', () => {
    const notice = { line: 'Codex sandbox unavailable on this host: read-only and Guarded modes are off', docs: 'https://example.test/docs' };
    const off = reduceHost(INITIAL_HOST_STATE, msg({ type: 'setModesByRunner', modesByRunner: {}, notice }));
    expect(off.runnerNotice).toEqual(notice);

    expect(reduceHost(off, msg({ type: 'setModesByRunner', modesByRunner: {} })).runnerNotice).toBeNull();
  });
});
