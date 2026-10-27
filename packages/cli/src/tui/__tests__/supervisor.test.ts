import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { initialState, reduce, type Action, type Step } from '../reducer';
import { render } from '../render';
import { style } from '../ansi';
import { conversationLines } from '../blocks';
import { RUN_SETTINGS_DEFAULTS, type GlobalRunSettings } from '@ordewell/core';
import type { TaskView, TuiState } from '../state';

beforeAll(() => { style.enabled = false; });
afterAll(() => { style.enabled = true; });

const key = (name: string, char?: string) => ({ type: 'key' as const, key: { name, char } });
const press = (state: TuiState, name: string, char?: string): Step => reduce(state, key(name, char));
const apply = (state: TuiState, action: Action): Step => reduce(state, action);
const frame = (state: TuiState): string => render(state).join('\n');

const task: TaskView = { id: 't1', order: 1, title: 'Build', type: 'ai', status: 'in_progress', dependencies: [] };
const plan = (over: Partial<TuiState> = {}): TuiState =>
  initialState({ sessionId: 's1', rows: 40, cols: 120, focus: 'plan', tasks: [task], runSettingsKnown: true, ...over });
/** The user's run settings as the daemon answered them (ADR-0030). */
const loaded = (state: TuiState, run: Partial<GlobalRunSettings>): TuiState =>
  apply(state, { type: 'settingsLoaded', settings: { run: { ...RUN_SETTINGS_DEFAULTS, ...run } } }).state;

describe('run settings in the TUI (ADR-0030)', () => {
  it('no longer has plan-pane keys for them', () => {
    for (const k of ['G', 'W', 'L']) expect(press(plan({ status: 'executing' }), 'char', k).effects).toEqual([]);
    expect(frame(plan())).not.toMatch(/G Merge at gates|W Supervisor/);
  });

  it('lists them in the welcome screen\'s Setup block, with the commands that change them', () => {
    const welcome = frame(loaded(initialState({ rows: 40, cols: 120 }), { supervisorLevel: 'act', autorun: true }));

    expect(welcome).toMatch(/Autonomy\s+Guarded\s*\n/);
    expect(welcome).toMatch(/Run\s+supervisor Act · auto-merge off · autorun on\s+\/settings/);
    expect(welcome).not.toMatch(/Research/);
  });

  it('shows them on the status line, and the run\'s own level where it differs', () => {
    expect(frame(plan())).toContain('● Guarded · supervisor Watch');
    expect(frame(loaded(plan(), { supervisorLevel: 'act', mergeAtGatesAutomatically: true, autorun: true }))).toContain('● Guarded · supervisor Act · auto-merge · autorun');

    const lowered = apply(loaded(plan({ status: 'executing' }), { supervisorLevel: 'act' }), { type: 'planUpdated', sessionId: 's1', plan: {
      tasks: [task], runSettings: { mergeAtGatesAutomatically: false, supervisorLevel: 'watch' },
    } }).state;
    expect(frame({ ...lowered, status: 'executing' })).toContain('supervisor Act → Watch');

    const stopped = apply(lowered, { type: 'planUpdated', sessionId: 's1', plan: {
      tasks: [task], runSettings: { mergeAtGatesAutomatically: false, supervisorLevel: 'act', unsupervised: 'its wake-up turn failed twice' },
    } }).state;
    expect(frame({ ...stopped, status: 'executing' })).toContain('supervisor Act → unsupervised');
  });

  it('keeps task origins out of the plan pane', () => {
    const added = apply(plan(), {
      type: 'planUpdated',
      sessionId: 's1',
      plan: {
        tasks: [
          { id: 't1', order: 1, title: 'Build', type: 'ai', status: 'in_progress', dependencies: [] },
          { id: 't2', order: 2, title: 'Add a cache', type: 'ai', status: 'pending', dependencies: [], addedBy: 'supervisor' },
        ],
      },
    }).state;
    expect(frame(added)).not.toMatch(/added by supervisor/);
    expect(frame(added)).toContain('Add a cache');
    expect(frame(plan())).not.toMatch(/added by supervisor/);
  });

  it('draws the run update and the supervisor\'s note apart from the planner\'s replies', () => {
    const lines = conversationLines([
      { type: 'message', id: 'b1', role: 'planner', text: 'Here is the plan.', streaming: false },
      { type: 'message', id: 'b2', role: 'wake_up', text: 'Run update:\n- task #1 "Build" failed', streaming: false },
      { type: 'message', id: 'b3', role: 'supervisor', text: 'Task 1 failed; retry it?', streaming: false },
    ], 80, false);

    const text = lines.join('\n');
    expect(text).toContain('◆ Here is the plan.');
    expect(text).toContain('↯ Run update:');
    expect(text).toContain('  - task #1 "Build" failed');
    expect(text).toContain('◇ Task 1 failed; retry it?');
  });
});
