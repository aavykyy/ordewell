import { describe, expect, it } from 'vitest';
import { patchView, savedPatchView, savedPatchViews, type HandoffDigest, type HandoffPatch } from '../Handoff';

const base = 'a'.repeat(40);

const patch = (over: Partial<HandoffPatch> = {}): HandoffPatch => ({
  kind: 'patch',
  path: '.ordewell/sessions/s1/tasks/t1/1.patch',
  attempt: 1,
  base,
  files: 3,
  added: 42,
  removed: 7,
  binary: 1,
  bytes: 1536,
  sha256: 'e'.repeat(64),
  ...over,
});

const flagged = patch({
  flags: [
    { kind: 'excluded', count: 1, paths: ['docs/link'] },
    { kind: 'dropped', count: 2, paths: ['big.bin'] },
    { kind: 'normalized', count: 1, paths: ['notes.txt'] },
  ],
});

describe('a saved patch as every surface shows it (ADR-0050)', () => {
  it('says what changed, from which commit, where it was saved and what it left out', () => {
    expect(patchView(flagged)).toEqual({
      path: '.ordewell/sessions/s1/tasks/t1/1.patch',
      attempt: 'attempt 1',
      changes: '3 files, 1 binary, +42 -7, 1.5 KB',
      base: 'from commit aaaaaaaaaaaa',
      saved: 'saved as .ordewell/sessions/s1/tasks/t1/1.patch (attempt 1)',
      flags: [
        'not carried (links and submodules): 1 file (docs/link)',
        'dropped over the size cap: 2 files (big.bin, +1 more)',
        'normalized by git attributes: 1 file (notes.txt)',
      ],
      peek: 'patch: 3 files, 1 binary, +42 -7',
    });
  });

  it('lists no flags when it left nothing out', () => {
    expect(patchView(patch()).flags).toEqual([]);
  });

  it('is absent from a handoff that names no patch, and found in one that does', () => {
    const plain: HandoffDigest = {
      summary: 'Done.', findingCount: 0, findings: [], artifacts: [{ kind: 'file', path: 'src/a.ts' }],
    };
    expect(savedPatchView(plain)).toBeNull();
    expect(savedPatchViews(plain)).toEqual([]);

    const saved: HandoffDigest = { ...plain, artifacts: [...plain.artifacts!, patch()] };
    expect(savedPatchView(saved)?.peek).toBe('patch: 3 files, 1 binary, +42 -7');
    expect(savedPatchViews(saved).map((p) => p.attempt)).toEqual(['attempt 1']);
  });
});
