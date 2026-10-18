import { describe, expect, it } from 'vitest';
import { EMPTY_TASK_LOG_FOLLOW, followTaskLog, type TaskLogBatch } from '../taskLogFollow';

/**
 * Adversarial checks on joining a saved task log with the live stream by
 * stream position (ADR-0018 P1): the orderings of reads, picks and batches
 * the happy path does not drive.
 */

const live = (attempt: number, seq: number, events: TaskLogBatch['events']): { type: 'live' } & TaskLogBatch =>
  ({ type: 'live', attempt, position: { stream: 'd', seq }, events });

describe('picking and loading attempts', () => {
  it('keeps a pinned pick when the abandoned load of the open view lands late', () => {
    let state = followTaskLog(EMPTY_TASK_LOG_FOLLOW, { type: 'loaded', attempt: 3, attempts: [1, 3], events: [{ type: 'text', text: 'third' }] });
    state = followTaskLog(state, { type: 'picked', attempt: 1 });
    // The view's opening read failed (abandoned): it must not unpin the pick.
    const abandoned = followTaskLog(state, { type: 'loaded', attempt: 3, events: [], abandoned: true });
    expect(abandoned.attempt).toBe(3);
    expect(abandoned.loaded).toBe(true);
    expect(abandoned.followLatest).toBe(false);
    expect(abandoned.view.blocks).toMatchObject([{ type: 'message', text: 'third' }]);
    // …and the picked attempt's read, landing after, still replaces the view.
    const picked = followTaskLog(abandoned, { type: 'picked', attempt: 1 });
    const loaded = followTaskLog(picked, { type: 'loaded', attempt: 1, events: [{ type: 'text', text: 'first' }] });
    expect(loaded.attempt).toBe(1);
    expect(loaded.view.blocks).toMatchObject([{ type: 'message', text: 'first' }]);
  });

  it('ignores a duplicate load of the attempt already shown, whatever it carries', () => {
    const state = followTaskLog(EMPTY_TASK_LOG_FOLLOW, { type: 'loaded', attempt: 2, attempts: [1, 2], events: [{ type: 'text', text: 'second' }] });
    const again = followTaskLog(state, { type: 'loaded', attempt: 2, attempts: [1, 2], events: [{ type: 'text', text: 'replayed' }] });
    expect(again).toBe(state);
  });

  it('does not let a newer attempt take the view while the reader pinned an older one, but keeps it listed', () => {
    let state = followTaskLog(EMPTY_TASK_LOG_FOLLOW, { type: 'loaded', attempt: 2, attempts: [1, 2], events: [{ type: 'text', text: 'second' }] });
    state = followTaskLog(state, { type: 'picked', attempt: 1 });
    expect(state.followLatest).toBe(false);
    // A retry raced the pinned read: buffered, then recorded, not followed.
    state = followTaskLog(state, live(3, 5, [{ type: 'text', text: 'third' }]));
    expect(state.pending).toHaveLength(1);
    const pinned = followTaskLog(state, { type: 'loaded', attempt: 1, position: { stream: 'd', seq: 4 }, events: [{ type: 'text', text: 'first' }] });
    expect(pinned.attempts).toEqual([1, 2, 3]);
    expect(pinned.attempt).toBe(1);
    expect(pinned.view.blocks).toMatchObject([{ type: 'message', text: 'first' }]);
    // Picking the retry now loads it, and live batches follow it again.
    let picked = followTaskLog(pinned, { type: 'picked', attempt: 3 });
    expect(picked.followLatest).toBe(true);
    picked = followTaskLog(picked, { type: 'loaded', attempt: 3, events: [{ type: 'text', text: 'third read' }] });
    expect(picked.view.blocks).toMatchObject([{ type: 'message', text: 'third read' }]);
    picked = followTaskLog(picked, live(3, 6, [{ type: 'text', text: ' more' }]));
    expect(picked.view.blocks).toMatchObject([{ type: 'message', text: 'third read' }, { type: 'message', text: ' more' }]);
  });

  it('swallows a batch of the read attempt that the position already covers, before and after the load', () => {
    let state = followTaskLog(EMPTY_TASK_LOG_FOLLOW, live(1, 2, [{ type: 'text_delta', runId: 'r', text: 'live' }]));
    state = followTaskLog(state, { type: 'loaded', attempt: 1, position: { stream: 'd', seq: 2 }, events: [{ type: 'text', text: 'saved' }] });
    // The file read held the same batch; the live copy is dropped.
    expect(state.view.blocks).toMatchObject([{ type: 'message', role: 'agent', text: 'saved' }]);
    state = followTaskLog(state, live(1, 2, [{ type: 'text_delta', runId: 'r', text: 'live' }]));
    expect(state.view.blocks).toMatchObject([{ type: 'message', role: 'agent', text: 'saved' }]);
  });

  it('buffers a batch of a newer attempt until its own read lands, then replays it on top', () => {
    let state = followTaskLog(EMPTY_TASK_LOG_FOLLOW, live(2, 4, [{ type: 'text', text: 'retry live' }]));
    state = followTaskLog(state, { type: 'loaded', attempt: 1, position: { stream: 'd', seq: 3 }, events: [{ type: 'text', text: 'first saved' }] });
    // Following latest: the retry's batch took the view.
    expect(state.attempt).toBe(2);
    expect(state.view.blocks).toMatchObject([{ type: 'message', text: 'retry live' }]);
  });
});

describe('stream identities', () => {
  it('rejects only copies of the read\'s own stream; a daemon restart replays', () => {
    let state = followTaskLog(EMPTY_TASK_LOG_FOLLOW, { type: 'loaded', attempt: 1, position: { stream: 'd1', seq: 9 }, events: [{ type: 'text', text: 'saved' }] });
    state = followTaskLog(state, { type: 'live', attempt: 1, position: { stream: 'd2', seq: 3 }, events: [{ type: 'text', text: 'after restart' }] });
    expect(state.view.blocks.at(-1)).toMatchObject({ type: 'message', text: 'after restart' });
  });

  it('treats an attempt-less batch (0) as nothing, even while nothing is loaded', () => {
    let state = followTaskLog(EMPTY_TASK_LOG_FOLLOW, { type: 'opened' });
    state = followTaskLog(state, { type: 'live', attempt: 0, events: [{ type: 'text', text: 'unsaved' }] });
    expect(state.pending).toHaveLength(1);
    state = followTaskLog(state, { type: 'loaded', attempt: 0, events: [] });
    expect(state.view.blocks).toEqual([]);
    expect(state.pending).toHaveLength(0);
  });
});
