# 0029 — The supervisor: levels, live planner turns, execution tools and auto-merge

**Status:** accepted — amends [ADR-0009](0009-coding-agents-as-planners.md),
[ADR-0013](0013-worktree-isolation.md), [ADR-0020](0020-ops-tasks-and-merge-gates.md)
and [ADR-0022](0022-ordewell-mcp-server.md); amended by [ADR-0030](0030-global-run-settings.md)
(the settings are global, saved and live; autorun)

**Amends:** ADR-0009 and ADR-0022 — the planner gains execution tools, a further
explicit exception to harness planners being read-only; ADR-0013 — "never
merged for the user" now has two exits the user opts into; ADR-0020 — the
"merge at gates automatically" setting it left to the autonomy work.

## Context

Once a run starts, the planner only wakes when the user writes to it, and what
the user writes mid-run waits in a queue. `Session.processQueuedMessages` hands
that queue to the planner only when the scheduler parks behind it with no
attempt active (`TaskOrchestrator.tick`), so "stop task 4" or "why did task 5
fail?" sent during a long task is answered after it ends. Nobody but the user
notices a stuck, failing or off-track task, and only the user can start, stop,
retry or answer one.

Four issues approach this from different sides:

- **#27** decided the first stage: the planner that wrote the plan stays in the
  conversation, wakes on events that need attention, reads, and suggests. Its
  plan edits are refused in those turns.
- **#91** asks for planner tools to run and stop the plan or a task, behind one
  core command seam, before any supervisor exists.
- **#29** wants the supervisor to start, stop, retry and replan under limits,
  with guards against loops.
- **#23** is the mandate: grants, limits, inheritance, escalation. It is an RFC
  and the largest trust decision in the roadmap.

Waiting for the mandate before any of the rest ships leaves the run unwatched
for the whole of that design. Shipping each issue on its own gives three
entry points to the scheduler and three consent rules. This ADR settles the
part that does not need the mandate, in a shape the mandate can take over.

ADR-0013 says Ordewell never merges for the user; ADR-0020 kept that and left
merging at gates automatically to this work. #84 adds a pause that ends on its
own, the usage-limit reset, which a supervisor should hear about.

## Decision

**A plan has a supervisor level: Off, Watch or Act. The supervisor is the
planner conversation that wrote the plan, taking turns while the run goes on.
What it may do is checked in core at one command seam, never only in its
prompt, and the run never depends on it.**

### Supervisor levels

- **Off** — today. The planner speaks only when the user writes to it.
- **Watch** — #27 as decided. The supervisor wakes on attention events, reads
  everything, and writes to the user. Execution tools and plan edits are
  refused in its wake-up turns, with a note telling it to suggest the action
  to the user instead.
- **Act** — Watch, and in wake-up turns it may also run, stop and retry tasks,
  message runners, deny approvals, edit the plan and merge, inside the loop
  guards below.

The level is a plan setting, Off by default. **It is saved on the plan at run
start**: flipping it mid-run changes nothing until the next run, the rule
ADR-0001 keeps for modes. The one exception goes downward only: a tripped guard
or a failed supervisor lowers the level for the rest of the run, with a notice,
and so can the user — drop to Watch, or turn it off — at any time during the
run. A lowering takes effect at once, in the wake-up turn under way too: what
that turn calls or edits next is checked against the lowered level.

*Amended by [ADR-0030](0030-global-run-settings.md):* the level is a global
user setting, Watch by default, set with `/supervisor`. A change applies at
once, in either direction, to the session it is typed in, and to other
sessions from their next run. The user's command also lifts a guard's or a
failure's lowering, the guards' memory kept.

The levels are a slim precursor of the mandate (#23). Watch is its `observe`
grant; Act later becomes the bundle of `control` and `replan` (and the merge
grant #23's comment proposes). Grants given separately, limits, inheritance,
delegation and revocation stay with #23. Because the check already lives at the
seam, the mandate replaces the level check there and nothing above it moves.

### Same conversation, its own message kind

The supervisor is the planner conversation that wrote the plan (#27). It
knows why each task exists, and its notes appear in the chat the user already
has. Compaction keeps a long run bounded. Supervisor messages carry their own
`kind` in `conversationHistory`, so every surface can tell them from a reply
to the user and style them apart. There is no second model, no second
transcript, no second process.

### What wakes it

A wake-up turn is opened by a batch from `WakePolicy`
(`packages/core/src/services/WakePolicy.ts`), the pure, tested debounce #59
built. The attention events are:

- a task failed;
- a task is waiting for input;
- a task is waiting for approval;
- a task went idle;
- a landing conflict (ADR-0015);
- an automatic Merge all at a merge gate that stopped;
- the run finished;
- **new:** a task paused on a usage limit, with the time it resumes (#84).
  Every task one runner's limit pauses is one entry.

A pass never wakes it. Passes ride along as "since last time: tasks 2, 3, 4
passed". Events close together — within five seconds of the first — are merged
into one wake-up; the run's end is delivered at once. The policy is code,
not prompt text, so when the supervisor speaks is testable without a model.

A due batch reaches the conversation as a **run update**: one line per event,
naming its task and a short detail — the verdict's reason, the question, the
request, the resume time — and the passes since the last one. Never a log: the
supervisor reads more with `task_output` and `task_diff`. The run update is
the supervisor's input (`kind: 'wake_up'`), and what it says in the turn is
its note (`kind: 'supervisor'`). The rules of its level are told to it after
the run update, each turn, and never saved.

### Live planner turns replace the between-batches queue

The pending plan edit queue is removed. **A user message during a run and a
wake-up are both planner turns taken at once, one at a time, while running
tasks carry on.** A planner turn already holds the conversation one at a time
(`PlannerTurn`); a wake-up that arrives during a user's turn waits for it, and
a user message during a wake-up turn is held as a queued prompt.

- **The scheduler holds new starts for the duration of a turn.** Running tasks
  are untouched; nothing new is spawned until the turn ends. The hold is always
  released when the turn ends — settled, stopped, failed or timed out — so a
  planner that crashes cannot freeze the run. This is what keeps a turn's plan
  edits from racing a task that would otherwise start mid-turn.
- **Plan edits in a turn apply at once to tasks not yet started.** An edit aimed
  at a running or finished task is refused with a note the model can act on:
  "task 4 is running; stop it first, or retry it after". That is the planner
  side of ADR-0012's direct-versus-planner rule, now applied mid-run instead of
  deferred. A batch of edits still applies whole or not at all, so one refused
  op refuses its batch; a whole new plan is refused while tasks run, since only
  edits can leave running work as it is.
- **Inputs that arrive during a turn are taken together by the next one**, in
  order, through one entry (`PlanTurns.enqueue`) that names who the input is
  from. The hold also lapses after five minutes, after which the turn goes on
  without holding the run: an edit is checked against the tasks as they stand
  when it applies, so a task that started meanwhile refuses it.
- **Pending turns are persisted on the plan**, so a daemon restart neither
  loses a user's message nor a wake-up batch not yet delivered.

### Reads

- **`task_output` reads any attempt's saved task log**, not only the live tail:
  filtered by event kind and paged, so a supervisor can read why attempt 1
  failed while attempt 2 runs.
- **`task_diff`** is new: the attempt's changed files first, then one file's
  diff on request. A supervisor deciding whether to retry needs what the task
  did, not only what it said.
- **In a wake-up turn the per-message read cap is replaced by a per-turn read
  budget set on the plan**, 12 reads unless the plan sets another. The user's
  turns keep today's caps
  (`MAX_TASK_QUERIES`, ADR-0022 P3). A wake-up has no user message to bound it,
  and a supervisor reading three things before it must land would miss the one
  that explains a failure.

### Execution tools, through one command seam

All of these reach the scheduler through **one core command seam**, as #91
asked; no tool calls into `TaskOrchestrator` directly. The API planner reaches
the same seam through its own tool definitions.

| tool | does |
|---|---|
| `run_plan` | start the approved plan |
| `run_task` | start one ready task; refuses one whose dependencies or merge gate are not met, and says which |
| `stop_task` | stop one task, denying its open approvals as stop does |
| `stop_run` | stop every running task, keep the plan |
| `retry_task` | retry, continuing the saved session (ADR-0018, K1) or fresh; an amended prompt goes through `edit_plan` first, so the plan holds what runs |
| `message_task` | send a task message (ADR-0023) |
| `answer_approval` | deny a runner approval with a note, or escalate it to the user — never allow |
| `merge_all` | Merge all, in Act wake-up turns only |

A start the turn asks for after editing that task in the same reply — an edit
held until the reply ends — waits for the edit to land and then goes through
the seam again, so it runs as edited: the plan holds what runs. An edit that
never lands — the turn stopped, or the edit refused as it landed — drops the
start, and the user is told; run on the unedited plan, it would not be what was
asked. In a wake-up
turn at Act the supervisor edits task by task; a whole new plan is refused,
since only edits let the user follow what changed.

**`answer_approval` never allows.** A runner asks because its mode did not
cover the request. Allowing it would widen the mode the plan gave that task,
which ADR-0001 forbids at spawn and #92 forbids down the tree. A supervisor can
narrow (deny), or hand the decision to a person.

**Consent depends on who started the turn:**

- **A user-started turn** follows #91. Stops and messages are always allowed —
  they only end or steer work. Starts and retries ask the user in Guarded and
  follow plan approval in Full. An unapproved task never starts, at any level.
  *Amended by [ADR-0030](0030-global-run-settings.md):* with autorun on, a
  plan the planner submits is approved and started as the user's standing
  instruction.
  `merge_all` is refused: the user is in the conversation, and presses Merge
  all themselves.
- **A wake-up turn under Watch** refuses every execution tool with "suggest it
  to the user".
- **A wake-up turn under Act** allows all of them without asking. Choosing Act
  is the consent.

**Tasks the supervisor adds under Act count as pre-approved and may start —
ops tasks included.** This is a deliberate choice, and it carries the risk
#23's comment describes: an instruction injected into something the planner
read — an issue body, a fetched page, a task's output — can become an ops task
that runs unattended on real systems, in the session's mode, with no one asked
after the first approval. Without it, Act would stop at every replan for a
person, which is Watch with extra steps. The answer belongs in the mandate:
changes after approval going back to the user unless granted, declared scope
per ops task, and escalation of irreversible or outward effects. #23 revisits
this choice; until then Act is the user's statement that they accept it, and
the level picker says so.

**Every action is recorded in the timeline with who asked** — the user, a
planner turn, or the supervisor — and surfaces draw it as they draw the
matching button press, so the plan pane looks the same whichever route acted.

### Loop guards (Act)

Checked at the seam, where the action executes:

- **Retries per task**: default 2, configurable on the plan. Past it,
  `retry_task` is refused.
- **No identical retry**: a retry after a failure with the same prompt and
  model as the failed attempt is refused. Something has to change.
- **No oscillating edits**: re-adding a task it removed this run, or reverting
  its own edit, is refused.
- **Wake-up rate**: more than six wake-ups within 30 minutes with no pass in
  between drops the run to Watch, with a notice. A supervisor that keeps waking
  and nothing passes is spinning.

A start of a task that failed is a retry however it is asked for — `run_task`,
or `run_plan`, which would start every failed task again. What the guards
remember lasts from the user's start of a run to their next: a run the
supervisor restarts itself, or a usage-limit reset resumes, continues the one
before, its level as lowered included, or each restart would wipe the count.
A run a failure halted stays halted through an edit to the failed task, so the
supervisor's retry after that edit resumes the run rather than starting the one
task on its own.

A refusal is a plain note back to the model naming the guard and what would be
accepted. Each tripped guard also posts a supervisor message to the user.

### Failure handling: the run never depends on the supervisor

- **A wake-up turn has a timeout** of ten minutes. On a crash or hang the
  planner is restarted by its saved native session id (ADR-0009's resume path)
  and the turn retried once. A turn that does not end when stopped has the
  conversation taken back from it, and what it wrote is undone as a failure's
  would be. A planner turn that ends without a reply — a dead agent — is a
  crash here, not a note.
- **Then the run goes unsupervised**: it carries on as Off, with a visible
  notice. Wake-ups not delivered are persisted and handed over whole at the
  next successful turn or user message, so nothing that happened is lost to
  the conversation.
- **A planner usage limit waits for its reset** as a runner's does (#84),
  read from the planner's own words; one whose reset cannot be read leaves the
  run unsupervised.
- **Undelivered wake-up batches reload after a daemon restart.**

### Usage limits

A task paused on a usage limit wakes the supervisor with its resume time. Under
Act it may move pending tasks to another allowed runner. That is a recorded
plan edit, and it cancels those tasks' scheduled auto-resume and makes them
ready for the next scheduler slot. Direct user edits follow the same rule.
Other tasks on the old runner keep their shared wait. Changing only the model
on the same runner keeps the resume because the limit belongs to that runner's
account. Moving a running task is refused like any edit to a running task.

### Merge at gates automatically

A plan setting, saved at run start, **usable with the supervisor Off.** When a
task reaches a merge gate, Ordewell runs Merge all itself, through the same
queue as landings and the user's Merge all. A conflict, or a dirty overlap in
the user's tree, aborts it with the tree untouched (ADR-0014's preflight,
unchanged); the gate then waits for the user, with a notice and, if a
supervisor is on, a wake-up. The timeline records "auto-merged for task N".

This is a second, opt-in exit from ADR-0013's "never merged for the user",
beside `merge_all` under Act. Both are switched on by the user per plan;
without either, the user's Merge all stays the only path.

*Amended by [ADR-0030](0030-global-run-settings.md):* a global user setting,
`/automerge`, not a plan setting saved at run start; a change applies at once
to the session it is typed in.

### Out of scope

Spending limits and harness distribution (a separate design), delegation and
delegated tasks (#33), mandate inheritance (#23, #92), the escalation inbox
(#30). An escalated approval goes to the user through today's approval card
until #30 exists.

## Considered options

- **Rejected: wait for the mandate.** The run stays unwatched for the whole of
  #23's design, and the mandate would arrive with no seam to enforce it at.
- **Rejected: one on/off toggle (#27's original shape).** Some users want to be
  told, not acted for. Two consents need two settings; three levels is the
  fewest that hold both.
- **Rejected: the word "autonomous" for the level.** ADR-0001 uses it for runner
  permission modes, and the autonomy level (Full, Guarded) is a different
  setting. A Guarded session can have an Act supervisor.
- **Rejected: keep the between-batches queue.** A question about a running task
  is answered after it ends, and a wake-up about a failure waits behind the
  task that is still running. A queue for wake-ups beside the one for user
  messages would be two paths for one thing.
- **Rejected: pause running tasks during a planner turn.** Their work is not in
  question. Holding only new starts is enough to keep edits from racing a
  spawn.
- **Rejected: apply edits to running tasks by stopping them implicitly.** It
  hides a stop inside an edit. The refusal says "stop it first", and the stop is
  then its own recorded action.
- **Rejected: enforce the level in the prompt.** A prompt is advice. The model
  that wants to retry will try; the seam is where it learns it cannot (#29,
  ADR-0008's `refuse` tier).
- **Rejected: let `answer_approval` allow.** It widens a task's mode after
  the plan set it (ADR-0001, #92). Deny or escalate keeps the plan the source
  of truth.
- **Rejected: added tasks under Act wait for the user.** Safer against
  injection, but Act then stalls at every replan. Recorded as a choice for #23
  to revisit, not as safe.
- **Rejected: `merge_all` in user-started turns.** The user is present and can
  press it; a merge by proxy adds a route to the user's branch for nothing.
- **Rejected: a separate supervisor model or process.** It would not know why
  the tasks exist, and the user would have two conversations about one plan.
- **Rejected: a supervisor the run waits on.** A planner crash, hang or limit
  would stop work that does not need it. The run degrades to Off instead.
- **Rejected: auto-merge only with a supervisor.** Merging at gates needs no
  judgement — the preflight decides — and users who want it may not want a
  supervisor.

## Consequences

- The pending plan edit, its queue and the drain go. Surfaces stop listing
  edits above the input; a mid-run message is a planner turn like any other.
- The scheduler gains a start hold scoped to a planner turn, with release on
  every way a turn ends. A test must cover the failure path.
- The planner's MCP server gains `task_diff` and the execution tools; the API
  planner gains matching tool definitions. Both go through the command seam.
- Harness planners can now change what runs, not only the plan. The file-write
  and shell invariants of ADR-0008, ADR-0009 and ADR-0026 are unchanged: the
  planner still edits no file and runs nothing outside its envelope. Effects
  still happen only in tasks.
- A plan gains: supervisor level, retry limit, wake-up read budget, merge at
  gates automatically, and pending turns — the user's messages and the
  wake-up batches not yet delivered. Older plans load as Off, with no
  auto-merge. *Amended by [ADR-0030](0030-global-run-settings.md):* the plan
  keeps only the pending turns and the run's `runSettings`; the level, retry
  limit, read budget and merge setting are global, and older plans' values are
  ignored.
- Act with ops tasks can act on real systems unattended. The level picker says
  so; #23 owns the narrower answer.
- ADR-0013's "never merged for the user" holds unless the user opts in per plan.

## History

- 2026-10-11 — accepted.
- 2026-10-11 — the command seam and the planner's execution tools (#91), less
  `merge_all`: user-started turns only; the supervisor is refused until its
  levels land. Plan approval is kept on the plan as the tasks the user
  approved — every task when they execute it, and each one they start or retry
  themselves — and a Guarded start asks on the planner's approval card.
- 2026-10-11 — live planner turns implemented (`PlanTurns`); the pending plan edit queue, its drain and `modifyDuringExecution` removed.
- 2026-10-11 — the Watch level (`Supervisor`): wake-ups from run events, `usage_limit` coalesced per runner, run updates, the wake-up read budget, refusals at Watch, failure handling and persistence. Surfaces offer Off and Watch; a plan set to Act runs as Watch until Act's rules land.
- 2026-10-11 — the Act level: every execution command without asking, `merge_all` as a planner tool (refused in user-started turns), edits in wake-up turns (a whole plan refused), tasks the supervisor adds approved and marked `addedBy: 'supervisor'`, a moved task's scheduled resume cancelled, and the loop guards (`LoopGuards`; retry limit `supervisorRetryLimit`, default 2). Added: the user may lower a running supervisor at once (the downward exception above), a start waits for the same reply's held edit, and a start of a failed task counts as a retry however asked. Surfaces offer Act, saying what it allows.
- 2026-10-11 — moved tasks become ready on their new runner through the same resume decision as direct user edits; same-runner model changes keep the wait.
- 2026-10-11 — supervision survives a daemon restart: the loop guards' memory (retries, failed-attempt shapes, the supervisor's edits, reported trips) and the wake policy's undelivered events, passes and wake-up timestamps are saved on the plan (`supervision`) and restored when it is adopted, so a debounced batch is still delivered and the guards hold at the point they reached. A user-started run still clears them.
- 2026-10-11 — the surfaces' execution buttons reach the seam as the user, so
  their actions appear in the timeline as the planner's and the supervisor's do:
  Execute plan (`run_plan`), Run task (`run_task`), Retry (`retry_task` from
  `fresh`), Continue (`retry_task` from `session`), Stop/cancel (`stop_task`),
  Stop execution (`stop_run`), a task message (`message_task`) and a runner
  approval's deny (`answer_approval`). `approveReview` approves every task in
  the plan, as executing it does. Force start past a merge gate, Mark
  complete/incomplete, Skip and the user's Merge all stay on their Session
  methods: the seam has no command for the first three, and its `merge_all` is
  the supervisor's — it flattens the structured merge result the Merge all card
  renders.
- 2026-10-11 — final verification of the merged slices. A planner edit adopted
  while a failure halts the run is reconciled into the run instead of reloading
  the plan, and keeps the failed task failed, so the retry after it resumes the
  run (before, the reload dropped the review approval and the retried task ran
  alone, its dependents never starting). A start deferred behind a held edit
  that never lands is dropped with a notice. VS Code's task-log message and
  Continue, and its Retry and Cancel task commands, reach the seam as the user,
  as the other surfaces' buttons do. The defaults are stated in the body: retry
  limit 2, wake-up read budget 12, wake-up debounce 5 s, wake-up turn timeout
  10 min, start-hold lapse 5 min, wake-up rate more than 6 in 30 min.
- 2026-10-12 — amended by [ADR-0030](0030-global-run-settings.md): the level,
  merge at gates automatically, the retry limit and the read budget become
  global user settings changed by chat commands, applied at once to the
  session they are typed in; Watch is the default; autorun starts a submitted
  plan.
