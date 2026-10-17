---
status: accepted
implemented: none
amends: ["0009", "0029"]
note: "starting one without approval waits for #104"
---

# 0037 — Research that outlives a planner turn is a research task, and its report wakes the planner

## Problem

A planner turn holds the conversation, and its end gives the conversation
back to the user. Work the planner starts therefore has to finish inside the
turn. An API planner's research subagents run within one tool round
(ADR-0005). A harness planner that ends its turn with background agents still
running is sent back to wait for them (ADR-0009; `MAX_AGENT_WAITS` in
`CliAgentAiService`), because nothing would bring their results into the
conversation afterwards.

So a long investigation is a long turn. The user cannot talk to the planner
while it runs, everything it reads passes through the planner's context or its
subagents' digests, and "scout first, then plan" becomes one turn that grows
until it is compacted.

The supervisor already brings results into the conversation later (ADR-0029):
run updates open wake-up turns while tasks run, and the user's messages are
live planner turns in between. What is missing is a task whose result is
addressed to the planner.

## Decision

**Research meant to outlive the planner's turn is a research task: a read-only
task in the plan whose report is addressed to the planner. When it ends, the
planner wakes with the report, at every supervisor level. Inside a turn,
harness subagents stay as they are, awaited before the turn ends.**

- **What it is (R1).** A read-only AI task (ADR-0031) marked `research: true`,
  with a self-contained brief: what to find out, where to start, and what the
  report must contain. Its report is its `task_complete` summary (ADR-0022,
  V4). It lands nothing. Where it reads, a worktree or the workspace itself,
  follows read-only tasks (#104).
- **Its end wakes the planner (R2).** A research task that passes, fails or is
  blocked opens a planner turn with a run update carrying its report, or the
  reason it did not pass. Reports from tasks that end close together are
  batched, as `WakePolicy` batches events today. Unlike the supervisor's
  wake-ups these come at every supervisor level, Off included: the planner
  asked for this report, and supervision is not the question.
- **Authority in that turn (R3).** A report turn acts with the authority of
  the turn that started the research task. One started in the user's turn acts
  as the user's turns do (ADR-0029, ADR-0030); one started in a supervisor's
  wake-up turn acts at the supervisor's level. The report itself is untrusted
  content, like everything the planner reads.
- **Starting one (R4).** Until read-only means one thing on every runner
  (#104), a research task follows the approval rule of any task the planner
  adds (ADR-0029, ADR-0030), including the scheduler rule of
  [ADR-0035](0035-effects-are-consented-and-recorded.md). Once it does, a
  research task starts without approval: it changes nothing, and approving
  each one would stop the conversation it exists to keep going. Run settings
  bound it instead: how many run at once, and how many one user message may
  lead to, counted across the report turns that follow it. Each one counts
  against its runner's usage like any task.
- **Harness subagents stay in the turn (R5).** A harness's own subagents are
  still awaited before the turn ends (ADR-0009). #24 draws a line at the task
  boundary: inside a task the harness decides, and across tasks Ordewell does.
  This draws the same line at the turn: inside a turn, the harness's agents;
  across turns, a research task. The planner's instructions say to use a
  research task for anything it would otherwise run in the background.
- **On the surfaces (R6)**, a research task is a row in the plan, marked as
  research, with its log, usage, stop and retry like any task. Its report is
  drawn in the conversation as the run update that delivered it.

## Considered options

- **Let a harness's background agents outlive the turn**, and treat the turn
  the harness opens when they finish as a planner turn. Rejected: only some
  harnesses open one, the work is invisible to the plan and to its limits, and
  no surface can stop it. What crosses a turn belongs to Ordewell, as #24 says
  of what crosses a task.
- **A research job outside the plan.** Rejected: a second kind of background
  work beside tasks, with its own lifecycle, logs, limits and surfaces, for
  what a read-only task already is.
- **Wake the planner on every pass.** Rejected for ADR-0029's reason: passes
  ride along. A research task's report wakes it because the planner asked for
  that report.
- **Research tasks that always wait for approval.** Rejected once #104 lands:
  they change nothing, and approving each one stops the conversation they keep
  going. Until then they wait, since read-only is only as good as each
  runner's own mode.
- **Deliver reports only at the supervisor's levels.** Rejected: at Off the
  planner would never hear the answer to its own question.

## Consequences

- The planner can scout and plan in rounds while the user keeps talking: plan
  the first round of exploration, then extend the plan as reports come back.
  The planner prompt teaches this for open problems.
- This is delegation one level deep: a task whose report returns to the node
  that started it. Delegated tasks (#33) extend it to child plans.
- Research costs runner sessions. Run settings bound it, and the plan shows it.
- When this is implemented, CONTEXT.md gains *Research task*, and ADR-0009's
  wait rule and ADR-0029's "a pass never wakes it" are rewritten to name
  research tasks.

## History

- 2026-10-15 — accepted. Not yet implemented.
