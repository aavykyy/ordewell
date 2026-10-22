import { promises as fs } from 'fs';
import * as path from 'path';

/**
 * What a read-only task's sealed runs may not leave for the tools that run
 * outside the sandbox (ADR-0046): a link out of its worktree, and a `.git`
 * where its runner's git starts.
 *
 * Links a read-only task's sealed runs left in its worktree that lead out of
 * it and the workspace. The task's runner reads that worktree with its
 * own tools, as the user and outside any sandbox, and its unsealed
 * commands read it in the planner's sandbox, which reads the whole host: a
 * link to `~/.ssh` there would hand either of them what a sealed run could
 * never read. Where the sandbox cannot refuse the link (bubblewrap), the task
 * shell removes it when the run ends, and nothing of the run is left to make
 * another, since the run's PID namespace ends with it.
 *
 * A `.git` the run planted is removed by the same walk. The runner's own git
 * starts where its command does and loads a `.git` there before any parent,
 * with whatever hooks, filters or `core.fsmonitor` the run gave it. One that
 * was under the writable directory before the task's first sealed run is the
 * checkout's: a submodule's `.git` file, a vendored repository, a worktree's
 * own. One planted later goes, and one that cannot be removed stops the task's
 * shell rather than stay for git to load.
 */

async function canonical(p: string): Promise<string> {
  try { return await fs.realpath(p); } catch { return path.resolve(p); }
}

function within(abs: string, roots: readonly string[]): boolean {
  return roots.some((root) => {
    const rel = path.relative(root, abs);
    return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
  });
}

/** Whether an entry is a `.git` git finds there; macOS's file system ignores case, so `.GIT` is one too. */
function isGitName(name: string): boolean {
  return name.toLowerCase() === '.git';
}

/** Where a link leads: its target on disk, or, dangling, the path it names. */
async function destination(link: string): Promise<string> {
  try { return await fs.realpath(link); } catch { /* dangling, or a loop */ }
  try { return path.resolve(path.dirname(link), await fs.readlink(link)); } catch { return link; }
}

/** Give the owner back full access to a directory the walk found, unless it no longer resolves to where it was found. */
async function opened(dir: string): Promise<boolean> {
  try {
    if ((await canonical(dir)) !== dir) return false;
    await fs.chmod(dir, ((await fs.lstat(dir)).mode & 0o7777) | 0o700);
    return true;
  } catch {
    return false;
  }
}

/** A file's state as the snapshot found it, and as the check finds it after a run (ADR-0046). */
type FileState =
  | { kind: 'missing' }
  | { kind: 'unreadable' }
  | { kind: 'bytes'; base64: string };

/** The entry names under a `.git` directory's `hooks/`. */
type HooksState =
  | { kind: 'missing' }
  | { kind: 'unreadable' }
  | { kind: 'entries'; names: string[] };

/**
 * A `.git` entry as the task's first sealed run found it, identity included
 * (ADR-0046): the sandbox refuses a write to it, and the check after every
 * run catches a backend that failed to, or an entry replaced at the same path.
 */
export type GitEntryState =
  | { path: string; directory: false; dev: number; ino: number; content: FileState }
  | { path: string; directory: true; dev: number; ino: number; content: FileState; hooks: HooksState };

async function fileState(file: string): Promise<FileState> {
  try {
    return { kind: 'bytes', base64: (await fs.readFile(file)).toString('base64') };
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'ENOENT' ? { kind: 'missing' } : { kind: 'unreadable' };
  }
}

async function hooksState(dir: string): Promise<HooksState> {
  try {
    return { kind: 'entries', names: (await fs.readdir(dir)).sort() };
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'ENOENT' ? { kind: 'missing' } : { kind: 'unreadable' };
  }
}

async function entryState(gitPath: string): Promise<GitEntryState | null> {
  try {
    const stat = await fs.stat(gitPath);
    if (stat.isDirectory()) {
      return {
        path: gitPath, directory: true, dev: stat.dev, ino: stat.ino,
        content: await fileState(path.join(gitPath, 'config')),
        hooks: await hooksState(path.join(gitPath, 'hooks')),
      };
    }
    // Neither a file nor a directory is nothing git can load, and reading a
    // FIFO as one would wait forever.
    if (!stat.isFile()) return null;
    return { path: gitPath, directory: false, dev: stat.dev, ino: stat.ino, content: await fileState(gitPath) };
  } catch {
    // Gone between readdir and stat: nothing to keep, and nothing to check.
    return null;
  }
}

/**
 * The `.git` entries under `dir`, with their identity, taken before a task's
 * first sealed run (ADR-0046). Whatever the checkout brought and the run did
 * not is in this set, and the sweep leaves it; anything else named `.git`
 * later was planted. Each entry is recorded with its identity, so the check
 * after every run can tell it from one the run put at the same path.
 */
export async function snapshotGitEntries(dir: string): Promise<GitBefore> {
  const top = await canonical(dir);
  const found = new Map<string, GitEntryState>();
  const walk = async (at: string): Promise<void> => {
    let entries;
    try {
      entries = await fs.readdir(at, { withFileTypes: true });
    } catch {
      if (!(await opened(at))) return;
      try { entries = await fs.readdir(at, { withFileTypes: true }); } catch { return; }
    }
    await Promise.all(entries.map(async (entry) => {
      const full = path.join(at, entry.name);
      if (isGitName(entry.name)) {
        // Record it, never walk in: a repository's own objects are not the
        // task's `.git` problem, and one can hold thousands of files.
        const gitPath = await canonical(full);
        if (found.has(gitPath)) return;
        const state = await entryState(gitPath);
        if (state) found.set(gitPath, state);
        return;
      }
      if (entry.isDirectory()) return walk(full);
    }));
  };
  await walk(top);
  const entries = [...found.values()].sort((a, b) => a.path.localeCompare(b.path));
  return { keep: new Set(entries.map((entry) => entry.path)), entries };
}

/** What the writable directory held before the task's first sealed run. */
export interface GitBefore {
  /** The canonical paths {@link snapshotGitEntries} found then. */
  keep: ReadonlySet<string>;
  /** Each of them as it was, for {@link changedGitEntries}. */
  entries: readonly GitEntryState[];
  /** The worktree roots whose own `.git` is the repository's: one per repo in a group. */
  worktrees?: readonly string[];
}

export interface SealedSweep {
  /** Links removed, relative to the walk root, sorted. */
  removedLinks: string[];
  /** A `.git` the run planted that the sweep removed, relative to the walk root, sorted. */
  removedGit: string[];
  /** A `.git` the run planted that the sweep could not remove, relative to the walk root, sorted. */
  stuckGit: string[];
}

/**
 * Move a `.git` aside, which takes one write to its directory however the run
 * left what it holds, then remove it. False when even the move failed: the
 * name still resolves, so git outside would find it.
 */
async function removeGitEntry(entry: string): Promise<boolean> {
  const dir = path.dirname(entry);
  const aside = path.join(dir, `.removed-git-${process.pid}-${Date.now()}`);
  try {
    await fs.rename(entry, aside);
  } catch {
    if (!(await opened(dir))) return false;
    try { await fs.rename(entry, aside); } catch { return false; }
  }
  await fs.rm(aside, { recursive: true, force: true }).catch(() => undefined);
  return true;
}

/**
 * Remove every link under `dir` that leads outside `roots`, and, when `git`
 * says what was there before, every `.git` the run planted after it. Returns
 * what was removed and what could not be. The walk never follows a link, a
 * directory the run left closed to its owner is opened to them, and a
 * directory that no longer resolves to where the walk found it is skipped
 * rather than removed from.
 */
export async function removeOutwardLinks(dir: string, roots: readonly string[], git?: GitBefore): Promise<SealedSweep> {
  const top = await canonical(dir);
  const inside = await Promise.all(roots.map(canonical));
  const worktrees = new Set(await Promise.all((git?.worktrees ?? []).map(canonical)));
  const sweep: SealedSweep = { removedLinks: [], removedGit: [], stuckGit: [] };
  // Every entry at once: it runs after each sealed command of a read-only
  // task, nearly all of its commands, and a worktree with its dependencies
  // installed holds thousands of directories, which one at a time is slow.
  const walk = async (at: string, checkGit: boolean): Promise<void> => {
    const here = await canonical(at);
    let entries;
    try {
      entries = await fs.readdir(at, { withFileTypes: true });
    } catch {
      // A run can leave a directory it may traverse but not list, hiding a
      // link that a read naming its path still follows; the user owns it, so
      // the walk takes the access back rather than skip it.
      if (!(await opened(at))) return;
      try { entries = await fs.readdir(at, { withFileTypes: true }); } catch { return; }
    }
    await Promise.all(entries.map(async (entry) => {
      const full = path.join(at, entry.name);
      if (checkGit && git && isGitName(entry.name)) {
        // A worktree's own `.git` and what the checkout brought stay. One
        // that is a directory is still walked for links, never for another
        // `.git`, since a repository's admin directory is not a task's
        // workspace; one the run planted where its runner's git starts goes.
        if (worktrees.has(here) || git.keep.has(await canonical(full))) return entry.isDirectory() ? walk(full, false) : undefined;
        const removed = await removeGitEntry(full);
        (removed ? sweep.removedGit : sweep.stuckGit).push(path.relative(top, full));
        return;
      }
      if (entry.isDirectory()) return walk(full, checkGit);
      if (!entry.isSymbolicLink() || within(await destination(full), inside)) return;
      if ((await canonical(at)) !== at) return;
      try {
        await fs.unlink(full);
      } catch {
        // Gone already, or in a directory the run left unwritable.
        if (!(await opened(at))) return;
        try { await fs.unlink(full); } catch { return; }
      }
      sweep.removedLinks.push(path.relative(top, full));
    }));
  };
  await walk(top, true);
  sweep.removedLinks.sort();
  sweep.removedGit.sort();
  sweep.stuckGit.sort();
  return sweep;
}

function sameFileState(a: FileState, b: FileState): boolean {
  if (a.kind !== b.kind) return false;
  return a.kind !== 'bytes' || b.kind !== 'bytes' || a.base64 === b.base64;
}

function sameHooks(a: HooksState, b: HooksState): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind !== 'entries' || b.kind !== 'entries') return true;
  return a.names.length === b.names.length && a.names.every((name, i) => name === b.names[i]);
}

async function changedEntry(entry: GitEntryState): Promise<boolean> {
  let stat;
  try {
    // The path, not what it points at: a link put here in place of the entry
    // is a change even when its target holds what was there (ADR-0046).
    stat = await fs.lstat(entry.path);
  } catch {
    return true;
  }
  // The path and its type are not enough: a run that could delete an entry
  // and make another there would pass a path-only check (ADR-0046).
  if (stat.isSymbolicLink() || stat.isDirectory() !== entry.directory) return true;
  if (!entry.directory && !stat.isFile()) return true;
  if (stat.dev !== entry.dev || stat.ino !== entry.ino) return true;
  if (!sameFileState(await fileState(entry.directory ? path.join(entry.path, 'config') : entry.path), entry.content)) return true;
  return entry.directory ? !sameHooks(await hooksState(path.join(entry.path, 'hooks')), entry.hooks) : false;
}

/**
 * Which `.git` entries the checkout brought are no longer what the task's
 * first sealed run found, relative to `root` and sorted (ADR-0046). The
 * profile refuses a write to each of them and to the worktree roots above
 * them, so a non-empty answer means the sandbox did not hold and the task's
 * shell must stop rather than let git outside load one.
 */
export async function changedGitEntries(entries: readonly GitEntryState[], root: string): Promise<string[]> {
  const top = await canonical(root);
  const changed = await Promise.all(entries.map(async (entry) => ((await changedEntry(entry)) ? path.relative(top, entry.path) : null)));
  return changed.filter((rel): rel is string => rel !== null).sort();
}

/**
 * Remove a `.git` a sealed run left at `dir`, a repo group's task workspace,
 * and say whether there was one (ADR-0046). The task's runner starts its own
 * git there, as the user and outside any sandbox, and git looks for a `.git`
 * where it starts before any parent, so one planted there would be the
 * repository it loads, with whatever `core.fsmonitor` the run gave it. Where
 * the sandbox cannot refuse creating it (bubblewrap) it is removed when the
 * run ends. A worktree root's own `.git` is the repository's and stays, and so
 * is one `keep` records from before the task's first sealed run.
 */
export async function removePlantedGit(dir: string, worktrees: readonly string[], keep?: ReadonlySet<string>): Promise<boolean> {
  const top = await canonical(dir);
  if ((await Promise.all(worktrees.map(canonical))).includes(top)) return false;
  const planted = path.join(top, '.git');
  try { await fs.lstat(planted); } catch { return false; }
  if (keep?.has(await canonical(planted))) return false;
  // Renamed first, which takes one write to `dir` however the run left the
  // inside, so git never finds it even where what it holds cannot be removed.
  const aside = path.join(top, `.removed-git-${process.pid}-${Date.now()}`);
  try {
    await fs.rename(planted, aside);
  } catch {
    if (!(await opened(top))) return false;
    try { await fs.rename(planted, aside); } catch { return false; }
  }
  await fs.rm(aside, { recursive: true, force: true }).catch(() => undefined);
  return true;
}
