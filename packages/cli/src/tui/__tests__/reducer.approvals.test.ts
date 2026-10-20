import { describe, it, expect } from 'vitest';
import { initialState, reduce, type Action, type Step } from '../reducer';
import type { ApprovalRequestView, TuiState } from '../state';

const key = (name: string, char?: string) => ({ type: 'key' as const, key: { name, char } });
const press = (state: TuiState, name: string, char?: string): Step => reduce(state, key(name, char));

const REQUEST: ApprovalRequestView = {
  id: 'ap-1',
  kind: 'shell_command',
  subject: 'npm test',
  scope: 'npm test',
  detail: 'Planner research wants to run: npm test',
};

const PATH_REQUEST: ApprovalRequestView = {
  id: 'ap-2',
  kind: 'external_path',
  subject: '/tmp/dump/a.log',
  scope: '/tmp/dump/*',
};

const requested = (request = REQUEST, sessionId = 's1'): Action => ({
  type: 'sessionMessage', message: { type: 'approval_request', ...request }, sessionId,
});

const settledElsewhere = (id: string, granted = true): Action => ({
  type: 'sessionMessage', message: { type: 'approval_settled', id, granted }, sessionId: 's1',
});

function withPending(request = REQUEST): TuiState {
  return reduce(initialState({ sessionId: 's1', planner: 'planning' }), requested(request)).state;
}

describe('approval overlay', () => {
  it('opens a modal when the planner asks for something', () => {
    const state = withPending();

    expect(state.overlay).toMatchObject({ kind: 'approval' });
    expect(state.overlay).toMatchObject({ request: { id: 'ap-1', subject: 'npm test' } });
  });

  it('ignores a request for a different session', () => {
    const state = initialState({ sessionId: 's1' });
    const next = reduce(state, requested(REQUEST, 'other')).state;

    expect(next.overlay).toBeNull();
  });

  it('grants on y and tells the daemon', () => {
    const { state, effects } = press(withPending(), 'y', 'y');

    expect(state.overlay).toBeNull();
    expect(effects).toContainEqual({ type: 'respondApproval', sessionId: 's1', approvalId: 'ap-1', granted: true });
  });

  it('grants on enter, matching the confirm overlay it sits beside', () => {
    const { effects } = press(withPending(), 'enter');

    expect(effects).toContainEqual({ type: 'respondApproval', sessionId: 's1', approvalId: 'ap-1', granted: true });
  });

  it('denies on n', () => {
    const { state, effects } = press(withPending(), 'n', 'n');

    expect(state.overlay).toBeNull();
    expect(effects).toContainEqual({ type: 'respondApproval', sessionId: 's1', approvalId: 'ap-1', granted: false });
  });

  it('denies on escape once no turn is in flight, so dismissing is never consent', () => {
    // A prompt outliving its turn (answered elsewhere, or the turn already
    // settled) still gets the plain deny — there is nothing left to stop.
    const { effects } = press({ ...withPending(), planner: 'idle' }, 'escape');

    expect(effects).toContainEqual({ type: 'respondApproval', sessionId: 's1', approvalId: 'ap-1', granted: false });
  });

  it('escape arms while a turn is in flight rather than denying one call; the second esc stops the turn', () => {
    const armed = press(withPending(), 'escape');
    expect(armed.state.overlay).toMatchObject({ kind: 'approval' });
    expect(armed.state.stopArmed).toBe(true);

    const { state, effects } = press(armed.state, 'escape');
    expect(effects).toEqual([{ type: 'cancelPlanning', sessionId: 's1' }]);
    expect(state.overlay).toBeNull();
  });

  it('ignores keys that mean neither yes nor no rather than guessing', () => {
    const { state, effects } = press(withPending(), 'k', 'k');

    expect(state.overlay).toMatchObject({ kind: 'approval' });
    expect(effects).toEqual([]);
  });

  it('keeps the request in the conversation, which shows the decision once the session settles it', () => {
    const answered = press(withPending(), 'y', 'y').state;
    expect(answered.conversation.blocks).toMatchObject([{ type: 'approval', subject: 'npm test', status: 'pending' }]);

    const settled = reduce(answered, settledElsewhere('ap-1', true)).state;
    expect(settled.conversation.blocks).toMatchObject([{ type: 'approval', subject: 'npm test', status: 'granted' }]);
  });
});

describe('approval queue', () => {
  it('shows the second request only after the first is answered', () => {
    const first = withPending();
    const both = reduce(first, requested(PATH_REQUEST)).state;

    expect(both.overlay).toMatchObject({ request: { id: 'ap-1' } });

    const afterFirst = press(both, 'y', 'y').state;
    expect(afterFirst.overlay).toMatchObject({ request: { id: 'ap-2' } });
  });

  it('does not queue the same request twice when a socket replays it', () => {
    const state = reduce(withPending(), requested(REQUEST)).state;
    const answered = press(state, 'y', 'y').state;

    expect(answered.overlay).toBeNull();
  });

  it('drops a queued request that was answered on another surface', () => {
    const both = reduce(withPending(), requested(PATH_REQUEST)).state;
    const settled = reduce(both, settledElsewhere('ap-2')).state;

    expect(press(settled, 'y', 'y').state.overlay).toBeNull();
  });

  it('closes the open modal when that request is settled elsewhere', () => {
    const settled = reduce(withPending(), settledElsewhere('ap-1')).state;

    expect(settled.overlay).toBeNull();
  });

  it('clears pending approvals on a new session — they belong to the old one', () => {
    const cleared = reduce(withPending(), { type: 'sessionCleared' }).state;

    expect(cleared.overlay).toBeNull();
    expect(cleared.pendingApprovals).toEqual([]);
  });

  // /new builds the fresh state directly rather than going through
  // sessionCleared, so a queued prompt from the abandoned session survived it
  // and would then be answered against a session id that no longer exists.
  it('clears them on /new too, not only on sessionCleared', () => {
    const queued = reduce(withPending(), requested(PATH_REQUEST)).state;
    const typed = { ...queued, overlay: null, editor: { ...queued.editor, text: '/new', cursor: 4 } };
    // The transcript holds the earlier decision, so /new confirms first.
    const reset = press(press(typed, 'enter').state, 'enter').state;

    expect(reset.sessionId).toBeNull();
    expect(reset.overlay).toBeNull();
    expect(reset.pendingApprovals).toEqual([]);
  });

  describe('a script task start (ADR-0035)', () => {
    const START: ApprovalRequestView = {
      id: 'ap-9', kind: 'task_start', subject: 'Run script task #2 "Push"', scope: 'Run script task #2 "Push"',
      body: Array.from({ length: 80 }, (_, i) => `echo line-${i}`).join('\n'),
    };

    it('keeps the body on the modal, whether it arrives live or is synced after a reconnect', () => {
      const live = withPending(START);
      expect(live.overlay).toMatchObject({ kind: 'approval', request: { id: 'ap-9', body: START.body } });

      const synced = reduce(initialState({ sessionId: 's1' }), {
        type: 'sessionMessage', sessionId: 's1', message: { type: 'approval_request', ...START },
      }).state;
      expect(synced.overlay).toMatchObject({ request: { body: START.body } });
    });

    it('scrolls the body with the arrow and page keys, to its end and no further, without answering', () => {
      const open = withPending(START);

      const down = press(open, 'down');
      expect(down.state.overlay).toMatchObject({ kind: 'approval', scroll: 1 });
      expect(down.effects).toEqual([]);

      const end = press(press(open, 'pagedown').state, 'pagedown');
      const far = [...Array(20)].reduce((state: TuiState) => press(state, 'pagedown').state, end.state);
      const scroll = far.overlay?.kind === 'approval' ? far.overlay.scroll ?? 0 : -1;
      expect(scroll).toBeGreaterThan(0);
      expect(press(far, 'pagedown').state.overlay).toMatchObject({ scroll });
      expect(press(far, 'pageup').state.overlay).toMatchObject({ kind: 'approval', scroll: expect.any(Number) });
    });

    it('still answers from a scrolled modal', () => {
      const scrolled = press(withPending(START), 'down').state;

      expect(press(scrolled, 'y', 'y').effects).toContainEqual({ type: 'respondApproval', sessionId: 's1', approvalId: 'ap-9', granted: true });
    });

    it('leaves arrow keys alone on a request with no body', () => {
      const step = press(withPending(), 'down');

      expect(step.state.overlay).toMatchObject({ kind: 'approval' });
      expect(step.state.overlay).not.toHaveProperty('scroll');
    });
  });
});
