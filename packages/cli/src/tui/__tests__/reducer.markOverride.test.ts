import { describe, it, expect } from 'vitest';
import { initialState, reduce, type Step } from '../reducer';
import type { TaskView, TuiState } from '../state';
import { EMPTY_RUN } from '@ordewell/core';
import { lastMessage } from './chat';

/**
 * Mark complete and Mark not done in the terminal (ADR-0029): `m` and the slash
 * commands ask first, in the core's words, and the daemon gets the user's yes
 * only on the command the popup sends. Nothing changes on one keystroke.
 */

const press = (state: TuiState, char: string): Step => reduce(state, { type: 'key', key: { name: 'char', char } });
const enter = (state: TuiState): Step => reduce(state, { type: 'key', key: { name: 'enter' } });
const escape = (state: TuiState): Step => reduce(state, { type: 'key', key: { name: 'escape' } });
const slash = (state: TuiState, text: string): Step =>
  reduce({ ...state, editor: { ...state.editor, text, cursor: text.length } }, { type: 'key', key: { name: 'enter' } });

function task(over: Partial<TaskView> = {}): TaskView {
  return { id: 't1', order: 1, title: 'Parse JSON', type: 'ai', status: 'pending', dependencies: [], assignedRunner: 'claude-code', taskMode: 'acceptEdits', ...over };
}

function pane(tasks: TaskView[], over: Partial<TuiState> = {}): TuiState {
  return initialState({ sessionId: 's1', focus: 'plan', selectedTask: 0, tasks, ...over });
}

const running = { starting: false, running: true, scheduled: false, resumable: false, advancesOnItsOwn: true };

describe('m, and /complete and /uncomplete, on an AI or script task', () => {
  it('asks in the core\'s words and sends nothing on the keystroke', () => {
    const asked = press(pane([task()]), 'm');

    expect(asked.effects).toEqual([]);
    expect(asked.state.overlay).toMatchObject({
      kind: 'confirm',
      title: 'Mark #1 Parse JSON complete?',
      message: expect.stringContaining('Mark task #1 Parse JSON complete? You vouch for its work although no passing verdict said it was done.'),
    });
  });

  it('sends the yes with the status it was asked about once confirmed', () => {
    const asked = press(pane([task({ status: 'failed' })]), 'm').state;

    expect(enter(asked).effects).toEqual([{ type: 'taskAction', sessionId: 's1', taskId: 't1', action: 'complete', confirmed: { seen: 'failed' } }]);
    expect(enter(asked).state.overlay).toBeNull();
  });

  it('changes nothing when the popup is cancelled', () => {
    const asked = press(pane([task()]), 'm').state;

    const cancelled = escape(asked);

    expect(cancelled.effects).toEqual([]);
    expect(cancelled.state.overlay).toBeNull();
  });

  it('says what Mark not done leaves alone', () => {
    const asked = press(pane([task({ status: 'completed' })]), 'm');

    expect(asked.state.overlay).toMatchObject({ message: expect.stringContaining('The work it did stays where it is') });
    expect(enter(asked.state).effects).toEqual([{ type: 'taskAction', sessionId: 's1', taskId: 't1', action: 'uncomplete', confirmed: { seen: 'completed' } }]);
  });

  it('asks the same of a script task', () => {
    const asked = press(pane([task({ type: 'script', assignedRunner: undefined })]), 'm');

    expect(asked.state.overlay).toMatchObject({ kind: 'confirm', action: { kind: 'mark-override', direction: 'complete' } });
  });

  it.each([['/complete 1', 'complete'], ['/uncomplete 1', 'uncomplete']])('%s asks too, naming the direction typed', (line, direction) => {
    const asked = slash(pane([task({ status: 'completed' })], { focus: 'chat' }), line);

    expect(asked.effects).toEqual([]);
    expect(asked.state.overlay).toMatchObject({ kind: 'confirm', action: { kind: 'mark-override', direction } });
  });

  it.each([
    ['starting', { ...running, running: false, starting: true }],
    ['running', running],
    ['scheduled', { ...running, running: false, scheduled: true }],
    ['holding a queued force start', { ...running, running: false, advancesOnItsOwn: true }],
    ['waiting out a usage limit', { ...running, running: false, resumable: true }],
  ])('does not ask while the run is %s: it says to Stop the run first', (_name, activity) => {
    const state = pane([task()], { run: { ...EMPTY_RUN, activity } });

    for (const step of [press(state, 'm'), slash({ ...state, focus: 'chat' }, '/complete 1')]) {
      expect(step.effects).toEqual([]);
      expect(step.state.overlay).toBeNull();
      expect(lastMessage(step.state)!.text).toContain('Stop the run first');
    }
  });

  it('refuses a task that left the plan while the popup was open', () => {
    const asked = press(pane([task()]), 'm').state;

    const answered = enter({ ...asked, tasks: [] });

    expect(answered.effects).toEqual([]);
    expect(lastMessage(answered.state)!.text).toContain('no longer in the plan');
  });
});

describe('a manual task', () => {
  const manual = task({ type: 'user', assignedRunner: undefined, taskMode: undefined });

  it('is signed off from m after a short question, even during a run, with no vouching sent', () => {
    const state = pane([manual], { run: { ...EMPTY_RUN, activity: running } });

    const asked = press(state, 'm');

    expect(asked.effects).toEqual([]);
    expect(asked.state.overlay).toMatchObject({ kind: 'confirm', message: expect.stringContaining('your own sign-off') });
    expect(enter(asked.state).effects).toEqual([{ type: 'taskAction', sessionId: 's1', taskId: 't1', action: 'complete' }]);
  });

  it('is signed off from /complete as typed, which asks nothing', () => {
    const state = pane([manual], { focus: 'chat', run: { ...EMPTY_RUN, activity: running } });

    expect(slash(state, '/complete 1').effects).toEqual([{ type: 'taskAction', sessionId: 's1', taskId: 't1', action: 'complete' }]);
  });
});
