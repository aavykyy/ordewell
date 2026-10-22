import * as fs from 'fs';
import * as path from 'path';
import { devNull } from 'os';
import type { IsolationRun } from '../interfaces/IWorktreeIsolation';
import { git, tryGit, type GitInvoker } from './gitExec';

export interface TaskDiffRead {
  repo?: string;
  path?: string;
}

export type TaskDiffResult = { available: true; text: string } | { available: false; reason: string };

export const TASK_DIFF_UNAVAILABLE = 'Task diff is not available for this run: no task-specific changes were recorded (shared runs cannot attribute workspace changes to one task).';

interface DiffFile {
  repo: string;
  path: string;
  added: string;
  removed: string;
  patch(): Promise<string>;
}

function allowedPath(file: string): boolean {
  return file.length > 0 && !path.isAbsolute(file) && !/^[A-Za-z]:/.test(file)
    && !file.split(/[\\/]/).some((part) => part === '..' || part === '.git' || part === '.ordewell');
}

function stats(raw: string): Array<{ path: string; added: string; removed: string }> {
  return raw.split('\0').flatMap((row) => {
    const match = /^(\d+|-)\t(\d+|-)\t([\s\S]+)$/.exec(row);
    return match ? [{ path: match[3], added: match[1], removed: match[2] }] : [];
  });
}

function inside(root: string, target: string): boolean {
  const rel = path.relative(root, target);
  return rel === '' || (!rel.startsWith(`..${path.sep}`) && rel !== '..' && !path.isAbsolute(rel));
}

export async function readTaskDiff(invoker: GitInvoker, run: IsolationRun, taskId: string, options: TaskDiffRead): Promise<TaskDiffResult> {
  const record = run.tasks[taskId];
  if (!record) return { available: false, reason: TASK_DIFF_UNAVAILABLE };
  // A read-only task's sealed runs may write its worktree, `.git` file
  // included: git run there could load a repository the task planted. Ordewell
  // runs no git in such a worktree (ADR-0046); the task's report is its result.
  if (record.readOnly) return { available: false, reason: 'Task diff is not available for a read-only task: it lands nothing, and Ordewell runs no git in its worktree. Its report is its result.' };
  if (options.path !== undefined && !allowedPath(options.path)) {
    return { available: false, reason: 'Refused task_diff path: use a literal repo-relative file path from the file list, without traversal or Ordewell state paths.' };
  }
  if (options.repo !== undefined && !run.repos.some((r) => r.path === options.repo)) {
    return { available: false, reason: `No repository matches "${options.repo}" in this run.` };
  }
  const reader: GitInvoker = {
    ...invoker,
    exec: (file, args, opts) => invoker.exec(file, args, { ...opts, env: { ...opts.env, GIT_OPTIONAL_LOCKS: '0' } }),
  };
  try {
    const files: DiffFile[] = [];
    const workspaceRoot = fs.realpathSync(run.workspaceRoot);
    for (const repo of run.repos) {
      if (options.repo !== undefined && repo.path !== options.repo) continue;
      const entry = record.repos[repo.path];
      if (!entry?.baseRef) return { available: false, reason: `Task diff is not available for repository ${repo.path}: this older run did not record the task's starting commit.` };
      if (!/^[a-f0-9]{40,64}$/.test(entry.baseRef)) throw new Error('Invalid recorded starting commit.');
      const live = record.status !== 'merged' && fs.existsSync(entry.worktree);
      const cwd = live ? entry.worktree : repo.root;
      if (!inside(workspaceRoot, fs.realpathSync(cwd))) throw new Error('The recorded task repository moved outside the workspace.');
      if (live) {
        const toplevel = (await git(reader, cwd, ['rev-parse', '--show-toplevel'])).trim();
        if (fs.realpathSync(toplevel) !== fs.realpathSync(entry.worktree)) throw new Error('The recorded task worktree is no longer a repository.');
      }
      const prefix = (await git(reader, repo.root, ['rev-parse', '--show-prefix'])).trim();
      const common = ['--no-pager', '-c', 'core.fsmonitor=false'];
      // A worktree comparison may run clean filters even with textconv disabled.
      const filters = await tryGit(reader, cwd, [...common, 'config', '--name-only', '--get-regexp', '^filter\\..*\\.(clean|smudge|process|required)$']);
      if (!filters.ok && filters.code !== 1) throw new Error('Could not inspect git filter configuration.');
      for (const key of filters.stdout.trim().split('\n').filter(Boolean)) common.push('-c', `${key}=${key.endsWith('.required') ? 'false' : ''}`);
      let target: string[] = [];
      if (!live) {
        const tip = entry.taskTip ?? (await git(reader, repo.root, [...common, 'rev-parse', '--verify', `refs/heads/${record.branch}^{commit}`])).trim();
        if (!/^[a-f0-9]{40,64}$/.test(tip)) throw new Error('Invalid task commit.');
        target = [tip];
      }
      const scope = prefix ? [`:(top,literal)${prefix.replace(/\/$/, '')}`] : [];
      const diffArgs = [...common, 'diff', '--no-ext-diff', '--no-textconv', '--no-renames', `--relative=${prefix}`, entry.baseRef, ...target];
      const listed = stats(await git(reader, cwd, [...diffArgs, '--numstat', '-z', '--', ...scope]));
      const allowed = (file: string) => allowedPath(file) && !entry.linked.some((linked) => file === linked || file.startsWith(`${linked}/`))
        && !run.shared.some((shared) => repo.path === '.' && (file === shared || file.startsWith(`${shared}/`)));
      for (const file of listed.filter((f) => allowed(f.path))) {
        files.push({ ...file, repo: repo.path, patch: () => git(reader, cwd, [...diffArgs, '--', `:(top,literal)${prefix}${file.path}`]) });
      }
      if (live) {
        const workspace = path.join(entry.worktree, prefix);
        const others = await git(reader, workspace, [...common, 'ls-files', '--others', '--exclude-standard', '-z', '--', '.']);
        for (const file of others.split('\0').filter((f) => allowed(f))) {
          const full = path.join(workspace, file);
          if (!inside(fs.realpathSync(workspace), fs.realpathSync(path.dirname(full)))) continue;
          const untracked = async (numstat: boolean): Promise<string> => {
            const result = await tryGit(reader, workspace, [...common, 'diff', '--no-index', '--no-renames', '--no-ext-diff', '--no-textconv', ...(numstat ? ['--numstat', '-z'] : []), '--', devNull, file]);
            if (!result.ok && result.code !== 1) throw new Error(result.stderr.trim() || 'Could not read an untracked file diff.');
            return result.stdout;
          };
          const counts = /^(\d+|-)\t(\d+|-)\t/.exec(await untracked(true));
          if (counts) files.push({ repo: repo.path, path: file, added: counts[1], removed: counts[2], patch: () => untracked(false) });
        }
      }
    }
    if (options.path !== undefined) {
      const selected = files.filter((f) => f.path === options.path);
      if (selected.length === 0) return { available: false, reason: `No changed file matches "${options.path}"${options.repo ? ` in repository ${options.repo}` : ''}. Read the file list first.` };
      const patches: string[] = [];
      for (const file of selected) patches.push(`[repo ${file.repo}] ${file.path}\n${await file.patch()}`);
      return { available: true, text: patches.join('\n') };
    }
    return { available: true, text: files.length ? files.map((f) => `[repo ${f.repo}] ${f.path}: ${f.added === '-' ? 'binary change' : `+${f.added} -${f.removed}`}\n`).join('') : 'No files changed since this task started.\n' };
  } catch (err: unknown) {
    return { available: false, reason: `Task diff is not available: ${err instanceof Error ? err.message : String(err)}` };
  }
}
