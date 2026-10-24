import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readSavedPatch } from '../taskDiffRead';

/**
 * `task_diff` on a read-only task that saved a patch (ADR-0050): its worktree
 * is gone, so the patch is what it changed, read in the shape a change task's
 * diff has. The patch here is git's own, as the capture writes it.
 */

const git = (cwd: string, ...args: string[]) => spawnSync('git', args, { cwd, encoding: 'utf8' }).stdout;

describe.skipIf(process.platform === 'win32')('readSavedPatch', () => {
  let repo: string;
  let patch: Buffer;
  const saved = { attempt: 2, base: 'c'.repeat(40) };

  beforeAll(() => {
    repo = realpathSync(mkdtempSync(join(tmpdir(), 'ordewell-saved-patch-')));
    git(repo, 'init', '-q');
    writeFileSync(join(repo, 'a.ts'), 'one\ntwo\nthree\n');
    writeFileSync(join(repo, 'old name.md'), 'a\nb\nc\nd\ne\n');
    writeFileSync(join(repo, 'gone.txt'), 'bye\n');
    writeFileSync(join(repo, 'run.sh'), 'echo\n');
    git(repo, 'add', '-A');
    git(repo, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'base');
    writeFileSync(join(repo, 'a.ts'), 'one\n2\nthree\nfour\n');
    git(repo, 'mv', 'old name.md', 'new\tname.md');
    rmSync(join(repo, 'gone.txt'));
    chmodSync(join(repo, 'run.sh'), 0o755);
    writeFileSync(join(repo, 'blob.bin'), Buffer.from([0, 1, 2, 255]));
    writeFileSync(join(repo, 'café.md'), 'new\n');
    git(repo, 'add', '-A');
    patch = spawnSync('git', ['diff', '--cached', '--binary', '--full-index', '-M', 'HEAD'], { cwd: repo }).stdout;
  });

  afterAll(() => rmSync(repo, { recursive: true, force: true }));

  it('lists each file the patch changes with its line counts, under where the patch came from', () => {
    const read = readSavedPatch(patch, saved, {});
    expect(read).toEqual({
      available: true,
      text: [
        'The patch attempt 2 saved, against commit cccccccccccc; the task\'s worktree is gone.',
        '[repo .] a.ts: +2 -1',
        '[repo .] blob.bin: binary change',
        '[repo .] café.md: +1 -0',
        '[repo .] gone.txt: +0 -1',
        '[repo .] new\tname.md: +0 -0',
        '[repo .] run.sh: +0 -0',
        '',
      ].join('\n'),
    });
  });

  it("reads one file's part, by the path it ends at", () => {
    const read = readSavedPatch(patch, saved, { path: 'new\tname.md' });
    expect(read.available && read.text).toContain('[repo .] new\tname.md\ndiff --git a/old name.md "b/new\\tname.md"\nsimilarity index 100%\nrename from old name.md\nrename to "new\\tname.md"');
    expect(readSavedPatch(patch, saved, { path: 'café.md' })).toMatchObject({ available: true, text: expect.stringContaining('diff --git "a/caf\\303\\251.md" "b/caf\\303\\251.md"\nnew file mode 100644') });
    const mode = readSavedPatch(patch, saved, { path: 'run.sh' });
    expect(mode.available && mode.text).toContain('old mode 100644\nnew mode 100755');
  });

  it('says which file it cannot find, which repository it does not have, and a patch no longer kept', () => {
    expect(readSavedPatch(patch, saved, { path: 'nope.ts' })).toEqual({ available: false, reason: expect.stringContaining('No changed file matches "nope.ts"') });
    expect(readSavedPatch(patch, saved, { repo: 'web' })).toEqual({ available: false, reason: expect.stringContaining('No repository matches "web"') });
    expect(readSavedPatch(undefined, saved, {})).toEqual({ available: false, reason: expect.stringContaining('the patch attempt 2 saved is no longer') });
  });
});
