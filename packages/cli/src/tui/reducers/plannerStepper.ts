import { ALL_PROVIDERS, type AiProvider } from '@ordewell/core';
import type { PickerItem, TuiState } from '../state';
import { DEFAULT_EFFORT, plannerEffortItems, plannerHarnessModel, plannerItems, plannerModelItems } from './pickers';
import { step } from './shared';
import type { StepChoices, StepperDefinition } from './stepper';

const offered = (items: PickerItem[]): Set<string> => new Set(items.filter((i) => !i.disabled).map((i) => i.id));

/**
 * The model a backend would open on: what the user last picked for it, else
 * the current model when it is the current backend — whichever its catalog
 * still lists. The stepper falls through to the catalog's first row.
 */
function preferredModel(state: TuiState, provider: string): string {
  const listed = offered(plannerModelItems(state, provider, ''));
  const current = provider === state.plannerProvider ? state.orchestratorModel : undefined;
  return [state.plannerModels[provider]?.model, current].find((id) => id && listed.has(id)) ?? '';
}

/** The same rule one level down: an effort only means something for the model it was picked with. */
function preferredEffort(state: TuiState, provider: string, modelId: string): string {
  const listed = offered(plannerEffortItems(state, provider, modelId, ''));
  const remembered = state.plannerModels[provider];
  const unchanged = provider === state.plannerProvider && modelId === state.orchestratorModel;
  const wanted = remembered?.model === modelId ? remembered.effort ?? '' : unchanged ? state.plannerEffort : '';
  return listed.has(wanted) ? wanted : '';
}

const hasEfforts = (state: TuiState, choices: StepChoices): boolean =>
  (plannerHarnessModel(state, choices.harness, choices.model)?.variants?.length ?? 0) > 0;

/**
 * `/planner` with no argument: harness, model and effort in one pass
 * (ADR-0009). Each step's rows come from the backend chosen before it, not
 * the one in effect, and nothing reaches the daemon until the last step —
 * so a cancel anywhere leaves the planner exactly as it was.
 */
export const plannerStepper: StepperDefinition = {
  title: 'Planner',
  hint: 'Who researches your goal and writes the plan. Coding agents use their own subscription — no API key.',
  steps: [
    {
      id: 'harness',
      label: 'Harness',
      items: (state) => plannerItems(state),
    },
    {
      id: 'model',
      label: 'Model',
      filterable: true,
      items: (state, choices) => plannerModelItems(state, choices.harness, preferredModel(state, choices.harness)),
    },
    {
      id: 'effort',
      label: 'Effort',
      skip: (state, choices) => !hasEfforts(state, choices),
      items: (state, choices) =>
        plannerEffortItems(state, choices.harness, choices.model, preferredEffort(state, choices.harness, choices.model)),
    },
  ],
  complete(state, choices) {
    const provider = choices.harness;
    const effort = choices.effort && choices.effort !== DEFAULT_EFFORT ? choices.effort : '';
    const model = plannerModelItems(state, provider, '').find((m) => m.id === choices.model);
    const level = plannerEffortItems(state, provider, choices.model, '').find((e) => e.id === effort);
    const parts = [
      ALL_PROVIDERS[provider as AiProvider]?.label ?? provider,
      model?.label ?? choices.model,
      ...(effort ? [`${level?.label ?? effort} effort`] : []),
    ];
    return step(state, [{
      type: 'setPlannerChoice',
      provider,
      modelId: choices.model,
      effort,
      notice: `Planner: ${parts.join(' · ')}`,
    }]);
  },
};
