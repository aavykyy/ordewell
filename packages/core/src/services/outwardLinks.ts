import { promises as fs } from 'fs';
import * as path from 'path';

/**
 * What a read-only task's sealed runs may not leave for the tools that run
 * outside the sandbox (ADR-0046): a link out of its worktree, and a `.git`
 * where its runner's git starts.
 *
 * Links a read-only task's sealed runs left in its worktree that lead out of
 * it and the workspace. The task's runner reads that worktree with
 * its own tools, as the user and outside any sandbox, and its unsealed
 * commands read it in the planner's sandbox, which reads the whole host: a
 * link to `~/.ssh` there would hand either of them what a sealed run could
 * never read. Where the sandbox cannot refuse the link (bubblewrap), the task
 * shell removes it when the run ends, and nothing of the run is left to make
 * another, since the run's PID namespace ends with it.
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

/**
 * Remove every link under `dir` that leads outside `roots`, and return the
 * paths removed, relative to `dir`, sorted. The walk never follows a link,
 * a directory the run left closed to its owner is opened to them, and a
 * directory that no longer resolves to where the walk found it is skipped
 * rather than removed from.
 */
export async function removeOutwardLinks(dir: string, roots: readonly string[]): Promise<string[]> {
  const top = await canonical(dir);
  const inside = await Promise.all(roots.map(canonical));
  const removed: string[] = [];
  // Every entry at once: it runs after each sealed command of a read-only
  // task, nearly all of its commands, and a worktree with its dependencies
  // installed holds thousands of directories, which one at a time is slow.
  const walk = async (at: string): Promise<void> => {
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
      if (entry.isDirectory()) return walk(full);
      if (!entry.isSymbolicLink() || within(await destination(full), inside)) return;
      if ((await canonical(at)) !== at) return;
      try {
        await fs.unlink(full);
      } catch {
        // Gone already, or in a directory the run left unwritable.
        if (!(await opened(at))) return;
        try { await fs.unlink(full); } catch { return; }
      }
      removed.push(path.relative(top, full));
    }));
  };
  await walk(top);
  return removed.sort();
}

/**
 * Remove a `.git` a sealed run left at `dir`, a repo group's task workspace,
 * and say whether there was one (ADR-0046). The task's runner starts its own
 * git there, as the user and outside any sandbox, and git looks for a `.git`
 * where it starts before any parent, so one planted there would be the
 * repository it loads, with whatever `core.fsmonitor` the run gave it. Where
 * the sandbox cannot refuse creating it (bubblewrap) it is removed when the
 * run ends. A worktree root's own `.git` is the repository's and stays.
 */
export async function removePlantedGit(dir: string, worktrees: readonly string[]): Promise<boolean> {
  const top = await canonical(dir);
  if ((await Promise.all(worktrees.map(canonical))).includes(top)) return false;
  const planted = path.join(top, '.git');
  try { await fs.lstat(planted); } catch { return false; }
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
