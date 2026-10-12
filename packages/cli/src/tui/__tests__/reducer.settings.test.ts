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

/** Enter on every remaining step, keeping each one's pre-selection. */
function finish(state: TuiState): Step {
  let out: Step = { state, effects: [] };
  while (out.state.overlay?.kind === 'stepper') out = press(out.state, 'enter');
  return out;
}

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

  it('skips the supervisor retries and reads steps once the supervisor is Off', () => {
    const atOff = typed(base({ runSettings: { ...RUN_SETTINGS_DEFAULTS, supervisorLevel: 'off' } }), '/settings').state;
    expect(stepper(atOff).trail.map((t) => t.label)).toEqual(['Autonomy', 'Supervisor', 'Automerge', 'Autorun', 'Parallel']);

    const toOff = walk(typed(base(), '/settings').state, 'tab', 'up');
    expect(onScreen(toOff).highlighted).toBe('Off');
    expect(onScreen(press(toOff, 'enter').state).step).toBe('Automerge');
  });

  it('applies nothing when cancelled, from any step', () => {
    const changed = walk(typed(base(), '/settings').state, 'down', 'enter', 'down', 'enter');
    expect(onScreen(changed).step).toBe('Supervisor retries');
    const out = ['escape', 'escape', 'escape'].reduce<Step>((s, k) => press(s.state, k), { state: changed, effects: [] });
    expect(out.state.overlay).toBeNull();
    expect(out.effects).toEqual([]);
    expect(out.state.autonomous).toBe(true);
  });

  it('says so when nothing changed', () => {
    const done = finish(typed(base(), '/settings').state);
    expect(done.effects).toEqual([]);
    expect(done.state.overlay).toBeNull();
    expect(lastMessage(done.state)?.text).toBe('No changes.');
  });

  it('saves only the changed settings, in one effect with one notice', () => {
    let state = typed(base(), '/settings').state;
    state = walk(state, 'tab', 'tab', 'tab', 'tab', 'tab');
    expect(onScreen(state).step).toBe('Autorun');
    state = walk(state, 'up', 'enter');
    expect(onScreen(state).step).toBe('Parallel');
    const done = press(type(state, '3'), 'enter');
    expect(done.effects).toEqual([]);
    expect(done.state.overlay?.kind).toBe('confirm');

    const saved = press(done.state, 'enter');
    expect(saved.effects).toEqual([
      { type: 'saveSettings', run: { autorun: true }, maxParallel: 3, message: 'Settings: Autorun on · Parallel 3', sessionId: 's1' },
    ]);
    expect(saved.state.maxParallel).toBe(3);
  });

  it('sends autonomy, supervisor limits and automerge together without asking when none is risky', () => {
    let state = typed(base(), '/settings').state;
    state = walk(state, 'down', 'enter');      // Guarded
    state = press(state, 'enter').state;       // Watch, unchanged
    state = walk(type(state, '3'), 'enter');   // retries 3
    state = walk(type(state, '24'), 'enter');  // reads 24
    state = press(state, 'char', '1').state;   // automerge on
    state = press(state, 'enter').state;       // autorun off, unchanged
    const done = press(state, 'enter');        // parallel 5, unchanged
    expect(done.state.overlay).toBeNull();
    expect(done.state.autonomous).toBe(false);
    expect(done.effects).toEqual([{
      type: 'saveSettings',
      run: { supervisorRetryLimit: 3, wakeUpReadBudget: 24, mergeAtGatesAutomatically: true },
      autonomous: false,
      message: 'Settings: Autonomy Guarded · Supervisor retries 3 · Supervisor reads 24 · Automerge on',
      sessionId: 's1',
    }]);
  });

  it('asks before Act, as /supervisor act does, and saves nothing when declined', () => {
    let state = typed(base(), '/settings').state;
    state = walk(state, 'tab', 'down', 'enter');
    const asked = finish(state);
    expect(asked.effects).toEqual([]);
    expect(asked.state.overlay).toMatchObject({ kind: 'confirm', message: 'Settings: Supervisor Act' });
    const declined = press(asked.state, 'escape');
    expect(declined.effects).toEqual([]);
    expect(declined.state.overlay).toBeNull();
  });

  it('saves any whole number typed for Parallel', () => {
    const state = walk(typed(base(), '/settings').state, ...Array<string>(6).fill('tab'));
    expect(onScreen(state)).toEqual({ step: 'Parallel', highlighted: '5' });
    const done = press(type(state, '17'), 'enter');
    expect(done.state.overlay).toBeNull();
    expect(done.effects).toEqual([
      { type: 'saveSettings', run: {}, maxParallel: 17, message: 'Settings: Parallel 17', sessionId: 's1' },
    ]);
    expect(done.state.maxParallel).toBe(17);
  });

  it('refuses 0 for Parallel and Supervisor reads, and takes it for Supervisor retries', () => {
    const parallel = walk(type(walk(typed(base(), '/settings').state, ...Array<string>(6).fill('tab')), '0'), 'enter');
    expect(onScreen(parallel)).toEqual({ step: 'Parallel', highlighted: '0' });
    const reads = walk(type(walk(typed(base(), '/settings').state, 'tab', 'tab', 'tab'), '0'), 'enter');
    expect(onScreen(reads)).toEqual({ step: 'Supervisor reads', highlighted: '0' });

    const retries = walk(type(walk(typed(base(), '/settings').state, 'tab', 'tab'), '0'), 'enter');
    expect(onScreen(retries).step).toBe('Supervisor reads');
    const done = finish(retries);
    expect(done.effects).toEqual([
      { type: 'saveSettings', run: { supervisorRetryLimit: 0 }, message: 'Settings: Supervisor retries 0', sessionId: 's1' },
    ]);
  });

  it('↓ stops at each count\'s minimum', () => {
    const down = (tabs: number, presses: number): string | undefined =>
      onScreen(walk(typed(base(), '/settings').state, ...Array<string>(tabs).fill('tab'), ...Array<string>(presses).fill('down'))).highlighted;
    expect(down(2, 5)).toBe('0');
    expect(down(3, 20)).toBe('1');
    expect(down(6, 10)).toBe('1');
  });
});
