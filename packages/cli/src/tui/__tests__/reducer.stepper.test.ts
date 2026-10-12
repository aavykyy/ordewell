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

  it('esc goes back one step, keeping what was chosen', () => {
    const s = keys(opened(), 'up', 'enter', 'escape');
    expect(at(s)).toEqual({ step: 'harness', row: 'claude', trail: '[Harness] › Model › Effort' });
  });

  it('esc on the first step cancels without applying anything', () => {
    const { state, effects } = press(opened(), 'escape');
    expect(state.overlay).toBeNull();
    expect(effects).toEqual([]);
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
