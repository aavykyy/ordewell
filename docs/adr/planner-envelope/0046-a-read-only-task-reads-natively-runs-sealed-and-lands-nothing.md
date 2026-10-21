---
status: accepted
implemented: partial
amends: ["0001", "0013", "0022", "0036", "0037"]
note: "the core is built (#104); withholding each runner's own writes and shell, and telling the planner, wait for the per-runner change"
---

# 0046 — A read-only task is Ordewell's: its runner's reads, a sealed shell, and nothing lands

## Problem

A read-only task ran in its runner's own read-only mode
([ADR-0001](../routing/0001-autonomous-mode-resolution.md)), and those modes
differ. Claude Code's plan mode writes its plan to a file under the runner's
own config folder, outside the workspace; Codex's read-only sandbox and
OpenCode's plan agent each draw the line somewhere else; none of them runs a
test. So a read-only task could still write, what it might touch depended on
the runner it was given, and a review that needed to run the suite, or try a
fix to see whether it held, could not be read-only.

Research tasks
([ADR-0037](../supervision/0037-research-tasks-wake-the-planner.md)) are
read-only tasks whose report is all that comes back (#103), and they start
without approval only once read-only means one thing on every runner (R4).

## Decision

**A read-only task is defined by Ordewell, the same on every runner. It keeps
its runner's native read tools; its only shell is Ordewell's `run_command`,
which runs sealed whatever the planner's envelope would ask about or refuse,
with the task's own worktree writable and nobody asked; and it lands nothing:
its worktree is thrown away when it ends, and its `task_complete` report is
its result.** The plan flag stays `readOnly`, and means a task that lands
nothing.

### Its shell

- **Only a read-only task has it.** `run_command` is among the tools of a
  read-only task's MCP token and no other task's
  ([ADR-0022](../runners/0022-ordewell-mcp-server.md)). It answers from the
  attempt's task shell (`BaseFileSystem.taskShell`), which is the planner's own
  command gate moved to the task's working directory: the same classifier,
  path confinement, `!` exclusions and allowlist
  ([ADR-0026](0026-one-envelope-for-every-planner.md)).
- **Nobody is asked.** A command the classifier reads as read-only, naming
  nothing outside the task's working directory, and one the allowlist covers,
  run as the planner's would, in the planner's sandbox
  ([ADR-0011](0011-sandboxing-the-planners-shell.md)) with the network its
  tier gives. Everything else — what would ask, what the classifier refuses, a
  path outside the working directory — runs sealed
  ([ADR-0036](0036-the-planners-shell-sealed-runs-and-native-opt-in.md)), as
  a research subagent's does (S5). An exclusion, and a denial the user gave on
  the card, still refuse (S3). A grant the user gave the planner on the card,
  and the `allow` approval mode, stay the planner's: they were given to its
  commands.
- **Its sealed runs** have ADR-0036's profile with its one writable directory
  set to the task's own worktree (its task workspace, in a repo group): the
  workspace readable, the worktree writable, no network, no home directory,
  and a scratch directory of the attempt's own as `TMPDIR` and `HOME`, removed
  when the attempt ends. Commands start in the worktree. So the task can try a
  fix, or add a failing test and run the suite. The repository's `.git` stays
  read-only, since a worktree's `.git` is a file pointing into it: git reads
  the history and records nothing, and each sealed result says so.
- **Without a worktree**, where the run does not isolate, the working
  directory is the workspace root and a sealed run has nothing of it writable.
- **Without a sandbox** (ADR-0036 S6), what would run sealed is refused, and
  the result says why.

### Its runner's own tools

- **Native reads stay.** The runner's own read, search and list tools work as
  they do for any task, each runner being built around them.
- **Native writes and the native shell are withheld, on every runner.** They
  run as the user, outside any sandbox, and a sealed command can make a
  symlink in the worktree: a native write tool would write through it wherever
  the user can, and confining it by path cannot see that. Withholding them
  keeps every write a read-only task makes inside the OS sandbox.

### Nothing lands

- **A pass lands nothing.** A read-only attempt (`AttemptKind` `readOnly`, and
  a continue of one) never integrates: a pass completes the task with nothing
  to land, and its worktree is released whatever it changed (`Landing`). So
  does Mark complete.
- **Its worktree is kept for nothing.** Its record is marked read-only
  (`IsolationTaskRecord.readOnly`): `integrate` refuses it, and every release —
  a pass, a failure, a stop, a cancel, a crash-recovery prune — removes it
  whole, with nothing kept on a branch. Ordewell runs no git inside it once the
  task has run there: keeping its changes would mean committing, as the user,
  in a tree its sealed commands wrote, `.git` file included. Removing it
  follows no link the task put on the way.
- **A continue starts clean.** Its worktree is fresh, and it is told that
  nothing its earlier attempt changed was kept.

## Testing decisions

- The task shell is tested through `BaseFileSystem.taskShell` with a sandbox
  backend that records each profile, as `taskShell.test.ts` does: which
  commands ran sealed, from where, with what writable, and that nobody was
  asked. `sealedRuns.e2e.test.ts` runs it in the host's real sandbox against a
  git worktree.
- Landing and release go through `FakeWorktreeIsolation` for the scheduler's
  side, and real git in `GitWorktreeIsolation.test.ts` for what is removed, what
  is never preserved, and where git runs.

## Out of scope

- A container's read-only mount of the workspace with a scratch folder (#99).
  It is the same definition on another sandbox.
- What a research task adds to a read-only one: its report waking the planner
  and its start without approval (ADR-0037).

## Considered options

- **Each runner's own read-only mode.** The design until 2026-10-21.
  Rejected: the modes differ, Claude Code's plan mode writes a plan file
  outside the workspace, none runs a test, and what a read-only task could
  touch depended on the runner it was given.
- **Ordewell's planner tools only, without the runner's native read tools.**
  Rejected by the user: every runner is built around its own reads, which
  change nothing.
- **The repository read-only to the task, with only scratch writable.**
  ADR-0036's suggestion for #104. Rejected by the user: a research task could
  not try a fix or add a failing test and run the suite.
- **Native writes confined to the worktree by path.** Rejected: a sealed
  command can make a symlink in the worktree, and a native write tool, which
  runs outside the sandbox as the user, follows it.
- **Keeping a read-only task's changes on a branch, as a removal keeps a
  change task's.** Rejected: nothing in it is work to keep, and keeping it means
  running git, as the user, in a tree its sealed commands wrote.

## Consequences

- A read-only task can run the project's tests, try a fix and add a failing
  test, and none of it reaches the plan's branches; its report is the result.
- Native read tools still run as the user, outside the sandbox, as far as each
  runner's own read rules let them, and a link a sealed command makes in the
  worktree can name a file outside it. What such a read finds reaches the model
  and its report; it writes nothing.
- On macOS a process that leaves a sealed run's process group outlives it,
  still sealed (ADR-0036), and can still be writing the worktree while it is
  removed.
- A failed or stopped read-only attempt leaves its log and its report to look
  at, and no worktree.
- Where no sandbox runs, a read-only task runs only the classifier's read-only
  commands and what the allowlist covers.
- Once the per-runner part is implemented, research tasks may start without
  approval (ADR-0037 R4), and the planner is told a read-only task can run
  commands.

## History

- 2026-10-21 — accepted; implemented in core, the per-runner part pending.
