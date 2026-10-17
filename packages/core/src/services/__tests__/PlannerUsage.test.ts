import { describe, it, expect } from 'vitest';
import { PlannerUsageLedger } from '../PlannerUsage';

describe('PlannerUsageLedger', () => {
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
    const ledger = new PlannerUsageLedger((source, model) => source === 'opencode' ? catalog[model] : undefined);
    ledger.record({ source: 'opencode', model: 'opencode/a', inputTokens: 1000 });
    expect(ledger.message().contextFill).toEqual({ usedTokens: 1000, windowTokens: 100000 });

    ledger.record({ source: 'opencode', model: 'opencode/b', inputTokens: 2000 });
    expect(ledger.message().contextFill).toEqual({ usedTokens: 2000, windowTokens: 400000 });

    ledger.record({ source: 'opencode', model: 'opencode/unlisted', inputTokens: 3000 });
    expect(ledger.message().contextFill).toBeUndefined();
  });

  it('keeps a reported window over the catalog\'s, on the calls that report none', () => {
    const ledger = new PlannerUsageLedger(() => 100000);
    ledger.record({ source: 'claude-code', model: 'opus', inputTokens: 1000, contextWindow: 200000 });
    ledger.record({ source: 'claude-code', model: 'opus', inputTokens: 1500 });

    expect(ledger.message().contextFill).toEqual({ usedTokens: 1500, windowTokens: 200000 });
  });

  it('keeps a restored ledger\'s window over the catalog\'s while the model is the same', () => {
    const ledger = new PlannerUsageLedger(() => 100000);
    ledger.restore({ totals: { inputTokens: 600 }, source: 'claude-code', model: 'opus', lastPromptTokens: 600, contextWindow: 200000 });
    ledger.record({ source: 'claude-code', model: 'opus', inputTokens: 700 });

    expect(ledger.message().contextFill).toEqual({ usedTokens: 700, windowTokens: 200000 });
  });

  it('carries no turn id outside a turn, and no context fill while the window is unknown', () => {
    const ledger = new PlannerUsageLedger();
    ledger.record({ source: 'openai', inputTokens: 10 });

    expect(ledger.message()).toEqual({ type: 'planner_usage', totals: { inputTokens: 10 }, byModel: [{ source: 'openai', totals: { inputTokens: 10 } }] });
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
