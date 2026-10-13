import { recallPlannerChoice } from './selectPlanner';

/** What the user last picked for one planner backend. */
export interface PlannerModelChoice {
  model: string;
  effort?: string;
}

/**
 * A candidate model as this planner's catalog lists it. Deliberately plain
 * data: a harness planner's catalog is its runner's own model list and a
 * vendor's is a picker list (ADR-0009), and the rule below is the same for
 * both — so the caller normalizes, and this module never reaches for a
 * ModelResolver, a config or the network.
 */
export interface PlannerModelCandidate {
  id: string;
  variants?: { id: string }[];
}

export interface PlannerModelRecall {
  model: string;
  effort: string;
  source: 'remembered' | 'catalog-default' | 'none';
}

/** The slice of `SettingsService` this needs, so tests can pass a plain object. */
export interface PlannerModelStore {
  getPlannerModel(provider: string): PlannerModelChoice | undefined;
  setPlannerModel(provider: string, entry: PlannerModelChoice | undefined): void;
}

/**
 * Remembers, per planner backend, the model the user last chose for it.
 *
 * Switching the planner has to clear the model — an id is scoped to the agent
 * that listed it, so an OpenRouter slug handed to Claude Code points it at
 * something it cannot spawn. That clear is correct and stays; what was missing
 * is that switching *back* then forced a re-pick of a model the user had
 * already chosen. The rule itself is `selectPlanner`'s; this is the storage
 * the surfaces that keep their memory in the settings file hand it.
 */
export class PlannerModelMemory {
  constructor(private store: PlannerModelStore) {}

  /** Record what the user picked for `provider`; a blank model forgets it instead. */
  remember(provider: string, model: string, effort?: string): void {
    const id = model.trim();
    // "No model" is a real state the surfaces reach (a clear, a cold catalog);
    // storing it as an entry would later restore an id that spawns nothing.
    if (!id) {
      this.store.setPlannerModel(provider, undefined);
      return;
    }
    const level = effort?.trim();
    this.store.setPlannerModel(provider, level ? { model: id, effort: level } : { model: id });
  }

  getPlannerModel(provider: string): PlannerModelChoice | undefined {
    return this.store.getPlannerModel(provider);
  }

  /**
   * What the model and effort should become when `provider` takes over the
   * planner, given the models it actually serves. The `source` is what the
   * three surfaces word their notice from — restored, defaulted, or nothing.
   */
  recall(provider: string, catalog: PlannerModelCandidate[]): PlannerModelRecall {
    return recallPlannerChoice(this.store.getPlannerModel(provider), catalog);
  }
}
