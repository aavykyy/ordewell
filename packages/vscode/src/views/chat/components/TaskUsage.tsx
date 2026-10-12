import React from 'react';
import type { TaskRowView, PlanUsage } from '@ordewell/core';
import { measures } from './UsageLine';

export default function TaskUsage({ usage }: { usage: TaskRowView['usage'] | PlanUsage }) {
  if (!usage) return null;
  const context = 'contextFill' in usage ? usage.contextFill : undefined;
  const detail = (usage.byModel ?? []).map((m) => `${m.source} / ${m.model ?? 'unattributed'}: ${measures(m.totals, true).join(' · ')}`).join('\n');
  return <span className="task-usage" title={detail}>
    {measures(usage.totals, true).join(' · ')}
    {'attempt' in usage && ` · ${context ? `context ${Math.round(context.usedTokens / context.windowTokens * 100)}%` : 'context unknown'}`}
    {usage.wallTimeMs !== undefined ? ` · ${Math.floor(usage.wallTimeMs / 1000)}s` : ' · time unknown'}
  </span>;
}
