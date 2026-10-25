import React from 'react';
import { contextMeterText, contextMeterTitle, costText, modelCostTitle, subagentCostTitle } from '@ordewell/core/plan-utils';
import type { UsageBlock } from '@ordewell/core';

/*
 * The planner's usage line (#53): the main model's context and the cost its
 * runner reported, pinned below the conversation. "Planner" is this footer's
 * own word — a task's footer draws the same meter without it — so it is added
 * here rather than to core's meter. Core words both, so the
 * surfaces agree; token counts stay in the ledger and are not drawn. The hovers
 * are the second question: exact counts, and which model cost what.
 */

export default function UsageLine({ block }: { block: UsageBlock }) {
  const meter = contextMeterText(block.contextFill);
  const cost = costText(block.totals);
  const agents = Object.entries(block.bySubagent ?? {});
  if (!meter && !cost && agents.length === 0) return null;

  return (
    <div className="usage-line" role="status">
      {(meter || cost) && (
        <span className="usage-line-measures">
          {meter && block.contextFill && <span className="usage-line-context" title={contextMeterTitle(block.contextFill)}>Planner {meter}</span>}
          {meter && cost && ' · '}
          {cost && <span className="usage-line-cost" title={block.byModel && modelCostTitle(block.byModel)}>{cost}</span>}
        </span>
      )}
      {agents.length > 0 && (
        <span className="usage-line-subagents" title={subagentCostTitle(block.bySubagent ?? {})}>
          {agents.length} subagent{agents.length === 1 ? '' : 's'}
        </span>
      )}
    </div>
  );
}
