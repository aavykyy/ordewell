import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PATCH_LIMITS, capturePatch, patchArtifact, patchReply, type PatchCaptureResult } from '../PatchCapture';
import type { OwnSealedRuns, TaskShell } from '../../interfaces/IFileSystem';

/**
 * The capture's rules (ADR-0050), through `capturePatch` and real git. Its
 * scripts run here in a plain shell standing in for the task's sealed runs,
 * so these test what is carried, refused and flagged; that they run sealed
 * is the e2e's to show (`PatchCapture.e2e.test.ts`).
 */

const git = (cwd: string, ...args: string[]) => {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`git ${args.join(' ')}: ${result.stderr}`);
  return result.stdout;
};

/** A shell held for the capture, its sealed runs a plain `sh` in the worktree with scratch as `$TMPDIR` and `$HOME`. */
function plainShell(runs: Partial<OwnSealedRuns> & Pick<OwnSealedRuns, 'scratch'>): TaskShell & { scripts: number; hold: NonNullable<TaskShell['hold']> } {
  const shell = {
    scripts: 0,
    run: async () => ({ success: false, output: 'not used', truncated: false }),
    hold: async <T>(work: (own: OwnSealedRuns) => Promise<T>) => work({
      worktrees: [],
      touched: true,
      async run(script, cwd) {
        shell.scripts += 1;
        const ran = spawnSync('/bin/sh', ['-c', script], { cwd, encoding: 'utf8', env: { PATH: process.env.PATH ?? '', HOME: runs.scratch, TMPDIR: runs.scratch } });
        return { success: ran.status === 0, output: `${ran.stdout}${ran.stderr}`, truncated: false };
      },
      ...runs,
    }),
    end() {},
  };
  return shell;
}

/** Whether the temporary directory's file system holds two spellings of a name as one file, as macOS and Windows do by default. */
function caseInsensitive(): boolean {
  const dir = mkdtempSync(join(tmpdir(), 'ordewell-case-'));
  try {
    writeFileSync(join(dir, 'Probe'), '');
    return existsSync(join(dir, 'probe'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe.skipIf(process.platform === 'win32')('capturePatch', () => {
  let repo: string;
  let scratch: string;
  let shell: ReturnType<typeof plainShell>;

  const capture = (linked?: string[]) => capturePatch(shell, linked ? { linked } : {});
  const saved = (result: PatchCaptureResult) => {
    if (result.kind !== 'saved') throw new Error(`not saved: ${result.reason}`);
    return result;
  };

  beforeEach(() => {
    repo = realpathSync(mkdtempSync(join(tmpdir(), 'ordewell-patch-repo-')));
    scratch = realpathSync(mkdtempSync(join(tmpdir(), 'ordewell-patch-scratch-')));
    git(repo, 'init', '-q');
    git(repo, 'config', 'user.email', 't@t');
    git(repo, 'config', 'user.name', 't');
    writeFileSync(join(repo, 'README.md'), 'one\ntwo\n');
    writeFileSync(join(repo, 'NOTES.md'), 'notes\n');
    mkdirSync(join(repo, 'config'));
    writeFileSync(join(repo, 'config', 'settings.json'), '{}\n');
    git(repo, 'add', '-A');
    git(repo, 'commit', '-qm', 'base');
    shell = plainShell({ worktrees: [repo], scratch });
  });

  afterEach(() => {
    rmSync(repo, { recursive: true, force: true });
    rmSync(scratch, { recursive: true, force: true });
  });

  it('saves every change with its stats, against the commit the worktree was cut from, and leaves nothing of its own in scratch', async () => {
    writeFileSync(join(repo, 'README.md'), 'one\ntwo\nthree\n');
    writeFileSync(join(repo, 'added.ts'), 'export const a = 1;\nexport const b = 2;\n');
    rmSync(join(repo, 'NOTES.md'));

    const result = saved(await capture());

    expect(result.stats).toEqual({ base: git(repo, 'rev-parse', 'HEAD').trim(), files: 3, added: 3, removed: 1, binary: 0, bytes: result.patch.length, sha256: createHash('sha256').update(result.patch).digest('hex'), flags: [] });
    const text = result.patch.toString('utf8');
    expect(text).toContain('diff --git a/added.ts b/added.ts\nnew file mode 100644');
    expect(text).toContain('deleted file mode 100644');
    expect(readdirSync(scratch)).toEqual([]);
    expect(shell.scripts).toBe(2);
  });

  it('never stages into the repository: its index and objects stay as they were', async () => {
    writeFileSync(join(repo, 'added.ts'), 'new\n');
    const index = readFileSync(join(repo, '.git', 'index'));
    const objects = git(repo, 'count-objects', '-v');

    saved(await capture());

    expect(readFileSync(join(repo, '.git', 'index')).equals(index)).toBe(true);
    expect(git(repo, 'count-objects', '-v')).toBe(objects);
    expect(git(repo, 'status', '--porcelain')).toBe('?? added.ts\n');
  });

  it('saves nothing, and runs nothing, for a shell that never ran sealed: its worktree is as Ordewell checked it out', async () => {
    shell = plainShell({ worktrees: [repo], scratch, touched: false });
    writeFileSync(join(repo, 'added.ts'), 'new\n');

    const result = await capture();

    expect(result).toMatchObject({ kind: 'empty', reason: expect.stringContaining('no command of this task has run sealed') });
    expect(shell.scripts).toBe(0);
  });

  it('saves nothing for a worktree with no changes', async () => {
    expect(await capture()).toMatchObject({ kind: 'empty', reason: expect.stringContaining('no changes') });
    expect(shell.scripts).toBe(1);
  });

  it('refuses a task with no worktree, and one across several repositories', async () => {
    shell = plainShell({ worktrees: [], scratch });
    expect(await capture()).toMatchObject({ kind: 'refused', reason: expect.stringContaining('no worktree') });
    shell = plainShell({ worktrees: [repo, scratch], scratch });
    expect(await capture()).toMatchObject({ kind: 'refused', reason: expect.stringContaining('several repositories') });
    expect(shell.scripts).toBe(0);
  });

  // On a case-insensitive file system the write edits README.md itself.
  it.skipIf(caseInsensitive())('refuses a new file named like one already there but for case', async () => {
    writeFileSync(join(repo, 'readme.MD'), 'shadow\n');
    expect(await capture()).toMatchObject({ kind: 'refused', reason: expect.stringContaining('"README.md" and "readme.MD" differ only in case') });
  });

  it('refuses a case-only rename, a new spelling beside the old one or a removal and an addition, as the file system has it', async () => {
    renameSync(join(repo, 'NOTES.md'), join(repo, 'notes.md'));

    expect(await capture()).toMatchObject({ kind: 'refused', reason: expect.stringContaining('"NOTES.md" and "notes.md" differ only in case') });
  });

  it('carries no symbolic link, and names it', async () => {
    const elsewhere = realpathSync(mkdtempSync(join(tmpdir(), 'ordewell-patch-elsewhere-')));
    try {
      symlinkSync(elsewhere, join(repo, 'outside'));
      symlinkSync('README.md', join(repo, 'inside'));
      writeFileSync(join(repo, 'added.ts'), 'new\n');

      const result = saved(await capture());

      expect(result.stats.flags).toEqual([{ kind: 'excluded', count: 2, paths: ['inside', 'outside'] }]);
      expect(result.stats.files).toBe(1);
      expect(result.patch.toString('utf8')).not.toContain('120000');
    } finally {
      rmSync(elsewhere, { recursive: true, force: true });
    }
  });

  it('saves nothing when a link is all that changed', async () => {
    symlinkSync('README.md', join(repo, 'inside'));
    expect(await capture()).toMatchObject({ kind: 'empty', flags: [{ kind: 'excluded', count: 1, paths: ['inside'] }] });
  });

  it("keeps out what Ordewell linked in, by name and whatever it is on disk, without naming it, ignored or not", async () => {
    writeFileSync(join(repo, '.gitignore'), '.env\n');
    git(repo, 'add', '.gitignore');
    git(repo, 'commit', '-qm', 'ignore');
    symlinkSync(join(repo, 'README.md'), join(repo, '.env.development'));
    symlinkSync(join(repo, 'README.md'), join(repo, '.env'));
    // A link the platform could only copy is a plain file, and still Ordewell's.
    writeFileSync(join(repo, 'config', 'local.json'), '{"secret":1}\n');
    writeFileSync(join(repo, 'added.ts'), 'new\n');

    const result = saved(await capture(['.env.development', '.env', 'config/local.json']));

    expect(result.stats).toMatchObject({ files: 1, flags: [] });
    const text = result.patch.toString('utf8');
    expect(text).not.toContain('.env');
    expect(text).not.toContain('local.json');
  });

  it('refuses a file git cannot read, with git naming it', async () => {
    writeFileSync(join(repo, 'unread.txt'), 'secret\n');
    chmodSync(join(repo, 'unread.txt'), 0o000);
    try {
      const result = await capture();
      expect(result).toMatchObject({ kind: 'refused', reason: expect.stringContaining('unread.txt') });
      expect(readdirSync(scratch)).toEqual([]);
    } finally {
      chmodSync(join(repo, 'unread.txt'), 0o644);
    }
  });

  it('flags a file git normalizes on the way in, whose bytes in the patch are not those the task left', async () => {
    writeFileSync(join(repo, '.gitattributes'), '*.txt text eol=lf\n');
    writeFileSync(join(repo, 'crlf.txt'), 'one\r\ntwo\r\n');
    writeFileSync(join(repo, 'plain.txt'), 'one\ntwo\n');

    const result = saved(await capture());

    expect(result.stats.flags).toEqual([{ kind: 'normalized', count: 1, paths: ['crlf.txt'] }]);
    expect(result.patch.toString('utf8')).not.toContain('\r');
  });

  it('drops a file whose part of the patch is over the cap, and names it with its size', async () => {
    writeFileSync(join(repo, 'huge.txt'), `${'x'.repeat(1023)}\n`.repeat(PATCH_LIMITS.fileBytes / 1024 + 1));
    writeFileSync(join(repo, 'small.txt'), 'small\n');

    const result = saved(await capture());

    expect(result.stats.files).toBe(1);
    expect(result.stats.flags).toEqual([{ kind: 'dropped', count: 1, paths: [expect.stringMatching(/^huge\.txt \(1\.0 MB\)$/)] }]);
    expect(result.patch.toString('utf8')).not.toContain('huge.txt');
  });

  it('measures a small edit to a large file by its part of the patch, not by the file', async () => {
    writeFileSync(join(repo, 'big.txt'), `${'y'.repeat(1023)}\n`.repeat(PATCH_LIMITS.fileBytes / 1024 + 1));
    git(repo, 'add', 'big.txt');
    git(repo, 'commit', '-qm', 'big');
    writeFileSync(join(repo, 'big.txt'), `${readFileSync(join(repo, 'big.txt'), 'utf8')}one more\n`);

    expect(saved(await capture()).stats).toMatchObject({ files: 1, added: 1, flags: [] });
  });

  it('keeps a large file that only moved, measuring it by its rename in the patch and not by the removal and addition it is on disk', async () => {
    writeFileSync(join(repo, 'big.txt'), `${'y'.repeat(1023)}\n`.repeat(PATCH_LIMITS.fileBytes / 1024 + 1));
    git(repo, 'add', 'big.txt');
    git(repo, 'commit', '-qm', 'big');
    renameSync(join(repo, 'big.txt'), join(repo, 'moved é.txt'));
    writeFileSync(join(repo, 'moved é.txt'), `${readFileSync(join(repo, 'moved é.txt'), 'utf8')}one more\n`);

    const result = saved(await capture());

    expect(result.stats).toMatchObject({ files: 1, added: 1, removed: 0, flags: [] });
    expect(result.patch.toString('utf8')).toContain('rename from big.txt\nrename to "moved \\303\\251.txt"');
    expect(result.patch.length).toBeLessThan(16 * 1024);
  });

  it('drops a large file that was rewritten as it moved with its removal, as the one file the patch holds', async () => {
    writeFileSync(join(repo, 'big.txt'), `${'y'.repeat(1023)}\n`.repeat(PATCH_LIMITS.fileBytes / 1024 + 1));
    git(repo, 'add', 'big.txt');
    git(repo, 'commit', '-qm', 'big');
    rmSync(join(repo, 'big.txt'));
    writeFileSync(join(repo, 'rewritten.txt'), `${'z'.repeat(1023)}\n`.repeat(PATCH_LIMITS.fileBytes / 1024 + 1));
    writeFileSync(join(repo, 'small.txt'), 'small\n');

    const result = saved(await capture());

    expect(result.stats).toMatchObject({ files: 1, flags: [{ kind: 'dropped', count: 1, paths: [expect.stringMatching(/^rewritten\.txt \(/)] }] });
    expect(result.patch.toString('utf8')).not.toContain('big.txt');
  });

  it('counts a file whose type changed once, as the patch lists it', async () => {
    symlinkSync('README.md', join(repo, 'ln'));
    git(repo, 'add', 'ln');
    git(repo, 'commit', '-qm', 'link');
    rmSync(join(repo, 'ln'));
    writeFileSync(join(repo, 'ln'), 'a file now\n');

    const result = saved(await capture());

    expect(result.patch.toString('utf8').match(/^diff --git /gm)).toHaveLength(2);
    expect(result.stats).toMatchObject({ files: 1, added: 1, removed: 1 });
  });

  it('reads no git configuration from the home directory the task writes, which is scratch', async () => {
    writeFileSync(join(scratch, 'ignore'), 'added.ts\n');
    writeFileSync(join(scratch, '.gitconfig'), `[core]\n\texcludesFile = ${join(scratch, 'ignore')}\n`);
    writeFileSync(join(repo, 'added.ts'), 'new\n');

    const result = saved(await capture());

    expect(result.patch.toString('utf8')).toContain('diff --git a/added.ts b/added.ts');
  });

  /** The shell, with what a process the sealed run left behind does to scratch after each script. */
  const tampered = (after: (script: number, file: (suffix: string) => string) => void): TaskShell => {
    const plain = plainShell({ worktrees: [repo], scratch });
    return {
      ...plain,
      hold: (work) => plain.hold((own) => work({
        ...own,
        worktrees: [repo],
        scratch,
        touched: true,
        async run(script, cwd) {
          const ran = await own.run(script, cwd);
          const stem = readdirSync(scratch).find((name) => name.endsWith('.d'))!.slice(0, -2);
          after(plain.scripts, (suffix) => join(scratch, `${stem}.${suffix}`));
          return ran;
        },
      })),
    };
  };

  it('reads nothing a link in scratch points at in place of what the capture wrote', async () => {
    writeFileSync(join(repo, 'added.ts'), 'new\n');
    const secret = join(repo, '..', `${repo.split('/').pop()}-secret`);
    writeFileSync(secret, 'secret\n');
    try {
      const shell = tampered((script, file) => {
        if (script !== 1) return;
        rmSync(file('raw'));
        symlinkSync(secret, file('raw'));
      });
      expect(await capturePatch(shell)).toMatchObject({ kind: 'refused', reason: expect.stringContaining('left no raw Ordewell could read') });
    } finally {
      rmSync(secret, { force: true });
    }
  });

  it('keeps no patch that did not replay to the tree that was staged', async () => {
    writeFileSync(join(repo, 'added.ts'), 'new\n');
    const shell = tampered((script, file) => {
      if (script === 2) writeFileSync(file('replayed'), `${'b'.repeat(40)}\n`);
    });
    expect(await capturePatch(shell)).toMatchObject({ kind: 'refused', reason: expect.stringContaining('did not replay to the same tree') });
  });

  // A process a sealed command left behind outlives it, and scratch is its to write, so the capture trusts the bytes it reads and nothing git wrote beside them.
  describe('against a patch rewritten in scratch after git wrote it', () => {
    const linkPatch = (mode: string) => `diff --git a/evil b/evil\nnew file mode ${mode}\nindex 0000000..e69de29\n--- /dev/null\n+++ b/evil\n@@ -0,0 +1 @@\n+/etc\n\\ No newline at end of file\n`;
    const rewriting = (patch: string) => tampered((script, file) => {
      if (script === 2) writeFileSync(file('patch'), patch);
    });

    it.each([['120000'], ['0120000'], ['120755'], ['160000']])('keeps no patch that creates a %s entry', async (mode) => {
      writeFileSync(join(repo, 'added.ts'), 'new\n');

      expect(await capturePatch(rewriting(linkPatch(mode)))).toMatchObject({ kind: 'refused', reason: expect.stringContaining('link or a submodule') });
      expect(readdirSync(scratch)).toEqual([]);
    });

    it('keeps no patch that turns a file it modifies into a link, by its index line or its mode change', async () => {
      writeFileSync(join(repo, 'added.ts'), 'new\n');
      for (const header of ['index 1111111..2222222 120000', 'old mode 100644\nnew mode 120000']) {
        const patch = `diff --git a/README.md b/README.md\n${header}\n--- a/README.md\n+++ b/README.md\n@@ -1 +1 @@\n-one\n+two\n`;

        expect(await capturePatch(rewriting(patch)), header).toMatchObject({ kind: 'refused', reason: expect.stringContaining('link or a submodule') });
      }
    });

    it('counts the files and lines of the patch it keeps, not of a listing git wrote beside it', async () => {
      writeFileSync(join(repo, 'added.ts'), 'new\n');
      const rewritten = 'diff --git a/a.ts b/a.ts\nnew file mode 100644\nindex 0000000..e69de29\n--- /dev/null\n+++ b/a.ts\n@@ -0,0 +1,2 @@\n+one\n+two\n'
        + 'diff --git a/b.ts b/b.ts\nnew file mode 100644\nindex 0000000..e69de29\n--- /dev/null\n+++ b/b.ts\n@@ -0,0 +1 @@\n+three\n';

      const result = saved(await capturePatch(rewriting(rewritten)));

      expect(result.stats).toMatchObject({ files: 2, added: 3, removed: 0, binary: 0, bytes: rewritten.length });
    });
  });

  it('carries a rename, a mode change and a binary file as git would apply them', async () => {
    git(repo, 'mv', 'NOTES.md', 'docs.md');
    git(repo, 'reset', '-q');
    chmodSync(join(repo, 'README.md'), 0o755);
    writeFileSync(join(repo, 'blob.bin'), Buffer.from([0, 1, 2, 255, 0, 3]));

    const result = saved(await capture());

    const text = result.patch.toString('utf8');
    expect(text).toContain('rename from NOTES.md\nrename to docs.md');
    expect(text).toContain('old mode 100644\nnew mode 100755');
    expect(text).toContain('GIT binary patch');
    expect(result.stats).toMatchObject({ files: 3, binary: 1 });
  });
});

describe('patchReply', () => {
  const stats = { base: 'a'.repeat(40), files: 2, added: 5, removed: 1, binary: 0, bytes: 2048, sha256: 'b'.repeat(64), flags: [] };

  it('says what was saved, where, and that it is already in the handoff', () => {
    const artifact = patchArtifact(stats, { path: '.ordewell/sessions/s/tasks/t/1.patch', attempt: 1 });
    expect(artifact).toEqual({ kind: 'patch', path: '.ordewell/sessions/s/tasks/t/1.patch', attempt: 1, base: 'a'.repeat(40), files: 2, added: 5, removed: 1, binary: 0, bytes: 2048, sha256: 'b'.repeat(64) });
    const reply = patchReply({ kind: 'saved', patch: Buffer.alloc(0), stats }, artifact, undefined);
    expect(reply.isError).toBeUndefined();
    expect(reply.text).toContain('Saved 2 files, +5 -1, 2.0 KB, as a patch against commit aaaaaaaaaaaa: .ordewell/sessions/s/tasks/t/1.patch.');
    expect(reply.text).toContain('named in your handoff as a patch artifact');
  });

  it('lists what the patch does not carry as the worktree has it', () => {
    const flags = [{ kind: 'excluded' as const, count: 3, paths: ['a', 'b'] }];
    const reply = patchReply({ kind: 'saved', patch: Buffer.alloc(0), stats: { ...stats, flags } }, undefined, undefined);
    expect(reply.text).toContain('Not as your worktree has it:\n- not carried (links and submodules): 3 files (a, b, +1 more)');
  });

  it('refuses as an error, and says a patch saved earlier stays', () => {
    const earlier = patchArtifact(stats, { path: 'p', attempt: 1 });
    expect(patchReply({ kind: 'refused', reason: 'no.' }, undefined, earlier)).toEqual({ text: 'Nothing saved: no. The patch you saved earlier stays.', isError: true });
    expect(patchReply({ kind: 'empty', reason: 'nothing changed.', flags: [] }, undefined, undefined)).toEqual({ text: 'Nothing saved: nothing changed.' });
  });
});
