import * as path from 'path';
import { SEARCH_EXCLUSIONS, type ToolOutcome } from '../interfaces/IFileSystem';

/** One directory entry, as the host's file API reports it. */
export interface DirEntry {
  name: string;
  directory: boolean;
}

const MAX_LINES = 300;
const NOT_DESCENDED = new Set<string>(SEARCH_EXCLUSIONS);

/**
 * `depth` levels of `root`, directories first, each level indented. Walked
 * here rather than by `tree`, which many machines (Windows among them) do not
 * have: without it the planner was shown one level and planned blind to
 * everything nested. Dependency and build directories are named but not
 * entered, as search skips them.
 *
 * `readEntries` throwing for `root` itself is the caller's error to report; a
 * nested directory that cannot be read is left out.
 */
export async function listTree(
  root: string,
  depth: number,
  readEntries: (abs: string) => Promise<DirEntry[]>,
): Promise<ToolOutcome> {
  const lines: string[] = [];
  let truncated = false;

  const walk = async (abs: string, level: number, entries: DirEntry[]): Promise<void> => {
    const sorted = [...entries].sort((a, b) => Number(b.directory) - Number(a.directory) || a.name.localeCompare(b.name));
    for (const entry of sorted) {
      if (lines.length >= MAX_LINES) {
        truncated = true;
        return;
      }
      lines.push(`${'  '.repeat(level)}${entry.directory ? 'D' : 'F'} ${entry.name}`);
      if (!entry.directory || level + 1 >= depth || NOT_DESCENDED.has(entry.name)) continue;
      const child = path.join(abs, entry.name);
      let nested: DirEntry[];
      try {
        nested = await readEntries(child);
      } catch {
        continue;
      }
      await walk(child, level + 1, nested);
    }
  };

  await walk(root, 0, await readEntries(root));
  return { success: true, output: lines.join('\n') || '(empty directory)', truncated };
}
