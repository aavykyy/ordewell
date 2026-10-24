import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { applyPatch, capturePatch, patchArtifact, type PatchApplyResult } from '../PatchCapture';
import { defaultExecFile } from '../gitExec';
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
});
