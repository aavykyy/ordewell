import { describe, it, expect, beforeAll } from 'vitest';
import { replayTaskLog } from '@ordewell/core';
import { initialState, reduce } from '../reducer';
import { render } from '../render';
import { style } from '../ansi';
import type { TaskView, TuiState } from '../state';
import { lastMessage } from './chat';

beforeAll(() => { style.enabled = false; });

const frame = (state: TuiState): string => render(state).join('\n');

// The plan stores a runner for every task it holds, whatever its type.
const task = (over: Partial<TaskView> = {}): TaskView => ({
  id: 't1', order: 1, title: 'Ship it', type: 'ai', status: 'pending', dependencies: [], assignedRunner: 'opencode', ...over,
});

const plan = (tasks: TaskView[], over: Partial<TuiState> = {}): TuiState =>
  initialState({ sessionId: 's1', rows: 30, cols: 120, focus: 'plan', tasks, runners: [{ id: 'opencode', name: 'OpenCode', enabled: true }], ...over });

const opened = (t: TaskView): TuiState =>
  initialState({
    sessionId: 's1', rows: 30, cols: 160, focus: 'chat', tasks: [t],
    taskView: { taskId: t.id, view: replayTaskLog([]), attempts: [], attempt: 0, pending: [], loaded: true, followLatest: true, queuedIndex: 0 },
  });

describe('the runner a task shows', () => {
  it('is on an AI task\'s plan row and task header', () => {
    expect(frame(plan([task()]))).toContain('opencode');
    expect(frame(opened(task()))).toContain('→ Task 1 · Ship it · opencode');
  });

  it.each([
    ['script', { type: 'script' as const, commands: [['git', 'push']] }],
    ['manual', { type: 'user' as const }],
  ])('is on neither the plan row nor the task header of a %s task', (_name, over) => {
    const t = task(over);
    expect(frame(plan([t]))).not.toContain('opencode');
    expect(frame(opened(t))).toContain('→ Task 1 · Ship it');
    expect(frame(opened(t))).not.toContain('opencode');
  });
});

describe('assigning a non-AI task from the composer', () => {
  const run = (text: string, t: TaskView) => {
    const base = plan([t], { focus: 'chat' });
    return reduce({ ...base, editor: { ...base.editor, text, cursor: text.length } }, { type: 'key', key: { name: 'enter' } });
  };

  it.each(['/task-model 1 gpt-5', '/task-mode 1 build', '/task-effort 1 high', '/task-runner 1 opencode'])('%s is refused for a script task, with no update sent', (text) => {
    const { state, effects } = run(text, task({ type: 'script', commands: [['git', 'push']], assignedModel: { modelId: 'gpt-5', modelLabel: 'GPT-5' } }));
    expect(effects.filter((e) => e.type === 'updateTask')).toEqual([]);
    expect(lastMessage(state)?.text).toContain('A script task runs no model');
  });

  it.each(['/task-model 1 gpt-5', '/task-mode 1 build', '/task-effort 1 high'])('%s is refused for a manual task, with no update sent', (text) => {
    const { state, effects } = run(text, task({ type: 'user' }));
    expect(effects.filter((e) => e.type === 'updateTask')).toEqual([]);
    expect(lastMessage(state)?.text).toContain('Manual tasks do not run an executor');
  });
});
