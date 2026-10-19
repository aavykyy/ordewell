import { describe, it, expect } from 'vitest';
import { addUsageTotals, addUsage, partedPromptUsage, type UsageTotals } from '../Usage';

describe('addUsage', () => {
  it('keeps cost provenance per currency through roll-ups, with any estimate marking the sum', () => {
    const estimate = addUsage({}, { source: 'claude-code', sessionBilling: { type: 'subscription', plan: 'max' }, reportedCost: { amount: 1, currency: 'USD', kind: 'estimate', basis: 'list' } });
    const billed = addUsage({}, { source: 'openrouter', reportedCost: { amount: 2, currency: 'USD', kind: 'billed' } });
    const totals = addUsageTotals(estimate, billed);
    expect(totals.reportedCost).toEqual({ USD: 3 });
    expect(totals.costProvenance).toEqual({ USD: { kind: 'estimate', billing: 'mixed' } });
    expect(estimate.costProvenance).toEqual({ USD: { kind: 'estimate', billing: 'subscription', basis: 'list' } });
  });

  it('sums the tokens of two calls', () => {
    const once = addUsage({}, { source: 'openai', inputTokens: 1200, outputTokens: 300, cachedInputTokens: 800 });
    const twice = addUsage(once, { source: 'openai', inputTokens: 50, outputTokens: 7, cachedInputTokens: 0 });

    expect(twice).toEqual({ inputTokens: 1250, outputTokens: 307, cachedInputTokens: 800 });
  });

  it('leaves a measure no call reported absent rather than zero', () => {
    const totals = addUsage(addUsage({}, { source: 'codex', outputTokens: 40 }), { source: 'codex', outputTokens: 2 });

    expect(totals).toEqual({ outputTokens: 42 });
    expect('inputTokens' in totals).toBe(false);
    expect('reportedCost' in totals).toBe(false);
  });

  it('sums reported cost per currency, never across currencies', () => {
    let totals: UsageTotals = {};
    totals = addUsage(totals, { source: 'claude-code', reportedCost: { amount: 0.25, currency: 'USD' } });
    totals = addUsage(totals, { source: 'openrouter', reportedCost: { amount: 0.5, currency: 'USD' } });
    totals = addUsage(totals, { source: 'other', reportedCost: { amount: 3, currency: 'EUR' } });

    expect(totals.reportedCost).toEqual({ USD: 0.75, EUR: 3 });
  });

  it('returns new totals and leaves the ones it was given alone', () => {
    const before: UsageTotals = { inputTokens: 10, reportedCost: { USD: 1 } };
    addUsage(before, { source: 'openai', inputTokens: 5, reportedCost: { amount: 1, currency: 'USD' } });

    expect(before).toEqual({ inputTokens: 10, reportedCost: { USD: 1 } });
  });
});

describe('partedPromptUsage', () => {
  it('counts the uncached tail, cache reads and cache writes as one prompt, only the reads as cached', () => {
    expect(partedPromptUsage({ uncached: 2, cacheRead: 9428, cacheWrite: 9174 })).toEqual({ inputTokens: 18604, cachedInputTokens: 9428 });
  });

  it('claims no cached share when cache reads went unreported', () => {
    expect(partedPromptUsage({ uncached: 120, cacheWrite: 30 })).toEqual({ inputTokens: 150 });
  });

  it('reports no prompt at all when no part of it was reported', () => {
    expect(partedPromptUsage({})).toEqual({});
  });
});
