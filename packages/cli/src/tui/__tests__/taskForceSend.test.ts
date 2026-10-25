import { describe, it, expect, vi } from 'vitest';
import { replayTaskLog, type TaskLogEvent } from '@ordewell/core';
import { initialState, reduce } from '../reducer';
import { render } from '../render';
import { footerHints, helpLayout } from '../layout';
import { decodeKey } from '../keys';
import { openTaskView } from '../reducers/taskView';
import { runEffect, type EffectDeps, type OrdewellApi } from '../effects';
import { DaemonError } from '../../apiClient';
import type { Action } from '../reducer';
import type { TaskLogState, TaskView, TuiState } from '../state';

/**
 * Force send from the task view (ADR-0023, F1): ctrl-s interrupts the running
 * step and sends the composer text next — or, with the composer empty, the
 * selected queued message.
 */

const task = (over: Partial<TaskView> = {}): TaskView => ({
  id: 't1', order: 2, title: 'Refactor PlanStore', type: 'ai', status: 'in_progress', dependencies: [], assignedRunner: 'claude-code', attempted: true,
  ...over,
});

const log = (events: TaskLogEvent[], queuedIndex: number | null = 0): TaskLogState => ({
  taskId: 't1',
  view: replayTaskLog([{ type: 'turn_start', message: 'Do the task' }, ...events]),
  attempts: [1],
  attempt: 1,
  pending: [],
  loaded: true,
  followLatest: true,
  queuedIndex,
});

const queued: TaskLogEvent[] = [
  { type: 'message_queued', messageId: 'm1', text: 'use Postgres' },
  { type: 'message_queued', messageId: 'm2', text: 'also tests' },
];

const opened = (tv: TaskLogState = log([]), over: Partial<TuiState> = {}): TuiState =>
  initialState({ sessionId: 's1', focus: 'chat', rows: 30, cols: 160, tasks: [task()], taskView: tv, ...over });

const withDraft = (state: TuiState, text: string): TuiState => ({ ...state, editor: { ...state.editor, text, cursor: text.length } });
const ctrlS = { type: 'key' as const, key: { name: 'ctrl-s' } };
// eslint-disable-next-line no-control-regex
const plain = (state: TuiState): string => render(state).join('\n').replace(/\x1b\[[0-9;]*m/g, '');
const lastSaid = (state: TuiState) => state.conversation.blocks.at(-1);

describe('ctrl-s in the task view', () => {
  it('decodes from the byte a terminal sends', () => {
    expect(decodeKey('\x13').name).toBe('ctrl-s');
  });

  it('force sends the composer text and empties the composer', () => {
    const { state, effects } = reduce(withDraft(opened(), '  stop, use Postgres '), ctrlS);
    expect(effects).toEqual([{ type: 'forceSendTaskMessage', sessionId: 's1', taskId: 't1', text: 'stop, use Postgres' }]);
    expect(state.editor.text).toBe('');
  });

  it('force sends the selected queued message when the composer is empty', () => {
    const { effects } = reduce(opened(log(queued, 1)), ctrlS);
    expect(effects).toEqual([{ type: 'forceSendQueuedTaskMessage', sessionId: 's1', taskId: 't1', messageId: 'm2' }]);
  });

  it('prefers the composer text over the selected queued message', () => {
    const { effects } = reduce(withDraft(opened(log(queued, 1)), 'this one'), ctrlS);
    expect(effects).toEqual([{ type: 'forceSendTaskMessage', sessionId: 's1', taskId: 't1', text: 'this one' }]);
  });

  it('force sends a handed-over message too, which the runner already has', () => {
    const { effects } = reduce(opened(log([...queued, { type: 'message_handed_over', messageId: 'm1' }])), ctrlS);
    expect(effects).toEqual([{ type: 'forceSendQueuedTaskMessage', sessionId: 's1', taskId: 't1', messageId: 'm1' }]);
  });

  it('force sends the newest pending message when none was picked', () => {
    const { effects } = reduce(opened(log(queued, null)), ctrlS);
    expect(effects).toEqual([{ type: 'forceSendQueuedTaskMessage', sessionId: 's1', taskId: 't1', messageId: 'm2' }]);
  });

  it('opens a task with no message picked', () => {
    const state = initialState({ sessionId: 's1', focus: 'chat', rows: 30, cols: 160, tasks: [task()] });
    expect(openTaskView(state, 's1', 't1').state.taskView?.queuedIndex).toBeNull();
  });

  it('moves the pick from the newest with ctrl-p', () => {
    const picked = reduce(opened(log(queued, null)), { type: 'key', key: { name: 'ctrl-p' } }).state;
    expect(reduce(picked, ctrlS).effects).toEqual([{ type: 'forceSendQueuedTaskMessage', sessionId: 's1', taskId: 't1', messageId: 'm1' }]);
  });

  it('goes back to the newest once the picked message is sent now', () => {
    const sent = reduce(opened(log(queued, 0)), ctrlS).state;
    expect(sent.taskView?.queuedIndex).toBeNull();
  });

  it('says what to do when there is nothing to send', () => {
    const { state, effects } = reduce(opened(), ctrlS);
    expect(effects).toEqual([]);
    expect(lastSaid(state)).toMatchObject({ text: expect.stringMatching(/type a message, or pick a queued one/) });
  });

  it('does not force send to a finished task, whose composer continues it', () => {
    const finished = opened(log([]), { tasks: [task({ status: 'completed', continuable: true })] });
    const { state, effects } = reduce(withDraft(finished, 'more'), ctrlS);
    expect(effects).toEqual([]);
    expect(lastSaid(state)).toMatchObject({ text: expect.stringMatching(/enter continues it/) });
  });
});

describe('what the task view shows for force send', () => {
  it('keeps the sent-now mark visible when the delivered message wraps', () => {
    const out = plain(opened(log([{ type: 'turn_start', message: 'Interrupt that sleep; call task_complete done with summary TUI_FORCE_OK. Do not perform any other work.', forced: true }])));
    expect(out).toContain('sent now');
    expect(out).toContain('other work.');
  });

  it('names ctrl-s in the header next to interrupt', () => {
    const out = plain(opened());
    expect(out).toContain('ctrl-x stop runner · ctrl-r remove queued · ctrl-s send now');
  });

  it('puts the send-now hint on the newest pending message only, when none was picked', () => {
    const out = plain(opened(log(queued, null)));
    expect(out).toContain('also tests · queued · ctrl-s sends now · ctrl-r removes');
    expect(out).toMatch(/use Postgres · queued(?! ·)/);
  });

  it('says a handed-over message waits for the current step, and offers send now on it', () => {
    const out = plain(opened(log([...queued, { type: 'message_handed_over', messageId: 'm1' }], 0)));
    expect(out).toContain('use Postgres · waiting for the current step · ctrl-s sends now');
    expect(out).not.toContain('handed over');
    expect(out).not.toMatch(/use Postgres.*ctrl-r removes/);
  });

  it('keeps the send-now hint off the queue while the composer holds text, and names it in the footer', () => {
    const out = plain(withDraft(opened(log(queued, null)), 'one more'));
    expect(out).not.toContain('ctrl-s sends now');
    expect(footerHints(withDraft(opened(log(queued, null)), 'one more'))).toContain('ctrl-s send now');
    expect(footerHints(opened(log(queued, null)))).not.toContain('ctrl-s send now');
  });

  it('shows a forced message first, as sending now', () => {
    const out = plain(opened(log([...queued, { type: 'message_queued', messageId: 'm3', text: 'stop now', forced: true }])));
    expect(out).toMatch(/stop now · sending now…(?! ·)/);
    expect(out.indexOf('stop now')).toBeLessThan(out.indexOf('use Postgres'));
  });

  it('lists ctrl-s in the help sheet, each task-view line whole', () => {
    const sheet = helpLayout(200, 160).lines.map((l) => l.replace(/\x1b\[[0-9;]*m/g, '')); // eslint-disable-line no-control-regex
    expect(sheet).toContain('  ctrl-s sends now: interrupts the running step, then delivers the composer text or, with it empty, the highlighted pending message');
    expect(sheet.some((l) => l.includes('ctrl-r removes a queued one'))).toBe(true);
    expect(sheet.some((l) => l.includes('ctrl-x stops the runner\'s running turn, and it then waits for your next message'))).toBe(true);
  });
});

describe('the force send effects', () => {
  function deps(api: Partial<OrdewellApi>) {
    const actions: Action[] = [];
    const effectDeps = { api, dispatch: (a: Action) => actions.push(a) } as unknown as EffectDeps;
    return { effectDeps, actions };
  }

  it('posts the composer text to the daemon', async () => {
    const execute = vi.fn().mockResolvedValue({ ok: true, message: 'Sent now.', payload: { kind: 'message', id: 'm3' } });
    const { effectDeps, actions } = deps({ execute });
    await runEffect({ type: 'forceSendTaskMessage', sessionId: 's1', taskId: 't1', text: 'now' }, effectDeps);
    expect(execute).toHaveBeenCalledWith('s1', { command: 'message_task', task: 't1', text: 'now', force: true });
    expect(actions).toEqual([]);
  });

  it('leaves what it says to the timeline, and shows the daemon\'s words when the message was delivered before send now reached it', async () => {
    const execute = vi.fn().mockResolvedValue({ ok: true, message: 'Sent.' });
    const { effectDeps, actions } = deps({ execute });
    await runEffect({ type: 'forceSendQueuedTaskMessage', sessionId: 's1', taskId: 't1', messageId: 'm1' }, effectDeps);
    expect(execute).toHaveBeenCalledWith('s1', { command: 'force_send_queued', task: 't1', id: 'm1' });
    expect(actions).toEqual([]);

    const refusal = new DaemonError('That message to task #1 "Build" was already delivered.', 400, 'refused');
    const late = deps({ execute: vi.fn().mockRejectedValue(refusal) });
    await runEffect({ type: 'forceSendQueuedTaskMessage', sessionId: 's1', taskId: 't1', messageId: 'm1' }, late.effectDeps);
    expect(late.actions).toEqual([{ type: 'failed', message: refusal.message, code: 'refused' }]);
  });
});
