# 0029 — The supervisor: levels, live planner turns, execution tools and auto-merge

**Status:** accepted — amends [ADR-0009](0009-coding-agents-as-planners.md),
[ADR-0013](0013-worktree-isolation.md), [ADR-0020](0020-ops-tasks-and-merge-gates.md)
and [ADR-0022](0022-ordewell-mcp-server.md); amended by [ADR-0030](0030-global-run-settings.md)
(the settings are global, saved and live; autorun)

*Pending:* [ADR-0035](0035-effects-are-consented-and-recorded.md) — `run_script`, its consent, and the scheduler starting only approved tasks (#95); [ADR-0037](0037-research-tasks-wake-the-planner.md) — a research task's report wakes the planner at every level.

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
- **Act** — Watch, and in wake-up turns it may also run, stop, retry and skip
  tasks, message runners, deny approvals, edit the plan and merge, inside the
  loop guards below.

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
naming its task and a short detail — the verdict's reason and the tasks the
failure blocks as the update goes out
([ADR-0034](0034-a-failed-task-blocks-only-its-dependents.md)), the question,
the request, the resume time — and the passes since the last one; the run's end
counts what completed, failed and is blocked. Never a log: the
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
| `skip_task` | end a task that failed, is blocked or is waiting for input as *skipped*, with a required reason; nothing of it lands, and its dependents go ahead, told the reason. In Act wake-up turns only |

A start the turn asks for after editing that task in the same reply — an edit
held until the reply ends — waits for the edit to land and then goes through
the seam again, so it runs as edited: the plan holds what runs. Before it
waits, it is judged against the task as the held edit leaves it, with the edit
counting as the change a retry after a failure needs: a start that could never
run is refused while the caller still reads the answer. One refused when it
goes through again is kept as refused, said to the user as a system line, and
told to the planner's next turn as a run update. An edit that
never lands — the turn stopped, or the edit refused as it landed — drops the
start, and the user is told; run on the unedited plan, it would not be what was
asked. In a wake-up
turn at Act the supervisor edits task by task; a whole new plan is refused,
since only edits let the user follow what changed.

**`skip_task` never vouches for work.** Verdicts come from evidence, so the
supervisor cannot Mark complete: that lands the work as if someone had checked
it, and only the user does. What it may decide is that work will not be waited
for. A skipped task gets no verdict and lands nothing; its worktree and branch
are kept, as a failed task's are, so the user can still look at it, retry it
or Mark complete it. A skip releases the task's dependents
([ADR-0034](0034-a-failed-task-blocks-only-its-dependents.md)), and each is
told in its prompt that the dependency was skipped and why, so it does not
count on that work. The reason is required of the supervisor and shown in the
timeline; the user's own Skip goes through the same command, as the user,
with the reason optional. The supervisor skips only a task that already needs
someone — failed, blocked, or waiting for input — never one that is running,
completed, or has not started with nothing blocking it.

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
  instruction; with autorun on and Full, the planner may also start a task it
  added after the plan was approved.
  `merge_all` and `skip_task` are refused: the user is in the conversation,
  and presses Merge all or skips the task themselves. A skip decides that
  work will not be waited for, which only the user, or a supervisor they let
  act, decides.
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
- **Skips count**: a skip of a task the supervisor retried this run counts
  against that task's retry limit, so past the limit the supervisor can
  neither retry nor skip it; the task is the user's. A skip of a task its own
  edit adds in the same reply is refused, and is never held for the edit to
  land as a start is.
- **No un-skipping**: a skipped task is never run again by the supervisor —
  not by `retry_task`, `run_task`, `run_plan` or an edit that re-arms it.
  Whether it runs again is the user's to decide.
- **Wake-up rate**: more than six wake-ups within 30 minutes with no pass in
  between drops the run to Watch, with a notice. A supervisor that keeps waking
  and nothing passes is spinning.

A start of a task that failed is a retry however it is asked for — `run_task`,
or `run_plan`, which would start every failed task again. What the guards
remember lasts from the user's start of a run to their next: a run the
supervisor restarts itself, or a usage-limit reset resumes, continues the one
before, its level as lowered included, or each restart would wipe the count.
A failure blocks only the failed task's dependents; independent work goes on,
and the run ends once nothing else can start (ADR-0034). A skip of the failed
task continues that ended run as a retry does, so what it blocked starts. An edit to the failed
task is reconciled into that ended run, keeping the task failed, so the
supervisor's retry after it continues the run and the tasks it blocked start
once it passes, rather than the one task running on its own.

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
Once the user says the limit has reset early, it may resume the task in its
saved session with `retry_task` from `session` (ADR-0018, U1). A pause is not
a failure, so no prompt or model change is asked of it, but the resume counts
against the task's retry limit; one that hits the limit again at once waits
for the user.

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

*Amended 2026-10-12 — merge at the end of a run, and who opens the handoff.*
A user who turned auto-merge on was still stopped at the end of the run, and
the handoff overlay asked about a merge the supervisor was about to make. So:

- **The setting also merges at the end of a run.** With it on, when a run
  settles with landed work that is not merged yet, Ordewell runs Merge all
  itself, by the same route as a gate merge: the `onAutoMerge` observer, the
  "auto-merged" timeline entry, a notice and the `isolation_merge` broadcast.
  If that merge stops (conflict, dirty overlap, failure) the run is handed off
  as before, and a supervisor that is watching gets an `auto_merge_stopped`
  event. The command is still `/automerge` and the key is unchanged; the
  setting reads "merge automatically": at merge gates and at the end of a run.
- **Surfaces do not open the handoff while a merge is coming.** With
  auto-merge on, no handoff is sent unless the automatic merge stops. With the
  supervisor at Act, the handoff is sent marked as deferred to the supervisor:
  the TUI prints only its transcript line, and the VS Code card says the
  supervisor may merge it but keeps its buttons. If the supervisor's wake-up
  turn for the finished run ends without merging, the handoff is sent again
  unmarked, and the TUI overlay opens then.

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
- **Rejected: let the supervisor Mark complete.** It would land work no
  evidence vouched for, with the model as the tie-breaker on whether it was
  done. A skip lets the run go on without the work instead, and lands none of
  it.
- **Rejected: a skip that marks the task complete.** The user's Skip did this
  until 2026-10-14: it landed the work as if vouched for, so "skip this, it is
  not needed" and "this is done" were one action with one effect.
- **Rejected: let any planner turn skip.** A plain planner turn the user did
  not let act would decide on its own that work need not be waited for.
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
  after a failure is reconciled into the run instead of reloading the plan. A start deferred behind a held edit
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
- 2026-10-12 — merge automatically also at the end of a run, and the end-of-run
  handoff is deferred while an automatic merge or an Act supervisor's merge is
  coming (see "Merge at gates automatically").
- 2026-10-13 — run supervision has one owner (`RunSupervision`), and who opened
  a run travels with the call that opened it rather than being read from what
  else was in flight: the user's Execute while a supervisor's `merge_all` was
  still merging had continued the run before, its lowered level and the
  guards' memory included.
- 2026-10-14 — a failure blocks only its dependents instead of halting the run; run updates name the tasks a failure blocks, and the run's end counts them ([ADR-0034](0034-a-failed-task-blocks-only-its-dependents.md)).
- 2026-10-14 — a start deferred behind a held edit is judged before it waits, against the task as edited, and one refused once the edit lands is told to the user and to the planner's next turn. Seen live: an Act supervisor's retry of a task added after the user approved the plan was answered "Queued", then refused after the turn with nobody told.
- 2026-10-14 — `skip_task`: a verdict-less `skipped` state that lands nothing and releases dependents, for the supervisor at Act with a required reason; the user's Skip goes through it as the user instead of marking the task complete. Skips count against the retry limit of a task the supervisor retried, and the supervisor never runs a skipped task again.
- 2026-10-14 — a task paused on a usage limit is resumed early with `retry_task` from `session`, outside the identical-retry guard and inside the retry limit (ADR-0018, U1).
- 2026-10-16 — plan approval is read only from the approval record, never from the plan's display status. The plan keeps its own `approved` mark, set by Execute plan, signing off a review and autorun's start, beside `approvedTasks`; a user's start of one task approves that task, not the plan. A plan saved before the mark existed is read from its status once, as it is adopted. Seen live: VS Code wrote its dock status (`draft`) onto the Session's plan after a run that ended with failures, after a stop and on reload, and every planner and supervisor start was then refused as unapproved. Surfaces keep their display status to themselves.
- 2026-10-16 — in Guarded, a planner start in a user-started turn of tasks the user has not approved asks instead of being refused: the approval card names the tasks a yes approves, a yes approves them as Execute plan does and starts the work, and a no is declined. Every other refusal still comes before the question, a plan the user never executed is still theirs to execute, and the supervisor's starts stay within what the user approved. A start deferred behind a held edit — `run_plan`, and a start of a task the edit adds — is judged against the plan as the edit leaves it, and one that will ask says so in its answer. Seen live: `run_plan` after `edit_plan` added tasks answered "Queued", and was refused once the reply ended.
- 2026-10-16 — the user's Stop of planner work cancels every user message waiting for it, at any stage — at the planner gate, behind a live opening or a live reply — each caller told it was stopped; before, it did so only at the gate, and the stopped turn's release opened the next one. Wake-ups waiting behind a stopped live turn are not what the user answered, so they stay undelivered and go with the next turn something else opens (the user's next message or the supervisor's next wake-up), never off the stopped turn's release; at the gate they are the stopped turn's and go with it. A force send still keeps the queue (ADR-0023). Seen live: a message sent while the opening ran was answered after Stop, its `submit_plan` landed, and autorun started a task.
