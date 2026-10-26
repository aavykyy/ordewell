import type { IsolationPreview, PreviewRepo } from '../interfaces/IWorktreeIsolation';

/** What a surface says about an {@link IsolationPreview}, in the words every surface shares. */
export interface IsolationPreviewNotice {
  /** Whether code tasks get isolated worktrees, in one sentence. */
  summary: string;
  /** One row per repository, in the preview's order: every one, never a cut list. */
  repos: { name: string; detail: string }[];
  /** What tasks share live, when something is shared. */
  shared?: string;
  /** A second sentence the summary leaves to the reader: the start-time decision, the ops tasks, a failure's reason. */
  note?: string;
}

const SHARED_NAMED = 5;
const OPS_TASKS = 'Ops and script tasks use your checkout.';

function repoName(repo: PreviewRepo): string {
  if (repo.path !== '.') return repo.path;
  return repo.top ? `Repository above this workspace (${repo.top})` : 'This workspace';
}

function repoDetail(repo: PreviewRepo, status: IsolationPreview['status']): string {
  const head = repo.head;
  const base = head.kind === 'branch' ? `on ${head.branch} (${head.commit})`
    : head.kind === 'detached' ? `detached HEAD at ${head.commit}`
    : head.kind === 'unknown' ? 'branch not read'
    : head.branch ? `no commits yet on ${head.branch}` : 'no commits yet';
  const shared = head.kind === 'unborn' && (status === 'ready' || status === 'dirty') ? '; tasks share it instead of isolating it' : '';
  return `${base}${shared}${repo.dirty ? ' · uncommitted changes to tracked files' : ''}`;
}

function sharedLine(shared: readonly string[]): string | undefined {
  if (shared.length === 0) return undefined;
  const more = shared.length - SHARED_NAMED;
  const named = shared.slice(0, SHARED_NAMED).join(', ');
  return `Shared live between tasks: ${more > 0 ? `${named} and ${more} more` : named}`;
}

/**
 * The words for a preview. Only `ready` and `dirty` promise isolation, `dirty`
 * after the start-time decision; `failed` promises nothing and never says
 * there is no repository, since it could not look.
 */
export function describeIsolationPreview(preview: IsolationPreview): IsolationPreviewNotice {
  const repos = preview.repos.map((repo) => ({ name: repoName(repo), detail: repoDetail(repo, preview.status) }));
  const shared = sharedLine(preview.shared);
  const notice = (summary: string, note?: string) => ({ summary, repos, ...(shared ? { shared } : {}), ...(note ? { note } : {}) });
  switch (preview.status) {
    case 'ready':
      return notice('Code tasks run in isolated git worktrees based on the repositories and branches below.', `${OPS_TASKS} The base branch is read again when a run starts.`);
    case 'dirty':
      return notice(
        'Code tasks get isolated worktrees from the repositories and branches below once you decide what to do with uncommitted changes.',
        `Starting a run asks whether to stash them or run without isolation. ${OPS_TASKS}`,
      );
    case 'disabled':
      return notice('Worktree isolation is turned off, so tasks run in the workspace without isolated worktrees.');
    case 'git-missing':
      return notice('Git was not found, so tasks run in the workspace without isolated worktrees.');
    case 'no-commits':
      return notice('No repository has a commit yet, so tasks run in the workspace without isolated worktrees.');
    case 'no-repo':
      return notice('No Git repository detected. Tasks run in the workspace without isolated worktrees.');
    case 'failed':
      return notice(
        "Could not read the Git repositories just now, so Ordewell can't say yet whether code tasks get isolated worktrees.",
        `${preview.error ?? 'Git did not answer'}. It is checked again when a run starts.`,
      );
  }
}
