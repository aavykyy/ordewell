import { describe, expect, it } from 'vitest';
import type { ReplyRun, ResearchLogEntry, ResearchStep } from '../../models/Task';
import type { TurnRun } from '../../services/AiService';
import type { SessionMessage } from '../../services/SessionMessage';
import { settleReply } from '../../services/settleReply';
import { EMPTY_CONVERSATION, reduceConversation, type ConversationView } from '../reduce';
import { fromTranscript } from '../transcript';

/**
 * Adversarial checks on the planner reply timeline (ADR-0017 A1), second
 * round: orderings of streams, retractions, stops and legacy sessions that the
 * recorded fixtures and the first round's tests do not drive. The invariant
 * under test is the user's: a run's words stay between the tool calls where it
 * said them, live and from the saved transcript, and the two views agree.
 */

const T0 = '2026-10-18T10:00:00.000Z';
const at = (ms: number) => new Date(Date.parse(T0) + ms).toISOString();

function timeline(view: ConversationView): string[] {
  return view.blocks.flatMap((b) => {
    if (b.type === 'message') return [`${b.role}: ${b.text}`];
    if (b.type === 'tool') return [`tool: ${b.headline.name}`];
    if (b.type === 'subagent') return ['subagent'];
    if (b.type === 'plan') return [`plan: ${b.status}`];
    if (b.type === 'thinking') return [`thinking: ${b.text}`];
    return [];
  });
}

function step(id: string, tool: string, callId: string, ms: number): { call: SessionMessage; done: SessionMessage; entry: ResearchStep } {
  const entry: ResearchStep = {
    id: `rs-${id}`, tool: tool as ResearchStep['tool'], args: '{}', result: 'ok', success: true, outcome: 'success',
    toolCallId: callId, timestamp: at(ms),
  };
  return {
    entry,
    call: { type: 'research_step', turnId: 't1', tool, args: '{}', toolCallId: callId },
    done: { type: 'research_step_done', turnId: 't1', step: entry },
  };
}

const live = (messages: SessionMessage[]) => messages.reduce(reduceConversation, EMPTY_CONVERSATION);

describe('many runs, many tool rounds, one turn', () => {
  // narration, read, narration, grep, answer — every copy settles after the
  // calls that followed it, the shape a harness planner's turn really has.
  const r1: ReplyRun = { segmentId: 'seg-1', text: 'First, the config.', startedAt: at(1000) };
  const r2: ReplyRun = { segmentId: 'seg-2', text: 'Now the parser.', startedAt: at(3000) };
  const r3: ReplyRun = { segmentId: 'seg-3', text: 'Both are fine.', startedAt: at(5000) };
  const read = step('1', 'read_file', 'c1', 2000);
  const grep = step('2', 'grep', 'c2', 4000);
  const stream: SessionMessage[] = [
    { type: 'planner_turn_started', turnId: 't1', prompt: 'check both' },
    { type: 'planner_text_delta', turnId: 't1', segmentId: 'seg-1', text: 'First, the config.' },
    read.call, read.done,
    { type: 'planner_text_delta', turnId: 't1', segmentId: 'seg-2', text: 'Now the parser.' },
    grep.call, grep.done,
    { type: 'planner_text_delta', turnId: 't1', segmentId: 'seg-3', text: 'Both are fine.' },
    { type: 'planner_message', turnId: 't1', content: 'Both are fine.', runs: [r1, r2, r3], timestamp: at(6000) },
    { type: 'planner_turn_ended', turnId: 't1', outcome: 'message' },
  ];

  it('keeps every run where it streamed, live', () => {
    expect(timeline(live(stream))).toEqual([
      'user: check both',
      'planner: First, the config.',
      'tool: Read',
      'planner: Now the parser.',
      'tool: Grep',
      'planner: Both are fine.',
    ]);
  });

  it('reloads the same order from the transcript entry and its research log', () => {
    const history = [{ role: 'assistant', content: 'Both are fine.', timestamp: at(6000), runs: [r1, r2, r3] }] as const;
    const log: ResearchLogEntry[] = [read.entry, grep.entry];
    expect(timeline(fromTranscript(history as never, log))).toEqual([
      'planner: First, the config.',
      'tool: Read',
      'planner: Now the parser.',
      'tool: Grep',
      'planner: Both are fine.',
    ]);
  });
});

describe('a complete copy that disagrees with its deltas', () => {
  it('settles the run where it began, not where its copy landed', () => {
    const stream: SessionMessage[] = [
      { type: 'planner_turn_started', turnId: 't1', prompt: 'look' },
      { type: 'planner_text_delta', turnId: 't1', segmentId: 'seg-1', text: 'Checking the tre' },
      step('1', 'read_file', 'c1', 2000).call,
      step('1', 'read_file', 'c1', 2000).done,
      // The stream lost a frame: the copy says more than the deltas did.
      { type: 'planner_message', turnId: 't1', content: 'Checking the tree.', timestamp: at(3000), runs: [
        { segmentId: 'seg-1', text: 'Checking the tree.', startedAt: at(1000) },
      ] },
      { type: 'planner_turn_ended', turnId: 't1', outcome: 'message' },
    ];
    expect(timeline(live(stream))).toEqual(['user: look', 'planner: Checking the tree.', 'tool: Read']);
  });

  it('drops a settled run the reply no longer contains, leaving its tool row', () => {
    const stream: SessionMessage[] = [
      { type: 'planner_turn_started', turnId: 't1', prompt: 'look' },
      { type: 'planner_text_delta', turnId: 't1', segmentId: 'seg-1', text: 'First thought.' },
      step('1', 'read_file', 'c1', 2000).call,
      step('1', 'read_file', 'c1', 2000).done,
      { type: 'planner_text_delta', turnId: 't1', segmentId: 'seg-2', text: 'Second thought.' },
      { type: 'planner_message', turnId: 't1', content: 'Second thought.', timestamp: at(4000), runs: [
        { segmentId: 'seg-2', text: 'Second thought.', startedAt: at(3000) },
      ] },
      { type: 'planner_turn_ended', turnId: 't1', outcome: 'message' },
    ];
    expect(timeline(live(stream))).toEqual(['user: look', 'tool: Read', 'planner: Second thought.']);
  });
});

describe('a retraction that arrives after the retry already streamed', () => {
  it('takes back the botched segment and the plan display it built, leaving the retry', () => {
    const stream = [
      { type: 'planner_turn_started', turnId: 't1', prompt: 'plan it' },
      { type: 'plan_token', turnId: 't1', segmentId: 'seg-bad', token: '{"tasks":[{' },
      { type: 'planner_text_retracted', turnId: 't1', segmentId: 'seg-bad' },
      { type: 'plan_token', turnId: 't1', segmentId: 'seg-good', token: '{"tasks":[]}' },
      { type: 'plan_generated', turnId: 't1', plan: { conversationHistory: [
        { role: 'assistant', content: 'Plan generated with 0 tasks.', timestamp: at(4000), kind: 'plan_generated' },
      ] } },
      { type: 'planner_turn_ended', turnId: 't1', outcome: 'plan' },
    ] as unknown as SessionMessage[];
    const view = live(stream);
    expect(timeline(view)).toEqual(['user: plan it', 'plan: generated']);
  });

  it('removes only the named segment when two stream at once', () => {
    const stream = [
      { type: 'planner_turn_started', turnId: 't1', prompt: 'plan it' },
      { type: 'plan_token', turnId: 't1', segmentId: 'seg-a', token: '{"tasks":[' },
      { type: 'plan_token', turnId: 't1', segmentId: 'seg-b', token: '{"tasks":[]}' },
      { type: 'planner_text_retracted', turnId: 't1', segmentId: 'seg-a' },
      { type: 'plan_generated', turnId: 't1', plan: { conversationHistory: [
        { role: 'assistant', content: 'Plan generated with 0 tasks.', timestamp: at(4000), kind: 'plan_generated' },
      ] } },
    ] as unknown as SessionMessage[];
    expect(timeline(live(stream))).toEqual(['user: plan it', 'plan: generated']);
  });
});

describe('a stop that lands between a run and its tool call', () => {
  it('leaves the streamed run and the unanswered call as they were', () => {
    const stream: SessionMessage[] = [
      { type: 'planner_turn_started', turnId: 't1', prompt: 'read it' },
      { type: 'planner_text_delta', turnId: 't1', segmentId: 'seg-1', text: 'Let me look.' },
      { type: 'research_step', turnId: 't1', tool: 'read_file', args: '{}', toolCallId: 'c1' },
      { type: 'planner_turn_ended', turnId: 't1', outcome: 'stopped' },
    ];
    expect(timeline(live(stream))).toEqual(['user: read it', 'planner: Let me look.', 'tool: Read']);
    const view = live(stream);
    expect(view.blocks[1]).toMatchObject({ streaming: false });
    expect(view.blocks[2]).toMatchObject({ type: 'tool', status: 'interrupted' });
  });
});

describe('a message that settles with no runs at all (a backend that reports none)', () => {
  it('replaces the final streamed segment rather than repeating it', () => {
    const stream: SessionMessage[] = [
      { type: 'planner_turn_started', turnId: 't1', prompt: 'look' },
      { type: 'planner_text_delta', turnId: 't1', segmentId: 'seg-1', text: 'Let me lo' },
      { type: 'planner_text_delta', turnId: 't1', segmentId: 'seg-1', text: 'ok.' },
      step('1', 'read_file', 'c1', 2000).call,
      step('1', 'read_file', 'c1', 2000).done,
      { type: 'planner_message', turnId: 't1', content: 'Nobody reported runs.', timestamp: at(3000) },
    ];
    // The final segment is the last thing the turn streamed; anything after a
    // segment means a later segment follows it. Here the message carries no
    // runs, so it settles last, and the narration above the read stays.
    expect(timeline(live(stream))).toEqual(['user: look', 'planner: Let me look.', 'tool: Read', 'planner: Nobody reported runs.']);
  });

  it('a runless settle after a tool call does not rewrite an earlier segment', () => {
    const stream: SessionMessage[] = [
      { type: 'planner_turn_started', turnId: 't1', prompt: 'look' },
      { type: 'planner_text_delta', turnId: 't1', segmentId: 'seg-1', text: 'Reading now.' },
      step('1', 'read_file', 'c1', 2000).call,
      step('1', 'read_file', 'c1', 2000).done,
      { type: 'planner_message', turnId: 't1', content: 'Done reading.', timestamp: at(3000) },
    ];
    // 'Reading now.' is not the turn's final segment: a later message settles
    // as its own block below the call.
    expect(timeline(live(stream))).toEqual(['user: look', 'planner: Reading now.', 'tool: Read', 'planner: Done reading.']);
  });
});

describe('a run that began after a tool call but before its result', () => {
  it('stays below the call it followed, live and after a reload', () => {
    // A research step is stamped when its call was announced (the producer's
    // rule), even though its result lands after the run that follows it.
    const read = step('1', 'read_file', 'c1', 1500);
    const stream: SessionMessage[] = [
      { type: 'planner_turn_started', turnId: 't1', prompt: 'look' },
      { type: 'planner_text_delta', turnId: 't1', segmentId: 'seg-1', text: 'Let me check.' },
      read.call,
      { type: 'planner_text_delta', turnId: 't1', segmentId: 'seg-2', text: 'While that runs…' },
      read.done,
      { type: 'planner_message', turnId: 't1', content: 'Done.', timestamp: at(6000), runs: [
        { segmentId: 'seg-1', text: 'Let me check.', startedAt: at(1000) },
        { segmentId: 'seg-2', text: 'While that runs…', startedAt: at(2000) },
      ] },
      { type: 'planner_turn_ended', turnId: 't1', outcome: 'message' },
    ];
    expect(timeline(live(stream))).toEqual([
      'user: look',
      'planner: Let me check.',
      'tool: Read',
      'planner: While that runs…',
    ]);
    const reloaded = fromTranscript(stream.filter((m) => m.type === 'planner_message').map((m) => ({
      role: 'assistant', content: m.content, timestamp: m.timestamp, runs: m.runs,
    })), [read.entry]);
    expect(timeline(reloaded)).toEqual(['planner: Let me check.', 'tool: Read', 'planner: While that runs…']);
  });
});

describe('a reload of a session saved before runs existed', () => {
  it('loads a transcript whose entries carry no runs, with the research log interleaved by time', () => {
    const view = fromTranscript(
      [
        { role: 'user', content: 'plan it', timestamp: at(0) },
        { role: 'assistant', content: 'I will read it.\n\nIt says hello.', timestamp: at(4000) },
      ],
      [
        { id: 'rs-1', tool: 'read_file', args: '{}', result: 'hello', success: true, outcome: 'success', toolCallId: 'c1', timestamp: at(2000) },
        { id: 'rs-2', tool: 'grep', args: '{}', result: 'none', success: true, outcome: 'success', toolCallId: 'c2', timestamp: at(3000) },
      ],
    );
    // A legacy session has no runs: the reply settles at its own time, below
    // the calls it made while composing it — the documented reload of a
    // session saved before runs existed.
    expect(timeline(view)).toEqual(['user: plan it', 'tool: Read', 'tool: Grep', 'planner: I will read it.\n\nIt says hello.']);
  });
});

describe('thinking between the deltas of one segment', () => {
  it('keeps the segment growing in one block around the thinking', () => {
    const stream: SessionMessage[] = [
      { type: 'planner_turn_started', turnId: 't1', prompt: 'think' },
      { type: 'planner_text_delta', turnId: 't1', segmentId: 'seg-1', text: 'Consider' },
      { type: 'planner_thinking_delta', turnId: 't1', segmentId: 'seg-t', text: 'a moment' },
      { type: 'planner_text_delta', turnId: 't1', segmentId: 'seg-1', text: 'ing.' },
      { type: 'planner_message', turnId: 't1', content: 'Considering.', timestamp: at(3000), runs: [
        { segmentId: 'seg-1', text: 'Considering.', startedAt: at(1000) },
      ] },
      { type: 'planner_turn_ended', turnId: 't1', outcome: 'message' },
    ];
    // The text keeps growing in its own block; the thinking it did between
    // the deltas is a step of its own, after the text that came first.
    expect(timeline(live(stream))).toEqual(['user: think', 'planner: Considering.', 'thinking: a moment']);
  });
});

describe('a turn whose transcript marker arrives while the segment streams', () => {
  it('takes the pending input for a user message the transcript also now carries', () => {
    const pending = fromTranscript([], [], undefined, [{ id: 'p1', source: 'user', text: 'go on', timestamp: at(0) }]);
    expect(timeline(pending)).toEqual(['user: go on']);
    const synced = reduceConversation(pending, {
      type: 'plan_generated',
      plan: { conversationHistory: [{ role: 'user', content: 'go on', timestamp: at(1000) }] },
    } as unknown as SessionMessage);
    expect(timeline(synced)).toEqual(['user: go on']);
    expect(synced.pendingInputs).toEqual([]);
  });
});

describe('a pending input the transcript carries behind a note written meanwhile', () => {
  const history = (...entries: [string, string, string, string?][]) => entries.map(([role, content, ms, kind]) => ({ role, content, timestamp: at(Number(ms)), ...(kind ? { kind } : {}) }));
  const sync = (view: ConversationView, conversationHistory: unknown[]) =>
    reduceConversation(view, { type: 'plan_generated', plan: { conversationHistory } } as unknown as SessionMessage);
  const reloaded = (earlier: unknown[]) => fromTranscript(earlier as never, [], undefined, [{ id: 'p1', source: 'user', text: 'go on', timestamp: at(0) }]);

  // The turn writes what it held at its own start, ahead of the notes written while it ran.
  it('takes it though a sync of the note has already moved the transcript past its time', () => {
    const start = history(['user', 'plan it', '-3000'], ['assistant', 'Which?', '-2000']);
    const note: [string, string, string, string] = ['assistant', 'Codex was enabled.', '5000', 'system'];
    let view = sync(reloaded(start), [...start, ...history(note)]);
    expect(view.pendingInputs).toHaveLength(1);

    view = sync(view, [...start, ...history(['user', 'go on', '1000'], note, ['assistant', 'Plan generated with 1 task.', '6000', 'plan_generated'])]);

    expect(view.pendingInputs).toEqual([]);
    expect(timeline(view).filter((line) => line === 'user: go on')).toHaveLength(1);
  });

  it('leaves it pending beside an identical message sent before it arrived', () => {
    const earlier = history(['user', 'go on', '-5000'], ['assistant', 'Which?', '-4000']);
    let view = sync(reloaded(earlier), [...earlier, ...history(['assistant', 'Codex was enabled.', '5000', 'system'])]);

    view = sync(view, [...earlier, ...history(['assistant', 'Codex was enabled.', '5000', 'system'], ['assistant', 'Plan generated with 1 task.', '6000', 'plan_generated'])]);

    expect(view.pendingInputs).toHaveLength(1);
  });
});

describe('a corrective retry after a botched envelope', () => {
  it('keeps the narration above the tool call and never draws the botched envelope beside the retry', async () => {
    const messages: SessionMessage[] = [];
    const progress = (input: SessionMessage): void => { messages.push(input); };
    const narration: TurnRun = { segmentId: 'seg-1', text: 'Let me look at the tasks.', startedAt: at(1000), narration: true };
    const envelope: TurnRun = { segmentId: 'seg-2', text: '{"tasks": [', startedAt: at(2000) };
    const retry: TurnRun = { segmentId: 'seg-3', text: 'Fixed.', startedAt: at(3000) };
    let call = 0;
    const turn = await settleReply({
      message: 'edit it',
      classify: { runners: ['claude-code'] },
      onProgress: (p) => {
        if (p.type === 'text_delta') progress({ type: 'planner_text_delta', turnId: 't1', segmentId: p.segmentId ?? '', text: p.text ?? '' });
        else if (p.type === 'text_retracted') progress({ type: 'planner_text_retracted', turnId: 't1', segmentId: p.segmentId });
        else if (p.type === 'tool_call') progress({ type: 'research_step', turnId: 't1', tool: p.tool ?? 'read_file', args: '{}', toolCallId: 'c1' });
        else if (p.type === 'tool_result') progress({ type: 'research_step_done', turnId: 't1', step: p.step! });
      },
      send: async () => {
        call += 1;
        if (call === 1) {
          progress({ type: 'planner_text_delta', turnId: 't1', segmentId: 'seg-1', text: narration.text });
          progress({ type: 'research_step', turnId: 't1', tool: 'read_file', args: '{}', toolCallId: 'c1' });
          progress({ type: 'research_step_done', turnId: 't1', step: {
            id: 'rs-1', tool: 'read_file', args: '{}', result: 'ok', success: true, outcome: 'success', toolCallId: 'c1', timestamp: at(1500),
          } });
          progress({ type: 'planner_text_delta', turnId: 't1', segmentId: 'seg-2', text: envelope.text });
          return { text: envelope.text, researchLog: [], runs: [narration, envelope] };
        }
        progress({ type: 'planner_text_delta', turnId: 't1', segmentId: 'seg-3', text: retry.text });
        return { text: retry.text, researchLog: [], runs: [retry] };
      },
    });
    expect(turn).toMatchObject({ kind: 'message', text: 'Fixed.' });
    const view = reduceConversation(
      { ...EMPTY_CONVERSATION },
      { type: 'planner_turn_started', turnId: 't1', prompt: 'edit it' },
    );
    const stream = [
      ...messages,
      { type: 'planner_message', turnId: 't1', content: 'Fixed.', timestamp: at(4000), runs: turn.runs },
      { type: 'planner_turn_ended', turnId: 't1', outcome: 'message' },
    ] as SessionMessage[];
    expect(timeline(stream.reduce(reduceConversation, view))).toEqual([
      'user: edit it',
      'planner: Let me look at the tasks.',
      'tool: Read',
      'planner: Fixed.',
    ]);
  });
});

describe('pending inputs a live turn adopts', () => {
  it('draws a pending user message and wake-ups once, in the turn that starts with them', () => {
    const pending = fromTranscript([], [], undefined, [
      { id: 'u1', source: 'user', text: 'go on', timestamp: at(0) },
      { id: 'w1', source: 'supervisor', text: 'Task 1 passed.', timestamp: at(0) },
    ]);
    expect(timeline(pending)).toEqual(['user: go on', 'wake_up: Task 1 passed.']);

    const turn = reduceConversation(pending, {
      type: 'planner_turn_started', turnId: 't1', prompt: 'go on', wakeUps: ['Task 1 passed.'],
    } as SessionMessage);
    // The pending inputs already drew in arrival order; the turn adopts them
    // in place rather than adding a second copy.
    expect(timeline(turn)).toEqual(['user: go on', 'wake_up: Task 1 passed.']);
    expect(turn.pendingInputs).toEqual([]);

    // The transcript that lands with them adds neither again.
    const synced = reduceConversation(turn, {
      type: 'plan_generated',
      plan: { conversationHistory: [
        { role: 'user', content: 'go on', timestamp: at(1000) },
        { role: 'user', content: 'Task 1 passed.', timestamp: at(1000), kind: 'wake_up' },
      ] },
    } as unknown as SessionMessage);
    expect(timeline(synced)).toEqual(['user: go on', 'wake_up: Task 1 passed.']);
  });
});
