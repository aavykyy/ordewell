import { describe, expect, it } from 'vitest';
import { taskHandoffLines } from '../taskHandoff';
import type { HandoffPatch } from '@ordewell/core';

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

  it('prints a saved patch with its changes, the file to open and what it left out (ADR-0050)', () => {
    const patch: HandoffPatch = {
      kind: 'patch', path: '.ordewell/sessions/s1/tasks/t1/1.patch', attempt: 1,
      base: 'a'.repeat(40), files: 2, added: 9, removed: 1, binary: 0, bytes: 900, sha256: 'f'.repeat(64),
      flags: [
        { kind: 'excluded', count: 1, paths: ['docs/link'] },
        { kind: 'dropped', count: 1, paths: ['big.bin'] },
      ],
    };

    expect(taskHandoffLines({ summary: 'Tried it.', findings: [], findingCount: 0, artifacts: [patch] }, '  ')).toEqual([
      '  ↳ Handoff: Tried it.',
      '  Patch: 2 files, +9 -1, 900 B, from commit aaaaaaaaaaaa',
      '  saved as .ordewell/sessions/s1/tasks/t1/1.patch (attempt 1)',
      '  not carried (links and submodules): 1 file (docs/link)',
      '  dropped over the size cap: 1 file (big.bin)',
    ]);
  });
});
