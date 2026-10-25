import React from 'react';
import { describe, it, expect, beforeEach } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import type { AccountLimitSnapshot, SessionMessage } from '@ordewell/core';
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
    expect(line.textContent).toBe('Planner ctx 700 (7%) · $0.0123');
    expect(document.querySelector('.message-list')!.contains(line)).toBe(false);
  });

  it('keeps drawing the newest usage when a supervisor wake-up turn opens above the line', () => {
    host.session(turnStarted, usage({ totals: { inputTokens: 1000 }, contextFill: { usedTokens: 1000 } }));
    host.session({ type: 'planner_turn_started', turnId: 'w1', prompt: '', wakeUps: ['Run update: task 1 failed'], supervisor: true });
    host.session(usage({ turnId: 'w1', totals: { inputTokens: 2000 }, contextFill: { usedTokens: 2000 } }));

    expect(document.querySelector('.usage-line')!.textContent).toBe('Planner ctx 2k');
  });

  it('draws no line when neither the context nor a cost is known', () => {
    host.session(turnStarted, usage({}));

    expect(document.querySelector('.usage-line')).toBeNull();
  });

  it('draws the used tokens alone while the window is unknown', () => {
    host.session(turnStarted, usage({ contextFill: { usedTokens: 61_143 } }));

    expect(document.querySelector('.usage-line')!.textContent).toBe('Planner ctx 61k');
    expect(document.querySelector('.usage-line-context')!.getAttribute('title')).toBe('61,143 tokens');
  });

  it('gives the meter exact counts on hover', () => {
    host.session(turnStarted, usage({ contextFill: { usedTokens: 61_143, windowTokens: 1_000_000 } }));

    expect(document.querySelector('.usage-line-context')!.textContent).toBe('Planner ctx 61k (6%)');
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

const codexLimits = (over: Partial<AccountLimitSnapshot> = {}): AccountLimitSnapshot => ({
  harness: 'codex',
  label: 'Codex',
  status: 'fresh',
  plan: 'plus',
  buckets: [{ id: 'codex', windows: [
    { slot: 'primary', usedPercent: 24, durationMinutes: 300, resetsAt: '2026-03-02T15:00:00.000Z' },
    { slot: 'secondary', usedPercent: 61, durationMinutes: 10080, resetsAt: '2026-03-06T09:00:00.000Z' },
  ] }],
  readAt: '2026-03-02T10:00:00.000Z',
  ...over,
});

describe('account limits under the planner', () => {
  let host: ReturnType<typeof hostBridge>;
  beforeEach(() => {
    render(<App />);
    host = hostBridge();
  });

  it('draws a signed-in harness\'s limits before the planner has made any call', () => {
    host.provider.setAccountLimits([codexLimits()]);

    expect(document.querySelector('.usage-line-context')).toBeNull();
    const row = document.querySelector('.account-limit')!;
    expect(row.textContent).toBe('Codex 5h 24% used · Weekly 61% used');
    expect(row.getAttribute('title')).toMatch(/^Codex 5h: 24% used, resets .+\nCodex Weekly: 61% used, resets .+\nPlan: plus\nRead .+$/);
    expect(document.querySelector('.message-list')!.contains(row)).toBe(false);
  });

  it('reaches each row\'s resets, plan and read time from the keyboard and a screen reader, not only a mouse hover', () => {
    host.provider.setAccountLimits([codexLimits({ status: 'stale' })]);

    const row = document.querySelector<HTMLElement>('.account-limit')!;
    expect(row.tabIndex).toBe(0);
    const detail = document.getElementById(row.getAttribute('aria-describedby')!)!;
    const lines = Array.from(detail.children, (line) => line.textContent);
    expect(lines).toHaveLength(4);
    expect(lines[0]).toMatch(/^Codex 5h: 24% used, resets \S/);
    expect(lines[1]).toMatch(/^Codex Weekly: 61% used, resets \S/);
    expect(lines[2]).toBe('Plan: plus');
    expect(lines[3]).toMatch(/^Last read \S.*; not current, a newer read is pending or failed$/);
    // A passive readout: a poll that moves a percentage is not announced over what the user is doing.
    const region = document.querySelector('.account-limits')!;
    expect(region.getAttribute('role')).not.toBe('status');
    expect(region.getAttribute('aria-live')).toBeNull();
  });

  it('keeps the planner\'s context and cost beside them', () => {
    host.session(turnStarted, usage({ totals: { reportedCost: { USD: 0.5 } }, contextFill: { usedTokens: 700, windowTokens: 10_000 } }));
    host.provider.setAccountLimits([codexLimits()]);

    expect(document.querySelector('.usage-line-measures')!.textContent).toBe('Planner ctx 700 (7%) · $0.50');
    expect(document.querySelector('.account-limit')!.textContent).toBe('Codex 5h 24% used · Weekly 61% used');
  });

  it('draws no row for a harness that is signed out, unsupported, not installed or not yet read', () => {
    host.provider.setAccountLimits(['signed_out', 'unsupported', 'not_installed', 'unknown'].map((status) =>
      codexLimits({ status: status as AccountLimitSnapshot['status'], buckets: [], readAt: null })));

    expect(document.querySelector('.account-limits')).toBeNull();
  });

  it('marks a stale read on the row, and draws a true 0% as used nothing', () => {
    host.provider.setAccountLimits([codexLimits({ status: 'stale', buckets: [{ id: 'codex', windows: [{ slot: 'primary', usedPercent: 0, durationMinutes: 300, resetsAt: null }] }] })]);

    const row = document.querySelector('.account-limit')!;
    expect(row.textContent).toBe('Codex 5h 0% used (stale)');
    expect(row.className).toContain('stale');
  });

  it('replays the last limits to a webview that reconnects', () => {
    host.provider.setAccountLimits([codexLimits()]);
    cleanup();
    render(<App />);
    host.provider.resendAllState();

    expect(document.querySelector('.account-limit')!.textContent).toBe('Codex 5h 24% used · Weekly 61% used');
  });
});
