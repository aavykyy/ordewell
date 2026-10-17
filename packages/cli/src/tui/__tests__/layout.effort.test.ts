import { describe, it, expect } from 'vitest';
import { planLayout } from '../layout';
import { initialState, type TaskView } from '../state';
import { stripAnsi } from '../ansi';

const task = (over: Partial<TaskView> = {}): TaskView => ({
  id: 't1', order: 1, title: 'Work', type: 'ai', status: 'pending', dependencies: [], assignedRunner: 'claude-code', ...over,
});

const model = (over: Partial<NonNullable<TaskView['assignedModel']>> = {}) =>
  ({ modelId: 'claude-opus', modelLabel: 'Claude Opus 5.5', ...over });

/** The task row's grey meta line, the one that hangs under the title. */
const metaLine = (t: TaskView, cols: number): string =>
  planLayout(initialState({ tasks: [t], rows: 40, cols }), 40, cols)
    .lines.map(stripAnsi)
    .find((line) => line.includes('claude-code')) ?? '';

describe('the effort on a collapsed task row', () => {
  it('shows the bare variant after the model when the pane is wide enough', () => {
    expect(metaLine(task({ assignedModel: model({ thinkingEffort: 'high' }) }), 140))
      .toMatch(/^\s*claude-code · Claude Opus 5\.5 · high$/);
  });

  it('drops the effort rather than truncate the line when it would not fit', () => {
    const t = task({ assignedModel: model({ thinkingEffort: 'high' }) });
    // 45 columns fits `claude-code · Claude Opus 5.5` but not the ` · high` tail.
    expect(metaLine(t, 45)).toMatch(/claude-code · Claude Opus 5\.5$/);
    expect(metaLine(t, 45)).not.toContain('high');
  });

  it('adds no segment for a task with no effort', () => {
    expect(metaLine(task({ assignedModel: model() }), 140)).toMatch(/claude-code · Claude Opus 5\.5$/);
  });

  it('adds none for a manual task, even one carrying an effort', () => {
    expect(metaLine(task({ type: 'user', assignedModel: model({ thinkingEffort: 'high' }) }), 140)).not.toContain('high');
  });

  it("keeps the plan's assignment on the row whichever model usage reports", () => {
    const t = task({
      assignedModel: model({ thinkingEffort: 'high' }),
      attemptUsage: [{ attempt: 1, runner: 'claude-code', startedAt: '', wallTimeMs: 1000, totals: { inputTokens: 1 }, byModel: [{ source: 'claude-code', model: 'claude-sonnet-x', totals: { inputTokens: 1 } }] }],
    });
    expect(metaLine(t, 140)).toMatch(/claude-code · Claude Opus 5\.5 · high$/);
  });
});
