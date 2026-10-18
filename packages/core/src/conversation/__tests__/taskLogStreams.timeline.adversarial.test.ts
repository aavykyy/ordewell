import { describe, expect, it } from 'vitest';
import type { TaskLogEvent } from '../../models/TaskLog';
import { EMPTY_TASK_LOG, reduceTaskLog, replayTaskLog, type TaskLogView } from '../taskLog';
import { EMPTY_TASK_LOG_FOLLOW, followTaskLog, type TaskLogBatch, type TaskLogFollow } from '../taskLogFollow';

/**
 * Adversarial checks on a structured task's log (ADR-0018, O1b), second
 * round: the run orderings, stops, notes and reloads the recorded fixtures do
 * not drive — each checked live (folded batch by batch), from the saved log
 * (replayed) and through the follow state the TUI and VS Code share.
 */

const start: TaskLogEvent = { type: 'turn_start', message: 'Do the task' };

function shown(view: TaskLogView): string[] {
  return view.blocks.flatMap((b) => {
    if (b.type === 'usage') return [];
    if (b.type === 'message') return [`${b.role}:${b.text}`];
    if (b.type === 'tool') return [`tool:${b.headline.name}:${b.status}`];
    if (b.type === 'subagent') return ['subagent'];
    return [b.type];
  });
}

/** The task log's blocks in order, folded from an empty view one event at a time — what a surface watching live holds. */
function folded(events: readonly TaskLogEvent[]): TaskLogView {
  return events.reduce(reduceTaskLog, EMPTY_TASK_LOG);
}

function reloaded(events: readonly TaskLogEvent[]): TaskLogView {
  return replayTaskLog(events);
}

describe('runs and tool calls interleaved', () => {
  const events: TaskLogEvent[] = [
    start,
    { type: 'text_delta', runId: 'r1', text: 'Let me look' },
    { type: 'tool_call', id: 'c1', name: 'Bash', args: '{"command":"ls"}' },
    { type: 'text_delta', runId: 'r2', text: 'The tree is fine.' },
    { type: 'tool_result', id: 'c1', output: 'ok', success: true },
    // The first run's copy lands after everything it announced.
    { type: 'text', runId: 'r1', text: 'Let me look at the tree.' },
    { type: 'text', runId: 'r2', text: 'The tree is fine.' },
  ];

  it('keeps each run above the call that followed it, live and reloaded', () => {
    const expected = ['user:Do the task', 'agent:Let me look at the tree.', 'tool:Bash:ok', 'agent:The tree is fine.'];
    expect(shown(folded(events))).toEqual(expected);
    expect(shown(reloaded(events))).toEqual(expected);
  });

  it('folds identically through a live batch merge of coalesced deltas', () => {
    // What the recorder puts on the wire: the two r1 deltas merged, one batch.
    const live = folded([
      start,
      { type: 'text_delta', runId: 'r1', text: 'Let me look' },
      { type: 'tool_call', id: 'c1', name: 'Bash', args: '{"command":"ls"}' },
      { type: 'text_delta', runId: 'r2', text: 'The tree is fine.' },
      { type: 'tool_result', id: 'c1', output: 'ok', success: true },
      { type: 'text', runId: 'r1', text: 'Let me look at the tree.' },
      { type: 'text', runId: 'r2', text: 'The tree is fine.' },
    ]);
    expect(shown(live)).toEqual(shown(reloaded(events)));
  });

  it('a run that never streamed appends where its copy landed, after the call', () => {
    const noDelta = folded([
      start,
      { type: 'tool_call', id: 'c1', name: 'Bash', args: '{}' },
      { type: 'tool_result', id: 'c1', output: 'ok', success: true },
      { type: 'text', runId: 'r9', text: 'Done with the tree.' },
    ]);
    expect(shown(noDelta)).toEqual(['user:Do the task', 'tool:Bash:ok', 'agent:Done with the tree.']);
  });
});

describe('a note the runner read mid-run', () => {
  it('sits between the run it interrupted and the run that followed it, all the way to the reload', () => {
    const events: TaskLogEvent[] = [
      start,
      { type: 'text_delta', runId: 'r1', text: 'Checking' },
      { type: 'message_queued', messageId: 'm1', text: 'use YAML' },
      { type: 'message_delivered', messageId: 'm1', text: 'use YAML' },
      { type: 'text_delta', runId: 'r2', text: 'Done.' },
      { type: 'text', runId: 'r1', text: 'Checking the tree.' },
      { type: 'text', runId: 'r2', text: 'Done.' },
    ];
    const expected = ['user:Do the task', 'agent:Checking the tree.', 'user:use YAML', 'agent:Done.'];
    expect(shown(folded(events))).toEqual(expected);
    expect(shown(reloaded(events))).toEqual(expected);
  });

  it('a late complete copy does not move below the note it predates', () => {
    const view = folded([
      start,
      { type: 'text_delta', runId: 'r1', text: 'Checking' },
      { type: 'message_delivered', messageId: 'm1', text: 'use YAML' },
      { type: 'text', runId: 'r1', text: 'Checking the tree.' },
    ]);
    expect(shown(view)).toEqual(['user:Do the task', 'agent:Checking the tree.', 'user:use YAML']);
  });
});

describe('a failed turn that repeats its own last words', () => {
  const limit = "You've hit your session limit · resets 8:10pm (Europe/Rome)";

  it('takes back the streamed repeat and shows the failure once, with a real reply above it', () => {
    const view = folded([
      start,
      { type: 'text_delta', runId: 'r1', text: 'The cache belongs in src/cache.ts.' },
      { type: 'text', runId: 'r1', text: 'The cache belongs in src/cache.ts.' },
      { type: 'text_delta', runId: 'r2', text: limit },
      { type: 'error', message: `${limit}.` },
    ]);
    expect(shown(view)).toEqual(['user:Do the task', 'agent:The cache belongs in src/cache.ts.', 'error:' + limit + '.']);
  });

  it('keeps later agent text that only resembles the failure', () => {
    const view = folded([
      start,
      { type: 'text_delta', runId: 'r1', text: limit },
      { type: 'text', runId: 'r1', text: limit },
      { type: 'text', runId: 'r2', text: 'But I can continue after the reset.' },
      { type: 'error', message: limit },
    ]);
    // The latest text is a real reply, so nothing is taken back.
    expect(shown(view)).toEqual(['user:Do the task', 'agent:' + limit, 'agent:But I can continue after the reset.', 'error:' + limit]);
  });
});

describe('a stop and a restart within one attempt', () => {
  it('marks the pending call interrupted and the text settled, then starts the next turn clean', () => {
    const stopped = folded([
      start,
      { type: 'text_delta', runId: 'r1', text: 'Working' },
      { type: 'tool_call', id: 'c1', name: 'Bash', args: '{}' },
      { type: 'turn_end', reason: 'interrupted' },
    ]);
    expect(shown(stopped)).toEqual(['user:Do the task', 'agent:Working', 'tool:Bash:interrupted', 'system:Interrupted.']);
    expect(stopped.working).toBe(false);
    expect(stopped.lastTurnEnd).toBe('interrupted');

    const restarted = folded([
      start,
      { type: 'text_delta', runId: 'r1', text: 'Working' },
      { type: 'tool_call', id: 'c1', name: 'Bash', args: '{}' },
      { type: 'turn_end', reason: 'interrupted' },
      { type: 'turn_start', message: 'Go on' },
      { type: 'text_delta', runId: 'r1', text: 'Continuing.' },
      { type: 'text', runId: 'r1', text: 'Continuing.' },
    ]);
    expect(shown(restarted)).toEqual([
      'user:Do the task', 'agent:Working', 'tool:Bash:interrupted', 'system:Interrupted.', 'user:Go on', 'agent:Continuing.',
    ]);
  });

  it('a runner_ended closes an open call that never returned', () => {
    const view = folded([
      start,
      { type: 'tool_call', id: 'c1', name: 'Bash', args: '{}' },
      { type: 'runner_ended' },
    ]);
    expect(shown(view)).toEqual(['user:Do the task', 'tool:Bash:interrupted']);
    expect(view.working).toBe(false);
  });
});

describe('a force send whose message opened the next turn', () => {
  it('shows the forced message once, at the turn it opened, without the queue entry', () => {
    const view = folded([
      start,
      { type: 'text_delta', runId: 'r1', text: 'Working' },
      { type: 'turn_end', reason: 'interrupted' },
      { type: 'message_queued', messageId: 'm1', text: 'use YAML', forced: true },
      { type: 'turn_start', message: 'use YAML', messageId: 'm1', forced: true },
      { type: 'text_delta', runId: 'r2', text: 'Switching.' },
      { type: 'text', runId: 'r2', text: 'Switching.' },
    ]);
    expect(shown(view)).toEqual(['user:Do the task', 'agent:Working', 'system:Interrupted.', 'user:use YAML', 'agent:Switching.']);
    expect(view.queued).toEqual([]);
  });

  it('a forced message still queued is listed once, not shown as a turn', () => {
    const view = folded([
      start,
      { type: 'message_queued', messageId: 'm1', text: 'use YAML' },
      { type: 'message_queued', messageId: 'm1', text: 'use YAML', forced: true },
    ]);
    expect(view.queued).toEqual([{ id: 'm1', text: 'use YAML', forced: true }]);
    expect(shown(view)).toEqual(['user:Do the task']);
  });
});

describe('thinking, subagents and usage between runs', () => {
  it('a subagent’s thinking stays nested while the planner runs on', () => {
    const view = folded([
      start,
      { type: 'text_delta', runId: 'r1', text: 'Delegating' },
      { type: 'tool_call', id: 'c1', name: 'Task', args: '{"prompt":"look"}' },
      { type: 'subagent_started', subagentId: 'c1', brief: 'look' },
      { type: 'thinking_delta', text: 'hmm', subagentId: 'c1' },
      { type: 'text_delta', runId: 'r2', text: 'While it looks…' },
      { type: 'text', runId: 'r1', text: 'Delegating now.' },
      { type: 'subagent_finished', subagentId: 'c1', outcome: 'done', digest: 'found it' },
    ]);
    // The run that began first stays first; the call became the subagent's
    // block at its own place; the run that began after it follows.
    expect(shown(view)).toEqual(['user:Do the task', 'agent:Delegating now.', 'subagent', 'agent:While it looks…']);
    const subagent = view.blocks.find((b) => b.type === 'subagent');
    expect(subagent).toMatchObject({ type: 'subagent', children: [{ type: 'thinking', text: 'hmm' }] });
  });
});

describe('a saved attempt a surface follows live', () => {
  const saved: TaskLogEvent[] = [
    start,
    { type: 'text_delta', runId: 'r1', text: 'First attempt.' },
    { type: 'turn_end', reason: 'completed' },
  ];

  const opened = (): TaskLogFollow => followTaskLog(EMPTY_TASK_LOG_FOLLOW, { type: 'opened' });
  const loaded = (state: TaskLogFollow, input: { attempt: number; events: TaskLogEvent[]; position?: { stream: string; seq: number }; attempts?: number[]; abandoned?: boolean }) =>
    followTaskLog(state, { type: 'loaded', ...input });
  const live = (state: TaskLogFollow, batch: TaskLogBatch) => followTaskLog(state, { type: 'live', ...batch });

  it('a finished attempt is not Working, live or from the file', () => {
    const fromFile = replayTaskLog(saved);
    expect(fromFile.working).toBe(false);
    expect(fromFile.lastTurnEnd).toBe('completed');
    const state = loaded(opened(), { attempt: 1, events: saved });
    expect(state.view.working).toBe(false);
  });

  it('an attempt cut off mid-turn still shows Working from its file', () => {
    const cut: TaskLogEvent[] = [start, { type: 'text_delta', runId: 'r1', text: 'Working' }];
    expect(replayTaskLog(cut).working).toBe(true);
    const state = loaded(opened(), { attempt: 1, events: cut });
    expect(state.view.working).toBe(true);
    // The end arrives live and stops it.
    const ended = live(state, { attempt: 1, events: [{ type: 'turn_end', reason: 'completed' }], position: { stream: 's', seq: 2 } });
    expect(ended.view.working).toBe(false);
  });

  it('a batch of a finished attempt carries its end only as far as the file did', () => {
    let state = loaded(opened(), { attempt: 1, events: saved, position: { stream: 's', seq: 1 } });
    const replay = live(state, { attempt: 1, events: saved, position: { stream: 's', seq: 1 } });
    expect(replay).toBe(state);
    state = live(state, { attempt: 1, events: [{ type: 'turn_end', reason: 'completed' }], position: { stream: 's', seq: 2 } });
    expect(shown(state.view)).toEqual(['user:Do the task', 'agent:First attempt.']);
  });

  it('a retry opens a new attempt and the old file is not grafted onto it', () => {
    let state = loaded(opened(), { attempt: 1, events: saved, position: { stream: 's', seq: 1 } });
    state = live(state, { attempt: 2, events: [{ type: 'turn_start', message: 'Try again' }, { type: 'text_delta', runId: 'r2', text: 'Second.' }], position: { stream: 's', seq: 2 } });
    expect(state.attempt).toBe(2);
    expect(shown(state.view)).toEqual(['user:Try again', 'agent:Second.']);
  });

  it('a pinned older attempt keeps its view while a new attempt streams, and can follow it later', () => {
    let state = loaded(opened(), { attempt: 2, attempts: [1, 2], events: [{ type: 'text', runId: 'r2', text: 'second' }], position: { stream: 's', seq: 1 } });
    state = followTaskLog(state, { type: 'picked', attempt: 1 });
    expect(state.followLatest).toBe(false);
    state = loaded(state, { attempt: 1, events: [{ type: 'turn_start', message: 'first' }, { type: 'text', runId: 'r1', text: 'first' }], position: { stream: 's', seq: 2 } });
    expect(state.attempt).toBe(1);
    // The pinned older attempt keeps its view while the newest streams.
    state = live(state, { attempt: 2, events: [{ type: 'turn_start', message: 'Try again' }], position: { stream: 's', seq: 3 } });
    expect(state.attempt).toBe(1);
    expect(state.attempts).toEqual([1, 2]);
    expect(shown(state.view)).toEqual(['user:first', 'agent:first']);
    // Picking the newest follows it again, with the buffered batch replayed.
    state = followTaskLog(state, { type: 'picked', attempt: 2 });
    expect(state.followLatest).toBe(true);
    state = loaded(state, { attempt: 2, events: [{ type: 'text', runId: 'r2', text: 'second' }], position: { stream: 's', seq: 2 } });
    expect(shown(state.view)).toEqual(['agent:second']);
    state = live(state, { attempt: 2, events: [{ type: 'text', runId: 'r2b', text: 'later' }], position: { stream: 's', seq: 4 } });
    expect(shown(state.view)).toEqual(['agent:second', 'agent:later']);
  });

  it('an old daemon response without positions joins by replay, not by content', () => {
    // The read has no position and the buffered live copy has none either:
    // the old behaviour, the read wins for its own attempt.
    let state = live(opened(), { attempt: 1, events: [{ type: 'text_delta', runId: 'r1', text: 'live' }] });
    state = loaded(state, { attempt: 1, events: [{ type: 'text', runId: 'r1', text: 'saved' }] });
    expect(shown(state.view)).toEqual(['agent:saved']);
    // A batch of another attempt replays on top anyway.
    state = live(state, { attempt: 1, events: [{ type: 'turn_end', reason: 'completed' }] });
    expect(state.view.working).toBe(false);
  });

  it('a batch that arrives before any read is buffered, then replayed after the load', () => {
    let state = opened();
    state = live(state, { attempt: 3, events: [{ type: 'turn_start', message: 'third' }] });
    expect(state.pending).toHaveLength(1);
    state = loaded(state, { attempt: 1, events: saved, position: { stream: 's', seq: 1 } });
    // The buffered newer attempt takes the view (following latest).
    expect(state.attempt).toBe(3);
    expect(shown(state.view)).toEqual(['user:third']);
  });
});

describe('the saved log a surface reads back', () => {
  it('is byte-for-byte the same view as the live fold for a whole attempt, stream boundaries and all', () => {
    const events: TaskLogEvent[] = [
      { type: 'task_skills', skills: [{ name: 'tdd', source: 'global', path: '/g/tdd/SKILL.md' }] },
      start,
      { type: 'thinking_delta', text: 'hmm' },
      { type: 'thinking', text: 'hmm' },
      { type: 'text_delta', runId: 'r1', text: 'Reading' },
      { type: 'tool_call', id: 'c1', name: 'Read', args: '{"file_path":"/repo/a.ts"}' },
      { type: 'tool_result', id: 'c1', output: 'export {}', success: true },
      { type: 'text_delta', runId: 'r1', text: ' done' },
      { type: 'text', runId: 'r1', text: 'Reading done' },
      { type: 'usage', record: { source: 'claude-code', model: 'sonnet', inputTokens: 10, outputTokens: 5 } },
      { type: 'turn_end', reason: 'completed' },
    ];
    expect(shown(folded(events))).toEqual(shown(reloaded(events)));
    expect(folded(events).working).toBe(false);
    expect(folded(events).usage).toBeDefined();
  });
});
