import { describe, it, expect } from 'vitest';
import { initialState, reduce, type Step } from '../reducer';
import { openStepper, type StepChoices, type StepperDefinition, type StepperState } from '../reducers/stepper';
import type { TuiState } from '../state';

const press = (state: TuiState, name: string, char?: string): Step => reduce(state, { type: 'key', key: { name, char } });

/** Presses each key in turn, failing the test if any of them asks the runtime to do something. */
function keys(state: TuiState, ...names: string[]): TuiState {
  return names.reduce((s, name) => {
    const { state: next, effects } = press(s, name);
    expect(effects).toEqual([]);
    return next;
  }, state);
}

const MODELS: Record<string, { id: string; label: string; efforts: string[] }[]> = {
  claude: [
    { id: 'opus', label: 'Opus', efforts: ['low', 'high'] },
    { id: 'haiku', label: 'Haiku', efforts: [] },
  ],
  codex: [{ id: 'gpt', label: 'GPT', efforts: ['medium', 'xhigh'] }],
};

const effortsOf = (choices: StepChoices): string[] =>
  MODELS[choices.harness]?.find((m) => m.id === choices.model)?.efforts ?? [];

const planner: StepperDefinition = {
  title: 'Planner',
  steps: [
    {
      id: 'harness',
      label: 'Harness',
      items: (state) => [
        { id: 'claude', label: 'Claude Code', selected: state.plannerProvider === 'claude' },
        { id: 'codex', label: 'Codex', selected: state.plannerProvider === 'codex' },
        { id: 'opencode', label: 'OpenCode', detail: 'CLI not installed', disabled: true },
      ],
    },
    {
      id: 'model',
      label: 'Model',
      items: (state, choices) => (MODELS[choices.harness] ?? []).map((m) => ({
        id: m.id, label: m.label, selected: m.id === state.orchestratorModel,
      })),
    },
    {
      id: 'effort',
      label: 'Effort',
      skip: (_state, choices) => effortsOf(choices).length === 0,
      items: (state, choices) => effortsOf(choices).map((e) => ({ id: e, label: e, selected: e === state.plannerEffort })),
    },
  ],
  complete: (state, choices) => ({
    state,
    effects: [
      { type: 'setPlanner', provider: choices.harness },
      { type: 'setModel', modelId: choices.model },
      ...(choices.effort ? [{ type: 'setPlannerEffort' as const, effort: choices.effort }] : []),
    ],
  }),
};

const base = initialState({ plannerProvider: 'codex', orchestratorModel: 'gpt', plannerEffort: 'xhigh' });

function opened(state: TuiState = base): TuiState {
  const { state: next, effects } = openStepper(state, planner);
  expect(effects).toEqual([]);
  return next;
}

const stepperOf = (state: TuiState): StepperState => {
  if (state.overlay?.kind !== 'stepper') throw new Error('no stepper open');
  return state.overlay.stepper;
};

/** The step on screen, its highlighted row, and the header, in one comparable shape. */
const at = (state: TuiState) => {
  const s = stepperOf(state);
  return {
    step: s.definition.steps[s.current].id,
    row: s.items[s.index]?.id,
    trail: s.trail.map((t) => (t.active ? `[${t.label}]` : t.value ? `${t.label}: ${t.value}` : t.label)).join(' › '),
  };
};

describe('stepper', () => {
  it('opens on the first step with the current value highlighted', () => {
    expect(at(opened())).toEqual({ step: 'harness', row: 'codex', trail: '[Harness] › Model › Effort' });
  });

  it('enter confirms a step and moves on to the next, pre-selected', () => {
    expect(at(keys(opened(), 'enter'))).toEqual({ step: 'model', row: 'gpt', trail: 'Harness: Codex › [Model] › Effort' });
  });

  it("rebuilds a later step's rows from what an earlier step chose", () => {
    const s = keys(opened(), 'up', 'enter');
    expect(stepperOf(s).items.map((i) => i.id)).toEqual(['opus', 'haiku']);
    expect(at(s)).toEqual({ step: 'model', row: 'opus', trail: 'Harness: Claude Code › [Model] › Effort' });
  });

  it("a changed choice drops the later steps' pre-selections, even ones the new rows still offer", () => {
    // Both sizes come in both colours; what a colour pre-selects is its own.
    const shirts: StepperDefinition = {
      title: 'Shirt',
      steps: [
        { id: 'colour', label: 'Colour', items: () => [{ id: 'red', label: 'Red', selected: true }, { id: 'blue', label: 'Blue' }] },
        { id: 'size', label: 'Size', items: (_s, c) => ['s', 'l'].map((id) => ({ id, label: id, selected: id === (c.colour === 'red' ? 's' : 'l') })) },
      ],
      complete: (state) => ({ state, effects: [] }),
    };
    const open = openStepper(base, shirts).state;
    expect(at(keys(open, 'down', 'enter')).row).toBe('l');
  });

  it('leaves a step that does not apply out of the header and the walk', () => {
    const s = keys(opened(), 'up', 'enter', 'down');
    expect(at(s).trail).toBe('Harness: Claude Code › [Model] › Effort');
    const { state, effects } = press(s, 'enter');
    expect(state.overlay).toBeNull();
    expect(effects).toEqual([
      { type: 'setPlanner', provider: 'claude' },
      { type: 'setModel', modelId: 'haiku' },
    ]);
  });

  it('drops a skipped step from the header when the current values skip it', () => {
    const s = opened(initialState({ plannerProvider: 'claude', orchestratorModel: 'haiku' }));
    expect(at(s).trail).toBe('[Harness] › Model');
  });

  it('esc closes from the first, a middle and the last step without applying anything', () => {
    const middle = keys(opened(), 'enter');
    const last = keys(opened(), 'enter', 'enter');
    expect(at(last).step).toBe('effort');
    for (const s of [opened(), middle, last]) {
      const { state, effects } = press(s, 'escape');
      expect(state.overlay).toBeNull();
      expect(effects).toEqual([]);
      expect(state.plannerProvider).toBe(s.plannerProvider);
      expect(state.orchestratorModel).toBe(s.orchestratorModel);
    }
  });

  it("tab jumps ahead without taking the highlighted row as the step's choice", () => {
    const s = keys(opened(), 'up', 'tab');
    expect(at(s)).toEqual({ step: 'model', row: 'gpt', trail: 'Harness: Codex › [Model] › Effort' });
  });

  it('shift-tab jumps back to the step as it was chosen', () => {
    const s = keys(opened(), 'enter', 'down', 'shift-tab');
    expect(at(s)).toEqual({ step: 'harness', row: 'codex', trail: '[Harness] › Model › Effort' });
  });

  it('tab and shift-tab stop at the ends', () => {
    expect(at(keys(opened(), 'shift-tab')).step).toBe('harness');
    expect(at(keys(opened(), 'tab', 'tab', 'tab')).step).toBe('effort');
  });

  it("right jumps ahead without taking the highlighted row as the step's choice", () => {
    const s = keys(opened(), 'up', 'right');
    expect(at(s)).toEqual({ step: 'model', row: 'gpt', trail: 'Harness: Codex › [Model] › Effort' });
  });

  it('left jumps back to the step as it was chosen', () => {
    const s = keys(opened(), 'enter', 'down', 'left');
    expect(at(s)).toEqual({ step: 'harness', row: 'codex', trail: '[Harness] › Model › Effort' });
  });

  it('right and left stop at the ends, and left on the first step keeps the stepper open', () => {
    const first = keys(opened(), 'left');
    expect(first.overlay?.kind).toBe('stepper');
    expect(at(first).step).toBe('harness');
    expect(at(keys(opened(), 'right', 'right', 'right')).step).toBe('effort');
  });

  it('jumping past steps keeps their values, and the last enter completes once with every choice', () => {
    const s = keys(opened(), 'tab', 'tab');
    expect(at(s)).toEqual({ step: 'effort', row: 'xhigh', trail: 'Harness: Codex › Model: GPT › [Effort]' });
    const { state, effects } = press(s, 'enter');
    expect(state.overlay).toBeNull();
    expect(effects).toEqual([
      { type: 'setPlanner', provider: 'codex' },
      { type: 'setModel', modelId: 'gpt' },
      { type: 'setPlannerEffort', effort: 'xhigh' },
    ]);
  });

  it('a digit chooses its row on a numbered step and moves on', () => {
    const s = keys(opened(), 'enter', 'tab');
    const { state, effects } = press(s, 'char', '1');
    expect(effects).toEqual([
      { type: 'setPlanner', provider: 'codex' },
      { type: 'setModel', modelId: 'gpt' },
      { type: 'setPlannerEffort', effort: 'medium' },
    ]);
    expect(state.overlay).toBeNull();
  });

  it('enter on a disabled row stays on the step', () => {
    const s = keys(opened(), 'down');
    const { state, effects } = press(s, 'enter');
    expect(effects).toEqual([]);
    expect(at(state).step).toBe('harness');
  });
});

describe('stepper number step', () => {
  /** Two counts after a list; `complete` hands back what it was given so a test can read it. */
  function counts(): { definition: StepperDefinition; done: () => StepChoices | undefined } {
    let completed: StepChoices | undefined;
    const definition: StepperDefinition = {
      title: 'Run',
      steps: [
        { id: 'pace', label: 'Pace', items: () => [{ id: 'fast', label: 'Fast', selected: true }, { id: 'slow', label: 'Slow' }] },
        { id: 'workers', label: 'Workers', number: { min: 1, current: (state) => state.maxParallel } },
        { id: 'retries', label: 'Retries', number: { min: 0, current: () => 2 } },
      ],
      complete: (state, choices) => {
        completed = choices;
        return { state, effects: [] };
      },
    };
    return { definition, done: () => completed };
  }
  const start = (definition: StepperDefinition): TuiState => openStepper(initialState({ maxParallel: 5 }), definition).state;
  const type = (state: TuiState, text: string): TuiState =>
    [...text].reduce((s, char) => {
      const { state: next, effects } = press(s, 'char', char);
      expect(effects).toEqual([]);
      return next;
    }, state);
  const entry = (state: TuiState): string | undefined => stepperOf(state).entry?.text;

  it('opens a number step pre-filled with the current value', () => {
    const { definition } = counts();
    const s = keys(start(definition), 'enter');
    expect(at(s).step).toBe('workers');
    expect(entry(s)).toBe('5');
  });

  it('the first digit replaces the pre-filled value, later ones append, and enter takes the number', () => {
    const { definition, done } = counts();
    const s = type(keys(start(definition), 'enter'), '17');
    expect(entry(s)).toBe('17');
    const next = keys(s, 'enter', 'enter');
    expect(next.overlay).toBeNull();
    expect(done()).toEqual({ pace: 'fast', workers: '17', retries: '2' });
  });

  it('enter stays on the step while the number is below the minimum or empty', () => {
    const { definition, done } = counts();
    const zero = type(keys(start(definition), 'enter'), '0');
    expect(at(keys(zero, 'enter')).step).toBe('workers');
    const empty = keys(start(definition), 'enter', 'backspace');
    expect(entry(empty)).toBe('');
    expect(at(keys(empty, 'enter')).step).toBe('workers');
    expect(done()).toBeUndefined();
  });

  it('esc closes with digits typed, without applying them', () => {
    const { definition, done } = counts();
    const s = type(keys(start(definition), 'enter'), '17');
    const { state, effects } = press(s, 'escape');
    expect(state.overlay).toBeNull();
    expect(effects).toEqual([]);
    expect(done()).toBeUndefined();
  });

  it('takes 0 where the minimum is 0', () => {
    const { definition, done } = counts();
    const s = type(keys(start(definition), 'enter', 'enter'), '0');
    expect(keys(s, 'enter').overlay).toBeNull();
    expect(done()).toEqual({ pace: 'fast', workers: '5', retries: '0' });
  });

  it('typing the pre-filled digit still starts a fresh number', () => {
    const { definition } = counts();
    expect(entry(type(keys(start(definition), 'enter'), '55'))).toBe('55');
  });

  it('ignores anything but digits', () => {
    const { definition } = counts();
    expect(entry(type(keys(start(definition), 'enter'), '1a-2'))).toBe('12');
  });

  it('↑ and ↓ step the number by one and stop at the minimum', () => {
    const { definition } = counts();
    const s = keys(start(definition), 'enter');
    expect(entry(keys(s, 'up', 'up'))).toBe('7');
    expect(entry(keys(s, ...Array<string>(6).fill('down')))).toBe('1');
    expect(entry(keys(type(s, '0'), 'down'))).toBe('1');
    expect(entry(keys(start(definition), 'enter', 'enter', 'down', 'down', 'down'))).toBe('0');
  });

  it('a digit after ↑ or ↓ starts the number afresh', () => {
    const { definition } = counts();
    expect(entry(type(keys(start(definition), 'enter', 'up'), '3'))).toBe('3');
  });

  it('switching steps keeps a valid typed number and shows it in the header', () => {
    const { definition } = counts();
    const s = keys(type(keys(start(definition), 'enter'), '17'), 'right');
    expect(at(s)).toEqual({ step: 'retries', row: undefined, trail: 'Pace: Fast › Workers: 17 › [Retries]' });
    expect(entry(keys(s, 'left'))).toBe('17');
    expect(entry(keys(s, 'shift-tab'))).toBe('17');
  });

  it('switching steps drops an invalid typed number for the current value', () => {
    const { definition } = counts();
    const s = keys(type(keys(start(definition), 'enter'), '0'), 'tab');
    expect(at(s).trail).toBe('Pace: Fast › Workers: 5 › [Retries]');
    expect(entry(keys(s, 'left'))).toBe('5');
  });
});

