import type { PlannerModelMemory, PlannerModelCandidate, PlannerModelRecall, PlannerBackendId, DiscoveredModel } from '@ordewell/core';

export interface VendorModelOption {
  id: string;
}

/**
 * What model and effort a switch to `provider` should land on. A harness
 * planner's catalog is that runner's own discovered models; a vendor's is the
 * API picker list (ADR-0009) — only one of the two ever applies for a given
 * provider.
 */
export function recallPlannerModel(
  memory: PlannerModelMemory,
  provider: PlannerBackendId,
  harnessModels: DiscoveredModel[] | undefined,
  vendorOptions: VendorModelOption[] | undefined,
): PlannerModelRecall {
  return memory.recall(provider, plannerCatalog(harnessModels, vendorOptions));
}

/** The DiscoveredModel/picker shapes normalized to what core judges a planner pick against. */
function plannerCatalog(
  harnessModels: DiscoveredModel[] | undefined,
  vendorOptions: VendorModelOption[] | undefined,
): PlannerModelCandidate[] {
  return harnessModels
    ? harnessModels.map((m) => ({ id: m.modelId, variants: m.variants }))
    : (vendorOptions ?? []).map((o) => ({ id: o.id }));
}
