import { describe, it, expect } from 'vitest';
import type { ResearchProgress } from '../../../models/Task';
import { TurnReply } from '../turnReply';

describe('TurnReply', () => {
  function reply() {
    const events: ResearchProgress[] = [];
    let clock = Date.parse('2026-10-18T10:00:00.000Z');
    const turn = new TurnReply((p) => events.push(p), () => new Date(clock += 1000));
    return { turn, events };
  }

  it('reports its runs in the order they began, each with its segment, its text and when it began', () => {
    const { turn, events } = reply();
    turn.delta('a', 'Let me ');
    turn.delta('a', 'check.');
    turn.toolCall();
    turn.delta('b', 'Found');
    // The first run's complete copy lands after the call and the next run began.
    turn.complete('a', 'Let me check.');
    turn.complete('b', 'Found it.');

    const segments = events.flatMap((e) => (e.type === 'text_delta' ? [e.segmentId] : []));
    expect(turn.runs()).toEqual([
      { runId: 'a', segmentId: segments[0], text: 'Let me check.', startedAt: '2026-10-18T10:00:01.000Z' },
      { runId: 'b', segmentId: segments[2], text: 'Found it.', startedAt: '2026-10-18T10:00:02.000Z' },
    ]);
    expect(segments[2]).not.toBe(segments[0]);
    expect(turn.text).toBe('Let me check.\n\nFound it.');
    // Neither complete copy streams again: both runs streamed already.
    expect(events.map((e) => e.type === 'text_delta' && e.text)).toEqual(['Let me ', 'check.', 'Found']);
  });

  it('streams a run that never streamed as its complete copy', () => {
    const { turn, events } = reply();
    turn.complete('a', 'Which store?');

    expect(events).toEqual([{ type: 'text_delta', text: 'Which store?', segmentId: turn.runs()[0].segmentId }]);
  });

  it('takes back what a failed turn said after its last call, and keeps what came before', () => {
    const { turn, events } = reply();
    turn.complete('a', 'Reading the cache.');
    turn.toolCall();
    turn.complete('b', 'The cache is in src/cache.ts.');
    turn.complete('c', 'Limit reached');

    expect(turn.fail('Limit reached.')).toBe('The cache is in src/cache.ts.\n\nLimit reached.');
    const [kept, ...taken] = events.flatMap((e) => (e.type === 'text_delta' ? [e.segmentId] : []));
    expect(events.filter((e) => e.type === 'text_retracted').map((e) => e.segmentId)).toEqual(taken);
    expect(turn.runs().map((run) => [run.runId, run.segmentId])).toEqual([['a', kept]]);
    expect(turn.text).toBe('Reading the cache.');
  });
});
