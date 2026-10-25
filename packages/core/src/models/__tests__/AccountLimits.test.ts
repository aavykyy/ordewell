import { describe, it, expect } from 'vitest';
import { accountLimitsOf, accountLimitsText, accountLimitsTitle, accountLimitWindowLabel, hasAccountLimits, type AccountLimitSnapshot, type AccountLimitWindow } from '../AccountLimits';

const window = (over: Partial<AccountLimitWindow>): AccountLimitWindow => ({ slot: 'primary', usedPercent: null, durationMinutes: null, resetsAt: null, ...over });

const codex = (over: Partial<AccountLimitSnapshot> = {}): AccountLimitSnapshot => ({
  harness: 'codex',
  label: 'Codex',
  status: 'fresh',
  plan: 'plus',
  buckets: [{ id: 'codex', windows: [
    window({ usedPercent: 24, durationMinutes: 300, resetsAt: '2026-03-02T15:00:00.000Z' }),
    window({ slot: 'secondary', usedPercent: 61, durationMinutes: 10080, resetsAt: '2026-03-06T09:00:00.000Z' }),
  ] }],
  readAt: '2026-03-02T10:00:00.000Z',
  ...over,
});

describe('account-limit wording', () => {
  it('words the compact row from each window\'s own length', () => {
    expect(accountLimitsText(codex())).toBe('Codex 5h 24% used · Weekly 61% used');
  });

  it('labels other lengths as reported, and an unreported one generically', () => {
    expect(accountLimitWindowLabel(window({ durationMinutes: 60 }))).toBe('1h');
    expect(accountLimitWindowLabel(window({ durationMinutes: 1440 }))).toBe('Daily');
    expect(accountLimitWindowLabel(window({ durationMinutes: 4320 }))).toBe('3d');
    expect(accountLimitWindowLabel(window({ durationMinutes: 20160 }))).toBe('2w');
    expect(accountLimitWindowLabel(window({ durationMinutes: 90 }))).toBe('90m');
    expect(accountLimitWindowLabel(window({}))).toBe('Primary');
    expect(accountLimitWindowLabel(window({ slot: 'secondary' }))).toBe('Secondary');
  });

  it('draws a reported 0% and leaves out a window whose share is unreported', () => {
    const snapshot = codex({ buckets: [{ id: 'codex', windows: [window({ usedPercent: 0, durationMinutes: 300 }), window({ slot: 'secondary', durationMinutes: 10080 })] }] });

    expect(accountLimitsText(snapshot)).toBe('Codex 5h 0% used');
  });

  it('draws nothing when no share is known, or the account has no limits to show', () => {
    expect(accountLimitsText(codex({ buckets: [{ id: 'codex', windows: [window({ durationMinutes: 300 })] }] }))).toBeNull();
    expect(accountLimitsText(codex({ buckets: [] }))).toBeNull();
    for (const status of ['signed_out', 'unsupported', 'not_installed', 'unknown'] as const) {
      expect(hasAccountLimits(codex({ status }))).toBe(false);
      expect(accountLimitsText(codex({ status }))).toBeNull();
    }
  });

  it('keeps a model\'s own bucket apart, after its name, and says when the read is stale', () => {
    const snapshot = codex({
      status: 'stale',
      buckets: [
        { id: 'codex', windows: [window({ usedPercent: 0.4, durationMinutes: 300 })] },
        { id: 'model-b', name: 'Spark', windows: [window({ usedPercent: 99.6, durationMinutes: 60 })] },
      ],
    });

    expect(accountLimitsText(snapshot)).toBe('Codex 5h <1% used · Spark 1h 100% used (stale)');
  });

  it('gives each window\'s exact share and reset, the plan and the read time on hover', () => {
    const time = (at: Date) => at.toISOString().slice(11, 16);

    expect(accountLimitsTitle(codex(), time)).toBe([
      'Codex 5h: 24% used, resets 15:00',
      'Codex Weekly: 61% used, resets 09:00',
      'Plan: plus',
      'Read 10:00',
    ].join('\n'));
    expect(accountLimitsTitle(codex({ status: 'stale', plan: undefined, buckets: [{ id: 'm', name: 'Spark', windows: [window({ durationMinutes: 60 })] }, { id: 'n', windows: [window({ usedPercent: 3 })] }] }), time)).toBe([
      'Codex 1h: not reported',
      'Codex n Primary: 3% used',
      'Last read 10:00; not current, a newer read is pending or failed',
    ].join('\n'));
  });

  it('gives a task only its own runner\'s account', () => {
    const claude = codex({ harness: 'claude-code', label: 'Claude Code' });

    expect(accountLimitsOf([codex(), claude], 'claude-code')).toEqual([claude]);
    expect(accountLimitsOf([codex(), claude], 'opencode')).toEqual([]);
    expect(accountLimitsOf([codex(), claude], undefined)).toEqual([]);
  });

  it('gives a task an account that meters one provider only while that provider serves it', () => {
    const go = codex({ harness: 'opencode', label: 'OpenCode Go', provider: 'opencode-go' });

    expect(accountLimitsOf([go], 'opencode', 'opencode-go/kimi-k2.6')).toEqual([go]);
    // Zen's pay-as-you-go `opencode` provider and a third party are not metered by Go.
    expect(accountLimitsOf([go], 'opencode', 'opencode/kimi-k2.6')).toEqual([]);
    expect(accountLimitsOf([go], 'opencode', 'openrouter/opencode-go/x')).toEqual([]);
    expect(accountLimitsOf([go], 'opencode', 'opencode-go')).toEqual([]);
    // No model known is no binding known.
    expect(accountLimitsOf([go], 'opencode', undefined)).toEqual([]);
    // An account that meters every model its runner serves ignores the model.
    expect(accountLimitsOf([codex()], 'codex', undefined)).toEqual([codex()]);
  });

  it('words a plan-month window Monthly without a length of its own, and keeps three windows apart', () => {
    const monthly = window({ slot: 'tertiary', period: 'month', usedPercent: 2.9, resetsAt: '2026-03-20T10:00:00.000Z' });
    const go = codex({
      harness: 'opencode', label: 'OpenCode Go', plan: 'go',
      buckets: [{ id: 'go', windows: [
        window({ usedPercent: 1, durationMinutes: 300 }),
        window({ slot: 'secondary', usedPercent: 5.8, durationMinutes: 10080 }),
        monthly,
      ] }],
    });

    expect(accountLimitWindowLabel(monthly)).toBe('Monthly');
    expect(accountLimitWindowLabel(window({ slot: 'tertiary' }))).toBe('Tertiary');
    expect(accountLimitsText(go)).toBe('OpenCode Go 5h 1% used · Weekly 6% used · Monthly 3% used');
    expect(accountLimitsTitle(go, (at) => at.toISOString().slice(0, 10))).toContain('OpenCode Go Monthly: 2.9% used, resets 2026-03-20');
  });
});
