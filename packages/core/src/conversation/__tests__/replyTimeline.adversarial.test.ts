import { describe, expect, it } from 'vitest';
import type { ReplyRun, ResearchLogEntry } from '../../models/Task';
import type { SerializedConversationMessage, SessionMessage } from '../../services/SessionMessage';
import { EMPTY_CONVERSATION, reduceConversation, type ConversationView } from '../reduce';
import { fromTranscript } from '../transcript';

/**
 * Adversarial checks on ADR-0017 A1 (a planner reply keeps its text where it
 * streamed): the shapes the happy-path tests do not drive — an edit turn's
 * narration, a failed turn's note, a compaction over replies with runs —
 * folded live and reloaded from the transcript they save.
 */

function timeline(view: ConversationView): string[] {
  return view.blocks.flatMap((b) => {
    if (b.type === 'message') return [`${b.role}: ${b.text}`];
    if (b.type === 'tool') return [`tool: ${b.headline.name}`];
    if (b.type === 'plan') return [`plan: ${b.status}`];
    if (b.type === 'compaction') return [`compaction: ${b.summary}`];
    return [];
  });
}

const T0 = '2026-10-18T10:00:00.000Z';
const at = (ms: number) => new Date(Date.parse(T0) + ms).toISOString();

/** A turn: the user's message, a run of narration, a tool round, a run of answer, all under one turn id. */
function streamedTurn(turnId: string, narration: string, answer: string): { messages: SessionMessage[]; runs: ReplyRun[] } {
  const narr: ReplyRun = { segmentId: 'seg-narration', text: narration, startedAt: at(1000) };
  const reply: ReplyRun = { segmentId: 'seg-answer', text: answer, startedAt: at(3000) };
  const step: ResearchLogEntry = {
    id: 'rs-1', tool: 'read_file', args: '{"path":"README.md"}', result: 'hello', success: true, outcome: 'success',
    toolCallId: 'c1', timestamp: at(2000),
  };
  const messages: unknown[] = [
    { type: 'planner_turn_started', turnId, prompt: 'look and edit' },
    { type: 'planner_text_delta', turnId, segmentId: narr.segmentId, text: narration },
    { type: 'research_step', turnId, tool: 'read_file', args: '{"path":"README.md"}', toolCallId: 'c1' },
    { type: 'research_step_done', turnId, step },
    { type: 'planner_text_delta', turnId, segmentId: reply.segmentId, text: answer },
  ];
  return { messages: messages as SessionMessage[], runs: [narr, reply] };
}

function reloaded(history: readonly SerializedConversationMessage[], researchLog: readonly ResearchLogEntry[]): ConversationView {
  return fromTranscript(history, researchLog);
}

describe('an edit turn whose narration streamed before the edit', () => {
  // What applyTaskOps broadcasts and appends: the said message (with runs),
  // then the "Tasks updated" line without one — both at the same timestamp.
  const turnId = 'turn-edit';
  const { messages, runs } = streamedTurn(turnId, 'I will reschedule task 2 now.', 'Done — task 2 follows task 1.');
  const said: SerializedConversationMessage = {
    role: 'assistant', content: `I will reschedule task 2 now.\n\nDone — task 2 follows task 1.`, timestamp: at(4000), runs,
  };
  const updated: SerializedConversationMessage = { role: 'assistant', content: 'Tasks updated:\n- task 2 after task 1', timestamp: at(4000) };
  const researchLog: ResearchLogEntry[] = [
    { id: 'rs-1', tool: 'read_file', args: '{"path":"README.md"}', result: 'hello', success: true, outcome: 'success', toolCallId: 'c1', timestamp: at(2000) },
  ];

  it('keeps the narration above the tool row and the "Tasks updated" line last, live', () => {
    const live = [...messages, { type: 'planner_message', content: said.content, timestamp: said.timestamp, turnId, runs } as SessionMessage, { type: 'planner_message', content: updated.content, timestamp: updated.timestamp, turnId } as SessionMessage]
      .reduce(reduceConversation, EMPTY_CONVERSATION);
    expect(timeline(live)).toEqual([
      'user: look and edit',
      'planner: I will reschedule task 2 now.',
      'tool: Read',
      'planner: Done — task 2 follows task 1.',
      'planner: Tasks updated:\n- task 2 after task 1',
    ]);
  });

  it('reloads the same order from the two entries the edit saved', () => {
    const view = reloaded([said, updated], researchLog);
    expect(timeline(view)).toEqual([
      'planner: I will reschedule task 2 now.',
      'tool: Read',
      'planner: Done — task 2 follows task 1.',
      'planner: Tasks updated:\n- task 2 after task 1',
    ]);
  });
});

describe('a failed turn whose failure note follows narration', () => {
  // What settleReply's note() builds: the kept narration, then a run that
  // never streamed carrying the failure. The session appends it to the
  // transcript as one entry with those runs.
  const turnId = 'turn-failed';
  const narration: ReplyRun = { segmentId: 'seg-narration', text: 'Let me look at the parser.', startedAt: at(1000) };
  const failure: ReplyRun = { segmentId: 'seg-note', text: 'The claude-code planner died on exit code 1.', startedAt: at(3000) };
  const entry: SerializedConversationMessage = {
    role: 'assistant', content: 'The claude-code planner died on exit code 1.', timestamp: at(3000), runs: [narration, failure],
  };
  const researchLog: ResearchLogEntry[] = [
    { id: 'rs-1', tool: 'read_file', args: '{"path":"parser.ts"}', result: 'export {}', success: true, outcome: 'success', toolCallId: 'c1', timestamp: at(2000) },
  ];

  it('settles the narration where it streamed and the failure after it, live', () => {
    const live = ([
      { type: 'planner_turn_started', turnId, prompt: 'why is parsing slow?', timestamp: T0 },
      { type: 'planner_text_delta', turnId, segmentId: narration.segmentId, text: narration.text, timestamp: at(1000) },
      { type: 'research_step', turnId, tool: 'read_file', args: '{}', toolCallId: 'c1', timestamp: at(2000) },
      { type: 'research_step_done', turnId, step: researchLog[0], timestamp: at(2000) },
      { type: 'planner_message', content: failure.text, timestamp: at(3000), turnId, runs: [narration, failure] },
      { type: 'planner_turn_ended', turnId, outcome: 'error' },
    ] as SessionMessage[]).reduce(reduceConversation, EMPTY_CONVERSATION);
    expect(timeline(live)).toEqual([
      'user: why is parsing slow?',
      'planner: Let me look at the parser.',
      'tool: Read',
      'planner: The claude-code planner died on exit code 1.',
    ]);
  });

  it('reloads the failure after the narration it followed', () => {
    expect(timeline(reloaded([entry], researchLog))).toEqual([
      'planner: Let me look at the parser.',
      'tool: Read',
      'planner: The claude-code planner died on exit code 1.',
    ]);
  });
});

describe('a compaction over replies that kept runs', () => {
  // After a compaction the transcript is [summary, ...tail]; the tail's
  // replies carry runs, and the research of the condensed turns is filtered
  // by the cutoff. A reload must draw the summary first and the kept runs
  // where they streamed.
  const summary: SerializedConversationMessage = { role: 'assistant', content: 'Summary of everything so far.', timestamp: at(0), kind: 'compaction' };
  const keptUser: SerializedConversationMessage = { role: 'user', content: 'what does it say?', timestamp: at(2000) };
  const keptSaid: SerializedConversationMessage = {
    role: 'assistant', content: 'I will read it.\n\nIt says hello.', timestamp: at(5000),
    runs: [
      { segmentId: 'seg-a', text: 'I will read it.', startedAt: at(2500) },
      { segmentId: 'seg-b', text: 'It says hello.', startedAt: at(4000) },
    ],
  };
  const oldResearch: ResearchLogEntry[] = [
    { id: 'up-1', type: 'user_prompt', content: 'the goal', timestamp: at(0) },
    { id: 'rs-old', tool: 'grep', args: '{}', result: 'old', success: true, outcome: 'success', toolCallId: 'c0', timestamp: at(1500) },
  ];
  const keptResearch: ResearchLogEntry[] = [
    { id: 'rs-1', tool: 'read_file', args: '{"path":"README.md"}', result: 'hello', success: true, outcome: 'success', toolCallId: 'c1', timestamp: at(3000) },
  ];

  it('opens on the summary with the kept runs among the kept research, and none of the condensed research', () => {
    const view = reloaded([summary, keptUser, keptSaid], [...oldResearch, ...keptResearch]);
    expect(timeline(view)).toEqual([
      'compaction: Summary of everything so far.',
      'user: what does it say?',
      'planner: I will read it.',
      'tool: Read',
      'planner: It says hello.',
    ]);
  });
});

describe('a transcript entry whose runs carry a stale segment id from a fork', () => {
  // A fork copies the transcript with its runs; reloading the fork must draw
  // every run, including one whose segment never streamed on this surface.
  it('draws each run of a forked reply, in the order it began', () => {
    const entry: SerializedConversationMessage = {
      role: 'assistant', content: 'First.\n\nSecond.', timestamp: at(5000),
      runs: [
        { segmentId: 'seg-forked-a', text: 'First.', startedAt: at(1000) },
        { segmentId: 'seg-forked-b', text: 'Second.', startedAt: at(3000) },
      ],
    };
    expect(timeline(reloaded([entry], []))).toEqual(['planner: First.', 'planner: Second.']);
  });
});
