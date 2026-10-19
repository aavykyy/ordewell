import { describe, it, expect } from 'vitest';
import { PlannerUsageLedger } from '../PlannerUsage';
import { ContextWindowFill, SessionWindows } from '../ContextWindowFill';

describe('PlannerUsageLedger', () => {
  it('saves and broadcasts billing facts without a cost, preserving the measured model context', () => {
    const ledger = new PlannerUsageLedger();
    ledger.record({ source: 'codex', model: 'gpt', inputTokens: 9000, contextWindow: 258400 });
    ledger.record({ source: 'codex', aggregate: true, sessionBilling: { type: 'subscription', plan: 'plus' } });
    const reopened = new PlannerUsageLedger();
    reopened.restore(JSON.parse(JSON.stringify(ledger.snapshot())));
    expect(reopened.message()).toMatchObject({ sessionBilling: { type: 'subscription', plan: 'plus' }, contextFill: { usedTokens: 9000, windowTokens: 258400 } });
    expect(reopened.snapshot().byModel).toEqual([{ source: 'codex', model: 'gpt', totals: { inputTokens: 9000 } }]);
    expect(reopened.snapshot().totals.reportedCost).toBeUndefined();
  });

  it('sums the planner\'s calls and its subagents\' into one line, each subagent\'s share shown apart', () => {
    const ledger = new PlannerUsageLedger();
    ledger.record({ source: 'claude-code', inputTokens: 1000, outputTokens: 100, contextWindow: 200000 });
    ledger.record({ source: 'claude-code', inputTokens: 400, outputTokens: 40, subagentId: 'sa1' });

    expect(ledger.message('t1')).toEqual({
      type: 'planner_usage',
      turnId: 't1',
      totals: { inputTokens: 1400, outputTokens: 140 },
      bySubagent: { sa1: { inputTokens: 400, outputTokens: 40 } },
      byModel: [{ source: 'claude-code', totals: { inputTokens: 1400, outputTokens: 140 } }],
      contextFill: { usedTokens: 1000, windowTokens: 200000 },
    });
  });

  it('measures the context by the planner\'s latest prompt, never a subagent\'s', () => {
    const ledger = new PlannerUsageLedger();
    ledger.record({ source: 'openai', inputTokens: 1000, contextWindow: 128000 });
    ledger.record({ source: 'openai', inputTokens: 3000 });
    ledger.record({ source: 'openai', inputTokens: 90000, subagentId: 'sa1' });

    expect(ledger.message().contextFill).toEqual({ usedTokens: 3000, windowTokens: 128000 });
  });

  it('measures a model whose backend reports no window against its catalog window, model by model', () => {
    const catalog: Record<string, number> = { 'opencode/a': 100000, 'opencode/b': 400000 };
    const ledger = new PlannerUsageLedger(new SessionWindows((source, model) => source === 'opencode' ? catalog[model] : undefined));
    ledger.record({ source: 'opencode', model: 'opencode/a', inputTokens: 1000 });
    expect(ledger.message().contextFill).toEqual({ usedTokens: 1000, windowTokens: 100000 });

    ledger.record({ source: 'opencode', model: 'opencode/b', inputTokens: 2000 });
    expect(ledger.message().contextFill).toEqual({ usedTokens: 2000, windowTokens: 400000 });

    ledger.record({ source: 'opencode', model: 'opencode/unlisted', inputTokens: 3000 });
    expect(ledger.message().contextFill).toEqual({ usedTokens: 3000 });
  });

  it('keeps a reported window over the catalog\'s, on the calls that report none', () => {
    const ledger = new PlannerUsageLedger(new SessionWindows(() => 100000));
    ledger.record({ source: 'claude-code', model: 'opus', inputTokens: 1000, contextWindow: 200000 });
    ledger.record({ source: 'claude-code', model: 'opus', inputTokens: 1500 });

    expect(ledger.message().contextFill).toEqual({ usedTokens: 1500, windowTokens: 200000 });
  });

  it('keeps a restored ledger\'s window over the catalog\'s while the model is the same', () => {
    const ledger = new PlannerUsageLedger(new SessionWindows(() => 100000));
    ledger.restore({ totals: { inputTokens: 600 }, source: 'claude-code', model: 'opus', lastPromptTokens: 600, contextWindow: 200000 });
    ledger.record({ source: 'claude-code', model: 'opus', inputTokens: 700 });

    expect(ledger.message().contextFill).toEqual({ usedTokens: 700, windowTokens: 200000 });
  });

  it('knows a window a task attempt was told for its model, from the planner\'s first call on it', () => {
    const windows = new SessionWindows(() => 100000);
    new ContextWindowFill(windows).fill({ source: 'claude-code', model: 'opus', contextWindow: 1_000_000 });
    const ledger = new PlannerUsageLedger(windows);
    ledger.record({ source: 'claude-code', model: 'opus', inputTokens: 60_000, outputTokens: 1000, contextTokens: 61_000 });

    expect(ledger.message().contextFill).toEqual({ usedTokens: 61_000, windowTokens: 1_000_000 });
  });

  it('follows the planner\'s model only: a switch clears the meter, a subagent or a breakdown leaves it', () => {
    const windows = new SessionWindows();
    windows.report('claude-code', 'haiku', 200_000);
    const ledger = new PlannerUsageLedger(windows);
    ledger.record({ source: 'claude-code', model: 'opus', inputTokens: 5000, contextWindow: 1_000_000 });
    ledger.record({ source: 'claude-code', model: 'haiku', inputTokens: 90_000, subagentId: 'sa1' });
    ledger.record({ source: 'claude-code', model: 'haiku', aggregate: true, reportedCost: { amount: 1, currency: 'USD' } });
    expect(ledger.message().contextFill).toEqual({ usedTokens: 5000, windowTokens: 1_000_000 });

    ledger.record({ source: 'claude-code', model: 'haiku', contextWindow: 200_000 });
    expect(ledger.message().contextFill).toBeUndefined();
    ledger.record({ source: 'claude-code', model: 'haiku', inputTokens: 7000 });
    expect(ledger.message().contextFill).toEqual({ usedTokens: 7000, windowTokens: 200_000 });
  });

  it('shows the size a compaction left, or none until the next call', () => {
    const ledger = new PlannerUsageLedger();
    ledger.record({ source: 'claude-code', model: 'opus', inputTokens: 150_000, contextTokens: 152_000, contextWindow: 200_000 });
    ledger.record({ source: 'claude-code', compacted: true, contextTokens: 9000 });
    expect(ledger.message().contextFill).toEqual({ usedTokens: 9000, windowTokens: 200_000 });

    ledger.record({ source: 'claude-code', compacted: true });
    expect(ledger.message().contextFill).toBeUndefined();
    expect(ledger.message().totals).toEqual({ inputTokens: 150_000 });
  });

  it('carries no turn id outside a turn, and the used tokens without a window while it is unknown', () => {
    const ledger = new PlannerUsageLedger();
    ledger.record({ source: 'openai', inputTokens: 10 });

    expect(ledger.message()).toEqual({ type: 'planner_usage', totals: { inputTokens: 10 }, contextFill: { usedTokens: 10 }, byModel: [{ source: 'openai', totals: { inputTokens: 10 } }] });
  });

  it('has usage only once something was measured — a bare window or an empty ledger says nothing', () => {
    const ledger = new PlannerUsageLedger();
    expect(ledger.hasUsage).toBe(false);

    ledger.record({ source: 'claude-code', contextWindow: 200000 });
    expect(ledger.hasUsage).toBe(false);

    ledger.record({ source: 'claude-code', reportedCost: { amount: 0.01, currency: 'USD' } });
    expect(ledger.hasUsage).toBe(true);
  });

  it('adopts a saved ledger and carries on from it', () => {
    const ledger = new PlannerUsageLedger();
    ledger.restore({ totals: { inputTokens: 1500 }, bySubagent: { sa1: { inputTokens: 900 } }, lastPromptTokens: 600, contextWindow: 200000 });
    ledger.record({ source: 'claude-code', inputTokens: 700 });

    expect(ledger.snapshot()).toEqual({
      totals: { inputTokens: 2200 },
      bySubagent: { sa1: { inputTokens: 900 } },
      lastPromptTokens: 700,
      source: 'claude-code',
      model: undefined,
      byModel: [{ source: 'claude-code', totals: { inputTokens: 700 } }],
    });
  });

  it('starts from zero when there is nothing saved to adopt, or when cleared', () => {
    const ledger = new PlannerUsageLedger();
    ledger.record({ source: 'openai', inputTokens: 10 });
    ledger.restore(undefined);
    expect(ledger.snapshot()).toEqual({ totals: {} });

    ledger.record({ source: 'openai', inputTokens: 10 });
    ledger.clear();
    expect(ledger.snapshot()).toEqual({ totals: {} });
    expect(ledger.hasUsage).toBe(false);
  });

  it('leaves a snapshot already handed out as it was when more usage arrives', () => {
    const ledger = new PlannerUsageLedger();
    ledger.record({ source: 'openai', inputTokens: 10, reportedCost: { amount: 1, currency: 'USD' } });
    const saved = ledger.snapshot();
    ledger.record({ source: 'openai', inputTokens: 5, reportedCost: { amount: 1, currency: 'USD' } });

    expect(saved).toEqual({ totals: { inputTokens: 10, reportedCost: { USD: 1 } }, lastPromptTokens: 10, source: 'openai', model: undefined, byModel: [{ source: 'openai', totals: { inputTokens: 10, reportedCost: { USD: 1 } } }] });
  });
});
