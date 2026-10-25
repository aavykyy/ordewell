import type { IsolationLandedTask, IsolationMergeBlock, IsolationMergeResult } from '../interfaces/IWorktreeIsolation';
import { SELF_REPO } from './repoPath';
import { capConflictFiles } from './conflictFiles';

/** One repo that kept "Merge all" from touching anything, as part of one line. */
export function blockNotice({ repo, reason, files, expected, actual, rebasing }: IsolationMergeBlock): string {
  switch (reason) {
    case 'merge-in-progress': return `${repo} has a merge in progress`;
    case 'conflict': return `${repo} would conflict in ${files.join(', ')}`;
    case 'uncommitted-changes': return `${repo} has uncommitted changes to ${files.join(', ')}`;
    case 'partial-landing': return `${repo} holds part of a task whose landing could not be rolled back`;
    case 'wrong-branch': return `${repo === SELF_REPO ? 'your checkout' : repo} is ${actual ? `on ${actual}` : rebasing ? 'in the middle of a rebase' : 'on a detached HEAD'}; this run started on ${expected}`;
    case 'git-error': return `git could not check ${repo}`;
  }
}

/** Every repo's reason, in the order "Merge all" named them, so a surface can list them or join them. */
export function blockNotices(blocked: readonly IsolationMergeBlock[]): string[] {
  return blocked.map(blockNotice);
}

/** What to do about repos that are off their branch, when that is all that kept the merge back. */
function branchFix(blocked: IsolationMergeBlock[]): string {
  if (blocked.length === 0 || blocked.some((b) => b.reason !== 'wrong-branch')) return '';
  const rebasing = blocked.filter((b) => b.rebasing);
  if (rebasing.length > 0) {
    const where = rebasing.map((b) => (b.repo === SELF_REPO ? 'your checkout' : b.repo)).join(', ');
    return ` Finish or abort the rebase in ${where}${rebasing.length < blocked.length ? ' and check out the branch each other repository started on' : ''}, then press Merge all again.`;
  }
  const started = [...new Set(blocked.map((b) => b.expected))];
  return started.length === 1 && blocked.length === 1
    ? ` Check out ${started[0]} and press Merge all again.`
    : ' Check out the branch each repository started on and press Merge all again.';
}

/** Which repos a "Merge all" that stopped part-way had merged already; merges into the user's branches are never undone. */
function landedNotice(landed: string[]): string {
  if (landed.length === 0) return 'Nothing was merged.';
  return landed.length === 1 ? `${landed[0]} was merged already and stays merged.` : `${landed.join(', ')} were merged already and stay merged.`;
}

/** Landed tasks that only landed after a conflict repair (ADR-0015). */
export function repairedLanded(handoff: { landed: readonly IsolationLandedTask[] }): IsolationLandedTask[] {
  return handoff.landed.filter((t) => t.repairedFiles?.length);
}

/**
 * So the reviewer knows where to look (ADR-0015): every landed task that only
 * landed after a repair, with the files it was started for — a leading-space
 * sentence for appending after a full stop, empty when none did. A landing whose
 * record names no file is left out, so no empty brackets are ever printed.
 */
export function repairedNotice(handoff: { landed: readonly IsolationLandedTask[] }): string {
  const repaired = repairedLanded(handoff);
  if (repaired.length === 0) return '';
  const named = repaired.map((t) => `${t.title}${t.repairedFiles?.length ? ` (${capConflictFiles(t.repairedFiles)})` : ''}`);
  const list = named.length === 1 ? named[0] : `${named.slice(0, -1).join(', ')} and ${named[named.length - 1]}`;
  return ` ${list} landed through ${repaired.length === 1 ? 'a conflict repair' : 'conflict repairs'}.`;
}

/**
 * How "Merge all" went, in words every surface shares. `group` is whether the
 * run spans more than a lone repo at `.`; only a merge into every repository
 * has something to say about that. `repaired` names the landed tasks that only
 * landed after a conflict repair (ADR-0015), so a clean-looking merge still
 * points review at what changed to get there.
 */
export function describeMergeResult(
  result: IsolationMergeResult,
  branch: string,
  group: boolean,
  repaired: readonly IsolationLandedTask[] = [],
): { level: 'info' | 'warn' | 'error'; message: string } {
  switch (result.outcome) {
    case 'merged': {
      const base = group
        ? `Merged ${branch} into the checked-out branch of every repository.`
        : `Merged ${branch} into your checked-out branch.`;
      const repairedNoticeText = repairedNotice({ landed: repaired });
      return { level: 'info', message: `${base}${repairedNoticeText}` };
    }
    case 'blocked':
      return { level: 'warn', message: `Merged nothing, so every tree is as it was: ${blockNotices(result.blocked).join('; ')}.${branchFix(result.blocked)}` };
    case 'conflict':
      return {
        level: 'warn',
        message: result.repo === SELF_REPO
          ? `Merging ${branch} conflicted, so it was aborted: your tree is as it was.`
          : `Merging ${branch} conflicted in ${result.repo}${result.files?.length ? ` (${result.files.join(', ')})` : ''}, so it was aborted there. ${landedNotice(result.landed ?? [])}`,
      };
    case 'failed': {
      const lone = result.repo === SELF_REPO;
      const where = lone ? '' : ` in ${result.repo}`;
      // Without git's words the only cause left is the user's own unfinished merge, the one case that never asks git.
      if (result.error) {
        return { level: 'error', message: `Could not merge ${branch}${where}: git said "${result.error}". ${lone ? 'Your tree is as it was.' : landedNotice(result.landed ?? [])}` };
      }
      return {
        level: 'error',
        message: lone
          ? `Could not merge ${branch}: finish or abort the merge already in progress, then try again.`
          : `Could not merge ${branch}${where}: finish or abort any merge in progress there, then try again. ${landedNotice(result.landed ?? [])}`,
      };
    }
  }
}

/**
 * What "Merge all" did and what the user can do next, in words every surface
 * shares: a group takes the shared wording and, when nothing or not everything
 * merged, is told the integration branches are plain branches to merge by hand;
 * a lone repo whose merge conflicted is told to resolve it with git.
 */
export function mergeOutcome(
  result: IsolationMergeResult,
  branch: string,
  group: boolean,
  repaired: readonly IsolationLandedTask[] = [],
): { ok: boolean; message: string } {
  const ok = result.outcome === 'merged';
  if (!group && result.outcome === 'conflict') {
    return { ok, message: `Merging ${branch} conflicted, so it was aborted: your tree is as it was. Merge it with git and resolve the conflict there.` };
  }
  const { message } = describeMergeResult(result, branch, group, repaired);
  return { ok, message: ok || !group ? message : `${message} Each repository's ${branch} is a plain branch you can merge by hand.` };
}
