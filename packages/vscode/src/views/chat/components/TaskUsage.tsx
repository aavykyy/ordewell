import React from 'react';
import type { UsageTotals } from '@ordewell/core';
import { measures } from './UsageLine';

interface TaskSpend {
  totals: UsageTotals;
  contextFill?: { usedTokens: number; windowTokens: number };
}

/**
 * A task's spend as one line: only what a runner reported, no wall time and no
 * per-model split. The meter belongs to one task's current model, so a plan
 * total passes `meter: false` and shows none.
 */
export function taskUsageText(usage: TaskSpend, meter: boolean): string {
  return [
    ...measures(usage.totals),
    ...(meter ? [usage.contextFill ? `ctx ${Math.round(usage.contextFill.usedTokens / usage.contextFill.windowTokens * 100)}%` : 'ctx unknown'] : []),
  ].join(' · ');
}

export default function TaskUsage({ usage, meter = false }: { usage: TaskSpend; meter?: boolean }) {
  return <span className="task-usage">{taskUsageText(usage, meter)}</span>;
}
