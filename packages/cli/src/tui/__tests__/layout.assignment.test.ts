import { describe, it, expect, beforeAll } from 'vitest';
import { initialState } from '../reducer';
import { render } from '../render';
import { style } from '../ansi';
import type { TaskView, TuiState } from '../state';

beforeAll(() => { style.enabled = false; });

const frame = (state: TuiState): string => render(state).join('\n');

const task = (over: Partial<TaskView> = {}): TaskView => ({
  id: 't1', order: 1, title: 'Add the route', type: 'ai', status: 'pending', dependencies: [], assignedRunner: 'codex', ...over,
});

const plan = (tasks: TaskView[], over: Partial<TuiState> = {}): TuiState =>
  initialState({
    sessionId: 's1', rows: 30, cols: 90, focus: 'plan', tasks,
    runners: [{ id: 'claude-code', name: 'Claude Code', enabled: true }, { id: 'codex', name: 'Codex', enabled: false }],
    ...over,
  });

describe('plan pane — a task outside the enabled runners and allowlist', () => {
  it('says its runner is switched off, on a task that still runs', () => {
    expect(frame(plan([task()]))).toContain('⚠ codex is switched off');
  });

  it('says its model is not in the allowlist', () => {
    const out = frame(plan(
      [task({ assignedRunner: 'claude-code', assignedModel: { modelId: 'claude-opus-4', modelLabel: 'Opus 4' } })],
      { allowlist: { 'claude-code': ['claude-sonnet-4'] } },
    ));
    expect(out).toContain('⚠ Opus 4 is not in the allowlist');
  });

  it('is quiet before the runners have loaded, rather than flagging every task', () => {
    expect(frame(plan([task()], { runners: [] }))).not.toContain('switched off');
  });

  it('is quiet about a task inside both', () => {
    expect(frame(plan([task({ assignedRunner: 'claude-code' })]))).not.toContain('⚠');
  });
});
