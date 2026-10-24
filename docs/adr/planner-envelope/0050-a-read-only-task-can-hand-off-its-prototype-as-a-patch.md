---
status: accepted
implemented: partial
amends: ["0022", "0046", "0047"]
note: "The capture, the kept patch, its artifact and task_diff are built; a change task applying a patch, the surfaces beyond one line, and the planner's guidance are not."
---

# 0050 — A read-only task can hand off its prototype as a patch

## Problem

A read-only task can try a fix in its own worktree
([ADR-0046](0046-a-read-only-task-reads-natively-runs-sealed-and-lands-nothing.md)),
and that worktree is thrown away whole when the attempt ends: its *Handoff*
([ADR-0047](../supervision/0047-structured-task-handoffs.md)) is all that comes
back. So a plan of explorers, then a judge, then a builder loses the one thing
worth judging. An explorer's prototype survives only as prose, and the builder
rebuilds it from a description.

An explorer cannot keep it on its own. With git 2.56.0, a plain
`git diff --binary HEAD` silently leaves out new files, and `git add` fails in a
sealed run because the repository's `.git` is read-only there. The recipe that
works (a private index and object store, with the repository's objects as
alternates) still breaks on a case-only rename on a case-insensitive file
system. It also sweeps in the links Ordewell put in the worktree, and stops on
an unreadable file.

## Decision

**A read-only task keeps its prototype by calling `save_patch`. Ordewell
captures every change in the task's worktree as a patch, inside the task's own
seal, and checks that the patch replays to the same tree. It keeps the patch
beside the attempt's log and names it in the attempt's handoff as a `patch`
artifact. The patch lands nothing. Choosing among several explorers' patches
needs no new mechanism: a shared check eliminates, a judge recommends among
those that pass, and the pick is approving the build task the planner adds.**

### The tool

- **`save_patch({})`** is on a read-only task's token alone, beside
  `run_command` ([ADR-0022](../runners/0022-ordewell-mcp-server.md)).
- **Its answer** says what it saved and what it left out, or why it saved
  nothing. What it saved is the files, the lines added and removed, the size
  and the base commit.
- **Saving again** replaces the attempt's patch. A save that finds nothing to
  save leaves an earlier patch in place.
- **Before the shell's first sealed run** there is nothing to save. Native
  writes are withheld and an unsealed command writes only scratch, so the
  worktree is still what Ordewell checked out. The call says so and runs
  nothing, so a save never seals a shell that was not sealed.
- **Refused** for a task with no worktree, and for one across a *Repo group*'s
  several repositories: a saved patch is one repository's changes.

### The capture runs inside the seal

`PatchCapture` owns the recipe. The task shell runs its two scripts as
Ordewell's own sealed runs (`TaskShell.hold`):

- No command rule judges them, since the task did not write them.
- They run under the task's sealed profile, from the worktree root.
- They are checked after each run as every sealed run is: the link walk and
  the `.git` record.
- The shell is held for them, so no command of the task runs in between.
- Where no sandbox can seal, nothing runs and the call says why.

**The first script** stages every change into a private index. The index is
seeded from a copy of the worktree's own, so git rehashes only what changed.
The object store is private too, in scratch, with the repository's object
directory as its alternate. The script then lists four things:

- the changes;
- every path the index holds;
- the size of each change's part of a patch;
- the base commit.

**Between the scripts**, Ordewell decides what is refused and what is left out.

**The second script** takes what is left out back out of the private index and
writes the patch with `git diff --cached --binary --full-index -M HEAD`. It then
replays the patch onto a fresh index at the same base. The patch is kept only
when that gives the very tree that was staged.

**Git's configuration is pinned** wherever it would change the patch or write
the repository:

- fsmonitor, the split index and the untracked cache off;
- `core.ignoreCase` off, so a case-only rename shows as two paths;
- ctime trusted;
- prefixes `a/` and `b/`;
- no external diff, textconv or order file;
- no system configuration and no replace objects.

**What the scripts wrote** is read from unguessable names in the attempt's
scratch, with no link followed and every size bounded.

### What is carried, refused and flagged

| The worktree has | The patch |
|---|---|
| new, changed, deleted, renamed or binary files, or a changed mode | carries them |
| a path Ordewell linked in (`IsolationTaskRepo.linked`: `.env*`, `node_modules`, `.claude`, a user's `worktreeLinks`) | leaves it out by name, as the landing commit does, whatever it is on disk |
| any other symbolic link, or a submodule | leaves it out, flagged `excluded` |
| a file whose part of the patch is over 1 MiB, or the largest files once the whole would pass 8 MiB | drops it, flagged `dropped` with its size |
| a file git converts on the way in (its `text`, `eol`, `filter` or encoding attributes) | carries it as git stores it, flagged `normalized`: those bytes differ from the worktree's |
| a new path that differs from another only in case, such as a case-only rename | refuses the save |
| a file git cannot read | refuses the save, in git's words |
| ignored files and empty directories | leaves them out, as any commit would |

A file's part is measured in the patch, not on disk, so a small edit to a
large file counts as small.

### Where it is kept, and who reads it

- **The file** is `<attempt>.patch` beside the attempt's *Task log*, in
  `.ordewell/sessions/<session>/tasks/<task>/`. It is written whole under
  another name first, and it goes with the session.
- **The artifact** is a fifth kind, `patch`, that only Ordewell adds:
  `{kind: 'patch', path, attempt, base, files, added, removed, binary, bytes,
  flags?}`.
  - It comes after the author's own artifacts and outside their limit.
  - It is added whatever the verdict, and an attempt that ended without a
    *Completion call* still hands it on.
  - It is in the plan's digest, so `read_task`, `task_query` and every surface
    show it as one line.
- **The planner's `task_diff`** reads the patch for a task whose handoff names
  one: the file list with line counts, or one file's part. It still runs no
  git in a read-only worktree.

### Choosing among explorers

Evidence eliminates, judgment picks among those left, and core is bound by no
pick.

- **The check.** Before the explorers start, the planner fixes one check, the
  same for each. An explorer that fails it is out. Exactly one that passes
  needs no pick; none that passes means the round failed.
- **The judge.** Two or more that pass are a tie on evidence. A read-only judge
  task that depends on every explorer reads their handoffs with `read_task`,
  and the patch files they name with its runner's own reads, which reach the
  workspace. It recommends one in a finding, and a finding is advice
  (ADR-0047).
- **The pick.** The planner proposes the build task on the recommended patch,
  and approving that task is the pick:
  - in the user's own turn, the user's, since a task added after the plan's
    approval is not approved to run;
  - at Act, the supervisor's, whose added tasks count as approved
    ([ADR-0029](../supervision/0029-the-supervisor.md));
  - at Watch, nobody's: the supervisor only suggests.

No field records the pick, and core reads nothing from the judge.

## Key properties

- **Git reads a tree a sealed run wrote only inside the seal.** Outside it, git
  would run as the user with the tree's own `.gitattributes`, filters and
  untracked files. It would also freshen the repository's existing object
  files.
- **A patch is not a verdict, and lands nothing.** It records what the task
  changed. A task passes or fails on its completion call alone.
- **The artifact is Ordewell's, not the author's.** A completion call's
  artifacts stay the four kinds of evidence. A `patch` artifact is written only
  from a capture that replayed.

## Testing decisions

- **The rules.** `PatchCapture` is tested through `capturePatch` with real git
  in throwaway repositories, a plain shell standing in for the sealed runs.
  Each rule is shown on git's own output: carried, excluded, dropped,
  normalized and refused. So is a refusal when a sealed run swaps one of the
  capture's files for a link, and when a replay differs.
- **End to end.** `PatchCapture.e2e.test.ts` runs the capture through a real
  task shell in the host's sandbox. It applies the patch outside the sandbox,
  in a fresh worktree at the same base, and compares every file and mode. CI's
  Linux sandbox job runs it under bubblewrap with `ORDEWELL_REQUIRE_SANDBOX`.
- **The seams around it.** `taskShell.test.ts` covers `TaskShell.hold` with the
  recording backend. The orchestrator's side, the artifact in the handoff
  whatever the verdict, uses `FakeWorktreeIsolation`. Which token is offered
  the tool is asserted at the MCP server test seam.

## Out of scope

- A change task applying a patch, and reporting an apply that conflicts.
- How the surfaces show a patch, beyond its one line.
- The planner's guidance for explorers, judges and builders.
- A repo group's several repositories.
- Candidate change tasks: see below.

## Considered options

- **Candidate change tasks, held unlanded until one is chosen.** Several change
  tasks whose passes stop at `Landing.landPassed`: a new `held` landing outcome
  and isolation status, a `choice` waiting reason, and a choose command that
  lands the winner and keeps the losers on preserved branches. Deferred:
  - it touches about fifteen core files and every surface;
  - loops, Mark complete, retries and crash recovery each need a rule of
    their own;
  - what is judged can differ from what lands, once the winner's merge needs
    a repair.

  A patch carries the same prototype as one file and one artifact, and the
  builder applies and retests it at the current base. Candidates remain the
  way for a prototype that needs services the seal withholds, or one that
  other tasks must build on before the choice.
- **A recipe the explorer writes and runs itself, with no tool.** Rejected: the
  plain diff silently drops new files, and `git add` fails in the seal. The
  recipe that works needs a private index and object store, and a case-only
  rename, a link into the main checkout and an unreadable file each break it
  in its own way. A model told to follow it gets one of those wrong silently,
  and Ordewell would keep whatever file it named.
- **Ordewell running git in the worktree outside the seal.** Rejected: that is
  git as the user in a tree a sealed run wrote, with its `.gitattributes`,
  filters and untracked files, which ADR-0046 refuses `task_diff` and release
  for. Outside the seal, git also freshens the repository's existing object
  files.

## Consequences

- An explorer's prototype outlives its worktree. A judge reads it, and a
  builder that depends on the explorer finds it named in its handoff.
- A save costs two sealed runs, and each walks the worktree for links, as
  every sealed run does.
- A patch is taken against the commit the explorer's worktree was cut from. One
  applied after other work has landed may conflict, and the test results it
  was saved with were for that base.
- What a patch holds is the task's doing. Whoever applies it treats it as
  untrusted content, as they treat a report.
- A file ignored only by the user's global gitignore is not ignored inside the
  seal, which has no home directory.

## History

- 2026-10-24 — accepted; the capture, the kept patch, its artifact and `task_diff` implemented.
