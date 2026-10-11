import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { initialState, reduce, type Action, type Step } from '../reducer';
import { render } from '../render';
import { style } from '../ansi';
import { conversationLines } from '../blocks';
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

describe('the supervisor in the TUI (ADR-0029)', () => {
  it('toggles the plan\'s supervisor between Off and Watch with W', () => {
    const off = plan();
    expect(press(off, 'char', 'W').effects).toEqual([{ type: 'setSupervisorLevel', sessionId: 's1', level: 'watch' }]);
    expect(frame(off)).toContain('W Supervisor: off');

    const watching = apply(off, { type: 'planUpdated', sessionId: 's1', plan: { tasks: [task], supervisorLevel: 'watch' } }).state;
    expect(watching.supervisorLevel).toBe('watch');
    expect(frame(watching)).toContain('W Supervisor: watch');
    expect(press(watching, 'char', 'W').effects).toEqual([{ type: 'setSupervisorLevel', sessionId: 's1', level: 'off' }]);
    expect(apply(watching, { type: 'sessionCleared' }).state.supervisorLevel).toBe('off');
  });

  it('says when the running supervisor differs from the setting, or stopped', () => {
    const changed = apply(plan({ status: 'executing' }), { type: 'planUpdated', sessionId: 's1', plan: {
      tasks: [task], supervisorLevel: 'off', runSettings: { mergeAtGatesAutomatically: false, supervisorLevel: 'watch' },
    } }).state;
    expect(frame({ ...changed, status: 'executing' })).toContain('supervisor next run off; now watch');

    const stopped = apply(changed, { type: 'planUpdated', sessionId: 's1', plan: {
      tasks: [task], supervisorLevel: 'watch', runSettings: { mergeAtGatesAutomatically: false, supervisorLevel: 'watch', unsupervised: 'its wake-up turn failed twice' },
    } }).state;
    expect(stopped.runSupervisor).toEqual({ level: 'watch', unsupervised: 'its wake-up turn failed twice' });
    expect(frame({ ...stopped, status: 'executing' })).toContain('unsupervised: the supervisor stopped');
  });

  it('reads an older plan, with no level saved, as Off', () => {
    const older = apply(plan(), { type: 'planUpdated', sessionId: 's1', plan: { tasks: [task], runSettings: { mergeAtGatesAutomatically: true } } }).state;
    expect(older.supervisorLevel).toBe('off');
    expect(older.runSupervisor).toEqual({ level: 'off' });
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
