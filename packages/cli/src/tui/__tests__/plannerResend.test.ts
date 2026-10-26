import { describe, it, expect, vi } from 'vitest';
import { initialState, reduce, type Step } from '../reducer';
import { runEffect, type EffectDeps, type OrdewellApi } from '../effects';
import type { TuiState } from '../state';
import { lastMessage } from './chat';
import { render } from '../render';
import { stripAnsi } from '../ansi';
import { chatLayout } from '../layout';

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
        workspace: '/ws', port: 3742, dispatch, newSessionId: () => 's2', setEnvVar: () => {}, saveAutonomy: () => ({ overridden: false }), hasBin: () => true,
        login: async () => ({ ok: true }),
        exit: vi.fn(),
        reviveDaemon: vi.fn(), setMouseCapture: vi.fn(), writeTerminal: vi.fn(),
      };
      // Only the request is pinned; the plan refresh after it has no daemon to reach.
      await runEffect({ type: 'cancelPlannerResend', sessionId: 's1' }, deps).catch(() => undefined);
      expect(cancelPlannerResend).toHaveBeenCalledWith('s1');
      expect(dispatch).toHaveBeenCalledWith({ type: 'notice', message: expect.stringMatching(said) });
    }
  });
});

describe('the resend that waits', () => {
  const AT = '2099-01-01T20:10:00.000Z';
  const planWith = (plannerResend?: { runner?: string; at?: string }) => ({ tasks: [], ...(plannerResend ? { plannerResend } : {}) });
  const shown = (state: TuiState): string => stripAnsi(chatLayout(state, 12, 100).footer.join('\n'));
  const planUpdated = (state: TuiState, plan: unknown): TuiState => reduce(state, { type: 'planUpdated', plan, sessionId: 's1' }).state;

  it('is kept from the plan and drawn in the chat footer with the way to cancel it', () => {
    const waiting = planUpdated(session(), planWith({ runner: 'claude-code', at: AT }));

    expect(waiting.plannerResend).toEqual({ runner: 'claude-code', at: AT });
    expect(shown(waiting)).toMatch(/Resending at .+, once claude-code's usage limit resets/);
    expect(shown(waiting)).toContain('/resend cancel');
    expect(stripAnsi(render(waiting).join('\n'))).toContain('Resending at');
  });

  it('goes when a later plan no longer carries it, as it does once it was sent or cancelled', () => {
    const waiting = planUpdated(session(), planWith({ at: AT }));
    const gone = planUpdated(waiting, planWith());

    expect(gone.plannerResend).toBeNull();
    expect(shown(gone)).not.toContain('Resending');
  });

  it('is not drawn for a hold with no time, which goes with the next message', () => {
    const held = planUpdated(session(), planWith({ runner: 'claude-code' }));

    expect(held.plannerResend).toBeNull();
    expect(shown(held)).not.toContain('Resending');
  });

  it('names the planner when no runner is recorded', () => {
    expect(shown(planUpdated(session(), planWith({ at: AT })))).toContain("once the planner's usage limit resets");
  });
});
