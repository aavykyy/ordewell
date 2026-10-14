import { describe, it, expect } from 'vitest';
import { initialState, reduce, type Action, type Step } from '../reducer';
import type { StepperState } from '../reducers/stepper';
import type { SessionMessage } from '@ordewell/core';
import type { PickerItem, TuiState } from '../state';
import { lastMessage, messagesOf } from './chat';

/**
 * The `/planner` picker (ADR-0009): who researches the goal and writes the
 * plan. Coding agents appear alongside API providers because "what plans for
 * me?" is one question; the picker is where that shows.
 */

function run(text: string, overrides: Partial<TuiState> = {}) {
  const base = initialState(overrides);
  const state = { ...base, editor: { ...base.editor, text, cursor: text.length } };
  return reduce(state, { type: 'key', key: { name: 'enter' } });
}

function items(state: TuiState): PickerItem[] {
  if (state.overlay?.kind !== 'picker') throw new Error('expected a picker overlay');
  return state.overlay.picker.items;
}

/** Move the picker cursor onto `id`, then press enter. */
function pick(state: TuiState, id: string) {
  const index = items(state).findIndex((i) => i.id === id);
  if (index < 0) throw new Error(`no picker row for "${id}"`);
  const positioned: TuiState = state.overlay?.kind === 'picker'
    ? { ...state, overlay: { kind: 'picker', picker: { ...state.overlay.picker, index } } }
    : state;
  return reduce(positioned, { type: 'key', key: { name: 'enter' } });
}

const installedAll: Partial<TuiState> = {
  runners: [
    { id: 'claude-code', name: 'Claude Code', enabled: true },
    { id: 'codex', name: 'Codex', enabled: true },
    { id: 'opencode', name: 'OpenCode', enabled: true },
  ],
};

function stepperOf(state: TuiState): StepperState {
  if (state.overlay?.kind !== 'stepper') throw new Error('expected a stepper overlay');
  return state.overlay.stepper;
}

const press = (state: TuiState, name: string): Step => reduce(state, { type: 'key', key: { name } });

/** Move the stepper's cursor onto `id`, then press enter. */
function choose(state: TuiState, id: string): Step {
  const stepper = stepperOf(state);
  const index = stepper.items.findIndex((i) => i.id === id);
  if (index < 0) throw new Error(`no row for "${id}"`);
  return press({ ...state, overlay: { kind: 'stepper', stepper: { ...stepper, index } } }, 'enter');
}

/** The step on screen and the row its cursor rests on. */
const at = (state: TuiState) => {
  const s = stepperOf(state);
  return { step: s.trail.find((t) => t.active)?.label, on: s.items[s.index]?.id };
};

describe('/planner', () => {
  const models = [
    { id: 'opus', label: 'Claude Opus 5.5', provider: 'anthropic', runners: ['claude-code'], variants: [{ id: 'low', label: 'Low' }, { id: 'high', label: 'High' }] },
    { id: 'haiku', label: 'Claude Haiku 5.5', provider: 'anthropic', runners: ['claude-code'], variants: [] },
    { id: 'gpt', label: 'GPT', provider: 'openai', runners: ['codex'], variants: [{ id: 'xhigh', label: 'Extra high' }] },
  ];
  const ready: Partial<TuiState> = {
    ...installedAll,
    models,
    orchestratorModels: [
      { id: 'deepseek/v4', label: 'DeepSeek V4', provider: 'openrouter' },
      { id: 'qwen/max', label: 'Qwen Max', provider: 'openrouter' },
    ],
    configuredProviders: ['openrouter'],
    plannerProvider: 'codex',
    orchestratorModel: 'gpt',
  };

  it('opens a stepper on the harness step, coding agents before API providers', () => {
    const { state } = run('/planner', ready);

    expect(at(state)).toEqual({ step: 'Harness', on: 'codex' });
    expect(stepperOf(state).items.map((i) => i.id)).toEqual(['claude-code', 'codex', 'opencode', 'openrouter']);
  });

  it('says a coding agent needs no API key', () => {
    const { state } = run('/planner', ready);
    expect(stepperOf(state).items.find((i) => i.id === 'claude-code')?.detail).toMatch(/no API key/i);
  });

  it('keeps an agent whose CLI is not installed listed, with the reason, and refuses it', () => {
    const opened = run('/planner', { ...ready, runners: [{ id: 'codex', name: 'Codex', enabled: true }] }).state;

    const claude = stepperOf(opened).items.find((i) => i.id === 'claude-code')!;
    expect(claude.disabled).toBe(true);
    expect(claude.detail).toMatch(/not installed|PATH/);

    const { state, effects } = choose(opened, 'claude-code');
    expect(effects).toEqual([]);
    expect(at(state).step).toBe('Harness');
    expect(lastMessage(state)?.role).toBe('error');
  });

  const saved = (provider: string, modelId: string, effort: string, notice: string) =>
    ({ type: 'setPlannerChoice', provider, modelId, effort, notice });

  /** Harness › Model › Effort, each confirmed with enter. */
  it('saves harness, model and effort as each is entered, moving on after each', () => {
    let out = choose(run('/planner', ready).state, 'claude-code');
    // The harness saves with the model and effort it would open on, so the planner is never half-switched.
    expect(out.effects).toEqual([saved('claude-code', 'opus', '', 'Planner: Claude Code · Claude Opus 5.5')]);
    expect(at(out.state).step).toBe('Model');

    out = choose(out.state, 'opus');
    expect(out.effects).toEqual([]);
    expect(at(out.state).step).toBe('Effort');
    expect(stepperOf(out.state).items.map((i) => i.label)).toEqual(['Runner default', 'Low', 'High']);

    const done = choose(out.state, 'high');
    expect(done.state.overlay).toBeNull();
    expect(done.effects).toEqual([saved('claude-code', 'opus', 'high', 'Planner: Claude Code · Claude Opus 5.5 · High effort')]);
  });

  it('names an effort whose catalog label already says "effort" once', () => {
    const catalog = [{ ...models[0], variants: [{ id: 'low', label: 'Low effort' }] }];
    const out = choose(choose(choose(run('/planner', { ...ready, models: catalog }).state, 'claude-code').state, 'opus').state, 'low');
    expect(out.effects).toEqual([saved('claude-code', 'opus', 'low', 'Planner: Claude Code · Claude Opus 5.5 · Low effort')]);
  });

  it('saves nothing and prints nothing for a step entered unchanged', () => {
    const opened = run('/planner', ready).state;
    const { state, effects } = choose(opened, 'codex');
    expect(effects).toEqual([]);
    expect(messagesOf(state)).toEqual(messagesOf(opened));
    expect(at(state)).toEqual({ step: 'Model', on: 'gpt' });
  });

  it('shows a saved harness as the current one on going back to it', () => {
    const state = press(choose(run('/planner', ready).state, 'claude-code').state, 'left').state;
    expect(at(state)).toEqual({ step: 'Harness', on: 'claude-code' });
    expect(stepperOf(state).items.find((i) => i.selected)?.id).toBe('claude-code');
  });

  it("keeps the saved choice marked when the daemon's answer lands", () => {
    const state = choose(run('/planner', ready).state, 'claude-code').state;
    const echoed = reduce(state, {
      type: 'settingsLoaded',
      settings: { aiProvider: 'claude-code', orchestratorModel: 'opus', plannerThinkingEffort: '', plannerModels: { 'claude-code': { model: 'opus' } } },
    }).state;
    expect(at(echoed)).toEqual({ step: 'Model', on: 'opus' });
    expect(stepperOf(echoed).items.find((i) => i.selected)?.id).toBe('opus');
  });

  it('skips the effort step for a model without variants', () => {
    let state = run('/planner', ready).state;
    state = choose(state, 'claude-code').state;
    expect(stepperOf(state).trail.map((t) => t.label)).toEqual(['Harness', 'Model', 'Effort']);

    const done = choose(state, 'haiku');
    expect(done.state.overlay).toBeNull();
    expect(done.effects).toEqual([saved('claude-code', 'haiku', '', 'Planner: Claude Code · Claude Haiku 5.5')]);
  });

  it('asks only harness and model for a vendor backend, from the vendor catalog', () => {
    const harness = choose(run('/planner', ready).state, 'openrouter');
    expect(harness.effects).toEqual([saved('openrouter', 'deepseek/v4', '', 'Planner: OpenRouter · DeepSeek V4')]);
    const state = harness.state;
    expect(stepperOf(state).trail.map((t) => t.label)).toEqual(['Harness', 'Model']);
    expect(stepperOf(state).items.map((i) => i.id)).toEqual(['deepseek/v4', 'qwen/max']);

    expect(choose(state, 'qwen/max').effects).toEqual([saved('openrouter', 'qwen/max', '', 'Planner: OpenRouter · Qwen Max')]);
  });

  it("lists the chosen harness's models, not the current planner's", () => {
    let state = run('/planner', ready).state;
    state = choose(state, 'claude-code').state;
    expect(stepperOf(state).items.map((i) => i.id)).toEqual(['opus', 'haiku']);

    // Back to the harness step and onto another one: the model step is rebuilt for it.
    state = press(state, 'shift-tab').state;
    state = choose(state, 'codex').state;
    expect(stepperOf(state).items.map((i) => i.id)).toEqual(['gpt']);
    expect(at(state).on).toBe('gpt');
  });

  it('pre-selects the model remembered for the chosen backend', () => {
    let state = run('/planner', { ...ready, plannerModels: { 'claude-code': { model: 'haiku' } } }).state;
    state = choose(state, 'claude-code').state;
    expect(at(state)).toEqual({ step: 'Model', on: 'haiku' });
  });

  it('pre-selects the current model when the backend is unchanged, and the first model otherwise', () => {
    const current = choose(run('/planner', { ...ready, plannerProvider: 'claude-code', orchestratorModel: 'haiku' }).state, 'claude-code').state;
    expect(at(current).on).toBe('haiku');

    const fresh = choose(run('/planner', ready).state, 'claude-code').state;
    expect(at(fresh).on).toBe('opus');
  });

  it('pre-selects the remembered effort while that model still declares it, else the runner default', () => {
    const remembered = { ...ready, plannerModels: { 'claude-code': { model: 'opus', effort: 'low' } } };
    let state = choose(run('/planner', remembered).state, 'claude-code').state;
    state = choose(state, 'opus').state;
    expect(at(state)).toEqual({ step: 'Effort', on: 'low' });

    const stale = { ...ready, plannerModels: { 'claude-code': { model: 'opus', effort: 'max' } } };
    state = choose(choose(run('/planner', stale).state, 'claude-code').state, 'opus').state;
    expect(stepperOf(state).items[stepperOf(state).index].label).toBe('Runner default');
  });

  it('pre-selects the current effort when the backend and model are unchanged', () => {
    const current = { ...ready, plannerProvider: 'claude-code', orchestratorModel: 'opus', plannerEffort: 'high' };
    const state = choose(choose(run('/planner', current).state, 'claude-code').state, 'opus').state;
    expect(at(state).on).toBe('high');
  });

  it('sends the runner default as an empty effort', () => {
    const current = { ...ready, plannerProvider: 'claude-code', orchestratorModel: 'opus', plannerEffort: 'high' };
    const state = press(run('/planner', current).state, 'tab').state;
    const { effects } = choose(press(state, 'tab').state, '__runner_default__');
    expect(effects).toEqual([saved('claude-code', 'opus', '', 'Planner: Claude Code · Claude Opus 5.5')]);
  });

  it('explains an empty catalog for the chosen harness, saving nothing until a model can go with it', () => {
    const { state, effects } = choose(run('/planner', { ...ready, models: [] }).state, 'claude-code');
    expect(effects).toEqual([]);
    expect(state.plannerProvider).toBe('codex');
    const row = stepperOf(state).items[0];
    expect(row.disabled).toBe(true);
    expect(row.label).toMatch(/No claude-code models discovered yet/);
    expect(row.detail).toContain('/refresh');
  });

  it('esc keeps what enter saved and changes nothing more, from any step', () => {
    const opened = run('/planner', ready).state;
    const first = press(opened, 'escape');
    expect(first.effects).toEqual([]);
    expect(first.state.overlay).toBeNull();
    expect(first.state.plannerProvider).toBe('codex');

    const state = press(choose(opened, 'claude-code').state, 'down').state;
    const closed = press(state, 'escape');
    expect(closed.effects).toEqual([]);
    expect(closed.state.overlay).toBeNull();
    expect(closed.state.plannerProvider).toBe('claude-code');
    expect(closed.state.orchestratorModel).toBe('opus');
  });

  it('fills in the preflight once runner discovery lands', () => {
    // The stepper can be opened before the daemon has answered; every agent
    // would otherwise be stuck showing as missing.
    const opened = run('/planner', { ...ready, runners: [] }).state;
    expect(stepperOf(opened).items.find((i) => i.id === 'codex')?.disabled).toBe(true);

    const { state } = reduce(opened, { type: 'runnersLoaded', runners: [{ id: 'codex', name: 'Codex', enabled: true }] });
    expect(stepperOf(state).items.find((i) => i.id === 'codex')?.disabled).toBe(false);
  });

  it('fills in the model step once the catalog lands', () => {
    const opened = choose(run('/planner', { ...ready, models: [] }).state, 'claude-code').state;
    const { state } = reduce(opened, { type: 'modelsLoaded', models });
    expect(stepperOf(state).items.map((i) => i.id)).toEqual(['opus', 'haiku']);
  });

  it('/planner <id> switches directly, leaving the model to the daemon', () => {
    const { state, effects } = run('/planner opencode', installedAll);
    expect(effects).toEqual([{ type: 'setPlanner', provider: 'opencode' }]);
    expect(state.overlay).toBeNull();
  });

  it('rejects a provider it does not know', () => {
    const { state, effects } = run('/planner notaplanner');
    expect(effects).toEqual([]);
    expect(lastMessage(state)?.role).toBe('error');
  });

  it('tracks the planner the daemon reports', () => {
    const { state } = reduce(initialState(), { type: 'settingsLoaded', settings: { aiProvider: 'codex' } });
    expect(state.plannerProvider).toBe('codex');
  });

  it('tracks the per-backend model memory the daemon reports', () => {
    const plannerModels = { codex: { model: 'gpt', effort: 'xhigh' } };
    const { state } = reduce(initialState(), { type: 'settingsLoaded', settings: { plannerModels } });
    expect(state.plannerModels).toEqual(plannerModels);
  });
});

describe('/model follows the planner backend', () => {
  const models = [
    { id: 'sonnet', label: 'Sonnet', provider: 'anthropic', runners: ['claude-code'], variants: [{ id: 'high', label: 'High' }] },
    { id: 'gpt-5.6-sol', label: 'GPT-5.6-Sol', provider: 'openai', runners: ['codex'] },
  ];

  it('offers a harness planner only that agent\'s own models', () => {
    const { state } = run('/model', {
      plannerProvider: 'claude-code',
      models,
      orchestratorModels: [{ id: 'deepseek/deepseek-v4-flash', label: 'V4 Flash', provider: 'openrouter' }],
    });

    expect(items(state).map((i) => i.id)).toEqual(['sonnet']);
  });

  it('shows the model provider so same-runner models from different providers stay distinguishable', () => {
    const { state } = run('/model', {
      plannerProvider: 'opencode',
      models: [
        { id: 'opencode/claude-sonnet-4-6', label: 'Claude Sonnet 4.6', provider: 'opencode', runners: ['opencode'] },
        { id: 'opencode-go/deepseek-v4-flash', label: 'DeepSeek V4 Flash', provider: 'opencode-go', runners: ['opencode'] },
      ],
    });

    expect(items(state).find((i) => i.id === 'opencode/claude-sonnet-4-6')?.detail).toContain('opencode');
    expect(items(state).find((i) => i.id === 'opencode-go/deepseek-v4-flash')?.detail).toContain('opencode-go');
  });

  it('offers a vendor planner the cross-provider catalog', () => {
    const { state } = run('/model', {
      plannerProvider: 'openrouter',
      models,
      orchestratorModels: [{ id: 'deepseek/deepseek-v4-flash', label: 'V4 Flash', provider: 'openrouter' }],
    });

    expect(items(state).map((i) => i.id)).toEqual(['deepseek/deepseek-v4-flash']);
  });

  it('explains an empty agent catalog instead of showing a blank list', () => {
    const { state } = run('/model', { plannerProvider: 'codex', models: [] });
    const row = items(state)[0];
    expect(row.disabled).toBe(true);
    expect(row.detail).toContain('/refresh');
  });
});

/**
 * `/planner-effort` (ADR-0009, story 8): the planning agent's thinking effort,
 * traded against latency and subscription tokens. The levels are the selected
 * model's own variants — never a fixed low/medium/high the agent may not have.
 */
describe('/planner-effort', () => {
  const models = [
    { id: 'sonnet', label: 'Sonnet', provider: 'anthropic', runners: ['claude-code'], variants: [{ id: 'low', label: 'Low' }, { id: 'high', label: 'High' }] },
    { id: 'haiku', label: 'Haiku', provider: 'anthropic', runners: ['claude-code'], variants: [] },
  ];
  const harness: Partial<TuiState> = { plannerProvider: 'claude-code', orchestratorModel: 'sonnet', models };

  it("lists the selected model's variants plus the runner default", () => {
    const { state } = run('/planner-effort', harness);
    expect(state.overlay).toMatchObject({ kind: 'picker', picker: { action: { kind: 'set-planner-effort' } } });
    expect(items(state).map((i) => i.label)).toEqual(['Runner default', 'Low', 'High']);
  });

  it('marks the current effort as selected, and the default when none is set', () => {
    expect(items(run('/planner-effort', harness).state)[0].selected).toBe(true);
    const withEffort = run('/planner-effort', { ...harness, plannerEffort: 'high' }).state;
    expect(items(withEffort).find((i) => i.id === 'high')?.selected).toBe(true);
    expect(items(withEffort)[0].selected).toBe(false);
  });

  it('persists the chosen level', () => {
    const { effects, state } = pick(run('/planner-effort', harness).state, 'high');
    expect(effects).toEqual([{ type: 'setPlannerEffort', effort: 'high' }]);
    expect(state.overlay).toBeNull();
  });

  it('sends an empty effort for the runner default rather than a fake level', () => {
    const opened = run('/planner-effort', { ...harness, plannerEffort: 'high' }).state;
    expect(pick(opened, items(opened)[0].id).effects).toEqual([{ type: 'setPlannerEffort', effort: '' }]);
  });

  it('/planner-effort <level> sets it without opening the picker', () => {
    const { state, effects } = run('/planner-effort low', harness);
    expect(effects).toEqual([{ type: 'setPlannerEffort', effort: 'low' }]);
    expect(state.overlay).toBeNull();
  });

  it('rejects a level the model does not declare, naming the ones it does', () => {
    const { state, effects } = run('/planner-effort xhigh', harness);
    expect(effects).toEqual([]);
    expect(lastMessage(state)?.role).toBe('error');
    expect(lastMessage(state)?.text).toContain('low, high');
  });

  it('says so when the selected model exposes no effort levels', () => {
    const { state } = run('/planner-effort', { ...harness, orchestratorModel: 'haiku' });
    expect(items(state)[0].disabled).toBe(true);
    expect(items(state)[0].label).toMatch(/no effort levels/i);
  });

  it('explains that a vendor planner has no separate effort axis', () => {
    const { state } = run('/planner-effort', { plannerProvider: 'openrouter', models });
    expect(items(state)[0].disabled).toBe(true);
    expect(items(state)[0].detail).toContain('/planner');
  });

  it('tracks the effort the daemon reports', () => {
    const { state } = reduce(initialState(), { type: 'settingsLoaded', settings: { plannerThinkingEffort: 'high' } });
    expect(state.plannerEffort).toBe('high');
  });
});

describe('streamed planner text', () => {
  const send = (state: TuiState, action: Action) => reduce(state, action).state;
  const hear = (message: SessionMessage, sessionId = 's1'): Action => ({ type: 'sessionMessage', message, sessionId });
  const delta = (text: string): SessionMessage => ({ type: 'planner_text_delta', turnId: 'turn-1', segmentId: 'seg-1', text });
  const s1 = { ...initialState(), sessionId: 's1' };

  it('grows one streaming planner block as deltas arrive', () => {
    const state = [delta('Look'), delta('ing into it')].map((m) => hear(m)).reduce(send, s1);
    expect(messagesOf(state)).toMatchObject([{ role: 'planner', text: 'Looking into it', streaming: true }]);
  });

  it('settles that block in place when the turn\'s reply arrives', () => {
    const streamed = send(s1, hear(delta('Looking into it')));
    const state = send(streamed, hear({ type: 'planner_message', content: 'Looking into it.', timestamp: '', turnId: 'turn-1' }));

    expect(messagesOf(state)).toMatchObject([{ role: 'planner', text: 'Looking into it.', streaming: false }]);
  });

  it('ignores a delta from a session that /new has replaced', () => {
    const { state } = reduce({ ...s1, sessionId: 's2' }, hear(delta('stray'), 's1'));
    expect(messagesOf(state)).toHaveLength(0);
  });
});
