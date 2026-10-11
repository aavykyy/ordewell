import { describe, it, expect } from 'vitest';
import { planLayout, revealOffset } from '../layout';
import { initialState, type TaskView } from '../state';
import { reduce, type Action } from '../reducer';
import { inboundFor } from '../inbound';
import type { WsEvent } from '../../apiClient';
import { stripAnsi } from '../ansi';
import type { AttemptUsage } from '@ordewell/core';

const usage: AttemptUsage = { attempt: 1, runner: 'codex', startedAt: '', wallTimeMs: 5000, totals: { inputTokens: 12400, outputTokens: 3100, reportedCost: { USD: 0.42 } }, byModel: [{ source: 'codex', model: 'actual-model', totals: { inputTokens: 12400 } }], lastPromptTokens: 36000, contextWindow: 200000 };
const task = (over: Partial<TaskView> = {}): TaskView => ({ id: 't', order: 1, title: 'Work', type: 'ai', status: 'completed', dependencies: [], ...over });
const lines = (tasks: TaskView[]) => planLayout(initialState({ tasks, rows: 40, cols: 140 }), 40, 140).lines.map(stripAnsi).join('\n');

describe('task row accounting', () => {
  it('uses planner formatting for the latest attempt and a separate task total', () => {
    const text = lines([task({ attemptUsage: [usage] })]);
    expect(text).toContain('12.4k in · 3.1k out · $0.42 · 18% ctx · 5s');
    expect(text).toContain('Tasks total: 12.4k in · 3.1k out · $0.42 · 5s');
  });

  it('shows unknown where a runner reported nothing', () => {
    expect(lines([task()])).toContain('unknown in · unknown out · cost unknown · ctx unknown · time unknown');
  });

  it('carries live usage from the daemon into the row even when status stays the same', () => {
    const actions: Action[] = [];
    const receive = inboundFor({}, (action) => actions.push(action), 's1').execution();
    const wire: unknown = { type: 'status_update', tasks: [{ id: 't', status: 'completed', verdict: null, attemptUsage: [usage] }] };
    receive(wire as WsEvent);
    const update = actions.find((a): a is Extract<Action, { type: 'tasksStatus' }> => a.type === 'tasksStatus');
    const state = initialState({ sessionId: 's1', tasks: [task()] });
    const updated = reduce(state, update!).state;
    expect(updated.tasks[0].attemptUsage).toEqual([usage]);
    expect(lines(updated.tasks)).toContain('$0.42');
  });

  it('applies nested usage updates without needing a status change', () => {
    const state = initialState({ tasks: [task({ id: 'parent', subtasks: [task()] })] });
    const updated = reduce(state, { type: 'tasksStatus', updates: { t: { status: 'completed', attemptUsage: [usage] } } }).state;
    expect(updated.tasks[0].subtasks?.[0].attemptUsage).toEqual([usage]);
    expect(lines(updated.tasks)).toContain('12.4k in');
  });

  it('keeps usage and unmerged landings from the same status update visible', () => {
    const actions: Action[] = [];
    const receive = inboundFor({}, (action) => actions.push(action), 's1').execution();
    receive({
      type: 'status_update',
      tasks: [{ id: 't', status: 'completed', verdict: null, attemptUsage: [usage] }],
      runMerge: {
        waitingAtGate: false, paused: false, repos: [],
        landed: [{ taskId: 't', order: 1, title: 'Work' }],
      },
    });
    const update = actions.find((a): a is Extract<Action, { type: 'tasksStatus' }> => a.type === 'tasksStatus');
    const state = initialState({ sessionId: 's1', tasks: [task({ id: 'parent', subtasks: [task()] })] });
    const updated = reduce(state, update!).state;
    const layout = planLayout({ ...updated, mergeAtGatesAutomatically: true }, 4, 140);
    const text = layout.lines.map(stripAnsi).join('\n');

    expect(updated.tasks[0].subtasks?.[0].attemptUsage).toEqual([usage]);
    expect(updated.runMerge?.handoff.landed).toEqual([{ taskId: 't', order: 1, title: 'Work' }]);
    expect(text).toContain('Tasks total: 12.4k in · 3.1k out · $0.42 · 5s');
    expect(text).toContain('G Merge at gates automatically: on');
    expect(text).toContain('1 landed task not merged — /handoff merge');
    expect(layout.rowSpans[0].start).toBe(5);
    expect(revealOffset(layout, layout.maxScroll, layout.rowSpans[0])).toBe(0);

    const cleared = reduce(updated, { type: 'tasksStatus', updates: {}, runMerge: null }).state;
    const clearedText = planLayout(cleared, 40, 140).lines.map(stripAnsi).join('\n');
    expect(clearedText).not.toContain('landed task');
    expect(clearedText).toContain('Tasks total: 12.4k in · 3.1k out · $0.42 · 5s');
  });
});
