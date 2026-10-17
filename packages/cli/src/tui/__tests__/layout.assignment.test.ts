import { describe, it, expect, beforeAll } from 'vitest';
import { initialState } from '../reducer';
import { render } from '../render';
import { style } from '../ansi';
import type { TaskView, TuiState } from '../state';

beforeAll(() => { style.enabled = false; });

const frame = (state: TuiState): string => render(state).join('\n');

// The plan pane wraps a long flag across rows; read it back as one line.
const flat = (state: TuiState): string => frame(state).split('\n').map((l) => l.replace(/^.*│/, '')).join(' ').replace(/\s+/g, ' ');

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

  it('says what follows by where the task stands: a failed one runs there only if retried, a running one already is', () => {
    const wide = { cols: 180 };
    expect(flat(plan([task({ status: 'failed' })], wide))).toContain('⚠ codex is switched off — failed; a retry would run it there unless moved');
    expect(flat(plan([task({ status: 'in_progress' })], wide))).toContain('⚠ codex is switched off — already running as assigned');
    expect(flat(plan([task()], wide))).toContain('⚠ codex is switched off — runs as assigned unless moved');
  });

  it('does not call a task running whose attempt ended on a usage limit', () => {
    const wide = { cols: 180 };
    const paused = (over: Partial<TaskView>) => task({ status: 'awaiting_user', awaitingReason: 'usage-limit', ...over });
    expect(flat(plan([paused({ resumeAt: '2099-01-01T00:00:00.000Z' })], wide))).toContain('⚠ codex is switched off — paused on a usage limit; resumes there at the reset unless moved');
    expect(flat(plan([paused({})], wide))).toContain('⚠ codex is switched off — paused on a usage limit; a retry would run it there unless moved');
    expect(flat(plan([task({ status: 'awaiting_user', awaitingReason: 'conflict' })], wide))).toContain('⚠ codex is switched off — waiting for the user; what runs next runs there unless moved');
  });

  it('says its model is not in the allowlist', () => {
    const out = frame(plan(
      [task({ assignedRunner: 'claude-code', assignedModel: { modelId: 'claude-opus-4', modelLabel: 'Opus 4' } })],
      { allowlist: { 'claude-code': ['claude-sonnet-4'] } },
    ));
    expect(out).toContain('⚠ Opus 4 is not in the allowlist');
  });

  it('reads an allowlist as the planner\'s catalog does: ids only another runner lists limit nothing', () => {
    const out = frame(plan(
      [task({ assignedRunner: 'claude-code', assignedModel: { modelId: 'claude-opus-4', modelLabel: 'Opus 4' } })],
      {
        allowlist: { 'claude-code': ['gpt-5'] },
        models: [
          { id: 'claude-opus-4', label: 'Opus 4', provider: '', runners: ['claude-code'] },
          { id: 'gpt-5', label: 'GPT-5', provider: '', runners: ['codex'] },
        ],
      },
    ));
    expect(out).not.toContain('is not in the allowlist');
  });

  it('is quiet before the runners have loaded, rather than flagging every task', () => {
    expect(frame(plan([task()], { runners: [] }))).not.toContain('switched off');
  });

  it('is quiet about a task inside both', () => {
    expect(frame(plan([task({ assignedRunner: 'claude-code' })]))).not.toContain('⚠');
  });
});
