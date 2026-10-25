import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { applyPatch, capturePatch, patchArtifact, type PatchApplyResult } from '../PatchCapture';
import { defaultExecFile, type GitInvoker } from '../gitExec';
import type { OwnSealedRuns, TaskShell } from '../../interfaces/IFileSystem';
import type { HandoffPatch } from '../../models/Handoff';

/**
 * A change task applying a saved patch (ADR-0050), end to end with real git:
 * the patch is captured from an explorer's worktree and applied in a builder's
 * at the same base, at a base that moved and merges, and at one that moved and
 * conflicts. Capture and apply are one concept, so the patch here is the
 * capture's own; its sealed runs are a plain shell, since `PatchCapture.e2e`
 * is the one that shows them sealed.
 */

const git = (cwd: string, ...args: string[]) => {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`git ${args.join(' ')}: ${result.stderr}`);
  return result.stdout;
};

const invoker = { exec: defaultExecFile, resolvePath: async () => process.env.PATH ?? '' };

function plainShell(worktree: string, scratch: string): TaskShell {
  const runs: OwnSealedRuns = {
    worktrees: [worktree],
    touched: true,
    scratch,
    async run(script, cwd) {
      const ran = spawnSync('/bin/sh', ['-c', script], { cwd, encoding: 'utf8', env: { PATH: process.env.PATH ?? '', HOME: scratch, TMPDIR: scratch } });
      return { success: ran.status === 0, output: `${ran.stdout}${ran.stderr}`, truncated: false };
    },
  };
  return { run: async () => ({ success: false, output: 'not used', truncated: false }), hold: (work) => work(runs), end() {} };
}

describe.skipIf(process.platform === 'win32')('applyPatch', () => {
  let repo: string;
  let scratch: string;
  let base: string;
  let patch: Buffer;
  let saved: HandoffPatch;
  let explorerTree: string;
  let worktrees = 0;

  const binaryA = Buffer.from(Array.from({ length: 2048 }, (_, i) => (i * 7) % 256));
  const binaryB = Buffer.from(Array.from({ length: 2048 }, (_, i) => (i * 11) % 256));
  const lines = (...text: string[]) => `${text.join('\n')}\n`;

  /** A worktree on its own branch, at `commit`, as Ordewell cuts a change task's. */
  function builder(commit: string): string {
    worktrees += 1;
    const dir = join(repo, '.ordewell', 'worktrees', `${worktrees}-build`);
    git(repo, 'worktree', 'add', '-q', '-b', `build-${worktrees}`, dir, commit);
    return dir;
  }

  function apply(worktree: string): Promise<PatchApplyResult> {
    return applyPatch(invoker, worktree, patch, saved);
  }

  const executable = (file: string) => (statSync(file).mode & 0o111) !== 0;

  const blob = (content: string) => spawnSync('git', ['hash-object', '--stdin'], { cwd: repo, input: content, encoding: 'utf8' }).stdout.trim();

  /** A patch written by hand, as a process that rewrote the saved file would, with the artifact that vouches for it: its size and hash are of these bytes. */
  function rewritten(text: string): { patch: Buffer; saved: HandoffPatch } {
    const hostile = Buffer.from(text, 'latin1');
    return { patch: hostile, saved: { ...saved, bytes: hostile.length, sha256: createHash('sha256').update(hostile).digest('hex') } };
  }

  beforeAll(async () => {
    repo = realpathSync(mkdtempSync(join(tmpdir(), 'ordewell-apply-repo-')));
    scratch = realpathSync(mkdtempSync(join(tmpdir(), 'ordewell-apply-scratch-')));
    git(repo, 'init', '-q', '-b', 'main');
    git(repo, 'config', 'user.email', 't@t');
    git(repo, 'config', 'user.name', 't');
    mkdirSync(join(repo, 'src'));
    mkdirSync(join(repo, 'docs'));
    writeFileSync(join(repo, 'src', 'greet.ts'), lines('export function greet() {', '  return "hello";', '}', '', 'export const tail = 1;'));
    writeFileSync(join(repo, 'docs', 'guide.md'), lines('# Guide', '', 'line one', 'line two', 'line three'));
    writeFileSync(join(repo, 'src', 'old-name.txt'), lines('a', 'b', 'c', 'd', 'e', 'f', 'g'));
    writeFileSync(join(repo, 'README.md'), lines('# repo', '', 'one', 'two', 'three', 'four', 'five', 'six'));
    writeFileSync(join(repo, 'assets.bin'), binaryA);
    writeFileSync(join(repo, 'gone.txt'), 'to be deleted\n');
    writeFileSync(join(repo, '.gitignore'), '.ordewell/\n');
    // A link the repository tracks: a capture never carries a change to one, so a patch that edits it was not written by one.
    symlinkSync('README.md', join(repo, 'latest'));
    git(repo, 'add', '-A');
    git(repo, 'commit', '-qm', 'base');
    base = git(repo, 'rev-parse', 'HEAD').trim();

    // The explorer's prototype: a modified file, a new executable one, a rename with an edit, a binary replaced, a deletion.
    const explorer = join(repo, '.ordewell', 'worktrees', '0-explore');
    git(repo, 'worktree', 'add', '-q', '-b', 'explore', explorer, base);
    writeFileSync(join(explorer, 'src', 'greet.ts'), lines('export function greet() {', '  return "hello, world";', '}', '', 'export const tail = 1;'));
    writeFileSync(join(explorer, 'docs', 'guide.md'), lines('# Guide', '', 'line one', 'line two, as the prototype has it', 'line three'));
    writeFileSync(join(explorer, 'src', 'feature.ts'), 'export const feature = true;\n');
    chmodSync(join(explorer, 'src', 'feature.ts'), 0o755);
    git(explorer, 'mv', 'src/old-name.txt', 'src/new-name.txt');
    writeFileSync(join(explorer, 'src', 'new-name.txt'), lines('a', 'b', 'c', 'd', 'e', 'f', 'g-edited'));
    writeFileSync(join(explorer, 'assets.bin'), binaryB);
    rmSync(join(explorer, 'gone.txt'));
    const captured = await capturePatch(plainShell(explorer, scratch));
    if (captured.kind !== 'saved') throw new Error(`not saved: ${captured.reason}`);
    patch = captured.patch;
    saved = patchArtifact(captured.stats, { path: '.ordewell/sessions/s/tasks/t/1.patch', attempt: 1 });
    git(explorer, 'add', '-A');
    explorerTree = git(explorer, 'write-tree').trim();
    git(explorer, 'reset', '-q');
  });

  afterAll(() => {
    rmSync(repo, { recursive: true, force: true });
    rmSync(scratch, { recursive: true, force: true });
  });

  // Capture stages in a copy of the worktree's index, and git rehashes only an
  // entry it calls racily clean: one whose cached mtime is no earlier than the
  // index's own. A copy made now is newer than every entry, so a same-size
  // rewrite whose stat the cache cannot tell apart keeps the base blob and
  // silently falls out of the patch.
  it('carries a same-size rewrite captured a second after the edit', async () => {
    const explorer = join(repo, '.ordewell', 'worktrees', 'same-size');
    git(repo, 'worktree', 'add', '-q', '-b', 'same-size', explorer, base);
    const asset = join(explorer, 'assets.bin');
    const indexPath = join(git(explorer, 'rev-parse', '--absolute-git-dir').trim(), 'index');
    const secondOf = (path: string) => Math.floor(statSync(path).mtimeMs / 1000);
    const cachedSecond = () => Number(/mtime: (\d+)/.exec(git(explorer, 'ls-files', '--debug', 'assets.bin'))![1]);

    // A refresh and a rewrite that straddle a second leave the cache a second
    // behind. Start again in the next second rather than sleep until one fits:
    // only the refresh and the 2 KiB rewrite are inside the window.
    let missed = '';
    let ready = false;
    for (let attempt = 1; attempt <= 8 && !ready; attempt += 1) {
      while (Date.now() % 1000 > 50) await new Promise((resolve) => setTimeout(resolve, 5));
      writeFileSync(asset, binaryA);
      git(explorer, 'update-index', '--refresh');
      writeFileSync(asset, binaryB);
      const [cached, file, index] = [cachedSecond(), secondOf(asset), secondOf(indexPath)];
      ready = cached === file && index === cached;
      missed = `attempt ${attempt}: cached ${cached}, file ${file}, index ${index}`;
    }
    // Explicit, not a skip: without a same-second cache there is no defect here to test.
    expect(ready, `the index cache and the rewrite never shared a second (${missed})`).toBe(true);
    // The worktree's own index is racily clean and sees the rewrite; only the
    // capture's fresh copy of it is not.
    expect(statSync(asset).size).toBe(binaryA.length);
    expect(git(explorer, 'diff-files', '--name-only')).toContain('assets.bin');

    writeFileSync(join(explorer, 'src', 'greet.ts'), lines('export function greet() {', '  return "hello, from the cached second";', '}', '', 'export const tail = 1;'));

    // Capture after that second: the copy of the index now looks newer than the
    // entry, so git trusts the stat the rewrite left behind.
    await new Promise((resolve) => setTimeout(resolve, 1100));

    const captured = await capturePatch(plainShell(explorer, scratch));

    expect(captured.kind).toBe('saved');
    if (captured.kind !== 'saved') return;
    expect(captured.patch.toString('latin1')).toContain('diff --git a/assets.bin b/assets.bin');
    expect(captured.stats).toMatchObject({ files: 2, binary: 1 });

    git(explorer, 'add', '-A');
    const expectedTree = git(explorer, 'write-tree').trim();
    const dir = builder(base);
    const result = await applyPatch(invoker, dir, captured.patch, patchArtifact(captured.stats, { path: '.ordewell/sessions/s/tasks/t/3.patch', attempt: 1 }));

    expect(result).toEqual({ kind: 'applied', sameBase: true, head: base, files: 2 });
    expect(git(dir, 'write-tree').trim()).toBe(expectedTree);
    expect(readFileSync(join(dir, 'assets.bin')).equals(binaryB)).toBe(true);
  });

  it('gives the explorer\'s tree, mode for mode, at the base it was taken against', async () => {
    const dir = builder(base);

    const result = await apply(dir);

    expect(result).toEqual({ kind: 'applied', sameBase: true, head: base, files: 6 });
    expect(git(dir, 'write-tree').trim()).toBe(explorerTree);
    expect(readFileSync(join(dir, 'assets.bin')).equals(binaryB)).toBe(true);
    expect(executable(join(dir, 'src', 'feature.ts'))).toBe(true);
    expect(existsSync(join(dir, 'gone.txt'))).toBe(false);
    expect(git(dir, 'status', '--porcelain').split('\n').filter(Boolean).sort()).toEqual([
      'A  src/feature.ts', 'D  gone.txt', 'M  assets.bin', 'M  docs/guide.md', 'M  src/greet.ts', 'R  src/old-name.txt -> src/new-name.txt',
    ]);
  });

  describe('where the base has moved', () => {
    let moved: string;
    let conflicting: string;

    beforeAll(() => {
      // Other work landed on other lines of the same files, and in a file the patch does not touch.
      const dir = builder(base);
      writeFileSync(join(dir, 'src', 'greet.ts'), lines('// greets', 'export function greet() {', '  return "hello";', '}', '', 'export const tail = 1;'));
      writeFileSync(join(dir, 'src', 'old-name.txt'), lines('a-upstream', 'b', 'c', 'd', 'e', 'f', 'g'));
      writeFileSync(join(dir, 'README.md'), lines('# repo', '', 'one', 'two', 'three', 'four', 'five', 'six', 'seven'));
      git(dir, 'add', '-A');
      git(dir, 'commit', '-qm', 'other work');
      moved = git(dir, 'rev-parse', 'HEAD').trim();

      // And other work that changed the very lines the patch changes, and the binary the patch replaces.
      const clash = builder(base);
      writeFileSync(join(clash, 'src', 'greet.ts'), lines('export function greet() {', '  return "hi there";', '}', '', 'export const tail = 1;'));
      writeFileSync(join(clash, 'docs', 'guide.md'), lines('# Guide', '', 'line one', 'line two, as upstream has it', 'line three'));
      writeFileSync(join(clash, 'assets.bin'), Buffer.from(Array.from({ length: 2048 }, (_, i) => (i * 13) % 256)));
      git(clash, 'add', '-A');
      git(clash, 'commit', '-qm', 'clashing work');
      conflicting = git(clash, 'rev-parse', 'HEAD').trim();
    });

    it('merges what the other work did not touch and says so', async () => {
      const dir = builder(moved);

      const result = await apply(dir);

      expect(result).toEqual({ kind: 'applied', sameBase: false, head: moved, files: 6 });
      expect(readFileSync(join(dir, 'src', 'greet.ts'), 'utf8')).toBe(lines('// greets', 'export function greet() {', '  return "hello, world";', '}', '', 'export const tail = 1;'));
      // The rename carries the edit, and the other work's edit to the file it moved.
      expect(readFileSync(join(dir, 'src', 'new-name.txt'), 'utf8')).toBe(lines('a-upstream', 'b', 'c', 'd', 'e', 'f', 'g-edited'));
      expect(readFileSync(join(dir, 'README.md'), 'utf8')).toContain('seven');
      expect(git(dir, 'ls-files', '-u')).toBe('');
    });

    it('reports each conflicted path and what kind it is, leaves the markers in the worktree, and applies the rest', async () => {
      const dir = builder(conflicting);

      const result = await apply(dir);

      expect(result).toEqual({
        kind: 'conflicted',
        sameBase: false,
        head: conflicting,
        files: 6,
        conflicts: [
          { path: 'assets.bin', binary: true },
          { path: 'docs/guide.md', binary: false },
          { path: 'src/greet.ts', binary: false },
        ],
      });
      const markers = readFileSync(join(dir, 'src', 'greet.ts'), 'utf8');
      expect(markers).toContain('<<<<<<<');
      expect(markers).toContain('return "hi there";');
      expect(markers).toContain('return "hello, world";');
      expect(markers).toContain('>>>>>>>');
      expect(git(dir, 'ls-files', '-u', '-z').split('\0').filter(Boolean).map((r) => r.split('\t')[1]).sort()).toEqual([
        'assets.bin', 'assets.bin', 'assets.bin', 'docs/guide.md', 'docs/guide.md', 'docs/guide.md', 'src/greet.ts', 'src/greet.ts', 'src/greet.ts',
      ]);
      // What did not conflict is in, and staged.
      expect(executable(join(dir, 'src', 'feature.ts'))).toBe(true);
      expect(existsSync(join(dir, 'gone.txt'))).toBe(false);
      expect(git(dir, 'diff', '--cached', '--name-status')).toContain('A\tsrc/feature.ts');
      // The task resolves them as it would any merge: the sides are the worktree's (ours) and the patch's (theirs).
      git(dir, 'checkout', '--theirs', '--', 'assets.bin');
      expect(readFileSync(join(dir, 'assets.bin')).equals(binaryB)).toBe(true);
    });

    it('applies none of a patch that deletes a file the other work changed, and says which, rather than leaving a half-merge', async () => {
      const dir = builder(base);
      writeFileSync(join(dir, 'gone.txt'), 'still wanted\n');
      git(dir, 'add', '-A');
      git(dir, 'commit', '-qm', 'changes what the patch deletes');
      const status = git(dir, 'status', '--porcelain=v2');

      const result = await apply(dir);

      expect(result).toMatchObject({ kind: 'refused', reason: expect.stringContaining('error: gone.txt: patch does not apply') });
      expect(git(dir, 'status', '--porcelain=v2')).toBe(status);
      expect(existsSync(join(dir, 'src', 'feature.ts'))).toBe(false);
    });

    it('refuses to apply over conflicts the task has not resolved, and touches nothing', async () => {
      const dir = builder(conflicting);
      await apply(dir);
      const before = git(dir, 'status', '--porcelain=v2');

      const result = await apply(dir);

      expect(result).toMatchObject({ kind: 'refused', reason: expect.stringContaining('docs/guide.md') });
      expect(git(dir, 'status', '--porcelain=v2')).toBe(before);
    });
  });

  it('refuses a worktree whose files the task already changed, with git\'s reason, and applies none of the patch', async () => {
    const dir = builder(base);
    writeFileSync(join(dir, 'src', 'greet.ts'), 'edited by the builder, not staged\n');

    const result = await apply(dir);

    expect(result).toMatchObject({ kind: 'refused', reason: expect.stringContaining('src/greet.ts: does not match index') });
    expect(existsSync(join(dir, 'src', 'feature.ts'))).toBe(false);
    expect(readFileSync(join(dir, 'src', 'greet.ts'), 'utf8')).toBe('edited by the builder, not staged\n');
  });

  it('refuses when the commit the patch was taken against is not in this repository', async () => {
    const dir = builder(base);

    const result = await applyPatch(invoker, dir, patch, { ...saved, base: 'f'.repeat(40) });

    expect(result).toMatchObject({ kind: 'refused', reason: expect.stringContaining('ffffffffffff') });
    expect(existsSync(join(dir, 'src', 'feature.ts'))).toBe(false);
  });

  it('refuses a directory that is not the root of a worktree of its own', async () => {
    const dir = builder(base);

    expect(await applyPatch(invoker, join(dir, 'src'), patch, saved)).toMatchObject({ kind: 'refused', reason: expect.stringContaining('not the root') });
  });

  describe('a link the repository tracks', () => {
    /** A hunk that points `latest` at /etc/passwd, git's own way of writing a one-line file with no newline at its end. */
    const retarget = ['@@ -1 +1 @@', '-README.md', '\\ No newline at end of file', '+/etc/passwd', '\\ No newline at end of file', ''];
    const was = () => blob('README.md').slice(0, 12);
    const now = () => blob('/etc/passwd').slice(0, 12);

    // Each is a section git would apply to `latest` and keep a link, though no mode line says so.
    const attacks: Array<[string, string[]]> = [
      ['edits it and names no mode', ['diff --git a/latest b/latest', `index ${was()}..${now()}`, '--- a/latest', '+++ b/latest', ...retarget]],
      ['renames it with an edit', ['diff --git a/latest b/moved', 'similarity index 50%', 'rename from latest', 'rename to moved', `index ${was()}..${now()}`, '--- a/latest', '+++ b/moved', ...retarget]],
      ['copies it with an edit', ['diff --git a/latest b/copied', 'similarity index 50%', 'copy from latest', 'copy to copied', `index ${was()}..${now()}`, '--- a/latest', '+++ b/copied', ...retarget]],
      ['names another file in its first line and the link in its --- and +++ lines', ['diff --git a/README.md b/README.md', `index ${was()}..${now()}`, '--- a/latest', '+++ b/latest', ...retarget]],
    ];

    it.each(attacks)('is not retargeted by a patch that %s', async (_, section) => {
      const dir = builder(base);
      const { patch: hostile, saved: vouched } = rewritten(section.join('\n'));
      const status = git(dir, 'status', '--porcelain=v2');

      const result = await applyPatch(invoker, dir, hostile, vouched);

      expect(result).toMatchObject({ kind: 'refused', reason: expect.stringMatching(/would leave .*(latest|moved|copied).* as a link or a submodule/) });
      expect(readlinkSync(join(dir, 'latest'))).toBe('README.md');
      expect(existsSync(join(dir, 'moved')) || existsSync(join(dir, 'copied'))).toBe(false);
      expect(git(dir, 'status', '--porcelain=v2')).toBe(status);
      expect(git(dir, 'ls-files', '-s', 'latest').split(' ')[0]).toBe('120000');
    });

    // Git before 2.32 refuses --cached with --3way, so there the trial never applies, and what the apply would leave is not known.
    it('is not retargeted where git cannot try the patch on a copy of the index', async () => {
      const dir = builder(base);
      const { patch: hostile, saved: vouched } = rewritten(attacks[0][1].join('\n'));
      const olderGit: GitInvoker = {
        ...invoker,
        exec: async (file, args, opts) => {
          if (args.includes('--cached') && args.includes('--3way')) throw Object.assign(new Error('git apply failed'), { stdout: '', stderr: 'error: --cached and --3way cannot be used together.\n', code: 1 });
          return invoker.exec(file, args, opts);
        },
      };
      const status = git(dir, 'status', '--porcelain=v2');

      const result = await applyPatch(olderGit, dir, hostile, vouched);

      expect(result).toMatchObject({ kind: 'refused', reason: expect.stringContaining('--cached and --3way cannot be used together') });
      expect(readlinkSync(join(dir, 'latest'))).toBe('README.md');
      expect(git(dir, 'status', '--porcelain=v2')).toBe(status);
    });

    it('still takes the capture\'s own deletion of it, and leaves the rest of the tree as it was', async () => {
      const explorer = join(repo, '.ordewell', 'worktrees', 'drops-link');
      git(repo, 'worktree', 'add', '-q', '-b', 'drops-link', explorer, base);
      rmSync(join(explorer, 'latest'));
      writeFileSync(join(explorer, 'README.md'), lines('# repo', '', 'one', 'two', 'three', 'four', 'five', 'six', 'edited'));
      const captured = await capturePatch(plainShell(explorer, scratch));
      if (captured.kind !== 'saved') throw new Error(`not saved: ${captured.reason}`);
      const dir = builder(base);

      const result = await applyPatch(invoker, dir, captured.patch, patchArtifact(captured.stats, { path: '.ordewell/sessions/s/tasks/t/2.patch', attempt: 1 }));

      expect(result).toMatchObject({ kind: 'applied', sameBase: true });
      expect(git(dir, 'ls-files', '-s', 'latest')).toBe('');
      expect(git(dir, 'status', '--porcelain').split('\n').filter(Boolean).sort()).toEqual(['D  latest', 'M  README.md']);
    });
  });

  describe('a path that leads out of the worktree', () => {
    let outside: string;
    let withSubmodule: string;

    beforeAll(() => {
      outside = realpathSync(mkdtempSync(join(tmpdir(), 'ordewell-apply-outside-')));
      mkdirSync(join(outside, '.claude'));
      writeFileSync(join(outside, '.claude', 'settings.json'), '{}\n');
      mkdirSync(join(outside, 'pkg'));
      writeFileSync(join(outside, 'pkg', 'index.js'), 'module.exports = 1;\n');
      // A submodule the repository tracks, which a worktree checks out as an empty directory.
      const dir = builder(base);
      git(dir, 'update-index', '--add', '--cacheinfo', `160000,${'1'.repeat(40)},sub`);
      git(dir, 'commit', '-qm', 'a submodule');
      withSubmodule = git(dir, 'rev-parse', 'HEAD').trim();
    });

    afterAll(() => rmSync(outside, { recursive: true, force: true }));

    /** A builder's worktree as the bootstrap leaves it: `.claude` linked whole and `node_modules` mirrored entry by entry, untracked, each link an absolute path out of it. */
    function bootstrapped(commit = base): string {
      const dir = builder(commit);
      symlinkSync(join(outside, '.claude'), join(dir, '.claude'));
      mkdirSync(join(dir, 'node_modules'));
      symlinkSync(join(outside, 'pkg'), join(dir, 'node_modules', 'pkg'));
      return dir;
    }

    const hooks = '{"hooks":{"SessionStart":[]}}\n';
    /** One section that creates `name`, as `git diff` writes a new file. */
    const creating = (name: string) => [`diff --git a/${name} b/${name}`, 'new file mode 100644', `index ${'0'.repeat(40)}..${blob(hooks)}`, '--- /dev/null', `+++ b/${name}`, '@@ -0,0 +1 @@', `+${hooks.trimEnd()}`];
    const outsideNow = () => [readdirSync(join(outside, '.claude')).sort(), readdirSync(join(outside, 'pkg')).sort()];
    const everything = (dir: string) => [git(dir, 'ls-files', '-s'), git(dir, 'status', '--porcelain=v2', '--untracked-files=all')];

    // No record of what was linked in: the links on disk alone refuse it.
    it.each([
      ['.claude, which the bootstrap linked to the main checkout\'s', '.claude/settings.local.json', '.claude', '.claude'],
      ['node_modules/pkg, which the bootstrap mirrored from the main checkout\'s package', 'node_modules/pkg/index.js', 'node_modules/pkg', 'pkg'],
    ])('refuses a file under %s, and writes nothing anywhere', async (_, name, link, target) => {
      const dir = bootstrapped();
      const { patch: hostile, saved: vouched } = rewritten(`${creating(name).join('\n')}\n`);
      const before = [...everything(dir), ...outsideNow()];

      const result = await applyPatch(invoker, dir, hostile, vouched);

      expect(result).toMatchObject({ kind: 'refused', reason: expect.stringContaining(name) });
      expect(result).toMatchObject({ reason: expect.stringContaining(`under ${link}, a link to ${join(outside, target)}`) });
      expect([...everything(dir), ...outsideNow()]).toEqual(before);
    });

    // Git refuses a path under a submodule only as it adds it to the index, after it has written the patch's earlier files.
    it('refuses a file under a link where git would stop at a later path, and writes nothing anywhere', async () => {
      const dir = bootstrapped(withSubmodule);
      const { patch: hostile, saved: vouched } = rewritten(`${[...creating('.claude/settings.local.json'), ...creating('sub/x')].join('\n')}\n`);
      const before = [...everything(dir), ...outsideNow(), readdirSync(join(dir, 'sub'))];

      const result = await applyPatch(invoker, dir, hostile, vouched);

      expect(result).toMatchObject({ kind: 'refused', reason: expect.stringContaining(`.claude/settings.local.json, under .claude, a link to ${join(outside, '.claude')}`) });
      expect([...everything(dir), ...outsideNow(), readdirSync(join(dir, 'sub'))]).toEqual(before);
    });

    it('refuses a rename whose target is under a link, and leaves the file where it was', async () => {
      const dir = bootstrapped();
      const was = lines('a', 'b', 'c', 'd', 'e', 'f', 'g');
      const renaming = ['diff --git a/src/old-name.txt b/.claude/moved.md', 'similarity index 100%', 'rename from src/old-name.txt', 'rename to .claude/moved.md'];
      const { patch: hostile, saved: vouched } = rewritten(`${renaming.join('\n')}\n`);
      const before = [...everything(dir), ...outsideNow()];

      const result = await applyPatch(invoker, dir, hostile, vouched);

      expect(result).toMatchObject({ kind: 'refused', reason: expect.stringContaining('.claude/moved.md, under .claude, a link to') });
      expect([...everything(dir), ...outsideNow()]).toEqual(before);
      expect(readFileSync(join(dir, 'src', 'old-name.txt'), 'utf8')).toBe(was);
    });

    it('refuses a patch that makes a directory a link and writes beneath it, before git runs', async () => {
      const dir = bootstrapped();
      const linking = ['diff --git a/vendored b/vendored', 'new file mode 120000', `index ${'0'.repeat(40)}..${blob(join(outside, 'pkg'))}`, '--- /dev/null', '+++ b/vendored', '@@ -0,0 +1 @@', `+${join(outside, 'pkg')}`, '\\ No newline at end of file'];
      const { patch: hostile, saved: vouched } = rewritten(`${[...linking, ...creating('vendored/index.js')].join('\n')}\n`);
      const before = [...everything(dir), ...outsideNow()];

      const result = await applyPatch(invoker, dir, hostile, vouched);

      expect(result).toMatchObject({ kind: 'refused', reason: expect.stringContaining('holds a link or a submodule') });
      expect([...everything(dir), ...outsideNow()]).toEqual(before);
    });

    // A `.git` in any spelling, anywhere in a path, would load a repository of the patch's own. In a worktree `.git` is a file, which the walk will not write under; git refuses every other spelling and place itself, reading no index for it.
    it.each(['.git/hooks/pre-commit', 'src/.git', '.GIT/hooks/pre-commit'])('refuses %s, a path into a repository, and writes nothing', async (name) => {
      const dir = bootstrapped();
      const { patch: hostile, saved: vouched } = rewritten(`${[...creating('src/added.ts'), ...creating(name)].join('\n')}\n`);
      const before = everything(dir);

      const result = await applyPatch(invoker, dir, hostile, vouched);

      expect(result).toMatchObject({ kind: 'refused', reason: expect.stringMatching(/invalid path|which is not a directory/) });
      expect(result).toMatchObject({ reason: expect.stringContaining(name) });
      expect(everything(dir)).toEqual(before);
      expect(existsSync(join(dir, 'src', 'added.ts'))).toBe(false);
    });

    it('refuses a path under a name Ordewell linked in where nothing on disk leads out yet, since landing would drop it', async () => {
      const dir = bootstrapped();
      const { patch: hostile, saved: vouched } = rewritten(`${creating('node_modules/fresh/index.js').join('\n')}\n`);
      const before = everything(dir);

      const result = await applyPatch(invoker, dir, hostile, vouched, { linked: ['.claude', 'node_modules'] });

      expect(result).toMatchObject({ kind: 'refused', reason: expect.stringContaining('node_modules/fresh/index.js') });
      expect(result).toMatchObject({ reason: expect.stringContaining('under node_modules, which Ordewell linked') });
      expect(everything(dir)).toEqual(before);
      expect(existsSync(join(dir, 'node_modules', 'fresh'))).toBe(false);
    });

    // Git would write the patch's other files first and then stop, leaving them untracked, with nothing staged to say so.
    it('refuses a path under something on disk that is not a directory, and writes none of the patch', async () => {
      const dir = bootstrapped();
      writeFileSync(join(dir, 'notes'), 'the builder\'s own, untracked\n');
      const { patch: hostile, saved: vouched } = rewritten(`${[...creating('src/added.ts'), ...creating('notes/x')].join('\n')}\n`);
      const before = everything(dir);

      const result = await applyPatch(invoker, dir, hostile, vouched);

      expect(result).toMatchObject({ kind: 'refused', reason: expect.stringContaining('notes/x, under notes, which is not a directory') });
      expect(everything(dir)).toEqual(before);
      expect(existsSync(join(dir, 'src', 'added.ts'))).toBe(false);
    });

    // On disk a submodule is a directory, so only the index says that git would write the file and then stop as it stages it.
    it('refuses a path under a submodule the repository tracks, and writes none of the patch', async () => {
      const dir = bootstrapped(withSubmodule);
      const { patch: hostile, saved: vouched } = rewritten(`${[...creating('src/added.ts'), ...creating('sub/x')].join('\n')}\n`);
      const before = [...everything(dir), readdirSync(join(dir, 'sub'))];

      const result = await applyPatch(invoker, dir, hostile, vouched);

      expect(result).toMatchObject({ kind: 'refused', reason: expect.stringContaining('sub/x, under sub, a submodule') });
      expect([...everything(dir), readdirSync(join(dir, 'sub'))]).toEqual(before);
      expect(existsSync(join(dir, 'src', 'added.ts'))).toBe(false);
    });

    // Git stops at the first file it cannot write, here one over a directory the builder made, after it has written those before it.
    it('says which files git wrote before it stopped, rather than that it applied none of the patch', async () => {
      const dir = bootstrapped();
      mkdirSync(join(dir, 'notes'));
      writeFileSync(join(dir, 'notes', 'mine.md'), 'the builder\'s own, untracked\n');
      const { patch: hostile, saved: vouched } = rewritten(`${[...creating('src/added.ts'), ...creating('notes')].join('\n')}\n`);
      const index = git(dir, 'ls-files', '-s');

      const result = await applyPatch(invoker, dir, hostile, vouched);

      expect(result).toEqual({ kind: 'stopped', changed: ['src/added.ts'], reason: expect.stringContaining('unable to write file \'notes\'') });
      expect(git(dir, 'ls-files', '-s')).toBe(index);
      expect(readFileSync(join(dir, 'src', 'added.ts'), 'utf8')).toBe(hooks);
    });

    it('still applies a patch that removes a file and puts a directory of the same name in its place', async () => {
      const dir = bootstrapped();
      const removing = ['diff --git a/gone.txt b/gone.txt', 'deleted file mode 100644', `index ${blob('to be deleted\n')}..${'0'.repeat(40)}`, '--- a/gone.txt', '+++ /dev/null', '@@ -1 +0,0 @@', '-to be deleted'];
      const { patch: moved, saved: vouched } = rewritten(`${[...removing, ...creating('gone.txt/inner')].join('\n')}\n`);

      const result = await applyPatch(invoker, dir, moved, vouched, { linked: ['.claude', 'node_modules'] });

      expect(result).toMatchObject({ kind: 'applied', sameBase: true });
      expect(git(dir, 'status', '--porcelain', '--untracked-files=no').split('\n').filter(Boolean).sort()).toEqual(['A  gone.txt/inner', 'D  gone.txt']);
      expect(readFileSync(join(dir, 'gone.txt', 'inner'), 'utf8')).toBe(hooks);
    });

    // A case-insensitive file system (macOS, Windows) finds the link by any spelling; a case-sensitive one would land a twin of it on main.
    it('refuses a case variant of a name Ordewell linked in, and writes nothing anywhere', async () => {
      const dir = bootstrapped();
      const { patch: hostile, saved: vouched } = rewritten(`${creating('.CLAUDE/settings.local.json').join('\n')}\n`);
      const before = [...everything(dir), ...outsideNow()];

      const result = await applyPatch(invoker, dir, hostile, vouched, { linked: ['.claude', 'node_modules'] });

      expect(result).toMatchObject({ kind: 'refused', reason: expect.stringContaining('.CLAUDE/settings.local.json') });
      expect(result).toMatchObject({ reason: expect.stringContaining('under .claude, which Ordewell linked') });
      expect([...everything(dir), ...outsideNow()]).toEqual(before);
    });
  });
});
