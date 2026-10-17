# 0019 — Nested repositories are shared live, not refused

**Status:** accepted — amends [ADR-0014](0014-multi-repo-workspaces.md)

**Amends:** ADR-0014 (multi-repo workspaces), whose `nested-repos` refusal this
replaces.

## Context

ADR-0014 made a workspace that is itself a git repository and contains further
repositories that are not submodules a *refusal*: `isActive` answered
`{ active: false, reason: 'nested-repos' }`, and every task of the run fell back
to the shared workspace root with a notice. It was written to stop the older,
worse behavior, where the outer repository isolated alone and the nested ones
were silently left out of every worktree.

The refusal is too coarse in three ways, and it has a hole:

- It is all-or-nothing. One nested clone — a scratch checkout, a vendored
  repository, a test fixture — turns off isolation for the **whole** workspace,
  including the outer repository that could be isolated perfectly well. That
  brings back the overlap ADR-0013 and ADR-0014 exist to remove.
- The only remedies the notice offers are to ignore the nested repositories in
  git or make them submodules, both changes to the user's real repository.
  `workspaceRepos`, whose whole job is to name the group, cannot help: when the
  workspace is itself a repository, `scanGroup` never reads it.
- The case it treats as safe is the leaky one. A nested repository the outer
  repository *ignores* is exempt from the refusal, so isolation proceeds — but
  `sharedPaths` returns nothing for a group of one, and a worktree only holds
  tracked files, so the ignored nested repository is simply absent from every
  task worktree, with no notice. The unignored case is refused loudly; the
  ignored case disappears in silence.

## Decision

**The outer repository isolates; the repositories nested in it are shared live.**

- A workspace that is a repository is a *group of one* whether or not it holds
  nested repositories. The refusal and the `nested-repos` reason are removed
  from `IsolationInactiveReason`, and with them the orchestrator's fallback
  notice for it.
- A nested repository is a repository below the workspace that the outer
  repository does not own as a submodule: a directory with its own `.git`
  (directory or file), not a staged gitlink and not declared in `.gitmodules`,
  found within two levels, skipping `.git`, `.ordewell` and `node_modules`
  (the detection ADR-0014 already used).
- Each is linked live into every task at the same relative path it has in the
  workspace, exactly like a shared path of a group. It is recorded as `shared`
  in the run, so the group's existing disclosure carries it: the one-line
  notice to the user, and the planner prompt, which tells the planner not to run
  two tasks that edit the same one at once. It points at the same path in the
  real workspace, so the planner's envelope (ADR-0008) is unchanged.
- **An ignored nested repository is shared too.** No linked artifact stands in
  for it, and the whole point is that it must not vanish. Only if the bootstrap
  has already linked an artifact that contains it (`vendor/`, `.venv/`) is it
  left alone, so the artifact stays linked whole rather than being replaced by a
  link to one repository inside it.
- The links are made **after** the bootstrap and recorded on the lone repo's
  worktree like its bootstrapped artifacts, so they are kept out of the task's
  commit and never walked into on cleanup.

- **Rejected: keep the refusal.** Half-isolating the outer repository is the
  failure ADR-0014 was right to name, but refusing the whole group is a bigger
  failure: it protects nothing. The nested repositories are books the tasks may
  legitimately need to read, and a live link discloses its own risk.
- **Rejected: compose the outer repository and the nested ones into one group.**
  It reads well — the outer at `.`, the nested at their paths — but a git
  worktree cannot cleanly hold another worktree inside its working directory,
  and the nested repository is *owned* by the outer one in no way that would let
  its history be integrated atomically with it.
- **Rejected: share only the unignored nested repositories.** It leaves the
  silent, invisible case exactly as it is, which is the one this ADR exists to
  remove.

## Consequences

- A repository with a nested clone now isolates: the outer repository in a
  worktree, the nested ones live and named. Edits to the nested ones are not
  isolated and not reviewed — visible in the notice and the planner prompt, as
  for any shared path. That is the trade: the outer repository keeps isolation
  instead of the whole workspace losing it.
- Detection still stops two levels below the root, the bound ADR-0014 chose to
  keep the scan off dependency trees. A nested repository deeper than that is
  not found, and so is not shared — the same bound the group's auto-detection
  has, and unchanged by this ADR.
- A nested repository inside a linked artifact (`vendor/`, `.venv/`) is live
  through the whole artifact link rather than linked a second time; the notice
  still names it, because a live path it is.
