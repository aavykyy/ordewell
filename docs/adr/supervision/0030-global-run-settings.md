# 0030 — Run settings are global, saved and live; autorun

**Status:** accepted — amends [ADR-0001](../routing/0001-autonomous-mode-resolution.md),
[ADR-0013](../isolation/0013-worktree-isolation.md), [ADR-0020](../isolation/0020-ops-tasks-and-merge-gates.md)
and [ADR-0029](0029-the-supervisor.md)

*Pending:* [ADR-0035](0035-effects-are-consented-and-recorded.md) — with autorun on in Full, the planner's script tasks run without asking.

**Amends:** ADR-0029 — the supervisor level, merge at gates automatically, the
retry limit and the wake-up read budget stop being per-plan settings saved at
run start; the default level becomes Watch; "an unapproved task never starts"
gains the autorun exception. ADR-0013 and ADR-0020 — "the user opts in per
plan" becomes "the user opts in". ADR-0001 — where the Full/Guarded level is
saved, not what it means.

## Problem

ADR-0029 made four settings plan settings: the supervisor level, *Merge at
gates automatically*, the supervisor's retry limit and the wake-up read budget.
Each is saved on the plan and captured at run start, so a change during a run
applies to the next one. Only a lowering of the level takes effect at once.

In use, that shape is wrong three ways:

- **They describe the user, not the plan.** How much a person lets Ordewell act
  for them does not change from one goal to the next. Per plan, every new
  session starts at the defaults and the user sets them again, or forgets to.
- **"Applies to the next run" reads as broken.** The user turns auto-merge on
  during a long run, the next gate waits anyway, and nothing on screen says
  why. ADR-0029 borrowed the rule from ADR-0001's modes, but the reason does
  not carry over: a mode is part of the plan the user reviews and of what a
  task runs with; the level and the merge setting are neither.
- **A session still stops at review.** Even at Act with auto-merge on, a new
  goal waits for the outline to be confirmed and for Execute. A user who wants
  to state a goal and come back to a finished run has no setting for it.

ADR-0029 stated the per-plan choice but weighed no alternative to it, so no
rejected option is reopened here.

The Full/Guarded level (ADR-0001) has a related problem. The TUI and CLI save
it in `~/.ordewell/.env`, which the daemon reads only when it starts, and the
extension in VS Code's own `ordewell.autonomousMode` setting, so two surfaces
on one machine can disagree.

## Decision

**Full/Guarded, the supervisor level, merge at gates automatically, autorun,
the retry limit and the wake-up read budget are machine-wide user settings,
saved in `settings.json` and changed with chat commands. A change applies at
once to the session it is made in, and to every other session from its next
run. Autorun, a new setting, starts the plan when the planner submits it.**

### One store, machine-wide

`settings.json` in the global data dir (`SettingsService`) holds every value.
There is no per-plan value and no per-workspace override.

- **The plan stores none of them.** Older plans' `supervisorLevel`,
  `mergeAtGatesAutomatically`, `supervisorRetryLimit` and `wakeUpReadBudget`
  are ignored on load and dropped on the next save. A plan once set to Act
  opens under the global level: the safe direction, accepted rather than
  migrated.
- **A run keeps its own copy, `runSettings`.** It is what the run actually used,
  the record behind the timeline, and the value a guard or a failure lowers.
- **Full/Guarded moves too.** On first start, a value in `~/.ordewell/.env` or
  a non-default `ordewell.autonomousMode` is copied into `settings.json` once,
  so nobody's level flips; the VS Code setting is removed from the extension.
  `ORDEWELL_AUTONOMOUS_MODE` stays as an override from the environment, but
  Ordewell no longer writes it. Its meaning is unchanged: read at generation,
  never at spawn (ADR-0001).
- **No new environment variables.** A script or CI run that needs its own
  values points `ORDEWELL_SETTINGS_PATH` at its own file.

| setting | values | default |
|---|---|---|
| autonomy level | Full, Guarded | Full |
| supervisor level | Off, Watch, Act | **Watch** |
| merge at gates automatically | on, off | off |
| autorun | on, off | off |
| supervisor retry limit | whole number ≥ 0 | 2 |
| wake-up read budget | whole number ≥ 1 | 12 |

Watch becomes the default because it only reads and writes notes to the user:
it never acts, and it makes the planner's watching of a run something a new
user has without asking. Its cost is planner usage on each wake-up. Older
plans that loaded as Off follow the global value like any other.

### Commands, not plan controls

The settings change in the planner chat, by commands the surface handles. A
bare command reports the value; an argument sets it.

| command | sets |
|---|---|
| `/auto [full\|guarded]` | autonomy level |
| `/supervisor [off\|watch\|act]` | supervisor level |
| `/supervisor retries <n>` | retry limit |
| `/supervisor reads <n>` | wake-up read budget |
| `/automerge [on\|off]` | merge at gates automatically |
| `/autorun [on\|off]` | autorun |

`/supervisor act` and `/autorun on` ask to confirm and say what they allow,
ops tasks on real systems included. The plan pane's `G`, `W` and `L` and VS
Code's plan-card controls are removed: one route per setting. `L` had no job
left, since `/supervisor watch` now lowers the run at once.

**The planner cannot change any of them.** The commands never reach the
planner as a message, and no planner tool, MCP tool or route the planner can
reach sets a run setting. A supervisor that could raise its own level would
make the level its own consent.

### Seeing them

The welcome screen's Setup block, in the TUI and in VS Code's empty chat, gains
two rows: **Autonomy** (Full/Guarded, `/auto`) and **Run** (supervisor level,
auto-merge, autorun, and their commands). Act and autorun on are drawn as a
warning, as the autonomous mode's `⚡` is. A status badge shows the same values
at all times, not only during a run, and during a run shows the run's level
where it differs from the global one: `Act → Watch (loop guard)`.

*2026-10-13:* in the TUI the badge sits at the right end of the status row
rather than on a row of its own, and is left off the bare welcome screen,
whose Setup block already shows the same values.

*2026-10-14:* the status row it shares with the badge now speaks only for the
chat on screen: `Planning…` in the planner's chat, `Working…` in a running
task's, nothing when that chat is idle. What the run waits on (tasks that wait
for you, a pause for Merge all) moved to the plan pane's title.

The two rows keep the glossary's line: *autonomy* names Full/Guarded only, and
the other four are the **run settings**.

### When a change applies

A command changes **the saved global value and the session it was typed in, at
once, in either direction.**

- **The session's run, if one is under way, takes the new value now.** Its
  `runSettings` is updated and the next merge gate, wake-up, retry or read is
  decided by it.
- **Every check at the command seam reads the run's level at the moment of the
  call.** A wake-up turn already under way is held to a lowering at once, as
  ADR-0029 already says, and may use a raise at once; its prompt still carries
  the rules it was given, so a raised turn may only suggest. The next turn is
  told the new rules.
- **Other sessions with a run under way keep their run's values until it
  ends.** Their next run starts from the global values. A raise typed in one
  repository never reaches a run the user was not looking at.
- **Sessions with no run read the global values when they next need them**: a
  planner turn reads autorun and Full/Guarded, a run start copies the rest.

There is no "lower every run everywhere" from one window; lowering a run is done
in its session, or by stopping it.

### The user's command beats an automatic lowering

ADR-0029 lowers a run for its rest when a loop guard trips (Act to Watch) or
the supervisor fails (unsupervised). A user's command after either sets the run
to the level typed:

- **After a guard**, the loop guards keep their memory — retries, failed-attempt
  shapes, the supervisor's edits — so raising the level never resets a limit.
  Only the wake-up rate window is cleared; kept, it would trip again at the next
  wake-up.
- **After a failure**, the command restarts supervision. Wake-ups not delivered
  are handed over whole at its first turn, as they are after a user message.

It is a fresh consent, given after the notice that explained the lowering.

### Autorun

**With autorun on, a plan the planner submits is approved and started, as if
the user had pressed Execute.** It is a switch of its own, independent of the
supervisor level, for the reason ADR-0029 keeps auto-merge independent: two
consents, "I do not need to see the plan" and "act for me when something goes
wrong", that users want in either combination.

- **The planner skips the outline gate.** Its prompt, read on each turn, tells
  it to write the outline into the chat as the plan's summary and submit
  without waiting. It still asks clarifying questions when it needs answers:
  a guess on real ambiguity that then runs unattended is the costly failure.
- **It fires on a submission only** — the first plan of a session, or a new
  plan after a run has finished. Never when a session loads with a plan
  waiting, and never when `/autorun on` is typed while one waits: that plan is
  already in front of the user.
- **The approval and the start are recorded** in the timeline as `run_plan`
  through the command seam, with autorun as who asked, and drawn as
  "Started by autorun".
- **It works under Guarded.** Guarded keeps meaning what ADR-0001 says, the
  runners' safe modes; autorun answers whether the plan waits, not what each
  task may do. ADR-0029's rule that a planner's own `run_task` and
  `retry_task` ask in Guarded is unchanged: autorun is the user's standing
  instruction, not the planner choosing to start.
- **It starts ops tasks too.** This is a deliberate choice, and it carries the
  risk ADR-0029 names for Act's added tasks, wider: an instruction injected
  into something the planner read can become an ops task that runs on real
  systems from a plan no person read. Holding plans with ops tasks for review
  was weighed and rejected below. The narrower answer — declared scope per ops
  task, escalation of outward effects — belongs to the mandate (#23), which
  revisits this. Until then, `/autorun on` is the user's statement that they
  accept it, and its confirmation says so.

This is the exception to ADR-0029's "an unapproved task never starts": under
autorun, submission is approval.

**With autorun on and Full, the planner may also start a task added after the
plan was approved.** A task the planner adds to an approved plan is otherwise
unapproved until the user starts it, so with autorun on a finished run stopped
at the first follow-up: the planner added the task, its `run_task` was
refused, and the task waited for a person the user had said was not needed.

- **The planner starts it, when it asks** — `run_task`, or `run_plan` over a
  plan with added tasks. Nothing starts on its own: adding a task for later
  stays possible, and autorun still fires on a whole submitted plan only.
- **A start in the reply that adds the task waits for the edit to land**, as a
  start of a task the reply edits already does (ADR-0029).
- **Both settings are read at the start**, not when the task was added, so
  turning autorun off or going to Guarded stops it at once. A start that goes
  through approves the task, as the user's own start does.
- **Ops tasks too**, for the reason autorun starts them in a submitted plan.
- **Only a planner turn the user started, and only on a plan the user or
  autorun approved.** Under Guarded, autorun off, or a plan never approved, an
  added task waits for the user as before. The supervisor's starts follow its
  level (ADR-0029): Act already counts its own added tasks as approved.

### API

`GET /api/settings` answers every run setting and the autonomy level;
`PATCH /api/settings` changes any of them, and with a `sessionId` also applies
the change to that session at once, as a command does. The per-plan
`PATCH /api/plans/:sessionId/settings` and
`POST /api/plans/:sessionId/supervisor/lower` are removed: their only client is
the CLI's own `apiClient`, and the project is before 1.0.

The route takes the run settings as named fields, never the autonomy level.
Full/Guarded stays in `SETTINGS_ENV_REFUSED`'s approval-posture class: a
surface writes it to `settings.json` itself, through `SettingsService`, and
the daemon reads it from there at generation.

## Considered options

- **Rejected: keep them per plan.** Every new goal starts at the defaults, and
  the settings describe the user, not the goal.
- **Rejected: per workspace.** A setting saved per
  repository is set again in every repository and forgotten in most. A
  per-workspace override for a repository with ops tasks on production can
  come later if it is needed.
- **Rejected: a global default with a per-plan override.** Two values for one
  setting, and a pane that must show which one won.
- **Rejected: keep "applies at the next run".** The rule fits modes, which are
  part of the reviewed plan; it does not fit the level or the merge setting,
  and it makes a change look ignored.
- **Rejected: a change reaches every session's run at once.** It would raise a
  run in another repository, perhaps one with ops tasks, to Act without the
  user looking at it.
- **Rejected: raises apply only to the typing session, lowerings everywhere.**
  Safer for a "stop everything", at the cost of an asymmetry no other setting
  has. Sessions keep what they started with, as in other agent tools.
- **Rejected: a guard's or failure's lowering holds over the user's command.**
  It brings back "change it now, it applies later" for the case where the user
  has just read why.
- **Rejected: autorun implied by Act, or allowed only with Act.** It ties two
  consents together and forbids autorun with Watch or Off, and Act without
  autorun.
- **Rejected: autorun skips clarifying questions too.** The planner would guess
  on real ambiguity, and the guess would run unattended.
- **Rejected: autorun skips only the final review.** The outline confirmation
  becomes the review, and the user still answers once per session.
- **Rejected: autorun holds plans with ops tasks for review, or holds the ops
  tasks back.** Safer against injection; recorded as a choice for #23 to
  revisit, not as safe.
- **Rejected: Guarded turns autorun into an approval card.** One setting would
  silently switch another off.
- **Rejected: autorun on by default.** With Full also the default, a new user's
  first goal would run agents without permission prompts from a plan they never
  saw, and the README's "review the plan" would describe a product that is not
  there out of the box.
- **Rejected: mirror the values into VS Code's settings.** Two stores and a sync
  with conflict rules, for a settings page. The commands and the Setup row show
  them on every surface.
- **Rejected: an "Autonomy" label over all of them.** The glossary keeps
  *autonomy* for Full/Guarded; a Guarded session can have an Act supervisor.
- **Rejected: keep the old routes as aliases.** One in-repo client, before 1.0.

## Consequences

- `UserSettings` gains the six values; the plan loses four fields and keeps
  `runSettings`, which one module owns (`RunSupervision`): it copies them at
  a run the user starts, keeps them for a run that continues, and applies the
  user's change to the run under way (`Session.applyRunSettings`). The
  scheduler keeps no value of its own: it reads the run's `runSettings` as it
  decides each automatic merge.
- The TUI and VS Code gain the commands and the Setup rows, and lose `G`, `W`,
  `L` and the plan-card controls. VS Code's `ordewell.autonomousMode` goes.
- The planner prompt gains an autorun branch: no outline gate, submit after the
  summary. The rule is read each turn, so turning autorun on mid-conversation
  changes the planner's next turn.
- The timeline gains autorun as an actor.
- With autorun on, Full and Act, Ordewell can go from a goal to changes on real
  systems with no person reading anything. Each of the three is a separate
  command with its own confirmation; #23 owns the narrower answer.
- ADR-0013's "never merged for the user" holds unless the user opts in, once,
  for every plan.
- The README's "Review the plan" step names `/autorun` as the way to skip it.

## History

- 2026-10-12 — accepted.
- 2026-10-12 — `/settings` in VS Code is a Run block in the chat's Settings panel, saving each setting as it is set; the terminal UI takes Parallel, retries and reads as typed numbers and steps with ←/→.
- 2026-10-12 — the terminal UI's `/settings` saves each step on enter and stays on it, instead of saving once at the last step; esc closes and keeps what was saved. Users wanted to see a choice take effect and leave with esc, as the VS Code Run block already allows. Act and autorun on still ask first, and the menu returns to the step either way.
- 2026-10-12 — with autorun on and Full, the planner may start a task added
  after the plan was approved; a start in the reply that adds it waits for the
  edit to land.
- 2026-10-12 — amended: the setting is read as "merge automatically": at merge
  gates and at the end of a run. A user who turned it on was still stopped at
  the end of the run, and the handoff overlay asked about a merge the
  supervisor was about to make. The command `/automerge` and the settings key
  `mergeAtGatesAutomatically` are unchanged; the handoff is not opened by the
  surfaces while an automatic merge is coming
  ([ADR-0029](0029-the-supervisor.md), "Merge at gates automatically").
- 2026-10-13 — one owner of the run's settings (`RunSupervision`); the
  scheduler reads them as it decides instead of holding a copy pushed from
  several places. A run the supervisor opened had merged by the user's setting
  from another session rather than by its own.
