/** The part of a run's handoff a Merge confirmation is worded from; structural, so each surface passes the handoff it holds. */
export interface MergeWordingHandoff {
  repos: readonly { path: string; baseBranch?: string; landed: readonly unknown[] }[];
}

/**
 * Whether the run spans more than a lone repo at the workspace root. A group of
 * one at `.` is worded and drawn exactly as it was before repo groups; anything
 * else names its repos.
 */
export function isRepoGroup(handoff: { repos: readonly { path: string }[] }): boolean {
  return handoff.repos.some((r) => r.path !== '.');
}

/** The repos Merge all will merge: those with work on their integration branch, else all of them. */
export function reposWithWork(handoff: MergeWordingHandoff): string[] {
  const withWork = handoff.repos.filter((r) => r.landed.length > 0);
  return (withWork.length > 0 ? withWork : handoff.repos).map((r) => r.path);
}

/**
 * What a Merge confirmation says the branch lands on: the branch the run
 * started on, which Merge all insists is checked out. A repo that started
 * detached has none, and keeps the old wording.
 */
export function mergeTarget(handoff: MergeWordingHandoff): string {
  if (!isRepoGroup(handoff)) return handoff.repos[0]?.baseBranch ?? 'the branch you have checked out';
  const targets = handoff.repos.filter((r) => reposWithWork(handoff).includes(r.path));
  const branches = new Set(targets.map((r) => r.baseBranch));
  const [only] = branches;
  if (branches.size === 1 && only) return `${only} in each of ${targets.map((r) => r.path).join(', ')}`;
  return `each of ${targets.map((r) => `${r.path} (${r.baseBranch ?? 'as checked out'})`).join(', ')}`;
}

/** The refusal Merge all makes when a repo is on another branch, for a confirmation to warn of; empty when no repo named a branch. */
export function checkoutRule(handoff: MergeWordingHandoff): string {
  const named = handoff.repos.filter((r) => r.baseBranch);
  if (named.length === 0) return '';
  if (!isRepoGroup(handoff)) return ` Nothing is merged unless ${named[0]!.baseBranch} is checked out.`;
  return ' Nothing is merged unless each repository is on the branch it started on.';
}
