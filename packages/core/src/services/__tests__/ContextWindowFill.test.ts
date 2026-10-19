import { describe, it, expect, vi } from 'vitest';
import { ContextWindowFill, SessionWindows, withContextWindows, type CatalogWindow } from '../ContextWindowFill';
import type { IRunner, StructuredEvent } from '../../interfaces/IRunner';
import { FakeRunnerSession } from '../../testing';

/** A catalog that knows Sonnet's and Haiku's windows on Claude Code, and nothing else. */
const catalog: CatalogWindow = (source, model) => (source !== 'claude-code' ? undefined
  : model === 'sonnet' ? 200_000
    : model === 'haiku' ? 100_000
      : model === 'broken' ? 0
        : undefined);

describe('ContextWindowFill', () => {
  it('keeps a window the reporter states over the catalog\'s', () => {
    const fill = new ContextWindowFill(new SessionWindows(catalog));
    expect(fill.fill({ source: 'claude-code', model: 'sonnet', contextWindow: 1_000_000 }).contextWindow).toBe(1_000_000);
  });

  it('reads the catalog for a record that states none', () => {
    const fill = new ContextWindowFill(new SessionWindows(catalog));
    expect(fill.fill({ source: 'claude-code', model: 'haiku', inputTokens: 5 })).toEqual({ source: 'claude-code', model: 'haiku', inputTokens: 5, contextWindow: 100_000 });
  });

  it('keeps a stated window for the same model\'s next records, rather than the catalog\'s', () => {
    const fill = new ContextWindowFill(new SessionWindows(catalog));
    fill.fill({ source: 'claude-code', model: 'sonnet', contextWindow: 1_000_000 });
    expect(fill.fill({ source: 'claude-code', model: 'sonnet' }).contextWindow).toBe(1_000_000);
  });

  it('reads another model\'s window from the catalog once the stream moves to it', () => {
    const fill = new ContextWindowFill(new SessionWindows(catalog));
    fill.fill({ source: 'claude-code', model: 'sonnet', contextWindow: 1_000_000 });
    expect(fill.fill({ source: 'claude-code', model: 'haiku' }).contextWindow).toBe(100_000);
    // The same model under another reporter is another catalog's.
    expect(fill.fill({ source: 'opencode', model: 'haiku' }).contextWindow).toBeUndefined();
  });

  it('keeps a stated window for its model when the stream comes back to it from another', () => {
    const fill = new ContextWindowFill(new SessionWindows(catalog));
    fill.fill({ source: 'claude-code', model: 'sonnet', contextWindow: 1_000_000 });
    fill.fill({ source: 'claude-code', model: 'mystery', contextWindow: 500_000 });
    fill.fill({ source: 'claude-code', model: 'haiku' });
    expect(fill.fill({ source: 'claude-code', model: 'sonnet' }).contextWindow).toBe(1_000_000);
    // A model no catalog lists keeps the one its reporter stated, too.
    expect(fill.fill({ source: 'claude-code', model: 'mystery' }).contextWindow).toBe(500_000);
  });

  it('leaves a subagent\'s record and a breakdown as they are, and the stream\'s model with them', () => {
    const fill = new ContextWindowFill(new SessionWindows(catalog));
    fill.fill({ source: 'claude-code', model: 'sonnet', contextWindow: 1_000_000 });
    const subagent = { source: 'claude-code', model: 'haiku', subagentId: 'sub-1' };
    const breakdown = { source: 'claude-code', model: 'haiku', aggregate: true as const };
    expect(fill.fill(subagent)).toBe(subagent);
    expect(fill.fill(breakdown)).toBe(breakdown);
    expect(fill.fill({ source: 'claude-code', model: 'sonnet' }).contextWindow).toBe(1_000_000);
  });

  it('leaves the window unknown when neither the reporter nor the catalog knows it', () => {
    const fill = new ContextWindowFill(new SessionWindows(catalog));
    const unknown = { source: 'claude-code', model: 'mystery' };
    expect(fill.fill(unknown)).toBe(unknown);
    expect(fill.fill({ source: 'claude-code' }).contextWindow).toBeUndefined();
    // Zero is no window: neither a report nor a listing of one counts.
    expect(fill.fill({ source: 'claude-code', model: 'broken', contextWindow: 0 }).contextWindow).toBe(0);
    expect(fill.fill({ source: 'claude-code', model: 'broken' }).contextWindow).toBeUndefined();
  });

  it('carries on from the model a stream last ran on', () => {
    const fill = new ContextWindowFill(new SessionWindows(catalog), { source: 'claude-code', model: 'sonnet', contextWindow: 1_000_000 });
    expect(fill.fill({ source: 'claude-code', model: 'sonnet' }).contextWindow).toBe(1_000_000);
  });
});

describe('SessionWindows', () => {
  it('knows a window one stream was told to every later stream of the session, over the catalog\'s', () => {
    const windows = new SessionWindows(catalog);
    new ContextWindowFill(windows).fill({ source: 'claude-code', model: 'sonnet', contextWindow: 1_000_000 });
    expect(new ContextWindowFill(windows).fill({ source: 'claude-code', model: 'sonnet', inputTokens: 5 }).contextWindow).toBe(1_000_000);
    // Keyed by its reporter and the exact model id.
    expect(new ContextWindowFill(windows).fill({ source: 'opencode', model: 'sonnet' }).contextWindow).toBeUndefined();
    expect(new ContextWindowFill(windows).fill({ source: 'claude-code', model: 'sonnet-4' }).contextWindow).toBeUndefined();
  });

  it('keeps only what a reporter stated, never a catalog\'s window or a window of 0', () => {
    const windows = new SessionWindows(catalog);
    const stream = new ContextWindowFill(windows);
    stream.fill({ source: 'claude-code', model: 'haiku' });
    stream.fill({ source: 'claude-code', model: 'mystery', contextWindow: 0 });
    stream.fill({ source: 'claude-code', contextWindow: 300_000 });
    stream.fill({ source: 'claude-code', model: 'sonnet', contextWindow: 1_000_000, subagentId: 'sub-1' });
    expect(windows.snapshot()).toEqual([]);
  });

  it('hands out what it was told to save with the plan, and knows it again once restored', () => {
    const windows = new SessionWindows(catalog);
    new ContextWindowFill(windows).fill({ source: 'claude-code', model: 'sonnet', contextWindow: 1_000_000 });
    const saved = windows.snapshot();
    expect(saved).toEqual([{ source: 'claude-code', model: 'sonnet', contextWindow: 1_000_000 }]);

    const reloaded = new SessionWindows(catalog);
    reloaded.restore(saved);
    expect(new ContextWindowFill(reloaded).fill({ source: 'claude-code', model: 'sonnet' }).contextWindow).toBe(1_000_000);
    reloaded.clear();
    expect(new ContextWindowFill(reloaded).fill({ source: 'claude-code', model: 'sonnet' }).contextWindow).toBe(200_000);
    // A saved window of 0 is no window either.
    reloaded.restore([{ source: 'claude-code', model: 'haiku', contextWindow: 0 }]);
    expect(reloaded.snapshot()).toEqual([]);
  });

  it('takes the latest window a reporter stated for a model', () => {
    const windows = new SessionWindows(catalog);
    new ContextWindowFill(windows).fill({ source: 'claude-code', model: 'sonnet', contextWindow: 1_000_000 });
    new ContextWindowFill(windows).fill({ source: 'claude-code', model: 'sonnet', contextWindow: 400_000 });
    expect(new ContextWindowFill(windows).fill({ source: 'claude-code', model: 'sonnet' }).contextWindow).toBe(400_000);
  });

  it('leaves a compaction as it is: it names no model and has no window', () => {
    const windows = new SessionWindows(catalog);
    const stream = new ContextWindowFill(windows);
    stream.fill({ source: 'claude-code', contextWindow: 300_000 });
    const compaction = { source: 'claude-code', compacted: true as const };
    expect(stream.fill(compaction)).toBe(compaction);
  });

  it('shows a compaction that names its model against that model\'s known window', () => {
    const windows = new SessionWindows(catalog);
    windows.report('claude-code', 'sonnet', 1_000_000);
    const compaction = { source: 'claude-code', model: 'sonnet', compacted: true as const, contextTokens: 3615 };
    expect(new ContextWindowFill(windows).fill(compaction)).toEqual({ ...compaction, contextWindow: 1_000_000 });
  });

  it('does not lend a variant\'s window to its base model, or the reverse', () => {
    const windows = new SessionWindows(catalog);
    new ContextWindowFill(windows).fill({ source: 'claude-code', model: 'sonnet[1m]', contextWindow: 1_000_000 });
    // The base model still reads its own catalog window…
    expect(new ContextWindowFill(windows).fill({ source: 'claude-code', model: 'sonnet' }).contextWindow).toBe(200_000);
    // …and a base window never measures the variant.
    new ContextWindowFill(windows).fill({ source: 'claude-code', model: 'haiku[1m]', contextWindow: 1_000_000 });
    expect(new ContextWindowFill(windows).fill({ source: 'claude-code', model: 'haiku' }).contextWindow).toBe(100_000);
  });
});

describe('withContextWindows', () => {
  function runnerOf(...sessions: FakeRunnerSession[]): IRunner {
    return { spawn: vi.fn(async () => sessions.shift()!), stop: vi.fn(), stopAll: vi.fn(), activeCount: 2 };
  }
  const spawnOpts = { taskId: 't1', runner: 'claude-code', prompt: 'Do it', cwd: '/repo' };

  it('fills each usage event before any listener sees it, and passes every other event through', async () => {
    const inner = new FakeRunnerSession('s1', 't1');
    const session = await withContextWindows(runnerOf(inner), new SessionWindows(catalog)).spawn(spawnOpts);
    const first: StructuredEvent[] = [];
    const second: StructuredEvent[] = [];
    session.onEvent((e) => first.push(e));
    session.onEvent((e) => second.push(e));

    inner.emitEvent({ type: 'usage', record: { source: 'claude-code', model: 'haiku', inputTokens: 5 } });
    inner.emitEvent({ type: 'assistant_text', runId: 'r1', text: 'Hi' });

    const expected = [
      { type: 'usage', record: { source: 'claude-code', model: 'haiku', inputTokens: 5, contextWindow: 100_000 } },
      { type: 'assistant_text', runId: 'r1', text: 'Hi' },
    ];
    expect(first).toEqual(expected);
    expect(second).toEqual(expected);
  });

  it('is the session it wraps in every other respect', async () => {
    const inner = new FakeRunnerSession('s1', 't1');
    const runner = runnerOf(inner);
    const wrapped = withContextWindows(runner, new SessionWindows(catalog));
    const session = await wrapped.spawn(spawnOpts);

    expect(session.id).toBe('s1');
    expect(session.taskId).toBe('t1');
    session.write('more');
    expect(inner.written).toEqual(['more']);
    inner.emitOutput('done');
    expect(session.getOutput()).toBe('done');
    session.kill();
    expect(inner.killed).toBe(true);
    wrapped.stop('s1');
    wrapped.stopAll();
    expect(runner.stop).toHaveBeenCalledWith('s1');
    expect(runner.stopAll).toHaveBeenCalled();
    expect(wrapped.activeCount).toBe(2);
  });

  it('knows a window one attempt was told to the attempts after it', async () => {
    const a = new FakeRunnerSession('s1', 't1');
    const b = new FakeRunnerSession('s2', 't1');
    const wrapped = withContextWindows(runnerOf(a, b), new SessionWindows(catalog));
    const first = await wrapped.spawn(spawnOpts);
    const second = await wrapped.spawn(spawnOpts);
    const windows: Array<number | undefined> = [];
    for (const session of [first, second]) session.onEvent((e) => { if (e.type === 'usage') windows.push(e.record.contextWindow); });

    a.emitEvent({ type: 'usage', record: { source: 'claude-code', model: 'sonnet', contextWindow: 1_000_000 } });
    b.emitEvent({ type: 'usage', record: { source: 'claude-code', model: 'sonnet' } });

    expect(windows).toEqual([1_000_000, 1_000_000]);
  });
});
