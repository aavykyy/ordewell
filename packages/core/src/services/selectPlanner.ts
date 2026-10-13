import type { AiProvider } from '../interfaces/IConfig';
import type { PlannerModelCandidate, PlannerModelChoice, PlannerModelRecall, PlannerModelStore } from './PlannerModelMemory';

/** Who plans, with which model and effort. Blank means unset. */
export interface PlannerSelectionState {
  provider: AiProvider;
  model: string;
  effort: string;
}

/** What one user action asked for; an absent field leaves that part alone. */
export interface PlannerSelectionChange {
  provider?: AiProvider;
  model?: string;
  effort?: string;
}

export interface PlannerSelectionResult {
  next: PlannerSelectionState;
  /** A pick the user made, to store for its provider; a blank model forgets it. */
  remember?: PlannerSelectionState;
  /** Present when a switch filled in the model itself, for the surface to word. */
  recall?: PlannerModelRecall;
}

export type PlannerModelLookup = Pick<PlannerModelStore, 'getPlannerModel'>;

/**
 * What the model and effort become when `provider`'s planner takes over with
 * nothing picked, given what it remembers and the models it actually serves.
 */
export function recallPlannerChoice(remembered: PlannerModelChoice | undefined, catalog: PlannerModelCandidate[]): PlannerModelRecall {
  const match = remembered && catalog.find((c) => c.id === remembered.model);
  if (remembered && match) {
    // An effort is a variant of a *specific* model, so a level the restored
    // model does not declare is stale — dropped rather than passed on to an
    // agent that never offered it.
    const level = remembered.effort ?? '';
    const survives = (match.variants ?? []).some((v) => v.id === level);
    return { model: match.id, effort: survives ? level : '', source: 'remembered' };
  }
  // A planner switch should land on something runnable, so an unusable memory
  // falls to the head of the catalog. An *empty* catalog means discovery is
  // cold or the agent serves nothing, and an invented id would only fail
  // later, at spawn.
  const first = catalog[0];
  if (first) return { model: first.id, effort: '', source: 'catalog-default' };
  return { model: '', effort: '', source: 'none' };
}

/**
 * Only a catalog that lists the model with its variants can refuse a level: a
 * cold catalog, an id typed by hand or a vendor model (which declares none)
 * leaves the user's word standing rather than wiping it on a guess.
 */
function offers(catalog: PlannerModelCandidate[], model: string, effort: string): boolean {
  const variants = catalog.find((c) => c.id === model)?.variants;
  return !variants || variants.some((v) => v.id === effort);
}

/**
 * The one rule for changing who plans (ADR-0009): every surface hands its
 * current state, the change, its memory and the catalog of the provider in
 * effect after the change, and writes back what this returns. It never
 * stores anything itself, so each surface keeps only its storage adapter.
 */
export function selectPlanner(
  current: PlannerSelectionState,
  change: PlannerSelectionChange,
  memory: PlannerModelLookup,
  catalog: PlannerModelCandidate[],
): PlannerSelectionResult {
  const provider = change.provider ?? current.provider;
  const switched = provider !== current.provider;
  const model = change.model?.trim();

  // A model id is scoped to the agent that listed it, so a switch never keeps
  // the old one. With no model of its own the switch restores this backend's
  // last pick — and a blank one sent alongside is the legacy clients' clear,
  // not a pick.
  if (switched && !model) {
    const recall = recallPlannerChoice(memory.getPlannerModel(provider), catalog);
    return { next: { provider, model: recall.model, effort: recall.effort }, recall };
  }
  if (!switched && model === undefined && change.effort === undefined) {
    return { next: current };
  }

  const nextModel = model ?? current.model;
  const asked = change.effort?.trim();
  // An inherited effort belongs to the model it was picked for: it survives a
  // new model only within the same backend, and only where that model offers it.
  const inherited = switched || !nextModel ? '' : current.effort;
  const wanted = nextModel ? asked ?? inherited : '';
  const effort = wanted && offers(catalog, nextModel, wanted) ? wanted : '';
  const next = { provider, model: nextModel, effort };
  return { next, remember: next };
}
