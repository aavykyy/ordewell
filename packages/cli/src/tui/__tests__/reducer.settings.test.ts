import { describe, it, expect } from 'vitest';
import { RUN_SETTINGS_DEFAULTS } from '@ordewell/core';
import { initialState, reduce, type Step } from '../reducer';
import type { StepperState } from '../reducers/stepper';
import type { TuiState } from '../state';
import { lastMessage } from './chat';

const key = (name: string, char?: string) => ({ type: 'key' as const, key: { name, char } });
const press = (state: TuiState, name: string, char?: string): Step => reduce(state, key(name, char));
const typed = (state: TuiState, text: string): Step =>
  reduce({ ...state, focus: 'chat', editor: { ...state.editor, text, cursor: text.length } }, key('enter'));

const base = (over: Partial<TuiState> = {}): TuiState => initialState({
  sessionId: 's1', rows: 40, cols: 120, autonomous: true, maxParallel: 5,
  runSettings: { ...RUN_SETTINGS_DEFAULTS, supervisorLevel: 'watch', supervisorRetryLimit: 2, wakeUpReadBudget: 12 },
  ...over,
});

function stepper(state: TuiState): StepperState {
  if (state.overlay?.kind !== 'stepper') throw new Error(`expected the stepper, got ${state.overlay?.kind ?? 'none'}`);
  return state.overlay.stepper;
}
/** The step on screen and its value: the highlighted row of a list, the typed digits of a number. */
const onScreen = (state: TuiState): { step: string; highlighted: string | undefined } => {
  const s = stepper(state);
  return { step: s.trail.find((t) => t.active)?.label ?? '', highlighted: s.entry?.text ?? s.items[s.index]?.label };
};

function type(state: TuiState, text: string): TuiState {
  return [...text].reduce((s, char) => {
    const { state: next, effects } = press(s, 'char', char);
    expect(effects).toEqual([]);
    return next;
  }, state);
}

/** Presses each key in turn, failing the test if any of them asks the runtime to do something. */
function walk(state: TuiState, ...names: string[]): TuiState {
  return names.reduce((s, name) => {
    const { state: next, effects } = press(s, name);
    expect(effects).toEqual([]);
    return next;
  }, state);
}

const marked = (state: TuiState): string | undefined => stepper(state).items.find((i) => i.selected)?.label;
const save = (run: object, message: string, extra: object = {}) =>
  ({ type: 'saveSettings', run, ...extra, message, sessionId: 's1' });

describe('/settings', () => {
  it('opens on Autonomy and pre-selects every current value', () => {
    let state = typed(base({ autonomous: false, maxParallel: 3 }), '/settings').state;
    const seen: { step: string; highlighted: string | undefined }[] = [];
    for (let i = 0; i < 7; i += 1) {
      seen.push(onScreen(state));
      state = press(state, 'tab').state;
    }
    expect(seen).toEqual([
      { step: 'Autonomy', highlighted: 'Guarded' },
      { step: 'Supervisor', highlighted: 'Watch' },
      { step: 'Supervisor retries', highlighted: '2' },
      { step: 'Supervisor reads', highlighted: '12' },
      { step: 'Automerge', highlighted: 'Off' },
      { step: 'Autorun', highlighted: 'Off' },
      { step: 'Parallel', highlighted: '3' },
    ]);
  });

  it('enter saves the choice at once and stays on the step, marked as the current value', () => {
    const { state, effects } = press(walk(typed(base(), '/settings').state, 'down'), 'enter');
    expect(effects).toEqual([save({}, 'Settings: Autonomy Guarded', { autonomous: false })]);
    expect(state.autonomous).toBe(false);
    expect(onScreen(state)).toEqual({ step: 'Autonomy', highlighted: 'Guarded' });
    expect(marked(state)).toBe('Guarded');
  });

  it('shows a saved value in the header and when the step is visited again', () => {
    const atAutomerge = walk(typed(base(), '/settings').state, 'tab', 'tab', 'tab', 'tab', 'up');
    const { state, effects } = press(atAutomerge, 'enter');
    expect(effects).toEqual([save({ mergeAtGatesAutomatically: true }, 'Settings: Automerge on')]);
    expect(state.runSettings.mergeAtGatesAutomatically).toBe(true);
    const next = walk(state, 'right');
    expect(stepper(next).trail.find((t) => t.label === 'Automerge')?.value).toBe('On');
    const back = walk(next, 'left');
    expect(onScreen(back)).toEqual({ step: 'Automerge', highlighted: 'On' });
    expect(marked(back)).toBe('On');
  });

  it('keeps the saved value when the daemon answers with it', () => {
    const saved = press(walk(typed(base(), '/settings').state, 'tab', 'tab', 'tab', 'tab', 'up'), 'enter').state;
    const run = { ...saved.runSettings, mergeAtGatesAutomatically: true };
    const { state } = reduce(saved, { type: 'settingsLoaded', settings: { run } });
    expect(onScreen(state)).toEqual({ step: 'Automerge', highlighted: 'On' });
    expect(marked(state)).toBe('On');
  });

  it("leaves the highlight where the user moved it when the daemon's answer lands", () => {
    const saved = press(walk(typed(base(), '/settings').state, 'tab', 'up'), 'enter').state;
    const moved = walk(saved, 'down');
    expect(onScreen(moved).highlighted).toBe('Watch');
    const run = { ...moved.runSettings, supervisorLevel: 'off' as const };
    const { state } = reduce(moved, { type: 'settingsLoaded', settings: { run } });
    expect(onScreen(state).highlighted).toBe('Watch');
    expect(marked(state)).toBe('Off');
  });

  it('esc keeps every choice already saved and undoes nothing', () => {
    const saved = press(walk(typed(base(), '/settings').state, 'down'), 'enter').state;
    const { state, effects } = press(walk(saved, 'tab', 'tab', 'tab', 'tab', 'up'), 'escape');
    expect(effects).toEqual([]);
    expect(state.overlay).toBeNull();
    expect(state.autonomous).toBe(false);
    expect(state.runSettings.mergeAtGatesAutomatically).toBe(false);
  });

  it('saves nothing for a row highlighted or a number typed without enter', () => {
    const highlighted = press(walk(typed(base(), '/settings').state, 'down'), 'escape');
    expect(highlighted.effects).toEqual([]);
    expect(highlighted.state.autonomous).toBe(true);
    const typedOnly = press(type(walk(typed(base(), '/settings').state, ...Array<string>(6).fill('tab')), '9'), 'escape');
    expect(typedOnly.effects).toEqual([]);
    expect(typedOnly.state.maxParallel).toBe(5);
  });

  it('saves nothing and says nothing when enter keeps the current value', () => {
    const open = typed(base(), '/settings').state;
    const { state, effects } = press(open, 'enter');
    expect(effects).toEqual([]);
    expect(lastMessage(state)).toEqual(lastMessage(open));
    expect(onScreen(state).step).toBe('Autonomy');
  });

  it('hides the supervisor retries and reads steps as soon as the supervisor is saved Off', () => {
    const atOff = typed(base({ runSettings: { ...RUN_SETTINGS_DEFAULTS, supervisorLevel: 'off' } }), '/settings').state;
    expect(stepper(atOff).trail.map((t) => t.label)).toEqual(['Autonomy', 'Supervisor', 'Automerge', 'Autorun', 'Parallel']);

    const { state, effects } = press(walk(typed(base(), '/settings').state, 'tab', 'up'), 'enter');
    expect(effects).toEqual([save({ supervisorLevel: 'off' }, 'Settings: Supervisor Off')]);
    expect(stepper(state).trail.map((t) => t.label)).toEqual(['Autonomy', 'Supervisor', 'Automerge', 'Autorun', 'Parallel']);
    expect(onScreen(state).step).toBe('Supervisor');
    expect(onScreen(walk(state, 'right')).step).toBe('Automerge');
  });

  it('asks before Act, as /supervisor act does, and returns to the step once confirmed', () => {
    const asked = press(walk(typed(base(), '/settings').state, 'tab', 'down'), 'enter');
    expect(asked.effects).toEqual([]);
    expect(asked.state.overlay).toMatchObject({ kind: 'confirm', message: 'Settings: Supervisor Act' });

    const confirmed = press(asked.state, 'enter');
    expect(confirmed.effects).toEqual([save({ supervisorLevel: 'act' }, 'Settings: Supervisor Act')]);
    expect(onScreen(confirmed.state)).toEqual({ step: 'Supervisor', highlighted: 'Act' });
    expect(marked(confirmed.state)).toBe('Act');
  });

  it('returns to the step with the old value when Act is declined', () => {
    const asked = press(walk(typed(base(), '/settings').state, 'tab', 'down'), 'enter').state;
    const declined = press(asked, 'escape');
    expect(declined.effects).toEqual([]);
    expect(onScreen(declined.state)).toEqual({ step: 'Supervisor', highlighted: 'Watch' });
    expect(marked(declined.state)).toBe('Watch');
    expect(declined.state.runSettings.supervisorLevel).toBe('watch');
  });

  it('asks before Autorun on, and returns to the step either way', () => {
    const atAutorun = walk(typed(base(), '/settings').state, ...Array<string>(5).fill('tab'), 'up');
    const asked = press(atAutorun, 'enter');
    expect(asked.state.overlay).toMatchObject({ kind: 'confirm', message: 'Settings: Autorun on' });

    const confirmed = press(asked.state, 'enter');
    expect(confirmed.effects).toEqual([save({ autorun: true }, 'Settings: Autorun on')]);
    expect(marked(confirmed.state)).toBe('On');
    expect(onScreen(confirmed.state).step).toBe('Autorun');

    const declined = press(asked.state, 'escape');
    expect(marked(declined.state)).toBe('Off');
    expect(onScreen(declined.state).step).toBe('Autorun');
  });

  it('saves any whole number typed for Parallel, staying on the step', () => {
    const state = walk(typed(base(), '/settings').state, ...Array<string>(6).fill('tab'));
    expect(onScreen(state)).toEqual({ step: 'Parallel', highlighted: '5' });
    const done = press(type(state, '17'), 'enter');
    expect(done.effects).toEqual([save({}, 'Settings: Parallel 17', { maxParallel: 17 })]);
    expect(done.state.maxParallel).toBe(17);
    expect(onScreen(done.state)).toEqual({ step: 'Parallel', highlighted: '17' });
  });

  it('refuses 0 for Parallel and Supervisor reads, and takes it for Supervisor retries', () => {
    const parallel = walk(type(walk(typed(base(), '/settings').state, ...Array<string>(6).fill('tab')), '0'), 'enter');
    expect(onScreen(parallel)).toEqual({ step: 'Parallel', highlighted: '0' });
    const reads = walk(type(walk(typed(base(), '/settings').state, 'tab', 'tab', 'tab'), '0'), 'enter');
    expect(onScreen(reads)).toEqual({ step: 'Supervisor reads', highlighted: '0' });

    const retries = press(type(walk(typed(base(), '/settings').state, 'tab', 'tab'), '0'), 'enter');
    expect(retries.effects).toEqual([save({ supervisorRetryLimit: 0 }, 'Settings: Supervisor retries 0')]);
    expect(onScreen(retries.state)).toEqual({ step: 'Supervisor retries', highlighted: '0' });
  });

  it('↓ stops at each count\'s minimum', () => {
    const down = (tabs: number, presses: number): string | undefined =>
      onScreen(walk(typed(base(), '/settings').state, ...Array<string>(tabs).fill('tab'), ...Array<string>(presses).fill('down'))).highlighted;
    expect(down(2, 5)).toBe('0');
    expect(down(3, 20)).toBe('1');
    expect(down(6, 10)).toBe('1');
  });
});
