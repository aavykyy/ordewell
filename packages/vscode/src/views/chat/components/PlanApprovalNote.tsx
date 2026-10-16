import React from 'react';
import type { GlobalRunSettings } from '@ordewell/core';

/** The user's autonomy level and run settings (ADR-0030), as the host sends them. */
export interface HostRunSettings {
  autonomous: boolean;
  run: GlobalRunSettings;
}

/**
 * What the first screen promises about starting a plan. Autorun is the user's
 * setting, not a constant, so the note says nothing until the host has sent it:
 * a promise made before then could be false.
 */
export default function PlanApprovalNote({ runSettings }: { runSettings?: HostRunSettings | null }) {
  if (!runSettings) return null;
  return runSettings.run.autorun
    ? <p className="warn">Autorun is on — a plan starts as soon as the planner submits it. Change it in /autorun.</p>
    : <p>Nothing runs until you approve the plan.</p>;
}
