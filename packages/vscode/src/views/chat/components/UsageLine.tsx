import React from 'react';
import type { UsageBlock, UsageTotals } from '@ordewell/core';

/*
 * The token line (#53): a session-wide status pinned below the conversation.
 * Totals include every subagent (core's contract); the per-agent shares are
 * the hover, because they are the second question after "how much so far".
 */

export function formatCount(n: number): string {
  return n.toLocaleString('en-US');
}

/** Four decimals at most, two at least: a session can cost a fraction of a cent or several dollars. */
export function formatAmount(amount: number): string {
  const [whole, frac = ''] = amount.toFixed(4).replace(/0+$/, '').split('.');
  return `${whole}.${frac.padEnd(2, '0')}`;
}

export function formatCost(currency: string, amount: number): string {
  const value = formatAmount(amount);
  return currency.toLowerCase() === 'usd' ? `$${value}` : `${value} ${currency.toUpperCase()}`;
}

export function measures(totals: UsageTotals, unknown = false): string[] {
  const parts: string[] = [];
  if (totals.inputTokens !== undefined) parts.push(`${formatCount(totals.inputTokens)} in`);
  else if (unknown) parts.push('unknown in');
  if (totals.outputTokens !== undefined) parts.push(`${formatCount(totals.outputTokens)} out`);
  else if (unknown) parts.push('unknown out');
  if (totals.cachedInputTokens !== undefined) parts.push(`${formatCount(totals.cachedInputTokens)} cached`);
  for (const [currency, amount] of Object.entries(totals.reportedCost ?? {})) parts.push(formatCost(currency, amount));
  if (unknown && !Object.keys(totals.reportedCost ?? {}).length) parts.push('cost unknown');
  return parts;
}

export default function UsageLine({ block }: { block: UsageBlock }) {
  const models = block.byModel?.map((m) => `${m.source} / ${m.model ?? 'model unknown'}: ${measures(m.totals, true).join(' · ')}`).join('\n');
  const agents = Object.entries(block.bySubagent ?? {});
  const agentTitle = agents
    .map(([id, totals]) => `${id}: ${measures(totals).join(' · ') || 'no usage reported'}`)
    .join('\n');

  return (
    <div className="usage-line" role="status">
      <span className="usage-line-tokens" title={models}>{measures(block.totals).join(' · ')}</span>
      {block.model && !block.contextFill && <span className="usage-line-context">context unknown</span>}
      {block.contextFill && (
        <span
          className="usage-line-context"
          title={`${formatCount(block.contextFill.usedTokens)} / ${formatCount(block.contextFill.windowTokens)} tokens`}
        >
          context {Math.round((block.contextFill.usedTokens / block.contextFill.windowTokens) * 100)}%
        </span>
      )}
      {agents.length > 0 && (
        <span className="usage-line-subagents" title={agentTitle}>
          {agents.length} subagent{agents.length === 1 ? '' : 's'}
        </span>
      )}
    </div>
  );
}
