---
status: accepted
amends: ["0013", "0015", "0029"]
---

# 0034 — A failed task blocks only its dependents

## Problem

A task fails when its attempt ends without the evidence a pass needs: the
runner reported `failed` or `blocked` through `task_complete`, or exited
without calling it. Until now a failure *halted* a full-plan run: attempts
already running finished, nothing new started, and the run waited for a retry
of the failed task to resume it.

In a real run one failed task — a live test the host could not support —
stopped every later task, including the many that did not depend on its
output. Nothing about the failure made that work unsafe; the halt only
delayed it until the user noticed and retried something they may not have
been able to fix.

## Decision

**A failed task blocks only its transitive dependents.** Independent work keeps
starting as usual.

- **The blocked rule.** A task not started yet is *blocked* while a dependency
  failed or is itself blocked. A blocked task is never started by the
  scheduler, and its own dependents are blocked with it. A task already at
  work — force-started, or waiting on the user — is not blocked and passes no
  block on. The rule is one pure function (`blockingFailures`,
  `packages/core/src/services/blocking.ts`) over task statuses and
  dependencies; nothing is stored, so whatever lifts a failure lifts its block.
  Subtasks follow the same rule.
- **A skip releases them too.** A skipped dependency is as finished as a
  completed one for the blocked rule: nothing of it lands, so there is
  nothing of its own to wait for. The work it waited on is another matter:
  the scheduler holds its dependents until the tasks behind the skip are met
  by the usual rule (completed, and in an isolated run merged into the
  integration branch), walking through a chain of skips to the nearest tasks
  that were not skipped. A failed or blocked task behind the skip holds
  nothing back, since skipping is how the user gives up on it. Skip ends the
  failed task as `skipped`, a terminal state with no verdict, without landing
  its work; its dependents start once the work behind it is done, told in
  their prompt that it was skipped and why (ADR-0029's `skip_task`). Mark
  complete, by contrast, lands the work as vouched for.
- **Every surface says what blocks a task.** The core task row view reads the
  plan tree and reports `status: 'blocked'` with `blockedBy`, the failed tasks
  by reference; the TUI, VS Code and `ordewell status` show "blocked by #N"
  from it. The scheduler, the command seam's refusals and the supervisor read
  the same function.
- **The run ends when nothing can start.** With nothing running and every task
  left failed or blocked, the run ends (`execution_complete`), saying how many
  tasks completed, failed and are blocked, and how many were skipped; the
  summary carries all four. A run whose every task completed or was skipped
  is finished.
  A task waiting on the user, on hold, at a merge gate or on a usage limit
  keeps the run open, as before.
- **A retry or a skip continues the run.** Retrying or skipping a task of a
  run that ended on a failure re-arms the scheduler, so the tasks the failed
  one blocked start once its retry passes, or on a skip once the work behind it is done — by the user,
  or by an Act supervisor within its loop guards. A planner edit made in between is reconciled into that run rather
  than reloaded over it, so the failed task stays failed: an edit is not a
  retry, and a reload would drop the review approval the retry continues.
  Loading another plan, starting a run or stopping one forgets it.
- **A merge gate and a usage-limit pause keep their meaning.** A task at a
  merge gate (ADR-0020) waits for Merge all and keeps the run open. A
  usage-limit pause still holds the whole run until the limit resets, and the
  reset resumes it whether or not a task failed meanwhile.
- **The supervisor is told.** A failure still wakes it (`task_failed`, ADR-0029).
  The run update names the tasks the failure blocks as the update goes out,
  and the run's end counts the blocked tasks.

Verdicts are unchanged: a task completes only on `task_complete` bound to its
attempt. This decides what a failure stops, not how a verdict is reached.

## Considered options

- **Halt the run on a failure, resume it on a retry.** The design until
  2026-10-14. Rejected: it stops work that does not depend on the failure, so
  one task the host cannot run stalls the whole plan until someone retries it,
  and a failure the user cannot fix leaves the rest of the plan unrun.
- **Store `blocked` on each dependent when a task fails, and clear it when the
  retry passes.** Rejected: a stored status has to be set and cleared on every
  path that fails, retries, edits, removes or reloads a task, and one missed
  path leaves a task blocked by nothing. A rule read from the plan's statuses
  cannot drift from them.
- **End the run but let a retry run only the retried task.** Rejected: the
  tasks the failure blocked would never start once it passed, so a retry
  would not undo the failure's effect — the bug the halt's resume was there to
  fix.
- **Release the dependents only by a passing retry or Mark complete.** The
  design until the skip landed. Rejected: when a failure cannot be fixed on
  this host, the only way to let its dependents go on was Mark complete, which
  lands the failed work as if someone had vouched for it.
- **Keep the run open until every failure is retried.** Rejected: a run that
  never ends never hands its work over, and a surface treats the end of the
  execution stream as the run's end; the retry continues an ended run instead.

## Consequences

- A plan finishes everything it can. A failure leaves only its own dependents
  undone, named on every surface and counted in the run's summary.
- A run can end with failed and blocked tasks, its landed work handed over as
  any finished run's is. The retry that continues it opens a run again.
- Independent work runs while a failure waits on the user, so a run spends
  runner time a halt would have held back until the retry.

## History

- 2026-10-14 — accepted and implemented; replaces the halted run.
- 2026-10-14 — a skipped task releases its dependents as a completed one does, without landing its work; a skip continues a run that ended on a failure; run summaries count skipped tasks.
- 2026-10-16 — a skipped dependency no longer lets its dependents start ahead of the work behind it: they wait until the skipped task's own unfinished ancestors are met, and the scheduler log and the command seam's refusals name those ancestors.
