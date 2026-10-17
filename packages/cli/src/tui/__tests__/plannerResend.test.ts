import { describe, it, expect, vi } from 'vitest';
import { initialState, reduce, type Step } from '../reducer';
import { runEffect, type EffectDeps, type OrdewellApi } from '../effects';
import type { TuiState } from '../state';
import { lastMessage } from './chat';

/**
 * A planner turn that ended on the planner's usage limit waits to be sent
 * again at the reset; `/resend cancel` keeps it for the user's next message.
 */

const session = (over: Partial<TuiState> = {}): TuiState => initialState({ sessionId: 's1', rows: 30, cols: 80, ...over });

function typed(state: TuiState, text: string): Step {
  return reduce({ ...state, editor: { ...state.editor, text, cursor: text.length } }, { type: 'key', key: { name: 'enter' } });
}

describe('/resend', () => {
  it('cancels the resend with cancel, and says how otherwise', () => {
    expect(typed(session(), '/resend cancel').effects).toEqual([{ type: 'cancelPlannerResend', sessionId: 's1' }]);

    const asked = typed(session(), '/resend');
    expect(asked.effects).toEqual([]);
    expect(lastMessage(asked.state)?.text).toMatch(/\/resend cancel/);
  });

  it('asks the daemon to cancel it, and says what happened', async () => {
    for (const [cancelled, said] of [[true, /goes with your next message/], [false, /Nothing waits/]] as const) {
      const cancelPlannerResend = vi.fn().mockResolvedValue({ cancelled });
      const dispatch = vi.fn();
      const deps: EffectDeps = {
        api: { cancelPlannerResend } as unknown as OrdewellApi,
        workspace: '/ws', port: 3742, dispatch, newSessionId: () => 's2', setEnvVar: () => {}, saveAutonomy: () => ({ overridden: false }), hasBin: () => true, exit: vi.fn(),
        reviveDaemon: vi.fn(), setMouseCapture: vi.fn(), writeTerminal: vi.fn(),
      };
      // Only the request is pinned; the plan refresh after it has no daemon to reach.
      await runEffect({ type: 'cancelPlannerResend', sessionId: 's1' }, deps).catch(() => undefined);
      expect(cancelPlannerResend).toHaveBeenCalledWith('s1');
      expect(dispatch).toHaveBeenCalledWith({ type: 'notice', message: expect.stringMatching(said) });
    }
  });
});
