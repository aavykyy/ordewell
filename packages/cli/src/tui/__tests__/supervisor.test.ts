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
  initialState({ sessionId: 's1', rows: 40, cols: 120, focus: 'plan', tasks: [task], ...over });
/** The user's run settings as the daemon answered them (ADR-0030). */
const loaded = (state: TuiState, run: Partial<GlobalRunSettings>): TuiState =>
  apply(state, { type: 'settingsLoaded', settings: { run: { ...RUN_SETTINGS_DEFAULTS, ...run } } }).state;
const typed = (state: TuiState, text: string): Step =>
  reduce({ ...state, focus: 'chat', editor: { ...state.editor, text, cursor: text.length } }, key('enter'));
const said = (step: Step): string => frame(step.state);

describe('run settings in the TUI (ADR-0030)', () => {
  it('/supervisor sets the level for this session and every later run, asking before Act', () => {
    expect(typed(plan(), '/supervisor watch').effects).toEqual([{ type: 'setRunSettings', changes: { supervisorLevel: 'watch' }, sessionId: 's1' }]);
    expect(typed(plan(), '/supervisor off').effects).toEqual([{ type: 'setRunSettings', changes: { supervisorLevel: 'off' }, sessionId: 's1' }]);

    const asked = typed(plan(), '/supervisor act');
    expect(asked.effects).toEqual([]);
    expect(asked.state.overlay).toMatchObject({ kind: 'confirm', title: 'Let the supervisor act?' });
    expect(frame(asked.state)).toMatch(/ops tasks included/);
    expect(press(asked.state, 'enter').effects).toEqual([{ type: 'setRunSettings', changes: { supervisorLevel: 'act' }, sessionId: 's1' }]);
  });

  it('/supervisor retries and reads set the loop guard and the wake-up budget, refusing what is out of range', () => {
    expect(typed(plan(), '/supervisor retries 3').effects).toEqual([{ type: 'setRunSettings', changes: { supervisorRetryLimit: 3 }, sessionId: 's1' }]);
    expect(typed(plan(), '/supervisor reads 20').effects).toEqual([{ type: 'setRunSettings', changes: { wakeUpReadBudget: 20 }, sessionId: 's1' }]);
    expect(typed(plan(), '/supervisor reads 0').effects).toEqual([]);
    expect(typed(plan(), '/supervisor retries -1').effects).toEqual([]);
    expect(typed(plan(), '/supervisor boss').effects).toEqual([]);
  });

  it('a bare /supervisor, /automerge or /autorun says what it is and changes nothing', () => {
    const state = loaded(plan(), { supervisorLevel: 'act', supervisorRetryLimit: 1, mergeAtGatesAutomatically: true });
    const supervisor = typed(state, '/supervisor');
    expect(supervisor.effects).toEqual([]);
    expect(said(supervisor)).toContain('Supervisor: Act, 1 retry per task, 12 reads per wake-up');
    expect(said(typed(state, '/automerge'))).toContain('Merge automatically (gates, end of run): on');
    expect(said(typed(state, '/autorun'))).toContain('Autorun: off');
  });

  it('/automerge and /autorun switch, and autorun asks before it turns on', () => {
    expect(typed(plan(), '/automerge on').effects).toEqual([{ type: 'setRunSettings', changes: { mergeAtGatesAutomatically: true }, sessionId: 's1' }]);
    expect(typed(plan(), '/automerge off').effects).toEqual([{ type: 'setRunSettings', changes: { mergeAtGatesAutomatically: false }, sessionId: 's1' }]);
    expect(typed(plan(), '/autorun off').effects).toEqual([{ type: 'setRunSettings', changes: { autorun: false }, sessionId: 's1' }]);

    const asked = typed(plan(), '/autorun on');
    expect(asked.effects).toEqual([]);
    expect(frame(asked.state)).toMatch(/without review, ops tasks included/);
    expect(press(asked.state, 'enter').effects).toEqual([{ type: 'setRunSettings', changes: { autorun: true }, sessionId: 's1' }]);
  });

  it('saves the setting alone when no session is open', () => {
    expect(typed(initialState({}), '/automerge on').effects).toEqual([{ type: 'setRunSettings', changes: { mergeAtGatesAutomatically: true } }]);
  });

  it('no longer has plan-pane keys for them', () => {
    for (const k of ['G', 'W', 'L']) expect(press(plan({ status: 'executing' }), 'char', k).effects).toEqual([]);
    expect(frame(plan())).not.toMatch(/G Merge at gates|W Supervisor/);
  });

  it('lists them in the welcome screen\'s Setup block, with the commands that change them', () => {
    const welcome = frame(loaded(initialState({ rows: 40, cols: 120 }), { supervisorLevel: 'act', autorun: true }));

    expect(welcome).toMatch(/Autonomy\s+Full\s*\n/);
    expect(welcome).toMatch(/Run\s+supervisor Act · auto-merge off · autorun on\s+\/settings/);
  });

  it('shows them on the status line, and the run\'s own level where it differs', () => {
    expect(frame(plan())).toContain('● Full · supervisor Watch');
    expect(frame(loaded(plan(), { supervisorLevel: 'act', mergeAtGatesAutomatically: true, autorun: true }))).toContain('● Full · supervisor Act · auto-merge · autorun');

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
