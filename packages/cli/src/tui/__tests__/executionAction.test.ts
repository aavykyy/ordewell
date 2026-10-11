import { describe, it, expect } from 'vitest';
import { initialState, reduce, type Action } from '../reducer';
import { inboundFor } from '../inbound';
import type { WsEvent } from '../../apiClient';
import { lastMessage } from './chat';

describe('a call at the command seam, from the daemon (ADR-0029)', () => {
  const wire: unknown = {
    type: 'execution_action',
    record: { command: 'stop_task', actor: 'planner-turn', task: { id: 't2', ref: '#2', title: 'Add the cache' }, outcome: 'done', at: '2026-10-11T10:00:00.000Z' },
    text: 'The planner stopped task #2 "Add the cache".',
  };

  it('is a line in the conversation, shown once whichever subscription delivers it', () => {
    const actions: Action[] = [];
    const inbound = inboundFor({}, (action) => actions.push(action), 's1');
    inbound.execution()(wire as WsEvent);
    inbound.planning()(wire as WsEvent);

    const state = actions.reduce((s, action) => reduce(s, action).state, initialState({ sessionId: 's1' }));

    expect(actions).toHaveLength(1);
    expect(lastMessage(state)).toMatchObject({ role: 'system', text: 'The planner stopped task #2 "Add the cache".' });
  });
});
