---
status: accepted
implemented: full
amends: ["0009", "0029"]
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
  V4). Like every read-only task
  ([ADR-0046](../planner-envelope/0046-a-read-only-task-reads-natively-runs-sealed-and-lands-nothing.md))
  it lands nothing: it works in a worktree of its own where the run isolates,
  which its sealed commands may write and which is thrown away when it ends,
  and in the workspace, which its commands cannot write, where the run does
  not.
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
- **Starting one (R4).** A research task the planner adds is approved as it
  lands and starts without asking, under ADR-0046's shared read-only profile.
  Removing research or lifting read-only withdraws that approval. How many a
  message starts is the planner's judgement: it starts a research task for each
  independent thread worth running in the background, and in a report turn
  starts another only when the report opens a genuinely new question. There is
  no per-message budget. The run's Parallel limit (`maxParallelSessions`,
  ADR-0030) bounds what runs at once: research tasks and every other task share
  the same slots, and one beyond the limit waits for a slot like any other. A
  research report does not spend a separate allowance. Each task counts against
  its runner's usage like any task.
- **Harness subagents stay in the turn (R5).** A harness's own subagents are
  still awaited before the turn ends (ADR-0009). #24 draws a line at the task
  boundary: inside a task the harness decides, and across tasks Ordewell does.
  This draws the same line at the turn: inside a turn, the harness's agents;
  across turns, a research task. The planner's instructions say to use a
  research task for anything it would otherwise run in the background.
- **On the surfaces (R6)**, a research task is a row in the plan, marked as
  research, with its log, usage, stop and retry like any task. It waits for a
  free slot like any other task. Its report is drawn in the conversation as the
  run update that delivered it: whole when short, folded after a few lines when
  long with the lines left out counted, and opened by the conversation's one
  detail switch.

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
- **Research tasks that always wait for approval.** Rejected once ADR-0046 is implemented on every runner:
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
- Research costs runner sessions. The run's Parallel limit bounds it, and the
  plan shows it.
- CONTEXT.md defines *Research task*. ADR-0009 keeps harness subagents inside
  their turn; ADR-0029 distinguishes research reports from ordinary passes.

## History

- 2026-10-15 — accepted. Not yet implemented.
- 2026-10-21 — where a research task works, and what it may write, follow read-only tasks as ADR-0046 defines them (R1).

- 2026-10-21 — implemented the core lifecycle, authority, approval and persisted message limits.
- 2026-10-21 — implemented the surfaces (R6): the research mark and the report block on the TUI, VS Code and the CLI commands, and the planner's guidance (R5).
- 2026-10-22 — the per-message research budget and its two run settings are gone: the planner decides how many a message starts, bounded by the run's Parallel limit, and a research task waits for a slot like any other (R4, R6).
