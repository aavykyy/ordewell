import * as path from 'path';
import { existsSync } from 'fs';
import type { IsolationRun } from '../interfaces/IWorktreeIsolation';
import { defaultExecFile, tryGit } from './gitExec';
import { repositoryRunnerConfigPaths } from './repositoryRunnerConfig';
import { augmentedPath } from '../utils/shellPath';

/** Configuration that differs from the run's base in the tree the runner will read. */
export async function taskStartConfig(run: IsolationRun | null, taskId: string, worktree: boolean): Promise<string[]> {
  if (!run) return [];
  const invoker = { exec: defaultExecFile, resolvePath: augmentedPath };
  const found: string[] = [];
  for (const repo of run.repos) {
    const cwd = worktree ? run.tasks[taskId]?.repos[repo.path]?.worktree : repo.root;
    if (!cwd || !repo.baseRef || !existsSync(cwd)) continue;
    const diff = await tryGit(invoker, cwd, ['diff', '--no-ext-diff', '--no-textconv', '--no-renames', '--name-only', '--diff-filter=ACMRTU', '-z', repo.baseRef, '--']);
    const untracked = await tryGit(invoker, cwd, ['ls-files', '--others', '-z', '--', '.mcp.json', '.claude', '.claude-plugin']);
    // Old restored runs and test doubles may have no reachable base or diff;
    // without evidence of a difference there is no reason to hold the start.
    if (!diff.ok || !untracked.ok) continue;
    const paths = repositoryRunnerConfigPaths([...diff.stdout.split('\0'), ...untracked.stdout.split('\0')]);
    found.push(...paths.map((name) => repo.path === '.' ? name : path.posix.join(repo.path, name)));
  }
  return [...new Set(found)].sort();
}
