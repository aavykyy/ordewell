import { describe, it, expect } from 'vitest';
import { fromTranscript } from '@ordewell/core';
import { initialState, reduce } from '../reducer';
import { render } from '../render';
import { footerHints, helpLayout } from '../layout';
import { decodeKey } from '../keys';
import type { TaskLogState, TaskView, TuiState } from '../state';

/**
 * Send now in the planner chat (ADR-0023, F5): ctrl-s stops the planner turn
 * in flight and answers the composer text — or, with the composer empty, the
 * newest queued prompt — in the turn that replaces it. Turn-scoped: the run's
 * tasks are never touched, and the prompts still queued keep their order.
 */

const ctrlS = { type: 'key' as const, key: { name: 'ctrl-s' } };
const key = (name: string, char?: string) => ({ type: 'key' as const, key: { name, char } });

const planning = (over: Partial<TuiState> = {}): TuiState =>
  initialState({ sessionId: 's1', status: 'planning', ...over });

const withDraft = (state: TuiState, text: string): TuiState => ({
  ...state,
  editor: { ...state.editor, text, cursor: text.length },
});

// eslint-disable-next-line no-control-regex
const plain = (state: TuiState): string => render(state).join('\n').replace(/\x1b\[[0-9;]*m/g, '');
const lastSaid = (state: TuiState) => state.conversation.blocks.at(-1);

const task = (over: Partial<TaskView> = {}): TaskView => ({
  id: 't1', order: 2, title: 'Refactor PlanStore', type: 'ai', status: 'in_progress', dependencies: [], assignedRunner: 'claude-code',
  ...over,
});

const log = (queued: { id: string; text: string; forced?: boolean }[]): TaskLogState => ({
  taskId: 't1',
  view: {
    blocks: [{ type: 'message', id: 'b1', role: 'agent', text: 'Do the task', streaming: false }],
    nextId: 2,
    queued: queued.map((m) => ({ ...m, forced: m.forced ?? false })),
    working: true,
    streams: {},
  },
  attempts: [1],
  attempt: 1,
  pending: [],
  loaded: true,
  followLatest: true,
  queuedIndex: 0,
});

describe('ctrl-s in the planner chat', () => {
  it('decodes from the byte a terminal sends', () => {
    expect(decodeKey('\x13').name).toBe('ctrl-s');
  });

  it('force sends the composer text and empties the composer', () => {
    const { state, effects } = reduce(withDraft(planning(), '  stop, use Postgres '), ctrlS);
    expect(effects).toEqual([{ type: 'forceSendPlannerMessage', sessionId: 's1', message: 'stop, use Postgres' }]);
    expect(state.editor.text).toBe('');
  });

  it('force sends the newest queued prompt when the composer is empty, keeping the rest in order', () => {
    const { state, effects } = reduce(planning({ queuedPrompts: ['one', 'two'] }), ctrlS);
    expect(effects).toEqual([{ type: 'forceSendPlannerMessage', sessionId: 's1', message: 'two' }]);
    expect(state.queuedPrompts).toEqual(['one']);
  });

  it('prefers the composer text over the queued prompts', () => {
    const { state, effects } = reduce(withDraft(planning({ queuedPrompts: ['one', 'two'] }), 'this one'), ctrlS);
    expect(effects).toEqual([{ type: 'forceSendPlannerMessage', sessionId: 's1', message: 'this one' }]);
    expect(state.queuedPrompts).toEqual(['one', 'two']);
  });

  it('is a plain send when no turn is running', () => {
    const { state, effects } = reduce(withDraft(planning({ status: 'idle' }), 'use bcrypt'), ctrlS);
    expect(effects).toEqual([{ type: 'sendMessage', sessionId: 's1', message: 'use bcrypt' }]);
    expect(state.editor.text).toBe('');
  });

  it('says what to do when there is nothing to send', () => {
    const { state, effects } = reduce(planning(), ctrlS);
    expect(effects).toEqual([]);
    expect(lastSaid(state)).toMatchObject({ text: expect.stringMatching(/type a message, or queue one/) });
  });
});

describe('the queue across a stop', () => {
  it('keeps the held prompts when the stopped turn was a force send', () => {
    const sent = reduce(withDraft(planning({ queuedPrompts: ['one', 'two'] }), 'now'), ctrlS).state;
    const { state, effects } = reduce(sent, { type: 'failed', message: 'The planner turn was stopped.' });

    expect(state.queuedPrompts).toEqual(['one', 'two']);
    expect(state.status).toBe('planning');
    expect(effects).toEqual([]);
  });

  it('still returns the queue to the input on a user stop', () => {
    const state = withDraft(planning({ queuedPrompts: ['one', 'two'] }), '/stop');
    const { state: stopped, effects } = reduce(state, key('enter'));

    expect(effects).toEqual([{ type: 'cancelPlanning', sessionId: 's1' }]);
    expect(stopped.queuedPrompts).toEqual([]);
    expect(stopped.editor.text).toBe('one\ntwo');
  });
});

describe('what the planner chat shows for force send', () => {
  it('names ctrl-s on the queued prompt, the hint dropping first at a narrow width', () => {
    const state = planning({ queuedPrompts: ['a parked thought'], cols: 200 });
    const row = plain(state).split('\n').find((line) => line.includes('a parked thought')) ?? '';
    expect(row).toContain('queued · esc to unsend · ctrl-s sends now');

    const narrow = planning({ queuedPrompts: ['a parked thought'], cols: 50 });
    const narrowRow = plain(narrow).split('\n').find((line) => line.includes('a parked thought')) ?? '';
    expect(narrowRow).toContain('a parked thought');
    expect(narrowRow).not.toContain('ctrl-s sends now');
  });

  it('marks the forced user message, from a reloaded transcript too', () => {
    const conversation = fromTranscript(
      [{ role: 'user', content: 'use Postgres instead', timestamp: '2026-10-13T00:00:00.000Z', forced: true }],
      [], undefined, [],
    );
    const out = plain(initialState({ sessionId: 's1', rows: 24, cols: 120, conversation }));
    expect(out).toContain('use Postgres instead · sent now');
  });

  it('names ctrl-s in the chat footer while a turn is in flight', () => {
    expect(footerHints(planning())).toContain('ctrl-s send now');
    expect(footerHints(planning({ status: 'idle' }))).not.toContain('ctrl-s send now');
  });

  it('documents ctrl-s for the planner in the help sheet', () => {
    // eslint-disable-next-line no-control-regex
    const sheet = helpLayout(200, 200).lines.map((line) => line.replace(/\x1b\[[0-9;]*m/g, ''));
    expect(sheet.some((line) => line.includes('ctrl-s sends now') && line.includes('planner'))).toBe(true);
  });
});

describe('what the task view shows for force send', () => {
  it('names ctrl-s on the selected queued row, and sending now once forced', () => {
    const state = initialState({
      sessionId: 's1', rows: 30, cols: 200, tasks: [task()],
      taskView: log([{ id: 'm1', text: 'use Postgres' }, { id: 'm2', text: 'stop now', forced: true }]),
    });
    const out = plain(state);
    expect(out).toContain('use Postgres · queued · ctrl-r removes · ctrl-s sends now');
    expect(out).toContain('stop now · sending now');
  });
});

