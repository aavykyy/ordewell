import { describe, it, expect } from 'vitest';
import type { ResearchStepOutcome, SessionMessage, ToolBlock } from '@ordewell/core';
import { initialState, reduce, type Action } from '../reducer';
import type { TuiState } from '../state';
import { chatActivity } from '../layout';

const hear = (message: SessionMessage, sessionId?: string): Action => ({ type: 'sessionMessage', message, ...(sessionId ? { sessionId } : {}) });
const send = (state: TuiState, action: Action) => reduce(state, action).state;
const drive = (state: TuiState, messages: SessionMessage[]) => messages.map((m) => hear(m)).reduce(send, state);

const planning = (): TuiState => ({ ...initialState(), planner: 'planning' });

const call = (path: string, toolCallId?: string): SessionMessage =>
  ({ type: 'research_step', tool: 'read_file', args: JSON.stringify({ path }), ...(toolCallId ? { toolCallId } : {}) });

const done = (path: string, toolCallId?: string, outcome: ResearchStepOutcome = 'success', result = ''): SessionMessage => ({
  type: 'research_step_done',
  step: {
    id: `rs-${path}`, tool: 'read_file', args: JSON.stringify({ path }), result, success: outcome === 'success', outcome,
    timestamp: '2026-09-27T10:00:00.000Z', ...(toolCallId ? { toolCallId } : {}),
  },
});

const tools = (state: TuiState): ToolBlock[] => state.conversation.blocks.filter((b): b is ToolBlock => b.type === 'tool');

describe('research calls during a planner turn', () => {
  it('adds one command block per call instead of overwriting the spinner', () => {
    const s = drive(planning(), [call('a.ts', 't1'), call('b.ts', 't2')]);

    expect(tools(s).map((t) => t.headline)).toEqual([{ name: 'Read', keyArg: 'a.ts' }, { name: 'Read', keyArg: 'b.ts' }]);
  });

  it('lists no tool call on the status row, however many a parallel round has out', () => {
    const s = drive(planning(), [call('a.ts', 't1'), call('b.ts', 't2'), call('c.ts', 't3')]);

    expect(chatActivity(s)).toEqual({ label: 'Planning…', busy: true });
  });

  it('keeps the status at planning through research: the row has no separate verb for it', () => {
    expect(drive(planning(), [call('a.ts', 't1')]).planner).toBe('planning');
  });

  it('leaves an executing run alone — research steps belong to the planner', () => {
    const executing: TuiState = { ...initialState(), status: 'executing' };
    const s = drive(executing, [call('a.ts', 't1')]);

    expect(s.status).toBe('executing');
    expect(chatActivity(s)).toBeNull();
  });

  it('ignores messages from a session that /new has replaced', () => {
    const s = send({ ...planning(), sessionId: 's2' }, hear(call('old.ts', 't1'), 's1'));

    expect(s.conversation.blocks).toEqual([]);
  });

  it('settles the call its result names, by tool_call id, across a parallel round', () => {
    const s = drive(planning(), [call('a.ts', 't1'), call('b.ts', 't2'), done('b.ts', 't2', 'success', 'b body')]);

    expect(tools(s).map((t) => [t.status, t.output])).toEqual([['pending', ''], ['ok', 'b body']]);
  });

  it('still says Planning while a call is out and after the round is over', () => {
    const open = drive(planning(), [call('a.ts', 't1'), call('b.ts', 't2'), done('a.ts', 't1')]);
    const over = drive(planning(), [call('a.ts', 't1'), call('b.ts', 't2'), done('a.ts', 't1'), done('b.ts', 't2')]);

    expect(chatActivity(open)?.label).toBe('Planning…');
    expect(chatActivity(over)?.label).toBe('Planning…');
  });

  it('says only Planning while a subagent runs, its brief kept off the row', () => {
    const s = drive(planning(), [{ type: 'subagent_started', subagentId: 'sa1', brief: 'find the auth handlers\n\tin src/ only' }]);

    expect(chatActivity(s)).toEqual({ label: 'Planning…', busy: true });
  });
});

describe('planner thinking', () => {
  it('becomes a thinking block in the conversation, not a status-row tail', () => {
    const s = drive(planning(), [
      { type: 'planner_thinking_delta', text: 'weighing ' },
      { type: 'planner_thinking_delta', text: 'the options' },
    ]);

    expect(s.conversation.blocks).toMatchObject([{ type: 'thinking', text: 'weighing the options', streaming: true }]);
    expect(s.planner).toBe('planning');
  });
});
