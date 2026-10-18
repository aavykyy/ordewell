import { describe, expect, it } from 'vitest';
import { EMPTY_TASK_LOG_FOLLOW, followTaskLog } from '../taskLogFollow';

describe('following a saved task log', () => {
  it('joins the read with buffered and late socket copies at its position', () => {
    let state = followTaskLog(EMPTY_TASK_LOG_FOLLOW, { type: 'opened' });
    state = followTaskLog(state, {
      type: 'live', attempt: 1, position: { stream: 'd', seq: 2 },
      events: [{ type: 'text_delta', runId: 'r', text: 'saved' }],
    });
    state = followTaskLog(state, {
      type: 'live', attempt: 1, position: { stream: 'd', seq: 4 },
      events: [
        { type: 'text_delta', runId: 'r', text: ' tail' },
        { type: 'tool_call', id: 'c', name: 'Read', args: '{}' },
        { type: 'turn_end', reason: 'completed' },
      ],
    });
    state = followTaskLog(state, {
      type: 'loaded', attempt: 1, attempts: [1], position: { stream: 'd', seq: 3 },
      events: [{ type: 'turn_start', message: 'go' }, { type: 'text_delta', runId: 'r', text: 'saved' }],
    });
    expect(state.view.blocks).toMatchObject([
      { type: 'message', role: 'user', text: 'go' },
      { type: 'message', role: 'agent', text: 'saved tail', streaming: false },
      { type: 'tool', toolCallId: 'c' },
    ]);
    expect(state.view.working).toBe(false);
    const late = followTaskLog(state, {
      type: 'live', attempt: 1, position: { stream: 'd', seq: 2 },
      events: [{ type: 'text_delta', runId: 'r', text: 'saved' }],
    });
    expect(late).toBe(state);
    const restarted = followTaskLog(state, {
      type: 'live', attempt: 1, position: { stream: 'restarted', seq: 1 },
      events: [{ type: 'turn_start', message: 'new daemon' }],
    });
    expect(restarted.view.blocks.at(-1)).toMatchObject({ type: 'message', text: 'new daemon' });
    expect(restarted.view.working).toBe(true);
  });
  it('keeps the latest pick when attempt reads return in reverse order', () => {
    let state = followTaskLog(EMPTY_TASK_LOG_FOLLOW, {
      type: 'loaded', attempt: 3, attempts: [1, 2, 3], events: [],
    });
    state = followTaskLog(state, { type: 'picked', attempt: 2 });
    state = followTaskLog(state, { type: 'picked', attempt: 1 });
    state = followTaskLog(state, {
      type: 'loaded', attempt: 1, events: [{ type: 'text', text: 'first attempt' }],
    });
    const stale = followTaskLog(state, {
      type: 'loaded', attempt: 2, events: [{ type: 'text', text: 'stale response' }],
    });
    expect(stale.attempt).toBe(1);
    expect(stale.view.blocks).toMatchObject([{ type: 'message', text: 'first attempt' }]);
  });

  it('pins earlier attempts, buffers their reads, and resumes following when the latest is picked', () => {
    let state = followTaskLog(EMPTY_TASK_LOG_FOLLOW, {
      type: 'loaded', attempt: 2, attempts: [1, 2], events: [],
    });
    state = followTaskLog(state, { type: 'picked', attempt: 1 });
    state = followTaskLog(state, {
      type: 'live', attempt: 3, position: { stream: 'd', seq: 9 },
      events: [{ type: 'text', text: 'third attempt' }],
    });
    const loading = state;
    expect(followTaskLog(state, { type: 'loaded', attempt: 2, events: [] })).toBe(loading);
    state = followTaskLog(state, {
      type: 'loaded', attempt: 1, position: { stream: 'd', seq: 8 },
      events: [{ type: 'text', text: 'first attempt' }],
    });
    expect(state.attempts).toEqual([1, 2, 3]);
    expect(state.attempt).toBe(1);
    expect(state.view.blocks).toMatchObject([{ type: 'message', text: 'first attempt' }]);
    state = followTaskLog(state, { type: 'picked', attempt: 3 });
    state = followTaskLog(state, { type: 'loaded', attempt: 3, events: [{ type: 'text', text: 'third attempt' }] });
    state = followTaskLog(state, { type: 'live', attempt: 4, events: [{ type: 'turn_start', message: 'fourth attempt' }] });
    expect(state.attempt).toBe(4);
    expect(state.view.blocks).toMatchObject([{ type: 'message', text: 'fourth attempt' }]);
    expect(followTaskLog(state, { type: 'live', attempt: 3, events: [{ type: 'text', text: 'late' }] })).toBe(state);
  });

});
