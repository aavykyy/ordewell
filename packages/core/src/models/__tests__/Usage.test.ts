import { describe, it, expect } from 'vitest';
import { addAttemptUsage, addPlannerUsage, addUsage, partedPromptUsage, plannerContextFill, startAttemptUsage, type PlannerUsage, type UsageRecord, type UsageTotals } from '../Usage';

describe('addUsage', () => {
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

describe('the context meter', () => {
  const fold = (...records: UsageRecord[]): PlannerUsage => records.reduce(addPlannerUsage, { totals: {} } as PlannerUsage);

  it('counts the context a call states it leaves, over its prompt alone', () => {
    const usage = fold({ source: 'claude-code', model: 'opus', inputTokens: 20_000, outputTokens: 500, contextTokens: 20_500, contextWindow: 200_000 });
    expect(plannerContextFill(usage)).toEqual({ usedTokens: 20_500, windowTokens: 200_000 });
  });

  it('falls back to the prompt when a call states no context', () => {
    expect(plannerContextFill(fold({ source: 'openai', model: 'gpt', inputTokens: 1000, outputTokens: 50 }))).toEqual({ usedTokens: 1000 });
  });

  const beforeCompaction: UsageRecord = { source: 'claude-code', model: 'opus', inputTokens: 24_000, outputTokens: 939, contextTokens: 24_939, contextWindow: 200_000, reportedCost: { amount: 0.5, currency: 'USD' } };

  it('reads the size a compaction reports it left, and counts nothing more', () => {
    const before = fold(beforeCompaction);
    const after = addPlannerUsage(before, { source: 'claude-code', compacted: true, contextTokens: 3615 });
    expect(plannerContextFill(after)).toEqual({ usedTokens: 3615, windowTokens: 200_000 });
    expect(after.totals).toEqual(before.totals);
    expect(after.byModel).toEqual(before.byModel);
    expect(after.model).toBe('opus');
  });

  it('knows no size after a compaction that reports none, until the next call', () => {
    const after = fold(beforeCompaction, { source: 'claude-code', compacted: true });
    expect(plannerContextFill(after)).toBeUndefined();
    expect(plannerContextFill(addPlannerUsage(after, { source: 'claude-code', model: 'opus', inputTokens: 4000, outputTokens: 100, contextTokens: 4100 }))).toEqual({ usedTokens: 4100, windowTokens: 200_000 });
  });

  it('resets an attempt\'s meter on a compaction the same way', () => {
    const start = startAttemptUsage(1, 'claude-code', '2026-10-19T10:00:00.000Z');
    const before = addAttemptUsage(start, beforeCompaction, '2026-10-19T10:01:00.000Z');
    const after = addAttemptUsage(before, { source: 'claude-code', compacted: true }, '2026-10-19T10:02:00.000Z');
    expect(plannerContextFill(after)).toBeUndefined();
    expect(after.totals).toEqual(before.totals);
  });
});
