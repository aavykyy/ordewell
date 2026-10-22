import { describe, it, expect } from 'vitest';
import { scriptHandoff, userTaskHandoff } from '../DerivedHandoff';
import { HANDOFF_LIMITS } from '../Handoff';

describe('the handoff of a script (ADR-0047)', () => {
  it('hands over the exit and the output tail as the summary, with no inferred findings', () => {
    const output = `${'noise\n'.repeat(10_000)}the real error\n`;
    const handoff = scriptHandoff({ outcome: 'failed', status: { code: 2, signal: null }, errorTail: '' }, 1000, output)!;
    expect(handoff.summary.startsWith('exited 2 in 1 s\n…')).toBe(true);
    expect(handoff.summary.endsWith('the real error')).toBe(true);
    expect(handoff.summary.length).toBeLessThanOrEqual(1500);
    expect(handoff.findings).toEqual([]);
    expect(handoff.findingCount).toBe(0);
    expect(handoff.report!.length).toBe(HANDOFF_LIMITS.report - 1);
    expect(handoff.report!.endsWith('the real error')).toBe(true);
  });

  it('says a step that never started could not start, and gives no exit code it does not have', () => {
    const handoff = scriptHandoff({ outcome: 'failed', status: { code: null, signal: null, error: 'spawn make ENOENT' }, errorTail: '' }, 5, '');

    expect(handoff).toEqual({
      summary: 'could not start: spawn make ENOENT',
      findings: [],
      findingCount: 0,
    });
  });

  it('hands over nothing for a script that was stopped', () => {
    expect(scriptHandoff({ outcome: 'stopped' }, 100, 'partial')).toBeUndefined();
  });
});

describe('the handoff of a user task (ADR-0047)', () => {
  it('is the summary alone when the task has no steps', () => {
    expect(userTaskHandoff()).toEqual({ summary: 'Completed by the user', findings: [], findingCount: 0 });
  });
});

it('bounds a script summary even when both the startup error and output are long', () => {
  const handoff = scriptHandoff({ outcome: 'failed', status: { code: null, signal: null, error: 'e'.repeat(5000) }, errorTail: '' }, 0, 'output'.repeat(1000))!;
  expect(handoff.summary.length).toBeLessThanOrEqual(1500);
  expect(handoff.summary.startsWith('could not start: ')).toBe(true);
  expect(handoff.summary.endsWith('…')).toBe(true);
});
