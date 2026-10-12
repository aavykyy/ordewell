import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import { EMPTY_TASK_LOG } from '@ordewell/core';
import { initialState, reduce, type Step } from '../reducer';
import { chatLayout, footerHints, planLayout } from '../layout';
import { style } from '../ansi';
import { inboundFor } from '../inbound';
import { runEffect, type EffectDeps, type OrdewellApi } from '../effects';
import type { TaskLogState, TaskView, TuiState } from '../state';
import type { WsEvent } from '../../apiClient';

/**
 * A task paused on its runner's usage limit that resumes on its own (#84):
 * the row and the task view say when, and `c` / `ctrl-x` cancel the resume.
 */

const RESUME_AT = new Date(2026, 9, 11, 20, 10).toISOString();

const task = (over: Partial<TaskView> = {}): TaskView => ({
  id: 't1', order: 1, title: 'Fix the parser', type: 'ai', status: 'awaiting_user', awaitingReason: 'usage-limit', resumeAt: RESUME_AT,
  dependencies: [], assignedRunner: 'claude-code', ...over,
});

const state = (tasks: TaskView[], over: Partial<TuiState> = {}): TuiState =>
  initialState({ sessionId: 's1', rows: 60, cols: 220, focus: 'plan', tasks, ...over });
const frame = (tasks: TaskView[]): string => planLayout(state(tasks), 60, 200).lines.join('\n');
const press = (s: TuiState, char: string): Step => reduce(s, { type: 'key', key: { name: 'char', char } });

const opened = (tasks: TaskView[]): TuiState => {
  const tv: TaskLogState = { taskId: 't1', view: EMPTY_TASK_LOG, attempts: [1], attempt: 1, pending: [], loaded: true, followLatest: true, queuedIndex: 0 };
  return state(tasks, { focus: 'chat', taskView: tv });
};

beforeEach(() => {
  style.enabled = false;
  vi.useFakeTimers({ now: new Date(2026, 9, 11, 17, 0), toFake: ['Date'] });
});

afterEach(() => {
  vi.useRealTimers();
});

describe('a task paused on a usage limit in the TUI', () => {
  it('says on its row when it resumes, and how to cancel that', () => {
    const shown = frame([task()]);
    expect(shown).toContain('    paused on a usage limit · claude-code');
    expect(shown).toContain('⏸ resumes at 8:10pm, once the usage limit resets — c cancels the resume');
  });

  it('says nothing of a resume once it waits for a manual retry', () => {
    const shown = frame([task({ resumeAt: undefined })]);
    expect(shown).toContain('    paused on a usage limit · claude-code');
    expect(shown).not.toContain('resumes at');
  });

  it('cancels the resume with c, and names that in the footer', () => {
    const paused = state([task()]);
    expect(press(paused, 'c').effects).toEqual([{ type: 'taskAction', sessionId: 's1', taskId: 't1', action: 'cancel-resume' }]);
    expect(footerHints(paused)).toContain('c cancel resume');

    const running = state([task({ status: 'in_progress', awaitingReason: undefined, resumeAt: undefined })]);
    expect(press(running, 'c').effects).toEqual([{ type: 'taskAction', sessionId: 's1', taskId: 't1', action: 'cancel' }]);
    expect(footerHints(running)).toContain('c cancel');
  });

  it('says when it resumes in the task view, where ctrl-x cancels the resume', () => {
    const view = opened([task()]);
    const header = chatLayout(view, 30, 200).header;
    expect(header[0]).toContain('→ Task 1 · Fix the parser · claude-code · paused on a usage limit · resumes at 8:10pm');
    expect(header[1]).toContain('ctrl-x cancel resume');
    expect(reduce(view, { type: 'key', key: { name: 'ctrl-x' } }).effects)
      .toEqual([{ type: 'taskAction', sessionId: 's1', taskId: 't1', action: 'cancel-resume' }]);

    const manual = opened([task({ resumeAt: undefined })]);
    expect(reduce(manual, { type: 'key', key: { name: 'ctrl-x' } }).effects).toEqual([{ type: 'interruptTask', sessionId: 's1', taskId: 't1' }]);
  });

  it('takes the resume time from a status update, and drops it when the update does', () => {
    const event = (resumeAt?: string): WsEvent => ({
      type: 'status_update',
      tasks: [{ id: 't1', status: 'awaiting_user', verdict: null, awaitingReason: 'usage-limit', ...(resumeAt ? { resumeAt } : {}) }],
    }) as WsEvent;
    let current = state([task({ resumeAt: undefined })]);
    const receive = inboundFor({}, (action) => { current = reduce(current, action).state; }, 's1').execution();

    receive(event(RESUME_AT));
    expect(current.tasks[0].resumeAt).toBe(RESUME_AT);

    receive(event());
    expect(current.tasks[0].resumeAt).toBeUndefined();
  });

  it('asks the daemon to cancel the resume, and says what happened', async () => {
    const cancelResume = vi.fn().mockResolvedValue({ cancelled: true });
    const dispatch = vi.fn();
    const deps: EffectDeps = {
      api: { cancelResume } as unknown as OrdewellApi,
      workspace: '/ws', port: 3742, dispatch, newSessionId: () => 's2', setEnvVar: () => {}, saveAutonomy: () => ({ overridden: false }), hasBin: () => true, exit: vi.fn(),
      reviveDaemon: vi.fn(), setMouseCapture: vi.fn(), writeTerminal: vi.fn(),
    };
    // Only the request is pinned; the plan refresh after it has no daemon to reach.
    await runEffect({ type: 'taskAction', sessionId: 's1', taskId: 't1', action: 'cancel-resume' }, deps).catch(() => undefined);
    expect(cancelResume).toHaveBeenCalledWith('s1', 't1');
    expect(dispatch).toHaveBeenCalledWith({ type: 'notice', message: 'Resume cancelled: retry the task once the limit resets.' });
  });
});
