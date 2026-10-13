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

const expandedLines = (t: TaskView) => {
  const state = { ...initialState({ tasks: [t], rows: 40, cols: 140 }), expandedTaskId: t.id };
  return planLayout(state, 40, 140).lines.map(stripAnsi).join('\n');
};

describe('task row accounting', () => {
  it('keeps the plan total at the top and no usage on the row, collapsed or expanded', () => {
    const t = task({ attemptUsage: [usage] });
    const collapsed = lines([t]);
    expect(collapsed).toContain('Tasks total: 12.4k in · 3.1k out · $0.42 · 5s');
    expect(collapsed.replace('Tasks total: 12.4k in · 3.1k out · $0.42 · 5s', '')).not.toMatch(/12\.4k in|18% ctx/);
    expect(expandedLines(t).replace('Tasks total: 12.4k in · 3.1k out · $0.42 · 5s', '')).not.toMatch(/12\.4k in|18% ctx|actual-model: /);
  });

  it('keeps skills, effort and mode off a collapsed row and shows them expanded', () => {
    const t = task({ type: 'ai', skills: ['tdd'], taskMode: 'plan', assignedModel: { modelId: 'm', modelLabel: 'M', thinkingEffort: 'high' } });
    const collapsed = lines([t]);
    for (const hidden of ['skills:', 'effort:', 'mode:']) expect(collapsed).not.toContain(hidden);
    const expanded = expandedLines(t);
    expect(expanded).toContain('skills: tdd');
    expect(expanded).toContain('effort: high · mode: plan');
  });

  it('carries live usage from the daemon into the row even when status stays the same', () => {
    const actions: Action[] = [];
    const receive = inboundFor({}, (action) => actions.push(action), 's1').execution();
    const wire: unknown = { type: 'status_update', tasks: [{ id: 't', status: 'completed', verdict: null, attemptUsage: [usage] }] };
    receive(wire as WsEvent);
    const update = actions.find((a): a is Extract<Action, { type: 'statusUpdate' }> => a.type === 'statusUpdate');
    const state = initialState({ sessionId: 's1', tasks: [task()] });
    const updated = reduce(state, update!).state;
    expect(updated.tasks[0].attemptUsage).toEqual([usage]);
    expect(lines(updated.tasks)).toContain('Tasks total: 12.4k in · 3.1k out · $0.42 · 5s');
  });

  it('applies nested usage updates without needing a status change', () => {
    const state = initialState({ tasks: [task({ id: 'parent', subtasks: [task()] })] });
    const updated = reduce(state, { type: 'statusUpdate', tasks: [{ id: 't', status: 'completed', verdict: null, attemptUsage: [usage] }] }).state;
    expect(updated.tasks[0].subtasks?.[0].attemptUsage).toEqual([usage]);
    expect(lines(updated.tasks)).toContain('Tasks total: 12.4k in');
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
    const update = actions.find((a): a is Extract<Action, { type: 'statusUpdate' }> => a.type === 'statusUpdate');
    const state = initialState({ sessionId: 's1', tasks: [task({ id: 'parent', subtasks: [task()] })] });
    const updated = reduce(state, update!).state;
    const layout = planLayout(updated, 4, 140);
    const text = layout.lines.map(stripAnsi).join('\n');

    expect(updated.tasks[0].subtasks?.[0].attemptUsage).toEqual([usage]);
    expect(updated.runMerge?.handoff.landed).toEqual([{ taskId: 't', order: 1, title: 'Work' }]);
    expect(text).toContain('Tasks total: 12.4k in · 3.1k out · $0.42 · 5s');
    expect(text).toContain('1 landed task not merged — /handoff merge');
    expect(layout.rowSpans[0].start).toBe(3);
    const at = revealOffset(layout, layout.maxScroll, layout.rowSpans[0]);
    expect(layout.rowSpans[0].start).toBeGreaterThan(at);
    expect(layout.rowSpans[0].end).toBeLessThanOrEqual(at + layout.rows - 1);

    const cleared = reduce(updated, { type: 'statusUpdate', tasks: [] }).state;
    const clearedText = planLayout(cleared, 40, 140).lines.map(stripAnsi).join('\n');
    expect(clearedText).not.toContain('landed task');
    expect(clearedText).toContain('Tasks total: 12.4k in · 3.1k out · $0.42 · 5s');
  });
});

describe('task row model name', () => {
  const running = (byModel: AttemptUsage['byModel'], over: Partial<TaskView> = {}) =>
    task({ status: 'running', assignedModel: { modelLabel: 'Sonnet 5.5' } as TaskView['assignedModel'], attemptUsage: [{ ...usage, byModel }], ...over });
  const expanded = (t: TaskView) => {
    const state = { ...initialState({ tasks: [t], rows: 40, cols: 140 }), expandedTaskId: t.id };
    return planLayout(state, 40, 140).lines.map(stripAnsi).join('\n');
  };

  it('shows the assigned model before usage names one', () => {
    const text = lines([running([])]);
    expect(text).toContain('Sonnet 5.5');
    expect(text).not.toContain('model unknown');
  });

  it('shows the model usage reports', () => {
    const text = lines([running([{ source: 'claude-code', model: 'claude-sonnet-x', totals: { inputTokens: 1 } }])]);
    expect(text).toContain('claude-sonnet-x');
    expect(text).not.toContain('model unknown');
  });

  it('leaves an unnamed entry out of the row', () => {
    const t = running([
      { source: 'claude-code', model: 'claude-sonnet-x', totals: { inputTokens: 1 } },
      { source: 'claude-code', totals: { inputTokens: 7000 } },
    ]);
    expect(lines([t])).not.toContain('model unknown');
    expect(lines([t])).not.toContain('unattributed');
    expect(expanded(t)).not.toContain('unattributed');
  });
});
