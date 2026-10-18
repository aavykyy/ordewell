import { describe, expect, it } from 'vitest';
import { coalesceTaskLog, type TaskLogEvent } from '../../models/TaskLog';
import { replayTaskLog, reduceTaskLog, EMPTY_TASK_LOG, type TaskLogView } from '../taskLog';
import { unkeyed } from './helpers';

/**
 * Adversarial checks on the task log's runs of text (ADR-0018, O1b): the
 * run-id paths the #79 (a limit said twice) and interleaving tests exercise
 * only without ids, and the coalescing a live batch travels through.
 */

const start: TaskLogEvent = { type: 'turn_start', message: 'Do the task' };
const limit = "You've hit your session limit · resets 8:10pm (Europe/Rome)";

function agentTexts(view: TaskLogView): string[] {
  return view.blocks.flatMap((b) => (b.type === 'message' && b.role === 'agent' ? [b.text] : []));
}

describe('a limit said twice, by a runner that ids its runs', () => {
  it('takes back a streamed run with an id that repeats the error', () => {
    const view = replayTaskLog([
      start,
      { type: 'text_delta', runId: 'r1', text: limit },
      { type: 'text', runId: 'r1', text: limit },
      { type: 'error', message: `${limit}.` },
    ]);
    expect(agentTexts(view)).toEqual([]);
    expect(unkeyed(view.blocks).at(-1)).toEqual({ type: 'message', role: 'error', text: `${limit}.`, streaming: false });
    expect(view.streams).toEqual({});
  });

  it('takes back a run with an id that was still streaming when the error landed', () => {
    const view = replayTaskLog([
      start,
      { type: 'text_delta', runId: 'r1', text: limit.slice(0, 20) },
      { type: 'text_delta', runId: 'r1', text: limit.slice(20) },
      { type: 'error', message: `${limit}.` },
    ]);
    expect(agentTexts(view)).toEqual([]);
    expect(unkeyed(view.blocks).at(-1)).toEqual({ type: 'message', role: 'error', text: `${limit}.`, streaming: false });
    expect(view.streams).toEqual({});
  });

  it('keeps a real earlier run beside the error, its own block untouched', () => {
    const view = replayTaskLog([
      start,
      { type: 'text', runId: 'r1', text: 'The cache belongs in src/cache.ts.' },
      { type: 'text_delta', runId: 'r2', text: limit },
      { type: 'error', message: `${limit}.` },
    ]);
    expect(agentTexts(view)).toEqual(['The cache belongs in src/cache.ts.']);
    expect(unkeyed(view.blocks).at(-1)).toEqual({ type: 'message', role: 'error', text: `${limit}.`, streaming: false });
  });

  it('leaves an earlier turn’s ided run alone', () => {
    const view = replayTaskLog([
      start,
      { type: 'text', runId: 'r1', text: limit },
      { type: 'turn_end', reason: 'completed' },
      { type: 'turn_start', message: 'Go on' },
      { type: 'error', message: limit },
    ]);
    expect(agentTexts(view)).toEqual([limit]);
  });
});

describe('thinking and subagent activity between the deltas of one ided run', () => {
  it('keeps the run in one block while subagent thinking streams between its deltas', () => {
    const view = replayTaskLog([
      start,
      { type: 'text_delta', runId: 'r1', text: 'Checking' },
      { type: 'thinking_delta', text: 'the subagent ponders…', subagentId: 'sa1' },
      { type: 'thinking', text: 'the subagent ponders…', subagentId: 'sa1' },
      { type: 'text_delta', runId: 'r1', text: ' the tree' },
      { type: 'text', runId: 'r1', text: 'Checking the tree.' },
    ]);
    expect(agentTexts(view)).toEqual(['Checking the tree.']);
    // The subagent's thinking nests under the subagent's own block.
    expect(view.blocks.map((b) => b.type)).toEqual(['message', 'message', 'subagent']);
    expect(view.blocks[2]).toMatchObject({ type: 'subagent', children: [{ type: 'thinking', text: 'the subagent ponders…' }] });
  });

  it('keeps the run in one block across a subagent event of its own tool call', () => {
    const view = replayTaskLog([
      start,
      { type: 'text_delta', runId: 'r1', text: 'Delegating' },
      { type: 'tool_call', id: 'c1', name: 'Task', args: '{"prompt":"look"}' },
      { type: 'subagent_started', subagentId: 'c1', brief: 'look' },
      { type: 'subagent_finished', subagentId: 'c1', outcome: 'done', digest: 'found it' },
      { type: 'text_delta', runId: 'r1', text: ' now' },
      { type: 'text', runId: 'r1', text: 'Delegating now.' },
    ]);
    expect(agentTexts(view)).toEqual(['Delegating now.']);
    // The user's turn line, the run's block above; the call became the subagent's block, sealed.
    expect(view.blocks.map((b) => b.type)).toEqual(['message', 'message', 'subagent']);
  });
});

describe('coalescing a live batch of interleaved runs', () => {
  const deltas: TaskLogEvent[] = [
    { type: 'text_delta', runId: 'a', text: 'First ' },
    { type: 'text_delta', runId: 'b', text: 'Second ' },
    { type: 'thinking_delta', text: 'hmm' },
    { type: 'text_delta', runId: 'a', text: 'run.' },
    { type: 'text_delta', runId: 'b', text: 'run.' },
  ];

  it('merges only consecutive deltas of one run, and thinking of one voice', () => {
    expect(coalesceTaskLog(deltas)).toEqual([
      { type: 'text_delta', runId: 'a', text: 'First ' },
      { type: 'text_delta', runId: 'b', text: 'Second ' },
      { type: 'thinking_delta', text: 'hmm' },
      { type: 'text_delta', runId: 'a', text: 'run.' },
      { type: 'text_delta', runId: 'b', text: 'run.' },
    ]);
  });

  it('never merges an ided delta into a legacy one, or two legacy runs of different turns', () => {
    expect(coalesceTaskLog([
      { type: 'text_delta', runId: 'a', text: 'One' },
      { type: 'text_delta', text: 'Two' },
    ])).toEqual([
      { type: 'text_delta', runId: 'a', text: 'One' },
      { type: 'text_delta', text: 'Two' },
    ]);
    expect(coalesceTaskLog([
      { type: 'text_delta', text: 'One' },
      { type: 'text_delta', text: 'Two' },
    ])).toEqual([{ type: 'text_delta', text: 'OneTwo' }]);
  });

  it('folds the coalesced batch into the same blocks the raw stream folds to', () => {
    const raw = replayTaskLog([start, ...deltas, { type: 'text', runId: 'a', text: 'First run.' }, { type: 'text', runId: 'b', text: 'Second run.' }]);
    const merged = replayTaskLog([start, ...coalesceTaskLog(deltas), { type: 'text', runId: 'a', text: 'First run.' }, { type: 'text', runId: 'b', text: 'Second run.' }]);
    expect(unkeyed(merged.blocks)).toEqual(unkeyed(raw.blocks));
    expect(agentTexts(merged)).toEqual(['First run.', 'Second run.']);
  });
});

describe('a run that streams across a turn end', () => {
  it('opens the next turn’s run as its own block, without the break, whether or not the log ids runs', () => {
    const ided = replayTaskLog([
      start,
      { type: 'text_delta', runId: 'r1', text: 'Working' },
      { type: 'turn_end', reason: 'completed' },
      { type: 'turn_start', message: 'Go on' },
      { type: 'text_delta', runId: 'r1', text: 'Still working.' },
    ]);
    expect(agentTexts(ided)).toEqual(['Working', 'Still working.']);
    const legacy = replayTaskLog([
      start,
      { type: 'text_delta', text: 'Working' },
      { type: 'turn_end', reason: 'completed' },
      { type: 'turn_start', message: 'Go on' },
      { type: 'text_delta', text: '\n\nStill working.' },
    ]);
    expect(agentTexts(legacy)).toEqual(['Working', 'Still working.']);
  });

  it('ignores a delta of the closed turn’s run id when the view was reduced from an empty view one batch at a time', () => {
    let view = EMPTY_TASK_LOG;
    for (const event of [start, { type: 'text_delta', runId: 'r1', text: 'Working' } as const, { type: 'turn_end', reason: 'interrupted' } as const]) {
      view = reduceTaskLog(view, event);
    }
    expect(view.working).toBe(false);
    expect(agentTexts(view)).toEqual(['Working']);
    expect(Object.keys(view.streams)).toEqual([]);
  });
});
