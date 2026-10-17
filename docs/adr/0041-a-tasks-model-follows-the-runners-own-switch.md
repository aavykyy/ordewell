# 0041 — A task's model follows the runner's own switch

**Status:** accepted — amends [ADR-0001](0001-autonomous-mode-resolution.md), [ADR-0003](0003-per-runner-model-allowlist.md) and [ADR-0018](0018-structured-runner-transport.md); settles #106

## Problem

A task's chat speaks its runner's own commands (ADR-0018, R1), so a user can
type `/model` there and the runner moves to another model mid-task. The plan is
the source of truth for what runs (ADR-0001), and it went on naming the model
the task was planned with. Three things followed:

- **The plan and the runner disagreed.** A Retry or Continue spawned on the
  planned model, undoing the user's switch, and the task card showed a model
  nothing was running.
- **An edit from outside and a switch inside could cross.** The task card's
  model picker and the planner's `edit_plan` could change a model the process
  was already running on, leaving the plan naming what is not running.
- **A task's usage read as one attempt's.** The usage line showed the latest
  attempt, so a stop, a model change or a continue made the earlier spend
  vanish. A resumed Claude Code session reported its running cost from the
  start, so its first turn either double-counted or was dropped. The context
  meter used the window the runner reported, or none, so after a switch it was
  measured against nothing or against the previous model's.

A Continue also offered a saved session to a task that had since been moved to
another runner, whose session the new runner cannot open (ADR-0018, K1), and a
Retry after such a move started fresh and threw away the work on disk.

## Decision

**The user's choice of model, made in the runner, is the plan's to follow; a
change nobody chose is stated and never written. While a task's runner is up its
model belongs to that runner.**

### A `/model` in the chat is a direct edit of the plan

- **It is detected however the message was routed.** The Claude Code connector
  reads a message that starts with a slash command as that command whether the
  surface sent it as a command or as plain text, and an alias counts. A
  switch is confirmed by the model the next turn reports, so a command that
  changed nothing is let go.
- **It is written to the plan as the user's own edit**: saved and announced as
  `task_updated`, so every surface shows it and a later Retry or Continue spawns
  on it. The model id is the one the runner lists, with aliases resolved
  (`sonnet`, `default`) by what the runner's `initialize` reports.
- **It is written even when the model is off the allowlist.** The user picked it
  in the runner; the allowlist is advice to the planner (ADR-0003, P1).
- **Effort is written only when the runner reports one.** Claude Code does not:
  `init` names the model alone, and `/model` takes no effort. The plan's effort
  stays, clamped to what the new model offers; a model discovery does not list
  gets none.
- **The task log says what the plan made of it.** `model_switched` is logged
  after the write-back settles, from its outcome, so it never claims an edit
  that did not land: "the plan now says …", or "the plan still says …" with why.
  A switch whose attempt had ended, when it arrived or while the edit waited,
  writes nothing and says nothing of the plan, which may be another one by
  then. An event saved before the plan's side was recorded replays as the
  runner's change alone.

### A change with no model command before it is stated, never written

A runner that falls back or moves model by itself (Ordewell never passes
`--fallback-model`) is reported as `model_drifted`. The task log states it, and
the plan keeps what it said.

### Runner commands are never interpreted

Codex and OpenCode get no synthesized `/model`. Ordewell does not parse a
runner's command grammar to find out what it meant (ADR-0018, R1). Only Claude Code, whose
`initialize` lists its models and whose turns name the one they ran on,
reports a switch; a `/model` sent to the others reaches the runner as the
runner's own command and the plan does not follow it.

### Model and effort are locked while a task's runner is live

For every actor, a task's model and effort cannot change while an attempt of it
is live: `validateTaskEdit` refuses with the reason, a model cleared as much as
one replaced. Nor can its runner, which would re-derive both; a move whose
discovery the task started during is refused too. **Stop, edit, continue is
the outside path**, and the runner's own `/model` is the inside one. The
write-back above is the one model edit a live runner allows, since it records
what that runner already runs. A planner edit or restatement leaves a task's
assignment alone where it names the runner, model and effort the plan holds:
the allowlist shapes what the planner writes, not a model the user switched
to (ADR-0043).

### A task's usage is its whole spend

- **Usage sums every attempt and every model** the task used (`taskUsageSummary`),
  including a resumed session's first turn when its baseline is known: a
  runner that reports a running session total has its count saved with the
  attempt (`runnerSessionCost`), and a continue of that session counts the
  first report's growth over it. With no baseline kept, that report only sets
  one.
- **The context meter follows the latest model.** It reads the latest attempt,
  because only the current model's window says how full the next prompt is.
- **Cost appears only when reported.** An absent measure is not zero and is not
  estimated; the usage line leaves it out.
- **The context window comes from the runner's report, else the runner's own
  listing or the provider's own endpoint**, filled per record
  (`ContextWindowFill`) so a model change mid-stream reads its own window. A
  window reported once is kept for its model; neither known leaves the meter
  unknown. Never an Ordewell table.

### Continue never crosses runners

A saved session records the runner it belongs to (`runnerSessionOwner`; for a
plan from before that, the runner of its last attempt, or with no attempt
recorded either, the runner the task is on when the plan loads, noted then so a
move cannot lose it). Continue is offered and
accepted only while the task is assigned to that runner. A move to another
runner, from any status and not only from a task paused on a usage limit, makes
the next Retry a *carry-over*: a fresh session on the new runner with the work
of the earlier runner's attempt restored (ADR-0018, K1).

## Key properties

- What the plan says a task runs on is what a Retry runs on, and a user's
  `/model` is never undone by one.
- A model the runner moved to on its own is visible in the log and absent from
  the plan.
- An edit from outside cannot change a model that is running.
- Spend never shrinks when a task is stopped, moved, switched or continued.
- Nothing the user reads as cost or context was estimated.

## Considered options

- **Write every observed model change to the plan.** Rejected: a fallback or
  drift would rewrite the plan with no one having chosen it, against ADR-0001.
- **Write nothing; let the plan and the runner differ.** Rejected: the next
  Retry would spawn on the planned model and undo the user's choice.
- **Synthesize a `/model` for Codex and OpenCode, or parse each runner's
  commands.** Rejected: it makes Ordewell the interpreter of every runner's
  grammar, which R1 keeps out of it.
- **Hold a `/model` to the allowlist.** Rejected: the user chose it in the
  runner itself, and the allowlist is advice to the planner.
- **Switch a live runner from outside** (a task-card pick or `edit_plan` moving
  a running process). Rejected for now: runners differ in whether a session can
  change model mid-turn, and the plan would name what is not yet running.
  Stop, edit, continue works on every runner.
- **Estimate effort or cost.** Rejected: no runner reports effort on a switch,
  and a price table goes stale and does not exist for a subscription (ADR-0017).
- **A window table kept in Ordewell.** Rejected for the same reason: it goes
  stale, and the runner or provider already lists the window.
- **The usage line shows the latest attempt.** The earlier behaviour; it lost
  the spend of every attempt before it.
- **The meter summed over attempts.** Rejected: a window belongs to one model.
- **Continue across runners by handing over the saved session id.** Rejected:
  the new runner cannot open it, and the attempt would fail; and a fresh Retry
  that drops the work on disk was no better.

## History

- 2026-10-17 — accepted and implemented (#106): a `/model` in a task chat is written to the plan, a drift is stated, the model is locked while the runner is live, a task's usage is its whole spend with the meter on the latest model, and Continue never crosses runners.
- 2026-10-17 — the lock covers a cleared model and a runner move; a planner edit keeps an untouched assignment; a switch after its attempt ended says nothing of the plan; a window is kept per model; an ownerless legacy session is owned by its runner at load.
