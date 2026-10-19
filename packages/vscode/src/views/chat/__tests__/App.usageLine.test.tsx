import React from 'react';
import { describe, it, expect, beforeEach } from 'vitest';
import { render } from '@testing-library/react';
import type { SessionMessage } from '@ordewell/core';
import App from '../App';
import { hostBridge } from './hostBridge';

const TURN = 'turn-1';
const turnStarted: SessionMessage = { type: 'planner_turn_started', turnId: TURN };
const usage = (over: Partial<Extract<SessionMessage, { type: 'planner_usage' }>>): SessionMessage => ({
  type: 'planner_usage', turnId: TURN, totals: { inputTokens: 1_234, outputTokens: 567 }, ...over,
});

describe('usage line', () => {
  let host: ReturnType<typeof hostBridge>;
  beforeEach(() => {
    render(<App />);
    host = hostBridge();
  });

  it('sits outside the scrolling conversation and draws the context and cost, no token count', () => {
    host.session(turnStarted, usage({
      totals: { inputTokens: 1_234, outputTokens: 567, cachedInputTokens: 900, reportedCost: { usd: 0.0123 } },
      contextFill: { usedTokens: 700, windowTokens: 10_000 },
    }));

    const line = document.querySelector('.usage-line')!;
    expect(line.textContent).toBe('ctx 700 (7%) · $0.0123');
    expect(document.querySelector('.message-list')!.contains(line)).toBe(false);
  });

  it('draws no line when neither the context nor a cost is known', () => {
    host.session(turnStarted, usage({}));

    expect(document.querySelector('.usage-line')).toBeNull();
  });

  it('draws the used tokens alone while the window is unknown', () => {
    host.session(turnStarted, usage({ contextFill: { usedTokens: 61_143 } }));

    expect(document.querySelector('.usage-line')!.textContent).toBe('ctx 61k');
    expect(document.querySelector('.usage-line-context')!.getAttribute('title')).toBe('61,143 tokens');
  });

  it('gives the meter exact counts on hover', () => {
    host.session(turnStarted, usage({ contextFill: { usedTokens: 61_143, windowTokens: 1_000_000 } }));

    expect(document.querySelector('.usage-line-context')!.textContent).toBe('ctx 61k (6%)');
    expect(document.querySelector('.usage-line-context')!.getAttribute('title')).toBe('61,143 of 1,000,000 tokens');
  });

  it('lists each model\'s cost on hover, leaving out those with none', () => {
    host.session(turnStarted, usage({
      totals: { reportedCost: { USD: 1.75 } },
      byModel: [
        { source: 'claude-code', model: 'opus', totals: { inputTokens: 5, reportedCost: { USD: 1.5 } } },
        { source: 'claude-code', model: 'sonnet', totals: { reportedCost: { USD: 0.25 } } },
        { source: 'codex', model: 'gpt', totals: { inputTokens: 9 } },
      ],
    }));

    expect(document.querySelector('.usage-line-cost')!.getAttribute('title')).toBe('claude-code / opus: $1.50\nclaude-code / sonnet: $0.25');
  });

  it('explains a subscription estimate at list price on the cost hover', () => {
    const totals = { reportedCost: { USD: 7.89 }, costProvenance: { USD: { kind: 'estimate' as const, billing: 'subscription' as const, basis: 'list' as const } } };
    host.session(turnStarted, usage({ totals, byModel: [{ source: 'claude-code', model: 'opus', totals }] }));
    const cost = document.querySelector('.usage-line-cost')!;
    expect(cost.textContent).toBe('≈$7.89 API-equivalent');
    expect(cost.getAttribute('title')).toBe("claude-code / opus: ≈$7.89 API-equivalent — Claude Code's estimate at list price; not billed on a subscription");
  });

  it('keeps the subagent count, whose hover gives each one\'s cost or says it reported none', () => {
    host.session(turnStarted, usage({
      totals: { reportedCost: { USD: 0.5 } },
      bySubagent: { 'sub-1': { inputTokens: 200, reportedCost: { USD: 0.02 } }, 'sub-2': { inputTokens: 40 } },
    }));

    const agents = document.querySelector('.usage-line-subagents')!;
    expect(agents.textContent).toBe('2 subagents');
    expect(agents.getAttribute('title')).toBe('sub-1: $0.02\nsub-2: reported no cost');
    expect(document.querySelector('.usage-line')!.textContent).not.toMatch(/\bin\b|\bout\b/);
  });
});
