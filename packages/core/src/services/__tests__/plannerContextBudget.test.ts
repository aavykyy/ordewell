import { describe, it, expect } from 'vitest';
import { TokenGauge, callBudget } from '../plannerContextBudget';

describe('callBudget', () => {
  // Worked by hand: ceiling = min(90% of W, W less the reply); the reply is
  // min(32,000, the provider's cap, a quarter of W).
  it.each([
    [{ contextWindow: 131_072 }, { maxOutputTokens: 32_000, ceiling: 99_072 }],
    [{ contextWindow: 1_048_576 }, { maxOutputTokens: 32_000, ceiling: 943_718 }],
    [{ contextWindow: 32_768 }, { maxOutputTokens: 8_192, ceiling: 24_576 }],
    [{ contextWindow: 16_384 }, { maxOutputTokens: 4_096, ceiling: 12_288 }],
    [{ contextWindow: 200_000, maxOutputTokens: 8_192 }, { maxOutputTokens: 8_192, ceiling: 180_000 }],
  ])('budgets %o as %o', (limits, expected) => {
    expect(callBudget(limits)).toMatchObject(expected);
  });

  it('prunes, once it must, down to three quarters of the ceiling', () => {
    expect(callBudget({ contextWindow: 131_072 })?.lowWater).toBe(74_304);
  });

  it('budgets nothing on a window it does not know', () => {
    expect(callBudget(undefined)).toBeUndefined();
    expect(callBudget({ maxOutputTokens: 4_096 })).toBeUndefined();
    expect(callBudget({ contextWindow: 0 })).toBeUndefined();
  });
});

describe('TokenGauge', () => {
  it('estimates high before any measurement, and refuses nothing on that guess alone', () => {
    const gauge = new TokenGauge();
    expect(gauge.charsPerToken('a')).toBe(3);
    expect(gauge.plainCharsPerToken('a')).toBeUndefined();
  });

  it('takes a model\'s own measurement with a margin, and another model\'s with a wider one until its own arrives', () => {
    const gauge = new TokenGauge();
    gauge.record('a', 44_000, 10_000);
    expect(gauge.charsPerToken('a')).toBeCloseTo(4.4 / 1.1);
    expect(gauge.charsPerToken('b')).toBeCloseTo(4.4 / 1.25);
    expect(gauge.plainCharsPerToken('b')).toBeCloseTo(4.4);

    gauge.record('b', 30_000, 10_000);
    expect(gauge.charsPerToken('b')).toBeCloseTo(3 / 1.1);
    expect(gauge.charsPerToken('a')).toBeCloseTo(4.4 / 1.1);
  });

  it('ignores a report of no tokens, and caps a ratio no tokenizer produces', () => {
    const gauge = new TokenGauge();
    gauge.record('a', 1_000, 0);
    expect(gauge.plainCharsPerToken('a')).toBeUndefined();
    gauge.record('a', 1_000_000, 10);
    expect(gauge.plainCharsPerToken('a')).toBe(6);
  });
});
