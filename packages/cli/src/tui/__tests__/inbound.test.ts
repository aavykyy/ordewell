import { describe, it, expect } from 'vitest';
import type { WsEvent } from '../../apiClient';
import type { Action } from '../reducer';
import { forgetInbound, inboundFor } from '../inbound';

/**
 * What one session's inbound subscriptions have already delivered is held per
 * client and session; a session the TUI is done with must not stay there for
 * the life of the process.
 */
describe('forgetting a session\'s inbound state', () => {
  const turn = { type: 'planner_turn_started', turnId: 't1', stream: 's', seq: 1 } as WsEvent;
  it('lets a forgotten session start clean instead of growing a map entry forever', () => {
    const api = {};
    const actions: Action[] = [];
    const dispatch = (action: Action): void => { actions.push(action); };

    const first = inboundFor(api, dispatch, 's1');
    first.planning()(turn);
    // The same broadcast on a second socket is a copy, not a new turn.
    first.planning()(turn);
    expect(actions).toHaveLength(1);

    forgetInbound(api, 's1');
    const reopened = inboundFor(api, dispatch, 's1');
    reopened.planning()(turn);
    expect(actions).toHaveLength(2);
  });
});
