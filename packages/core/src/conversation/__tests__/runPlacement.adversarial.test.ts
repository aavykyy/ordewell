import { describe, expect, it } from 'vitest';
import type { ReplyRun } from '../../models/Task';
import type { SessionMessage } from '../../services/SessionMessage';
import { EMPTY_TASK_LOG, reduceTaskLog, type TaskLogView } from '../taskLog';
import { EMPTY_CONVERSATION, reduceConversation, type ConversationView } from '../reduce';

/**
 * Adversarial: the one rule for where a run of reply text lands, checked
 * across the two views that keep it — the task log (ADR-0018 O1b) and the
 * planner chat (ADR-0017 A1). A run's complete copy must settle the block its
 * own deltas built, wherever that block now sits, so a late read-back can
 * never move text below the tool row it announced.
 */

const start = { type: 'turn_start', message: 'Do the task' } as const;

function kinds(view: TaskLogView): string[] {
  return view.blocks.map((b) => {
    if (b.type === 'message') return `${b.role}:${b.text}`;
    if (b.type === 'tool') return `tool:${b.headline.name}`;
    return b.type;
  });
}

describe('a run’s complete copy settles its own block, wherever it sits', () => {
  it('keeps an earlier run above the tool row when its copy arrives last (task log)', () => {
    const view = reduceTaskLog(reduceTaskLog(reduceTaskLog(reduceTaskLog(reduceTaskLog(reduceTaskLog(EMPTY_TASK_LOG, start),
      { type: 'text_delta', runId: 'r1', text: 'Let me look' }),
      { type: 'tool_call', id: 'c1', name: 'Bash', args: '{"command":"ls"}' }),
      { type: 'text_delta', runId: 'r2', text: 'The tree is fine.' }),
      { type: 'tool_result', id: 'c1', output: 'ok', success: true }),
      { type: 'text', runId: 'r1', text: 'Let me look at the tree.' });
    expect(kinds(view)).toEqual([
      'user:Do the task',
      'agent:Let me look at the tree.',
      'tool:Bash',
      'agent:The tree is fine.',
    ]);
  });

  it('keeps an earlier run above the tool row when its copy arrives first (task log)', () => {
    const view = reduceTaskLog(reduceTaskLog(reduceTaskLog(reduceTaskLog(reduceTaskLog(reduceTaskLog(EMPTY_TASK_LOG, start),
      { type: 'text_delta', runId: 'r1', text: 'Let me look' }),
      { type: 'text', runId: 'r1', text: 'Let me look at the tree.' }),
      { type: 'tool_call', id: 'c1', name: 'Bash', args: '{"command":"ls"}' }),
      { type: 'tool_result', id: 'c1', output: 'ok', success: true }),
      { type: 'text_delta', runId: 'r2', text: 'The tree is fine.' });
    expect(kinds(view)).toEqual([
      'user:Do the task',
      'agent:Let me look at the tree.',
      'tool:Bash',
      'agent:The tree is fine.',
    ]);
  });

  it('replaces only the named run’s block, leaving a later run untouched (task log)', () => {
    const view = reduceTaskLog(reduceTaskLog(reduceTaskLog(EMPTY_TASK_LOG, start),
      { type: 'text_delta', runId: 'r1', text: 'Checking' }),
      { type: 'text_delta', runId: 'r2', text: 'Done.' });
    const settled = reduceTaskLog(view, { type: 'text', runId: 'r1', text: 'Checking the tests.' });
    expect(kinds(settled)).toEqual(['user:Do the task', 'agent:Checking the tests.', 'agent:Done.']);
  });
});

function chat(blocks: SessionMessage[]): ConversationView {
  return blocks.reduce(reduceConversation, EMPTY_CONVERSATION);
}

function chatLines(view: ConversationView): string[] {
  return view.blocks.flatMap((b) => {
    if (b.type === 'message') return [`${b.role}:${b.text}`];
    if (b.type === 'tool') return [`tool:${b.headline.name}`];
    return [];
  });
}

describe('the planner chat places a reply’s runs the same way', () => {
  const narration: ReplyRun = { segmentId: 'seg-1', text: 'Let me read it.', startedAt: '2026-10-18T10:00:01.000Z' };
  const answer: ReplyRun = { segmentId: 'seg-2', text: 'It says hello.', startedAt: '2026-10-18T10:00:03.000Z' };

  it('keeps the narration above the tool row, and a run that never streamed last', () => {
    const view = chat([
      { type: 'planner_turn_started', turnId: 't1', prompt: 'read it' },
      { type: 'planner_text_delta', turnId: 't1', segmentId: 'seg-1', text: narration.text },
      { type: 'research_step', turnId: 't1', tool: 'read_file', args: '{"path":"README.md"}', toolCallId: 'c1' },
      { type: 'research_step_done', turnId: 't1', step: { id: 'rs1', tool: 'read_file', args: '{"path":"README.md"}', result: 'hello', success: true, outcome: 'success', toolCallId: 'c1', timestamp: '2026-10-18T10:00:02.000Z' } },
      { type: 'planner_text_delta', turnId: 't1', segmentId: 'seg-2', text: answer.text },
      { type: 'planner_message', turnId: 't1', content: 'It says hello.', runs: [
        narration, answer, { segmentId: 'seg-note', text: 'Nothing was changed.', startedAt: '2026-10-18T10:00:04.000Z' },
      ] },
    ] as SessionMessage[]);
    expect(chatLines(view)).toEqual([
      'user:read it',
      'planner:Let me read it.',
      'tool:Read',
      'planner:It says hello.',
      'planner:Nothing was changed.',
    ]);
  });

  it('drops a segment of the turn the reply no longer contains', () => {
    const view = chat([
      { type: 'planner_turn_started', turnId: 't1', prompt: 'read it' },
      { type: 'planner_text_delta', turnId: 't1', segmentId: 'seg-stale', text: 'This was retracted by the reply.' },
      { type: 'planner_text_delta', turnId: 't1', segmentId: 'seg-2', text: answer.text },
      { type: 'planner_message', turnId: 't1', content: 'It says hello.', runs: [answer] },
    ] as SessionMessage[]);
    expect(chatLines(view)).toEqual(['user:read it', 'planner:It says hello.']);
  });
});
