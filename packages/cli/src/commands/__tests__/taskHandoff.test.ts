import { describe, expect, it } from 'vitest';
import { taskHandoffLines } from '../taskHandoff';

describe('taskHandoffLines', () => {
  it('puts the commit, subject then body, before the summary', () => {
    expect(taskHandoffLines({
      summary: 'Did it.', findings: [], findingCount: 0, commit: { subject: 'Add x', body: 'Why x.' },
    }, '  ')).toEqual(['  ↳ Handoff', '  Commit: Add x', '  Why x.', '  Did it.']);
  });

  it('prints a handoff with only a commit', () => {
    expect(taskHandoffLines({ summary: '', findings: [], findingCount: 0, commit: { subject: 'Add x' } }, '')).toEqual(['↳ Handoff', 'Commit: Add x']);
  });

  it('keeps the summary on the heading line without a commit', () => {
    expect(taskHandoffLines({ summary: 'Did it.', findings: [], findingCount: 0 }, '')).toEqual(['↳ Handoff: Did it.']);
  });
});
