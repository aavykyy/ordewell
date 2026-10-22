import { describe, it, expect } from 'vitest';
import { scriptHandoff, userTaskHandoff } from '../DerivedHandoff';
import { HANDOFF_LIMITS } from '../Handoff';

describe('the handoff of a script (ADR-0047)', () => {
  it('keeps the end of a long output as the detail of its blocker, inside the limit, and as much as fits in the report', () => {
    const output = `${'noise\n'.repeat(10_000)}the real error\n`;

    const handoff = scriptHandoff({ outcome: 'failed', status: { code: 2, signal: null }, errorTail: '' }, 1000, output)!;

    const detail = handoff.findings[0].detail!;
    expect(detail.length).toBe(HANDOFF_LIMITS.detail);
    expect(detail.startsWith('…')).toBe(true);
    expect(detail.endsWith('the real error\n')).toBe(true);
    expect(handoff.report!.length).toBe(HANDOFF_LIMITS.report - 1);
    expect(handoff.report!.endsWith('the real error')).toBe(true);
  });

  it('says a step that never started could not start, and gives no exit code it does not have', () => {
    const handoff = scriptHandoff({ outcome: 'failed', status: { code: null, signal: null, error: 'spawn make ENOENT' }, errorTail: '' }, 5, '');

    expect(handoff).toEqual({
      summary: 'could not start: spawn make ENOENT',
      findings: [{ id: 'F1', severity: 'blocker', title: 'Script could not start' }],
      findingCount: 1,
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
