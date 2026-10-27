import { expect, it, vi } from 'vitest';
import type { AccountLimitReading } from '@ordewell/core';
import { chatLayout } from '../layout';
import { stripAnsi } from '../ansi';
import { draftPlan, liveDaemon } from './liveDaemon';

it('loads and reconnects live account snapshots through the daemon and ApiClient without saving them', async () => {
  const reads: { signal: AbortSignal; finish: (reading: AccountLimitReading) => void }[] = [];
  const daemon = await liveDaemon(() => [{
    harness: 'codex', label: 'Codex', scope: () => 'test',
    acquire: (signal) => new Promise((finish) => { reads.push({ signal, finish }); }),
  }]);
  try {
    daemon.save(draftPlan(), 's');
    const tui = daemon.tui();
    await tui.run({ type: 'loadSession', sessionId: 's' });
    await tui.act({ type: 'settingsLoaded', settings: { aiProvider: 'codex', orchestratorModel: 'gpt-5' } });
    await vi.waitFor(() => expect(reads).toHaveLength(1));
    expect(tui.state().accountLimits).toMatchObject([{ status: 'unknown', buckets: [] }]);
    const before = tui.state();
    reads[0].finish({ kind: 'limits', owner: 'never-transmit-this', buckets: [{ id: 'account', windows: [{ slot: 'primary', usedPercent: 37, durationMinutes: 300, resetsAt: null }] }] });
    await vi.waitFor(() => expect(chatLayout(tui.state(), 24, 160).footer.map(stripAnsi)).toEqual(['Codex 5h 37% used']));
    expect(tui.state().conversation).toBe(before.conversation);
    expect(tui.state().scroll).toBe(before.scroll);
    expect(JSON.stringify(daemon.pool.getPlan('s'))).not.toMatch(/account_limits|never-transmit-this|usedPercent/);
    expect(JSON.stringify(tui.actions)).not.toContain('never-transmit-this');

    daemon.dropSockets();
    await vi.waitFor(() => expect(tui.actions.some((action) => action.type === 'followLost')).toBe(true));
    await tui.run({ type: 'loadSession', sessionId: 's' });
    await vi.waitFor(() => expect(reads).toHaveLength(2));
    expect(tui.state().accountLimits).toMatchObject([{ status: 'unknown', buckets: [] }]);
    expect(chatLayout(tui.state(), 24, 160).footer).toEqual([]);
    reads[1].finish({ kind: 'signed_out' });
    await vi.waitFor(() => expect(tui.state().accountLimits).toMatchObject([{ status: 'signed_out', buckets: [] }]));
    expect(daemon.turns).toHaveLength(0);
  } finally {
    await daemon.close();
  }
});
