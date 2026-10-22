import { promises as fs } from 'fs';
import * as path from 'path';

/**
 * Links a read-only task's sealed runs left in its worktree that lead out of
 * it and the workspace (ADR-0046). The task's runner reads that worktree with
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

/**
 * Remove every link under `dir` that leads outside `roots`, and return the
 * paths removed, relative to `dir`, sorted. The walk never follows a link,
 * and a directory that no longer resolves to where the walk found it is
 * skipped rather than removed from.
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
    try { entries = await fs.readdir(at, { withFileTypes: true }); } catch { return; }
    await Promise.all(entries.map(async (entry) => {
      const full = path.join(at, entry.name);
      if (entry.isDirectory()) return walk(full);
      if (!entry.isSymbolicLink() || within(await destination(full), inside)) return;
      if ((await canonical(at)) !== at) return;
      try {
        await fs.unlink(full);
        removed.push(path.relative(top, full));
      } catch { /* gone already */ }
    }));
  };
  await walk(top);
  return removed.sort();
}
