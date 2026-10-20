import { describe, it, expect } from 'vitest';
import { createStepLog, formatStepLine, isTransient } from '../researchLog';
import type { WsEvent } from '../../apiClient';
import type { ResearchStep } from '@ordewell/core';

const step = (overrides: Partial<ResearchStep> = {}): ResearchStep => ({
  id: 'rs-1',
  tool: 'read_file' as ResearchStep['tool'],
  args: JSON.stringify({ path: 'src/auth.ts' }),
  result: 'export const auth = 1;',
  success: true,
  outcome: 'success',
  timestamp: '',
  ...overrides,
});

const done = (overrides: Partial<ResearchStep> = {}, event: Record<string, unknown> = {}): WsEvent =>
  ({ type: 'research_step_done', step: step(overrides), ...event });

describe('formatStepLine', () => {
  it('names an issued call as the TUI\'s command row does', () => {
    expect(formatStepLine({ type: 'research_step', tool: 'read_file', args: '{"path":"src/auth.ts"}' }))
      .toBe('Read(src/auth.ts)');
  });

  it('indents a subagent call under its parent', () => {
    expect(formatStepLine({ type: 'research_step', tool: 'grep', args: '{"pattern":"login"}', subagentId: 'sub-1' }))
      .toBe('  ↳ Grep(login)');
  });

  it('reports the outcome and a result preview when a call settles', () => {
    expect(formatStepLine(done())).toBe('✓ Read(src/auth.ts) → export const auth = 1;');
  });

  it('distinguishes failure, refusal, denial and non-execution from success', () => {
    const marks = (['failure', 'refused', 'denied', 'not_executed'] as const).map((outcome) =>
      formatStepLine(done({ outcome, success: false, result: '' })),
    );

    expect(marks).toEqual([
      '✗ Read(src/auth.ts)',
      '⊘ Read(src/auth.ts)',
      '⊘ Read(src/auth.ts)',
      '– Read(src/auth.ts)',
    ]);
  });

  it('collapses a multi-line result to one truncated line', () => {
    const line = formatStepLine(done({ result: `first\nsecond${'x'.repeat(400)}` }))!;

    expect(line).not.toContain('\n');
    expect(line.startsWith('✓ Read(src/auth.ts) → first second')).toBe(true);
    expect(line.endsWith('…')).toBe(true);
    expect(line.length).toBeLessThan(220);
  });

  it('gives verbose runs a longer preview', () => {
    const args = { result: 'y'.repeat(1000) };
    const quiet = formatStepLine(done(args))!;
    const loud = formatStepLine(done(args), { verbose: true })!;

    expect(loud.length).toBeGreaterThan(quiet.length);
  });

  it('indents a settled subagent call too', () => {
    expect(formatStepLine(done({ result: '' }, { subagentId: 'sub-1' }))).toBe('  ↳ ✓ Read(src/auth.ts)');
  });

  it('prints nothing for lifecycle events or a malformed done event', () => {
    expect(formatStepLine({ type: 'status_update', tasks: [] })).toBeNull();
    expect(formatStepLine({ type: 'plan_token', token: 'x' })).toBeNull();
    // A daemon that sends `research_step_done` without its step is off-contract;
    // the renderer still has to survive it rather than throw at the user.
    expect(formatStepLine({ type: 'research_step_done' } as unknown as WsEvent)).toBeNull();
  });
});

describe('isTransient', () => {
  it('holds the status line only for a call still in flight', () => {
    expect(isTransient({ type: 'research_step', tool: 'grep', args: '{}' })).toBe(true);
    expect(isTransient(done())).toBe(false);
    expect(isTransient({ type: 'planner_thinking_delta', text: 'x' })).toBe(false);
  });
});

describe('createStepLog', () => {
  const thought = (text: string, extra: Partial<Extract<WsEvent, { type: 'planner_thinking_delta' }>> = {}): WsEvent =>
    ({ type: 'planner_thinking_delta', turnId: 't1', text, ...extra });

  it('drops reasoning unless --verbose asked for it', () => {
    const log = createStepLog();

    expect(log.push(thought('Considering the auth flow'))).toEqual([]);
    expect(log.flush()).toEqual([]);
  });

  // The API backends stream thinking a token at a time, in segments.
  it('prints an API backend\'s streamed thinking as one line once the run ends', () => {
    const log = createStepLog({ verbose: true });

    const lines = [
      thought('Considering ', { segmentId: 'r1' }),
      thought(' the\nauth flow', { segmentId: 'r1' }),
      { type: 'research_step_done', step: step() } as WsEvent,
      thought('Now the store.', { segmentId: 'r2' }),
    ].flatMap((e) => log.push(e));

    expect(lines).toEqual([
      { text: '  · Considering the auth flow', transient: false },
      { text: '✓ Read(src/auth.ts) → export const auth = 1;', transient: false },
    ]);
    expect(log.flush()).toEqual([{ text: '  · Now the store.', transient: false }]);
    expect(log.flush()).toEqual([]);
  });

  it('prints a harness planner\'s unsegmented thinking, each thinker on its own line', () => {
    const log = createStepLog({ verbose: true });

    const lines = [
      thought('Grep for the cache.'),
      thought('Scan src.', { subagentId: 'sa1' }),
      { type: 'research_step', tool: 'grep', args: '{"pattern":"cache"}' } as WsEvent,
    ].flatMap((e) => log.push(e));

    expect(lines).toEqual([
      { text: '  · Grep for the cache.', transient: false },
      { text: '  · Scan src.', transient: false },
      { text: 'Grep(cache)', transient: true },
    ]);
  });
});

describe("a session's notice in the log", () => {
  it('is printed whole, on one line, where a piped run will see it', () => {
    const message = "The planner's shell runs without an OS sandbox on this machine: bubblewrap (bwrap) is not installed.\n\nInstall it, then restart Ordewell.";
    expect(formatStepLine({ type: 'notice', level: 'warn', message }))
      .toBe("! The planner's shell runs without an OS sandbox on this machine: bubblewrap (bwrap) is not installed. Install it, then restart Ordewell.");
  });
});
