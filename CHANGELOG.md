# Changelog

All notable changes to this project are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).
While Ordewell is pre-1.0, minor versions may contain breaking changes.

## [Unreleased]

### Security

- **The planner cannot raise its own consent.** The supervisor level, merge
  automatically, autorun and Full/Guarded are changed by your chat commands
  only; no planner tool, MCP tool or route the planner can reach sets them,
  and the commands never reach the planner as a message
  ([ADR-0030](docs/adr/0030-global-run-settings.md)).
- **A supervisor can narrow a runner's permissions, never widen them.**
  `answer_approval` denies a runner's request with a note or hands it to you;
  it cannot allow one. Effects still happen only in tasks: the planner still
  edits no file and runs nothing outside its envelope
  ([ADR-0029](docs/adr/0029-the-supervisor.md)).
- **A repository cannot poison Ordewell's TOML reader.** Ordewell reads a
  repository's `.codex/config.toml` before anything is approved;
  a `__proto__`, `constructor` or `prototype` key is now refused, and the
  tables it builds are prototype-free, so a key in the file can never reach an
  inherited member.
- **A repository's MCP server cannot wear Ordewell's name.** A project server
  named `ordewell_x` had its tools pre-approved as Ordewell's, which are never
  asked about. Ordewell now recognises its own tools by the exact tool or
  server name, never a prefix, and an OpenCode project server whose name could
  give one of its tools an Ordewell name is not offered to the planner at all
  ([ADR-0022](docs/adr/0022-ordewell-mcp-server.md),
  [ADR-0028](docs/adr/0028-planners-never-run-repository-config.md)).

### Added

- **A supervisor that watches your run, and optionally acts.** The planner
  conversation that wrote the plan now takes turns while the run goes on, at
  one of three levels: **Off** (it speaks only when you write), **Watch** (the
  default: it wakes on a failure, a task waiting for input or approval, an idle
  task, a landing conflict, an automatic merge that stopped, a usage-limit
  pause or the end of the run, reads what it needs and writes you a note), or
  **Act** (it may also run, stop and retry tasks, message runners, deny
  approvals, edit the plan task by task and merge, without asking). A wake-up
  is a digest, one line per event with the passes since the last one, never a
  log. Its notes are marked as the supervisor's in the chat. It decides what
  to do next, never whether a task passed
  ([ADR-0029](docs/adr/0029-the-supervisor.md)).
- **The supervisor can skip a task at Act.** `skip_task` gives up waiting for
  a task that failed, is blocked or is waiting for input, with a required
  reason that the timeline shows and the dependents are told. Like your Skip,
  it lands nothing; the supervisor can never mark work complete. At Watch it
  is refused like the other execution tools, and a planner turn you started
  cannot skip. A skip of a task the supervisor retried counts against its
  retry limit, it cannot skip a task its own edit adds in the same reply, and
  it never runs a skipped task again: that is yours to decide
  ([ADR-0029](docs/adr/0029-the-supervisor.md)).
- **Guards that keep Act from looping.** A task is retried at most twice by
  default (`/supervisor retries <n>`), an identical retry or re-adding a
  task it removed is refused, and more than six wake-ups in 30 minutes with no
  task passing drops the run to Watch with a notice. A turn that crashes or
  hangs is restarted once; after that the run carries on unsupervised, with a
  notice. Tasks Act adds count as approved, ops tasks included, so choosing Act
  accepts that an instruction injected into something the planner read could
  run unattended on real systems.
- **Supervision survives a daemon restart.** Wake-ups not yet delivered, the
  user's messages waiting for a turn, and the loop guards' counts are saved
  with the plan and restored when it is loaded again.
- **The planner can run the plan, not only write it.** Tools `run_plan`,
  `run_task`, `stop_task`, `stop_run`, `retry_task`, `message_task`,
  `answer_approval` and `merge_all` reach the scheduler through one command
  seam, the same one the surfaces' buttons now use, so the timeline records
  who acted: you, a planner turn or the supervisor. In a turn you started,
  stops and messages go through, starts and retries ask you in Guarded and
  follow plan approval in Full, and `merge_all` is refused because Merge all is
  yours to press.
- **The planner can read why an attempt failed.** `task_output` reads any
  attempt's saved log, filtered by event kind and paged, and the new
  `task_diff` lists the files an attempt changed, then one file's diff.
- **Merge all at any point during a run.** Whenever landed work is not in your
  branch yet, the TUI plan pane says how many landed tasks are not merged
  (`/handoff merge`) and VS Code shows a Merge all button with the same
  count. A task gated on that work still waits for it
  ([ADR-0013](docs/adr/0013-worktree-isolation.md),
  [ADR-0020](docs/adr/0020-ops-tasks-and-merge-gates.md)).
- **Merge automatically.** `/automerge on` merges for you at each merge gate
  and, now, at the end of a run: a run that settles with landed work not yet
  merged runs Merge all itself, by the same preflight. A conflict or a dirty
  overlap aborts with your tree untouched and the run is handed over as
  before. The timeline reads "auto-merged at the end of the run".
- **Run settings you set once.** `/supervisor [off|watch|act]`,
  `/supervisor retries <n>`, `/supervisor reads <n>`, `/automerge [on|off]`
  and `/autorun [on|off]` report the value when bare and set it with an
  argument; `ordewell supervisor`, `ordewell automerge` and `ordewell autorun`
  do the same from the shell. The welcome screen's Setup block gains an
  **Autonomy** row and a **Run** row, and a badge shows the values at all
  times. `/supervisor act` and `/autorun on` ask you to confirm and say what
  they allow ([ADR-0030](docs/adr/0030-global-run-settings.md)).
- **Autorun.** With `/autorun on`, a plan the planner submits is approved and
  started as if you had pressed Execute, and the planner skips the outline
  gate but still asks clarifying questions. It fires on a submission only,
  never when a session loads with a plan waiting. With autorun on and Full, a
  planner turn you start may also start a task it added to an approved plan.
  Under Guarded those tasks wait for you as before.
- **Read-only tasks.** A review, an audit or an analysis that must not change
  files is marked read-only in the plan, and runs in its runner's read-only
  mode (`plan` on Claude Code, Codex and OpenCode) at either level. It stays
  read-only through a move or a split, and its AI subtasks inherit it
  ([ADR-0031](docs/adr/0031-the-planner-says-read-only-not-a-mode.md)).
- **Usage on every task attempt.** Each attempt records its tokens, reported
  cost and wall time, grouped by the model that actually ran, and the task
  row, the plan total, `ordewell status` and the VS Code task card show them.
  A measure a runner did not report reads "unknown", never zero, and usage with
  no model named is labelled "unattributed".
- **A task paused on a usage limit resumes by itself.** When the runner names
  the reset (Claude Code and Codex do, OpenCode does not), the task shows
  "Resumes at 8:10pm" with a cancel and is continued from its saved session at
  that time. Tasks paused on one runner share one wait, and a plan loaded after
  the time resumes at once. Without a time, after a cancel, or when the limit
  is hit again at once, the task waits for a manual retry
  ([ADR-0018](docs/adr/0018-structured-runner-transport.md)).
- **Resume now, when the limit resets early.** A task paused on a usage limit
  resumes in its saved session as soon as you say so, instead of waiting for
  its reset or starting over: *Resume now* on its row (`r` in the terminal UI,
  a button in VS Code), or a message typed into its box, which the runner gets
  after the reset notice. Every other task waiting on that runner's reset
  resumes with it. The planner and an Act supervisor resume it with
  `retry_task` from `"session"`, and a message sent to it with `message_task`
  resumes it too. A resume that hits the limit again at once waits for you.
  The cancel is now labelled *Don't resume*, and Skip is offered while the
  task is paused ([ADR-0018](docs/adr/0018-structured-runner-transport.md)).
- **Send now in the planner chat.** `ctrl-s` in the terminal UI, and *Send now*
  in VS Code, interrupts the planner turn in flight and answers the message
  alone in the turn that replaces it, ahead of every prompt already queued; the
  run's tasks carry on untouched, and a queued prompt the planner already has
  is marked handed over. A running or waiting task's VS Code card also carries
  a message box with the same button (`Ctrl+Enter`).

### Changed

- **Skip no longer lands a task's work.** Skip used to mark the task complete,
  landing whatever it had done as if you had vouched for it. A skipped task now
  ends as **skipped**: no verdict, and nothing it produced lands. Its worktree
  and branch are kept, as a failed task's are, so you can still look at it,
  retry it or Mark complete it later. The tasks that depend on it go ahead
  without it, and their prompt says it was skipped and why. Skipped is shown
  apart from done and failed in the terminal UI, VS Code and `ordewell
  status`, and counted on its own in a run's summary. Skip is offered on a
  failed, blocked or waiting task; `ordewell skip <id> --reason "…"` takes an
  optional reason. **Mark complete is unchanged**: it is how you vouch for work,
  and it lands it.
- **A failed task blocks only its dependents.** A failure used to halt the
  whole run until it was retried. Now independent work keeps starting, the
  failed task's dependents (and theirs) are shown "blocked by #N" on every
  surface, and the run ends once nothing else can start, counting what
  completed, failed and is blocked. Retrying the failed task, or skipping it,
  continues that run, and what it blocked starts
  ([ADR-0034](docs/adr/0034-a-failed-task-blocks-only-its-dependents.md)).
- **Codex's read-only and Guarded modes are off where its sandbox cannot
  start.** Ordewell checks Codex's sandbox once per daemon. On a host where it
  cannot start (stock Ubuntu 23.10 and later, many containers), those modes are
  listed as unavailable with the reason, never assigned by the planner or the
  pickers, and a task already in one fails at start saying why; Ordewell never
  swaps the mode for another. Full access is not sandboxed and stays available.
  [docs/troubleshooting.md](docs/troubleshooting.md) explains the cause and how
  to fix it ([ADR-0033](docs/adr/0033-codex-planner-without-its-sandbox.md)).
- **A task's report is its full `task_complete` summary.** The summary is kept
  whole as the task's `report` (cut at 20,000 characters, saying so), and
  `task_query` and `task_output` return it ahead of any log tail. A dependent's
  prior task outputs carry it in place of the tail, cut at 4,000 characters per
  dependency; `logTail` is kept only for attempts that ended without a report.
  Saved sessions load unchanged. The completion instruction now tells a runner
  that the summary is its whole result, and that a read-only task's findings
  belong there, not in a file.
- **A runner is reminded once when its turn ends without `task_complete`.** A
  clean turn end gets one reminder from Ordewell, once per attempt, before the
  task waits for input; never after a failed or interrupted turn, a usage
  limit, or while your message is queued. The task stays in progress and only
  `task_complete` settles it. Task messages carry a `from: 'ordewell'` marker,
  and the task log shows the reminder as an "Ordewell: …" system line
  ([ADR-0018](docs/adr/0018-structured-runner-transport.md)).
- **Runners' own memory is off in Ordewell runs.** Claude Code's auto-memory
  and Codex's memories no longer load into planners or tasks, so a plan and a
  task depend on the repository and your instruction files, not on notes
  outside it. Your runners' memory outside Ordewell is untouched
  ([ADR-0032](docs/adr/0032-runner-state-outside-the-workspace.md)).
- **Guarded planners read the web without asking.** Under the default `auto`
  approval mode, fetches and searches run at both levels, still behind the
  private-address guard, the secret check, `!` exclusions and the web-read
  budget. Set the approval mode to `ask` to approve each new site and search
  provider. `curl` and `wget` still ask per site in Guarded
  ([ADR-0027](docs/adr/0027-web-reads-in-the-planner-envelope.md)).
- **The terminal UI takes the logo's teal and your theme's background.** One
  accent, the logo's teal, marks the prompt, the planner, carets, headings and
  the logo's dot; yellow, green and red are left to mean a state. The welcome
  draws the full logo, icon and wordmark, when the terminal has room for it,
  and in a smaller one the wordmark alone, broken over two lines when narrow;
  a terminal too small for any of them skips the logo. The version sits after
  the workspace path at the foot of the welcome. The
  grey band under your messages and the composer is mixed from the background
  your terminal reports, so it is a lighter step on a dark theme and a darker
  one on a light theme instead of a near-black slab. The plan pane puts a blank line between
  tasks and hangs runner and model under the title, and footer keys read
  brighter than what they do. The autonomy and run settings badge moves from
  its own top row to the right end of the status row, and is left off the
  welcome, whose Setup block shows the same.
- **`/planner` is one stepped flow.** In the terminal UI and in VS Code it
  walks Harness › Model › Effort; VS Code saves once, at the end, and
  cancelling there applies nothing. `/planner <provider>`, `/model` and `/planner-effort`
  remain as shortcuts. The user-facing name is now *planner model*; the
  `orchestratorModel` setting and `ORCHESTRATOR_MODEL` are unchanged.
- **`/settings` walks your run settings.** Autonomy, supervisor (with retries
  and reads), merge automatically, autorun and parallel are set in one stepped
  panel in the terminal UI, and only what changed is saved. In VS Code they are
  a Run block in the chat's Settings panel: each is clicked or typed and saved
  at once, and Act and autorun still ask first. The individual commands remain.
- **Parallel, retries and reads take a typed number.** In the terminal UI's
  `/settings` they are numbers, typed or moved by ↑/↓, instead of preset lists.
- **Terminal pickers are restyled.** Short lists are numbered, labels and
  details are aligned, and the current value is marked. Multi-choice pickers
  switch steps with ←/→ (tab and shift-tab still work).
- **The welcome shows a compact 3-row logo at every terminal size.** The mark
  carries the wordmark (plain bold text, letter-spaced) and version beside it, and stays at
  the top of a short terminal; the large braille banner, its one-line fallback and the
  description paragraph are gone.
- **Esc closes the `/settings` and `/planner` menus** in the terminal UI,
  discarding choices not yet confirmed, instead of going back a step.
- **Enter saves at once in the terminal UI's `/settings` and `/planner`.** The
  menu shows the new value straight away and esc keeps it; `/settings` stays on
  the step, `/planner` moves on, and Act and autorun still ask first.
- **Your messages and the input box sit on a grey band.** In the terminal UI's
  chat and task view each message you sent is set off by a grey band the width
  of the pane, so it is easy to find when scrolling back, and the input box you
  type in is on the same band.
- **Plan rows are one line plus a meta line.** Skills, effort and mode show
  when a row is expanded. Per-task usage moved out of the rows into the task
  view's pinned footer, with time and a per-model breakdown; *Tasks total*
  stays at the top. VS Code task cards drop per-task usage too, and show
  model and mode badges only when expanded.
- **The plan footer shows only the keys that apply** to the selected task,
  plus `? keys` for the full key sheet.
- **A running task is marked quiet after 10 minutes without output** (was 5),
  so a long build and test run no longer wakes the supervisor for nothing.

- **Run settings belong to you, not the plan.** The supervisor level, merge
  automatically, the retry limit, the wake-up read budget, autorun and
  Full/Guarded are saved machine-wide in `settings.json`. A change applies at
  once, in either direction, to the session it is typed in, and to other
  sessions from their next run; your command also lifts a lowering a guard
  or a failure made, with the guards' counts kept. Older plans' own values are
  ignored. The supervisor level defaults to **Watch**, so a wake-up is a
  planner turn and uses the planner's usage; `/supervisor off` turns it off.
- **Full/Guarded is saved with them.** A value in `~/.ordewell/.env` or in
  VS Code's `ordewell.autonomousMode` is copied to `settings.json` once.
  `ORDEWELL_AUTONOMOUS_MODE` still overrides it from the environment, and
  `/auto` says so when it does.
- **The planner says read-only, never a mode.** A plan or an edit that names a
  `taskMode` has it ignored or refused with `readOnly` named instead, and the
  planner is no longer shown runner mode lists. A task it adds or moves lands
  on its runner's mode for your level, and under Guarded an edit cannot reach a
  mode only Full allows. A mode you pick by hand is kept
  ([ADR-0031](docs/adr/0031-the-planner-says-read-only-not-a-mode.md)).
- **A message during a run is answered at once.** It no longer waits in a queue
  for the scheduler to park between batches: a planner turn takes it while
  running tasks carry on, holds new starts for the length of the turn, and
  applies its edits at once to tasks not yet started. An edit to a running
  task is refused with "stop it first", and a whole new plan is refused while
  tasks run.
- **No pop-up for a merge that is on its way.** With merge automatically on,
  the end-of-run handoff is sent only if that merge stops. With an Act
  supervisor it is deferred: the TUI prints a transcript line without opening
  the overlay, the VS Code card says the supervisor may merge it and keeps its
  buttons, and `ordewell run` says so. If the supervisor's turn for the finished
  run ends without a merge, the handoff opens as before.
- **The built-in `tdd` task skill is model-invocable.** The planner attaches it
  on its own to tasks that implement or change behaviour, not to verification,
  docs or ops tasks. Set `disable-model-invocation: true` in your copy in
  `~/.ordewell/skills/tdd/` to opt out. The other built-ins stay user-only
  ([ADR-0024](docs/adr/0024-unified-skills.md)).
- **Internals reorganized behind narrower modules.** The three runner adapters
  share one permission ledger; a run's settings and supervision have one owner
  (`RunSupervision`); a spawn-with-tools is one step over a per-conversation
  planner session; a Session's plan scope tears down in one place and each
  planner turn's deferred effects settle with it; a task reference resolves
  through one module; and the planner's task intake is one path for
  `submit_plan` and `edit_plan`. Dead planning code that only tests exercised
  is gone. Behaviour changed in a few places, listed here: `submit_plan` now
  refuses a duplicate task id, a dependency on a task that is not in the plan,
  a dependency cycle and ops on a subtask, as `edit_plan` always did, and a
  task's thinking effort is one field (saved plans are migrated on load), so an
  `edit_plan` effort change reaches the runner that task is spawned with. The
  rest of the changes are the fixes below.
- **The run view is decided once, in core.** The terminal UI and VS Code fold
  the same core view of a run instead of each rebuilding it, so a surface that
  joins a run already going receives its current state at once rather than
  waiting for the next change, and a task row's state reads the same in both.
- **Planner selection is decided in core.** `/planner`, `/model` and
  `/planner-effort` in every surface go through one decision. Reselecting the
  planner already in use changes nothing; choosing a model keeps the current
  effort only where that model offers it and drops one it does not; clearing
  the model clears its effort; and the terminal UI and CLI now save the effort
  the daemon answers to.
- **A subtask dependency reads by its dotted label** (`#2.1`) on a task row, in
  the terminal UI and on the VS Code card, instead of by an order that only
  meant something at the top level.
- **A subtask is named by its dotted reference on every surface and in every
  prompt.** The `ordewell task-*` commands, the terminal UI's pickers,
  confirmations and notices, a handoff's landed list, and the prompts the
  planner is given for a merge, a split and a conflict all read `#2.1` now,
  never an order that only meant something at the top level.
- **A task's thinking effort shows on its row in the terminal UI** when the
  terminal is wide enough, instead of only when the row is expanded.

### Documentation

- **What each part can touch.** [SECURITY.md](SECURITY.md#what-each-part-can-touch)
  states what planners, change tasks, ops tasks and read-only tasks can read,
  write and reach today, and what is planned
  ([#90](https://github.com/ordewell/ordewell/issues/90),
  [#93](https://github.com/ordewell/ordewell/issues/93),
  [#99](https://github.com/ordewell/ordewell/issues/99),
  [#104](https://github.com/ordewell/ordewell/issues/104)).

### Removed

- **Parts of `@ordewell/core`'s public surface.** The package now exports
  what the terminal UI, VS Code, the daemon and the benchmarks import by name,
  not whole modules. The `./order-labels` subpath is gone (use
  `@ordewell/core/plan-utils`), and so are `Planner.modify`,
  `IAiService.modifyPlan`, `migrateLegacyPlan`, `PlanStore`'s `merge`,
  `mergeMultiple` and `split` (a plan's merges and splits go through
  `applyTaskOps`), and the modify-plan prompt builders. An embedder that
  imported one of these names must use its replacement.
- **Per-plan supervisor controls.** The plan pane's `G`, `W` and `L` keys and
  VS Code's plan-card controls are gone; use `/supervisor`, `/automerge` and
  `/autorun`. The daemon's per-plan settings route and
  `POST /api/plans/:sessionId/supervisor/lower` go with them, replaced by
  `PATCH /api/settings` with a `run` object and an optional `sessionId`.
- **The `ordewell.autonomousMode` VS Code setting.** Use `/auto full` or
  `/auto guarded`.
- **The list of queued plan edits above VS Code's input**, with its withdraw
  buttons: a message sent during a run is a planner turn now.

### Fixed

- **Planners read line ranges without asking.** `sed -n '10,40p' FILE` and
  the other line-number prints run like `head` and `tail`, so a planner on
  Full is no longer denied the way models most often read part of a file.
  Substitutions and regex addresses still ask. A denied command now says how
  to rewrite it: the line reads that run freely, or, for a path after a `cd`
  on a line with `;`, that only `&&` chains are followed
  ([ADR-0008](docs/adr/0008-planner-exploration-envelope.md)).
- **Codex plans on stock Ubuntu.** Where Codex's sandbox cannot start
  (Ubuntu 23.10 and later restrict the user namespaces it needs), a Codex
  planner no longer stops with an error asking for `sudo`. It plans with its
  own shell off and reads the workspace through Ordewell's `run_command`, as
  the other planners do, and a note says how to give it its shell back. A
  Codex task that needs the sandbox is still refused, and the message now
  offers Full access or another runner
  ([ADR-0033](docs/adr/0033-codex-planner-without-its-sandbox.md)).
- **A planner reads back its runner's saved output.** When Claude Code or
  OpenCode saves a long tool result to a file outside the workspace, the
  planner reads that file without asking, in Guarded and Full, as it did
  before planners stopped loading the repository's config. Only the files its
  own session saved count; a link out of them is still asked about
  ([ADR-0032](docs/adr/0032-runner-state-outside-the-workspace.md)).
- **A one-shot planner reads the workspace.** A planner with nobody to ask
  had every Claude Code read refused, inside the workspace too.
- **A usage limit shows once.** Claude Code reports a limit as a message and
  again as the turn's error, worded alike. The planner chat, the task chat and
  task views, a reload and the task's plain text now show it once, as the
  failure, and a real reply before it stays.
- **Usage-limit waits are released when a task changes runner.** Moving a
  paused task to another runner, by hand or by a planner edit, cancels its
  scheduled resume and makes it ready on the new runner. Other tasks on the old
  runner keep their wait, and a model change on the same runner keeps it.
- **A resumed attempt keeps the paused attempt's uncommitted work in an
  isolated run.** A continue starts at the integration tips and restores the
  previous attempt's unlanded edits. If a conflict prevents that, the agent is
  told which preserved branches hold the work.
- **A plan edit after a run no longer shows every task as not done in the
  TUI.** The tasks were still completed; only the display read as if the run's
  work had been lost.
- **The TUI follows the session it shows.** Runs started by autorun, the
  planner's run tools or the supervisor, and the supervisor's reports after a
  run's end, are drawn without waiting for you to act.
- **A coding-agent planner's reply stays beside the plan or edit it submits.**
  The message used to vanish the moment the turn settled, live and on reload.
- **A supervised run finishes after an edited retry.** A planner edit made after
  a failure ended the run is reconciled into it and keeps the failed task
  failed, so the retry resumes the run instead of running that task alone. A
  start deferred behind an edit that never lands is dropped, with a notice.
- **A user message is no longer shown twice on replay**, and a view rebuilt
  mid-turn shows the turn's inputs.
- **A checkpoint's summary can be read in full in VS Code**, with Show full and
  Show less under its first line.
- **The task row names the model that reported usage.** It shows the assigned
  model until the first usage report instead of "model unknown".
- **A task's runner is never swapped for another.** A plan or edit that names a
  runner the plan may not use is refused, instead of being silently moved to
  the first allowed runner; the model allowlist now walks subtasks as well as
  tasks and says what it changed
  ([ADR-0003](docs/adr/0003-per-runner-model-allowlist.md)).
- **A subtask can be edited on its own.** A direct edit to a subtask, by its
  dotted label or its title, used to fail with "Task not found"; it now finds
  its target at any depth and checks its dependencies among its siblings, and
  the planner is shown subtasks under their dotted labels.
- **A plan replaced mid-turn keeps the old turn's research out of the new
  plan.** When another plan is adopted while a planner turn is in flight, that
  turn's saved subagent steps no longer land in the adopted plan or its save,
  and the old plan's run is stopped with it, so no agent of the old plan is
  left running.
- **Executing a plan whose tasks are all done announces the end once**, not
  twice.
- **A run the supervisor opened keeps its own settings**, instead of merging
  against your global setting; and Execute pressed while a supervisor's Merge
  all was waiting on git starts a run of its own rather than continuing the
  supervisor's, so it does not inherit a lowered level or the guards' memory.
- **An Ordewell-tool approval is logged as decided on Codex too.** Claude Code
  and Codex now cancel a permission request still open when the turn ends
  (Claude Code keeps it while background work that may have raised it runs),
  and a Codex MCP call is forgotten once it completes, so an approval can no
  longer take its tool from a finished call.
- **A planner process a failed send killed takes its token with it**, a start
  that lands after a reset or a newer conversation takes its own process and
  token back, and a permission answer the runner cannot take no longer surfaces
  as an unhandled rejection.
- **A runner's last line is not lost.** A pipe that closes with a final line
  that has no trailing newline — often the failure or the turn end — now
  delivers it, a process that dies mid-turn reports its stderr instead of
  hanging, and a failure inside a consumer fails the turn rather than escaping
  as an uncaught host exception.
- **Stopping a run goes before its runners are killed**, so a conflict repair
  that fires as the old session is killed cannot land work the stop just
  cancelled; a second Mark complete no longer lands and announces the task
  again; and changing the run settings under an open run merges an
  already-reached gate now.
- **A planner's response survives any character.** A reply whose bytes are
  split across two reads is decoded once, so a multi-byte character is no
  longer turned into `�`.
- **Emoji and combining characters edit as one unit in the terminal UI.** The
  composer's cursor, backspace, delete, selection and line truncation move by
  grapheme, so `⚠️`, a family emoji and an accented `é` are no longer split.
- **Deleting a live session works.** The session is stopped before its file is
  removed, so a running session can no longer write itself back and reappear in
  the list.
- **A webview message that fails says so.** A handler error used to be dropped
  as an unhandled rejection; VS Code now logs it and shows the message.
- **An approval the runner never waited on is no longer announced as waiting.**
  An Ordewell tool, and a task's request under an auto-approving mode, is
  allowed at once; the chat still told you "Task N waits for approval" for it.
  The log now records that the request was already decided, and the notice, the
  task view and a saved-log read leave it settled.
- **A wrapped system notice keeps its colour in the terminal UI.** The second
  and later rows of a system, error or run-update line now stay grey, red or
  yellow like the first, and the doubled `·` before a system notice is gone.
- **A force send keeps a supervisor wake-up's run update.** A force send that
  stopped a wake-up turn dropped its run update as a stop does. The update now
  waits behind the forced prompt and reaches the supervisor in its next turn,
  so a failure or a run's end it carried is not lost.
- **A surface joining a finished run is handed the handoff that was sent.**
  Reading it back out of the run record could show one after a stop, which
  hands nothing over, and miss what the supervisor had marked first.
- **A planner turn's starts do not outlive its plan.** When a plan is closed or
  replaced before the edit its start waited on landed, the starts it deferred
  are dropped with a notice; one already handed to the scheduler goes on.
- **A run that ended on a failure ends with the plan it failed in.** Loading a
  session after a failure left the run waiting on a retry, so the next retry would restart a run nobody
  started and a usage-limit move would arm the scheduler.
- **A stop cancels a repair for good.** A stop that arrived while a repair read
  its evidence used to let its merge go ahead anyway; the attempt is no longer
  the task's, so the conflict stays as it was and waits on you.
- **A worktree release after a plan load lets go of the right run's task.** The
  release is bound to the run it was asked in, not the one a plan load put in
  its place, whose records share the task ids.
- **Stop never signals a process-group id the system has recycled.** Once a
  runner's group leader has exited, every signal to its group is preceded by
  asking whether any member is left, so a group Ordewell cannot vouch for is
  left alone.
- **A descendant holding a runner's pipes no longer hangs its turn.** A runner
  whose process exited but whose stdout or stderr was still held open used to
  wait for `close` forever; the turn now ends a short grace after `exit`, and
  the output written before it is still delivered.
- **An OpenCode frame handler's throw is the turn's failure.** A throw while
  reading the event stream used to be swallowed until the stream closed,
  leaving a turn waiting on a permission request nobody would see; it now fails
  the turn, and a request Ordewell already allowed is answered even if showing
  it throws.
- **A Claude Code or Codex project MCP server named `ordewell` is left out.**
  Ordewell's own entry is written over that name, so an approval of it would
  never take effect; the planner is told the server was not offered.
- **A `readOnly` that cannot apply is reported, not dropped.** A `submit_plan`
  that marks a manual task read-only now warns, as it does for `taskMode`, that
  a manual task runs in no mode.
- **A dependency cycle is refused as the chain it is.** The refusal names each
  task on the cycle in dependency order and pins it to one of them, instead of
  an unowned error a JSON retry repeated.
- **The terminal UI's run view keeps up with the session it shows.** Joining a
  run already going shows its status at once, a task updated by another surface
  or the supervisor shows here too, and starting, loading or forking a session
  begins from an empty run rather than the last one's tasks, merge gate and
  checkpoint.
- **Send now in the terminal UI keeps its edges.** A built-in command typed and
  sent with `ctrl-s` runs as it does on enter instead of being forced through
  as a message, a forced send whose turn fails puts the prompt back in the
  composer or its place in the queue, and the stop of the turn it replaced is
  not shown as an error.
- **A narrow queued prompt keeps its message.** The takeback hint is given only
  the columns the first row has left, instead of truncating the prompt it sits
  after; a row too narrow for it drops the hint.
- **Clearing a planner model no longer writes the word "undefined".** When the
  daemon reports no effort, `ordewell model` and the terminal UI's `/model`
  write an empty value, as `planner-effort default` does.
- **A checkpoint you answered in VS Code is not reopened by a stale update.**
  The panel remembers the answer by task and question, so a run view still
  carrying the question — before the status update that clears the task, or
  after another task's update — does not ask again; a different question still
  opens.
- **Send now treats a skill invocation as a planner prompt.** *Send now* on
  `/name …` in VS Code now stops the turn and answers it as a planner message,
  while a built-in command still goes to the host as Send does.

## [0.9.1] — 2026-10-11

### Security

- **Planners no longer run a repository's config.** Before anyone has
  approved anything, a planner could start what the repository it researches
  named: Claude Code's project hooks, `env` block and helper commands, an
  OpenCode plugin, or a project MCP server on any runner. Now a Claude Code
  planner reads only your user settings, with hooks off; an OpenCode planner
  loads no project config and no language servers; and a Codex planner treats
  the repository as untrusted. The project's instruction files (`CLAUDE.md`,
  `AGENTS.md`) still reach the planner, as text
  ([ADR-0028](docs/adr/0028-planners-never-run-repository-config.md)).
- **Project MCP servers start only once you approve them.** A server a
  repository declares (`.mcp.json`, `opencode.json`, `.codex/config.toml`)
  is shown to you with exactly what would run, and your approval is
  remembered for that repository and that definition; a changed definition
  asks again. In Full nobody is asked, so it does not start unless the
  allowlist names it (`mcp-server:<name>@<hash>`); `!mcp-server:*` starts
  none. The planner is told which servers it does not have.
- **Web reads have guards that hold without a person.** The private-address
  guard now parses addresses (IPv4-mapped IPv6, shared and unique-local
  ranges, every DNS answer) and connects only to an address it checked.
  Redirects are followed one hop at a time, and a hop to another site is
  decided again. A name is looked up only after the exclusions, the budget
  and your approval pass. Only GET and HEAD are sent, with no credentials,
  and a URL or query that looks like it carries a secret is refused.
- **`curl` and `wget` in the planner's shell are approved per site.**
  Approving one site approves no other. Flags that write files are refused,
  flags that send data or credentials ask every time, startup files such as
  `.curlrc` are not read, and `curl` connects only to the address the guard
  checked. A `curl` or `wget` named by its path is refused, so a script the
  repository ships cannot reuse an approval, and both stay refused in Full
  and allowlist mode. A
  refused read points the planner to its own fetch tool; a refused effect
  points it to an ops task in the plan.
- **OpenCode 2.x planners cannot use code mode's `execute`.** Where OpenCode
  cannot list Ordewell's tools outside code mode, the planner fails to start
  with an error naming the version instead.

### Added

- **Web search and fetch for every planner.** Claude Code, Codex, OpenCode and
  API planners can read documentation and search the web, decided by one
  policy. Guarded asks once per site for a fetch and once per session for a
  search; Full under `auto` reads without asking; `allowlist` mode reads only
  what the allowlist names. Each runner uses its own provider's search where
  it can, and Ordewell's `fetch` and `web_search` otherwise. Research
  subagents get web reads too, and never prompt.
- **Ways to turn web reads down or off.** `!` exclusions win in every mode:
  `!web_search:*` turns every search off, and with `!https://*` and
  `!http://*` every web read. `ordewell.plannerWebReadBudget` /
  `ORDEWELL_WEB_READ_BUDGET` caps the reads in one planner turn, and 0 turns
  them off, Codex's own search included. Every web-read decision appears in
  the research timeline.

### Changed

- **The Stalled badge waits 5 minutes.** A task was marked Stalled after a
  minute without output, which long model turns and slow builds routinely
  reach.

### Fixed

- **DuckDuckGo search works.** Ordewell's own web search reads DuckDuckGo's
  real results page, recognises its bot challenge, and pauses for a short
  while when challenged instead of returning nothing.
- The VS Code model panel names the planner's actual provider instead of
  labelling every planner "via OpenRouter".
- A task card's skill picker reads "Add skill…" instead of "+ skill".
- The VS Code extension's host tests pass again.

## [0.9.0] — 2026-10-10

### Security

- **One research envelope for every planner.** Claude Code, Codex and OpenCode
  planners now research under the same rules as the API planner: read-only
  commands run, anything else is decided by your approval mode, and file
  writes are refused in every mode
  ([ADR-0026](docs/adr/0026-one-envelope-for-every-planner.md)). An OpenCode
  planner no longer runs its own shell, subagents or any tool its user
  configuration allows; its permission policy is now Ordewell's alone.
- **A program named by its path no longer runs unasked.** `./cat README.md`
  ran a file the repository could ship under that name without a prompt. A
  path-named program now always asks, and approving `gh` does not approve
  `./bin/gh`.
- **The planner's approval settings cannot come from a repository.**
  `ordewell.plannerApprovals`, `ordewell.plannerAllowlist` and
  `ordewell.plannerAllowlistDefaults` are user settings only, and
  `ORDEWELL_APPROVAL_DEFAULTS` joins the approval variables refused from a
  workspace's environment files.

### Added

- **`run_command` for harness planners.** A Claude Code, Codex or OpenCode
  planner runs shell commands through Ordewell, so it can read issues, cloud
  resources or cluster state (`gh issue list`, `az vm list`,
  `kubectl get pods`) during research.
- **Your MCP tools in planning.** A harness planner can use the MCP servers you
  configured, such as an issue tracker or a todo list. Each tool is approved
  like a command; read-only tools on the allowlist run without asking.
- **Planner allowlist.** Standing approvals for planner research: command
  rules (`gh issue list`, `gcloud * * list`), MCP tool rules (`mcp:find-*`)
  and path or URL patterns, with `!` exclusions that always win. A built-in
  list covers read-only commands for GitHub, GitLab, Jira, Azure, Google
  Cloud, AWS and other clouds, Kubernetes, Docker and Podman, installed
  packages and local processes, plus MCP tools whose names start with a read
  verb. Set it with `ordewell.plannerAllowlist` or `ORDEWELL_APPROVAL_ALLOW`,
  and turn the built-in list off with `ordewell.plannerAllowlistDefaults` or
  `ORDEWELL_APPROVAL_DEFAULTS=false`.
- **Approval modes tied to autonomy.** `ordewell.plannerApprovals` /
  `ORDEWELL_APPROVAL_MODE`: `auto` (default) asks you in Guarded and, in Full,
  runs only the allowlist and refuses the rest without waiting on anyone, so
  the plan carries the change as an ops task instead. `ask`, `allowlist` and
  `allow` set it explicitly.

### Changed

- A Claude Code planner runs in Claude Code's `default` permission mode, with
  its tool requests answered by Ordewell, instead of `dontAsk`. A Codex
  planner asks before a user MCP tool instead of failing it.
- A command whose words the shell globs or computes, or that a leading
  `VAR=value` redirects, is never covered by an allowlist rule.

### Fixed

- **OpenCode 2.x.** Ordewell recognises OpenCode 2's MCP status, so planners
  and tasks start on it again, and lists its own tools outside OpenCode 2's
  code mode, so tasks find `task_complete` and `checkpoint`. The planner's
  policy also covers OpenCode 2's renamed `shell` and `subagent` tools and its
  `browser` tool.

## [0.8.1] — 2026-10-10

### Changed

- Up to five AI tasks now run at once by default, up from three. Change it with
  `ordewell parallel <n>`, `/parallel` or `ORDEWELL_MAX_PARALLEL`.

## [0.8.0] — 2026-10-10

### Security

- **A Claude Code planner can no longer write through its native plan file.**
  Claude Code's plan mode let a Bash heredoc write its own plan file, inside or
  outside the workspace, even with `Write` disallowed. A Claude Code planner
  now runs under `--permission-mode dontAsk` with `Bash`, `PowerShell`,
  `EnterPlanMode` and `ExitPlanMode` withheld alongside the edit tools, on
  fresh and resumed sessions alike. It researches with `Read`, `Grep` and
  `Glob`; it no longer runs shell commands
  ([ADR-0008](docs/adr/0008-planner-exploration-envelope.md)).
- **A runner never inherits another Ordewell's MCP credential.** When Ordewell
  runs inside a task of another Ordewell, `ORDEWELL_MCP_TOKEN_*` variables from
  the host or workspace environment are dropped, and a parent's server entry
  and allow rule are removed from an inherited `OPENCODE_CONFIG_CONTENT`. Only
  the attempt's own launch variables carry a token.

### Added

- **Skills, unified.** Planner skills and task skills are now one thing: a
  `SKILL.md` folder (the Agent Skills format) with `applies-to: planner | task`
  (default `planner`) and Claude Code's `disable-model-invocation` and
  `user-invocable` fields. Skills live in `~/.ordewell/skills/` (global, written
  by you) or in a workspace's `.ordewell/skills/`, which is now committed to
  git (the `.ordewell/.gitignore` carves it out) and so reaches every task
  worktree; a task can write a skill there for later tasks. On a name clash the
  global skill wins and the workspace copy is reported as shadowed. All
  built-in skills are user-only. See [docs/skills.md](docs/skills.md) and
  [ADR-0024](docs/adr/0024-unified-skills.md).
- **Task skills.** The planner attaches a skill to a task or subtask, and
  Ordewell puts its text in that task's prompt when it starts, so it works on
  every runner. In VS Code, skills are chips on task and subtask cards, locked
  while the plan executes like a task's model and mode; the TUI sets them with
  `K` or `/task-skills`. A name that does not exist yet is a warning when a
  plan is submitted, as is a workspace skill that is not committed (task
  worktrees only get what is committed); if a name still does not resolve at
  start, the task fails before its runner is spawned. Skills are resolved where
  the task runs, so skills created by an earlier task in its worktree are found.
  The skills an attempt was given are recorded on it and shown at the top of
  its task log. The planner sees and validates each task's skills on every planner
  path, including the API-key planners and plan edits, and sees them in its plan
  view and in `task_query`.
- **`tdd` is a task skill.** `/tdd` asks the planner to attach it to the tasks
  it fits.
- **The planner can load skills itself.** A planner with tools attached sees
  the model-invocable planner skills and loads one with the `load_skill` tool.
- **`ordewell task-skills <id> [a,b|none]`** (and `/task-skills` in the TUI)
  attaches task skills to a task; with no names it lists the task skills and
  marks the attached ones.
- **`ordewell skills`** lists the skills a workspace sees, with scope,
  `applies-to`, who can invoke each, any shadowed copy, and any skill folder
  skipped for an invalid name (lowercase letters, digits, `-` and `_`, starting
  with a letter or digit); `--json` for scripts.
- **Skills in a multi-repo group.** A group root's own `.ordewell/skills/` is
  read in place and each repo's committed folder is read as checked out (in the
  task's worktree when it runs). The planner's catalog, `/name`, the chips,
  `ordewell task-skills` and `ordewell skills` all see the same set; global
  still wins.

### Changed

- **Tools or nothing.** A task or coding-agent planner checks Ordewell's MCP
  tools after spawn and respawns once if they cannot connect. A second attach
  failure fails the task or planner turn before its prompt is sent.
- **Checkpoints use the `checkpoint` tool only.** Text checkpoint markers are
  no longer interpreted.
- **A coding-agent planner plans through tools only.** A Claude Code, Codex or
  OpenCode planner's plan or edit lands only from an accepted `submit_plan` or
  `edit_plan` call; plan JSON in its reply is prose. A one-shot planning
  session that ends without an accepted submission gets one corrective
  session, then fails with the reasons its calls were refused.
- Leftover plugin manifests in `~/.ordewell/plugins/` are skipped, with one
  notice at host startup.
- **`/name` keeps your text.** The message is sent as you typed it, with the
  skill's instructions beside it. The conversation records a snapshot of the
  skill as loaded and shows a one-line notice with its path (shortened and
  displayed correctly on Windows). In planner chat a `/word` that names no
  skill is plain text: in the TUI it goes to the planner as typed, where it used
  to be reported as an unknown command. In the TUI task view an unknown `/word`
  is still refused as an unknown command, and a skill name points to
  `/task-skills`.
- **TDD is no longer applied to every task by default.** The `tdd` toggle is
  gone; use `/tdd` or attach the skill to the tasks that need it.

### Fixed

- Skill files saved with CRLF line endings or a UTF-8 BOM (as git does for a
  committed skill on Windows) now load; their frontmatter was not read.

### Removed

- The terminal transport and its tmux requirement.
- Plugin runners and `ordewell plugins`.
- `ordewell terminal`, TUI `/terminal` and `t`, and the Structured/Terminal
  badges. Press Enter on a task in the TUI plan pane to open its task log.
- The completion marker; only an attempt-bound `task_complete` call completes
  a task.
- The `verify` and `tdd` mode toggles, and the `ordewell tdd` and `ordewell
  verify` commands with them, and `/tdd on|off` and `/verify on|off` in the
  TUI; `/tdd` is now the skill directive.
- The runner-transport setting, its pill, `/transport` and `ordewell
  transport`. Runners are structured-only
  ([ADR-0025](docs/adr/0025-structured-only-runners.md)). A saved plan pinned
  to the terminal transport now runs structured.
- **Daemon API:** `SettingsResponse` no longer carries `tdd`, `verification` or
  `runnerTransport`, and a settings update that sends them ignores them.
  `/api/commands` lists no commands, and `POST /api/commands/:name` answers
  404.

## [0.7.2] — 2026-10-07

### Security

Planner research runs shell commands under a command policy: some are run
without asking, some ask, and some are refused outright. These inputs slipped
past the refusal tier, so a command that should have been refused asked for
approval or ran. Each is now refused.

- **A `!`-prefixed command is refused.** `!` is a shell keyword that negates the
  pipeline after it, and the command behind it was not judged as the command
  it is.
- **A line with more than 32 substitutions is refused**, instead of being
  judged on the first 32 and letting the rest through.
- **An interpreter fed through stdin counts as piped.** `bash <<< '…'`, a
  here-document, `sh < file` and `<&` hand an interpreter code exactly as
  `… | sh` does, and are refused the same way.
- **Every spelling of an inline-code flag is read.** Combined and glued flags
  (`bash -lc`, `perl -lne`, `perl -e'…'`), `node -p` and `--print`, `php -r`,
  PowerShell's `-EncodedCommand` and any abbreviation of its code parameters,
  `cmd /q/c`, `deno eval`, a `data:` URL handed to `node`, `deno` or `bun`, and
  PowerShell's positional command. A versioned or suffixed interpreter name
  (`python3.12`, `node22`, `nodejs`, `pwsh-preview`) is the interpreter too.
- **Quoting and escaping no longer hide a command inside a substitution.** A
  quoted or escaped `)` ended `$( )` early, `` \` `` inside backticks was not a
  nested substitution, a `${…}` holding a quote, paren or escape could close a
  `$( )` at the wrong place, and `$'…'` was lexed as plain single quotes, so a
  `\'` inside it let the rest of the line pass unread. A substitution the
  policy cannot read to its end now refuses the line.
- **A `<<` that is not a here-document no longer hides the lines after it.**
  Inside a comment, a `${…}` or `$[…]` expansion, or `(( ))` arithmetic, `<<`
  is not a here-document, but it was treated as one and the following lines
  were skipped as data. They are now read as commands; `(( ))` and an
  unreadable `${…}` refuse the line. A here-document body is still skipped to
  its delimiter, and an unclosed one refuses the line.
- **Command names are matched case-insensitively for refusal.** `DEL`, `Rd`,
  `RM` and `CMD /c` run on Windows and on case-insensitive filesystems, but a
  re-cased name was not recognised as the refused command. The permitted tier
  stays exact-case, so a re-cased name never gains the no-prompt tier.
- **`NAME+=value` is an assignment prefix**, and `env` takes any word holding
  `=`, so neither hides the command that follows from the refusal checks.
- **Windows `cmd` forms are read the way `cmd.exe` reads them.** `cmd/c del x`
  is `cmd /c`, `,del x` is `del`, and `cmd;/c del x` is refused. A command word
  still holding a `/` or `=` — `cmd"/c"`, `del=x` — is refused rather than read
  wrong, a drive-absolute path such as `C:/Git/usr/bin/rm.exe` can no longer
  scope to the bare drive, `call` is unwrapped to the command it runs, and
  `start` is refused.

### Changed

- **In the cmd dialect, a program path written with forward slashes is refused
  during planner research.** Use backslashes. A forward-slash path is read
  wrong by the policy — as a switch, or as the wrong program name — so it is
  refused instead.
- **A runner starts in its own process group without a controlling
  terminal.** A prompt that reads `/dev/tty` now fails instead of waiting on
  the terminal Ordewell runs in.
- **Stopping a planner turn is reported as a stop, not an error.** However the
  planner's backend names the error it throws on the way out, the TUI, the CLI
  and VS Code stay quiet for a stop, and the daemon answers 409
  (`planner_turn_stopped`) without logging a fault. A real failure whose
  message mentions "aborted" is still reported as one.

### Fixed

- **Stop ends everything a task started.** On Linux and macOS, stopping a task
  used to signal only the runner's own process, so the shells, MCP servers,
  test runs and dev servers it had started kept running. A runner now gets a
  process group of its own and Stop signals the whole group; quitting
  Ordewell, or pressing Ctrl-C in the terminal it runs in, does the same. An
  interactive (pty-wrapped) task is the exception: its agent runs in a session
  of its own under `script`, so Stop reaches `script` and relies on the pty
  hangup to end the agent and its foreground children. A process the agent
  deliberately detached can outlive Stop.
- **A runner that fails to start no longer stays running.** A Codex app-server
  whose handshake failed or timed out, or an OpenCode server that never
  became ready, was left running with nothing attached to it.
- **Non-ASCII output survives.** A character split across two reads of a
  runner's output turned into `�` in the task log and in error messages.
- **A reply to a runner that just exited no longer crashes the daemon** on the
  terminal transport.
- **Terminal-transport runners no longer inherit `CLAUDECODE` or Node debugging
  flags** from the process that started Ordewell, matching the structured
  transport. A workspace that sets one on purpose still passes it.
- **A second interrupt no longer overwrites the first** on Codex when it is
  asked for before Codex has named the turn.
- **OpenCode no longer accumulates listeners and buffer.** A retry delay left
  its abort listener behind, and the server banner was read without a bound
  on the pending line.
- **The scheduler no longer starts what it should not.** A task could be
  started after Stop, after it stopped being ready, or after the plan changed,
  and a start could push the run past the parallel limit. Each task is judged
  again just before it starts.
- **A failure while settling a verdict no longer leaves a task integrating
  forever.** The task now fails (a conflict repair waits on you, as its
  conflict did), the run halts, and the error is shown instead of being lost
  as an unhandled rejection.
- **Isolated-run start-up is safer.** A stash that fails keeps your choice open
  instead of dropping it, a stash that succeeds is always announced, and a run
  stopped while it was being set up no longer opens afterwards.
- **Queued plan edits are applied once, and to the plan they were meant for.**
  An edit could be applied twice after a reload, the run could go on before the
  planner's answer was applied, and an answer arriving for a plan you had
  since replaced could land in the new one. One drain runs at a time, and an
  edit sent during it is drained after.
- **A queued message you removed stays removed.** It could come back after a
  reload; a message the planner already has can no longer be removed.
- **Merging a task with itself no longer counts as two tasks.** Naming the
  same task twice in a merge now leaves one task, which a merge refuses.
- **Changes are saved before they are shown.** Approving a review,
  rescheduling, interrupting a task, controlling a queued task message and
  Merge all announced the change before saving it.
- **A planner turn that outlives its plan no longer writes into the next
  one.** A turn that settles after a new plan, another session or a closed
  session replaced its own is discarded; a superseded compaction no longer
  ends the planner turn that followed it; a second planner message sent while
  a turn is in flight is refused as busy.
- **Worktree landing cannot be undone mid-merge.** Hand-off, discard and
  orphan pruning now wait for a landing in flight instead of rolling back the
  merge it was making.
- **A git command can no longer hang forever.** One stuck on a hook is stopped
  after ten minutes and the error names the git subcommand that timed out.
- **A fatal error in the TUI stays on screen.** It was printed on the
  alternate screen and wiped when the screen was left.
- **A lost daemon connection is noticed.** The TUI used to show a run as still
  going, and `ordewell run` exited 0; the TUI now says the connection was lost
  (task statuses stay as last reported, since the daemon may still be running
  them), and `ordewell run` exits 1.
- **A stray rejection no longer takes the daemon down** with every session's
  runners. Starting a plan or loading a session over a live one now stops the
  old session's runners and planner turn instead of leaving them running.
- **OpenRouter is no longer reported as configured** when only
  `OPENAI_API_KEY` is set.
- **A task awaiting you shows as awaiting, not pending,** in CLI output.

## [0.7.1] — 2026-10-06

### Added

- **A message reaches a running task between tool calls.** On the structured
  transport, a message you send to a working Claude Code, Codex or OpenCode 1.x
  task is handed to the runner at once, and the model reads it after the
  command or edit in flight, inside the same turn. It used to wait until the
  turn ended, which for a task is usually when the work is done. The queue
  marks a message the runner already has as handed over (it can no longer be
  removed), and the task log shows it where the model read it. OpenCode 2.x,
  and a runner that refuses a message, keep the old behaviour: the message
  opens the next turn (ADR-0023).
- **Force send.** `ctrl-s` in the TUI task view, or *Send now*
  (`Ctrl+Enter`) in the VS Code task log, interrupts the running step and
  delivers the message straight away, ahead of anything queued. With the
  composer empty, `ctrl-s` force sends the selected queued message. The task
  stays in progress throughout. On Codex the interrupt stops the agent
  waiting on a command, not the command itself.
- **Answer a task's checkpoint from the TUI and the CLI.** The TUI task view
  shows the whole question as a card, answered with `ctrl-y` (approve) or
  `ctrl-g` (reject, with the composer text as the reason).
  `/checkpoint <id> approve|reject [reason]` and
  `ordewell checkpoint <id> approve|reject [reason]` work from anywhere, and
  the chat notice reads "Task N asks: … — t on it to answer".

### Changed

- **Internals reorganized behind narrower modules.** OpenCode 1.x and 2.x share
  one HTTP transport, each task row's state is decided once in core for the TUI
  and VS Code, each runner's Ordewell tools are declared in one place, plan
  editing has its own module, and what differs between change, ops, repair and
  continued attempts is read from one attempt kind. No behaviour change is
  intended beyond the fixes below.

### Fixed

- **OpenCode 2.x task logs show file edits as diffs**, as they do on 1.x. An edit
  row used to say only that the edit succeeded.
- **A message sent to a task is never lost.** A message still queued when the
  task reported done used to vanish with the task; the verdict now waits for
  it, and a report made before the agent read a message no longer counts. A
  message that can no longer reach the runner — its process ended, or its
  turn failed — is shown as undelivered, with its text.
- **A merge or clean-up never deletes a live task's worktree.** Stop puts the
  tasks it ends back to not started and keeps their worktrees; Merge all, Clean
  up and Discard leave a run alone while any task in it is live; and work that
  never landed is kept on an `ordewell-preserved/<run-id>/<task>` branch
  before a worktree is removed.
- **A task interrupted at a checkpoint can ask again.** An interrupt or a
  force send left the open checkpoint call pending, so the agent's next
  checkpoint was refused and the task stayed stuck at the old one.
- **The TUI shows how to answer a runner's tool request right under it**
  (`ctrl-y` allow, `ctrl-t` allow for the task, `ctrl-g` deny), and the notice in
  other panes names the keys too.

## [0.7.0] — 2026-10-05

### Added

- **A task reports done and asks its questions through Ordewell's own tools.**
  On the structured transport, a Claude Code, Codex or OpenCode task can finish
  by calling `task_complete` and ask you something by calling `checkpoint`,
  instead of printing the `<<<ORDEWELL_DONE_…>>>` and
  `<<<ORDEWELL_CHECKPOINT: …>>>` markers itself. Call and marker are the same
  evidence: whichever arrives first settles the attempt. Only a done call
  passes; a blocked or failed call ends the task with the reason the agent
  gave, and a call's summary is the output its dependents receive. The printed
  marker stays as the fallback for the terminal transport, plugin runners, and
  any session where the server did not attach. Nothing extra to install — the
  server ships with Ordewell and is injected into the runner it starts (#46).
- **A structured planner reads the live catalog and submits its work through
  tools.** A Claude Code, Codex or OpenCode planner lists the enabled runners
  and models with `list_runners` and `list_models`, reads tasks with
  `task_query` and `task_output`, and submits or edits the plan with
  `submit_plan` and `edit_plan`. The catalog is read when the call is made, so
  a runner you enable, or a model you allowlist, while the conversation is open
  now reaches the plan; a plan naming a runner that is switched off is refused
  by name. The plan and the `taskOps`/`taskQuery` JSON envelopes stay as the
  fallback (#69).

### Changed

- **A task's file edits read as diffs, on every runner.** An edit row in the
  TUI and VS Code task log now says what changed ("Added 3 lines, removed 2
  lines"). Below that come the edited lines, numbered, with additions marked
  `+` in green and removals `-` in red. Collapsed, a row previews the first ten
  lines; the detail switch (ctrl+o in the TUI) shows all of them. Claude Code
  and OpenCode rows used to say only that the edit succeeded.
- **A Codex patch shows one row per file**, named for the change
  (`Add`, `Update`, `Delete`), with paths relative to the task's worktree. A
  patch to six files used to be one row listing six absolute paths.

### Fixed

- **A long path in a command row keeps its file name in view.** The TUI and
  VS Code cut it from the left instead of the right, and VS Code shows the
  whole path on hover. A worktree path used to hide the file name entirely.

## [0.6.4] — 2026-10-04

### Security

- **Approving one `cd` no longer approves every later one.** A `cd` the planner
  could not follow — `cd "$HOME"`, `cd ~`, `pushd`, `builtin cd` — was
  remembered as approved for the whole session, and the paths after it are
  judged from the workspace root. Once `cd "$HOME"` was approved,
  `cd "$HOME" && cat .ssh/id_rsa` ran without a prompt. Such a command is now
  approved for that exact line only.
- **`builtin eval`, `builtin source` and `enable -f` are refused** during
  planner research, like `eval` and `source`. `builtin` hid the command it
  ran, so these only asked for approval, and one approved `builtin echo`
  covered them for the session. `enable -f` loads a library file into the
  shell and runs its code.

## [0.6.3] — 2026-10-04

### Security

- **Planner research no longer reads outside the workspace through a `cd`
  chain.** 0.6.2 followed `cd … &&` chains so research inside the workspace ran
  without a prompt, but a segment that ran no command — `X=1`, a redirect
  alone — hid the `||` or `|` that made the `cd` uncertain, and a `CDPATH` set
  on the same line could send a bare-name `cd` outside. Commands such as
  `cd nonexist || X=1 && cat ../secret` then read outside the workspace with
  no prompt. Following is now decided as each operator is read, and on a line
  that can steer a `cd` it asks again.

### Fixed

- **OpenCode 2.x runs on the terminal transport.** Its interactive command
  takes no `--model` or `--agent`, and its `run` has no `--variant`, so tasks
  either exited at once or ran on the wrong model. Ordewell reads the installed
  version and gives 2.x its own command lines: the TUI gets its agent and model
  through its config, `run` gets the variant on the model id, and both run on
  their own server in the task's directory. 1.x installs are unchanged.
- **The terminal transport runs TTY-needing runners on macOS without tmux.**
  Ordewell called `script` the util-linux way, which macOS's `script` rejects
  (`illegal option -- f`), so OpenCode tasks failed at once without tmux.
  macOS and the BSDs now get their own `script` invocation.
- **Codex tasks on the terminal transport no longer hang without tmux.**
  `codex exec` reads a piped stdin to its end before it starts, and Ordewell
  kept the task's stdin open, so the task never finished. A run with no
  terminal and its prompt in its arguments now has its stdin closed.

## [0.6.2] — 2026-10-04
### Changed

- The autonomy levels are now **Full** and **Guarded** (were Full auto and Auto):
  `/auto full` and `/auto guarded`, `ordewell auto full|guarded`. `auto`, `on`
  and `off` still work as aliases.

### Fixed

- A task waiting on a tool approval no longer also shows as idle once it has
  been silent for a minute; idle watching resumes when its last open approval
  is answered or withdrawn.
- **A `cd` into a repo inside the workspace no longer prompts.** Planner
  research asked for approval on `cd api && git log && cd ../web && git log`
  although both directories are inside the workspace: `cd` was never read-only
  navigation, and `../web` was judged from the workspace root instead of from
  `api`. A `cd` to a literal directory now runs without a prompt, and a chain
  of them joined by `&&` is followed, so later paths are judged from where the
  shell will be. Anything the classifier cannot follow — `;`, `||`, subshells,
  `$(…)`, a variable, `cd -`, or `CDPATH` set — behaves as before.
- **Planner search works on a Mac without ripgrep.** Without `rg` the search
  falls back to the system `grep`, and macOS's `grep` has no `-P`, so every
  planner grep and symbol lookup failed with `invalid option -- P`. The fallback
  now asks the machine's `grep` which regex mode it has and uses `-E` where
  `-P` is missing.
- **OpenCode 2.x works as a planner and a structured-transport runner.** OpenCode
  2.x replaced its server API, so planning with it failed at once with
  `POST /session failed: 405 Method Not Allowed`. Ordewell now recognises a 2.x
  server and speaks its API — plans, tasks, permission requests, interrupts,
  subagents and resumed sessions — and keeps the 1.x protocol for older installs.
  The terminal transport is not covered yet: 2.x's interactive command takes no
  `--model` or `--agent`, and its `run` command takes the variant on the model
  rather than as `--variant`.

## [0.6.1] — 2026-10-02

### Added

- **Ops tasks.** A plan can now carry a goal through to the operations around
  it — redeploy and watch the pipeline, whitelist an address, provision a
  resource, push a tag, reword commits. An ops task changes no repository files:
  it runs in your checkout, never in a worktree, in the session's mode, and in
  parallel as its dependencies allow. The planner decides which tasks are ops
  and splits "bump the version and redeploy" into a change and an ops task; you
  can flip a task with `O` in the TUI, `/task-ops`, `ordewell task-ops` or the
  task card in VS Code until it starts. An ops task that changes tracked files
  waits for you instead of completing, and a retry is told what the attempt
  before it did. (ADR-0020)
- **Merge gates, and Merge all during a run.** An ops task or a manual task that
  depends on change tasks waits until their work is merged into your branch, and
  says so ("waits for Merge all"). Merge all now works mid-run: it merges what
  has landed, the run goes on, and the waiting tasks start by themselves. A run
  with nothing else to do shows as paused for Merge all. Force start, or running
  a single task, passes a gate after a confirmation naming what is not merged
  (`--yes` answers it in the CLI). Ordewell still never merges for you.

### Changed

- **A dirty tree holds a run at its first change task**, not at its start, so a
  run of only ops tasks is never blocked by uncommitted changes.

## [0.6.0] — 2026-10-02

### Changed

- **The structured transport is now the default, and tmux is optional.** Tasks
  are driven through their runner's own protocol instead of a terminal screen
  and keyboard, for Claude Code, Codex and OpenCode alike; the experimental
  label is gone. To go back to the terminal transport, run `/transport terminal`
  (or `ordewell transport terminal`), or switch off the Structured toggle in
  VS Code; a choice you already stored is kept, and it applies from the next
  run. tmux is now needed only by the terminal transport, to give each task a
  terminal window you can open. Without it Ordewell starts as usual, and a run
  on the terminal transport says what is unavailable and how to get it. A runner
  with no structured connector still falls back to the terminal, with the reason
  shown on the task.
  - **Codex and OpenCode structured connectors.** Codex tasks run over
    `codex app-server` and OpenCode tasks over `opencode serve`, so those runners
    get the structured task log and runner approvals Claude Code already had.
  - **Full auto and Auto.** Two autonomy levels, set with `/auto [full|auto]`
    and shown on every surface. Each runner's manifest says what a level means
    for it, and the plan's level is held rather than rewritten when a task
    starts.
  - **Claude tasks ask clarifying questions in plain text.** A Claude Code task
    on the structured transport asks in its reply and waits for you, instead of
    using its built-in question tool.
- **The VS Code task log's message box works like the planner's.** Enter sends
  and Shift+Enter starts a new line; one button sends what is typed, stops the
  live turn when nothing is, and greys out when there is neither. Esc twice
  stops the turn too, with a hint after the first press. The separate Interrupt
  button is gone.

### Fixed

- **Opening a structured task after reopening a session.** `t` and `/terminal`
  looked for a tmux window the task never had, and said it "hasn't opened a
  terminal yet". A task with a saved log now opens that log, and a task with
  neither says so plainly.
- **The terminal UI keeps your place when you scroll back.** The planner chat
  jumped to the newest line whenever a block arrived, and a task log slid what
  you were reading upward as lines came in below. Both now hold the lines you
  were on while you read back, and follow new output once you are at the bottom
  again. What you send yourself still brings the pane to the bottom.
- **Live logs in VS Code follow new output again.** The task log, the planner
  conversation and a task card's runner output now stay on the newest lines
  while you are at the bottom, and stop following as soon as you scroll up to
  read back. Before, the task log never followed, the planner could lose its
  place when a large block arrived, and the runner output pulled you back down
  on every new line.

- **Fewer pointless approval prompts from planner research.** A search pattern
  or filter program that starts with `/` — `grep "/api/users" src`,
  `find . -path '/x/*'`, `sed -n '/start/,/end/p'`, `git log --grep=/fix/` — is
  no longer mistaken for a file outside the workspace, and `/dev/null` and the
  standard streams never ask. Files those commands read are still confined.
- **One prompt per command.** A command that needs approval and also reaches
  outside the workspace, or reads from several outside directories, now asks
  once and lists everything it covers, instead of one prompt after another.
  Each directory is still granted on its own.

## [0.5.6] — 2026-09-30

### Added

- **CI runs the VS Code integration test and reports coverage.** Every push
  now builds a real VS Code, drives the extension against a synthetic runner,
  and prints each package's statement/branch/function coverage in the job's
  summary — report-only, so it never fails a build on a percentage.
- **An experimental *structured* transport for Claude Code tasks.** Turn it on
  with `/transport structured` (or `ordewell transport structured`); the next
  run drives each Claude Code task through its own protocol instead of a tmux
  screen and keyboard, so "running", "waiting for approval" and "waiting for
  input" are read from the runner rather than guessed from silence. Off by
  default, and copied onto the plan when a run starts, so a change applies from
  the next run. A task whose runner has no structured connector yet (Codex,
  OpenCode) still runs on the terminal transport, with the fallback and its
  reason shown on the task — never a silent downgrade.
- **A task log for structured tasks, in the TUI and VS Code.** `t` or
  `/terminal` on a structured task swaps the TUI's chat pane to its log; VS Code
  opens the same log in an editor tab on demand from the task's "Open log". The
  log streams live and is saved one file per attempt, so reopening a session, or
  restarting the daemon, rebuilds the same view.
- **Runner approvals as cards in the task log.** When a task's runner asks to
  use a tool its mode does not cover, the request appears inline and waits — with
  *Allow*, *Allow for this task* where the runner offers its own session-scoped
  grant, and *Deny* with an optional note the agent reads. A task with a pending
  request shows a waiting badge and stays in progress; cancelling, stopping or
  retrying denies whatever is still open.
- **Talking to a running structured task.** A message sent to a task is queued
  and delivered when its turn ends, and can be taken back before it goes; a turn
  can be interrupted mid-flight. A turn that ends without the completion marker
  leaves the task waiting for input (or at a checkpoint) with no verdict
  invented, and a reply resumes it.
- **Continue a finished structured task.** A completed or failed structured task
  can be continued in its saved Claude session, with the message as the next
  turn; the continued attempt is verified and landed like any other. It is not
  offered for a conflicted task.

### Changed

- **The plan saves to disk the moment a task settles**, not only at certain
  points in a run, so a crash or a closed session loses less: reopening finds
  the last task's verdict already on disk.
- **TaskOrchestrator and Session were split into focused modules** — isolation
  and conflict repair, the runner-exit classifier, message queue and readiness,
  and the wiring that builds them — with no change to what a run does. Session
  itself is down to one composition root.

### Fixed

- **OpenCode's terminal fits its tab.** The agent was floored at 80 columns, so
  in a narrower tab its TUI was clipped on the right and its lines wrapped
  mid-word. The floor is now 45 columns, the limit below which OpenCode exits.

- **`/model set` with an API model while a coding agent plans.** Naming an
  OpenRouter (or other vendor) model such as `deepseek/deepseek-v4-flash` used
  to open a picker of the agent's own Claude models and set nothing. It now
  offers to switch the planner to that provider and sets the model. The
  `/model set` suggestions also follow the planner now: with a coding agent
  planning they list that agent's models, not the whole API catalog.

- **An API planner now uses the model you set last.** A planner conversation
  on OpenRouter (or any OpenAI-compatible provider) kept calling the model it
  started with, so `/model` and the model picker changed the setting but not
  the running conversation. The model is now read on every API call, as the key
  already is.

- **An API planner now uses the key you set last.** The planner kept the
  client it built with the first key, so after a wrong key gave
  `401 User not found.` a corrected `/key` (or edited endpoint) still went out
  with the old one, mid-conversation included. The client is rebuilt whenever
  the key or base URL changes, for OpenAI-compatible providers and Gemini alike.
  A missing key now names its own provider and variable, keyless local
  `openai_compatible` endpoints work, and keys and base URLs are trimmed.
  `.env` values in quotes or behind `export` are read without them.

- **An error from the UI while a task starts no longer corrupts that task.**
  Observers (the host broadcast, session persistence) could throw during
  `startTask`; one throwing observer now only fails to notify — the task keeps
  running, its worktree is not torn down, and the next ready task still
  starts.
- **A task that fails to spawn now stops the runner it partially started.**
  Previously only cancel, retry, Mark complete and stop did; a failed spawn
  could leave the runner process alive and the verifier still watching a
  worktree that was already deleted.
- **Cancelling a task that already finished no longer reverts it.** A cancel
  that arrives after the task's verdict has already landed — a race, most
  often when a task finishes right as you cancel it — is now a no-op instead
  of silently putting a completed task back to pending and discarding its
  verdict.
- **An unlisted command-runner is refused, not asked.** `xargs -a list rm`,
  `awk 'BEGIN{system(...)}'` and similar could land at the ask tier with a
  binary-wide remembered grant, contradicting ADR-0008's "refuse is not
  promptable." This narrows the planner's exploration envelope
  ([ADR-0008](docs/adr/0008-planner-exploration-envelope.md)), it does not
  widen it.
- **Provider keys and the daemon token are written 0600**, even when they
  replace an existing file created with looser permissions — a plain write
  over an existing file keeps that file's old mode, so the write now goes
  through a fresh temp file renamed over the target instead.
- **The usage-limit pause message mentions a kept worktree only when there is
  one.** A paused task in a run without isolation has no worktree, so it is
  no longer told it does.
- **A failed planner turn rolls back even when a task settled mid-turn.**
  Save-on-verdict's background save could bump the same counter the rollback
  guard reads, so a turn that failed right after a task finished kept its
  unanswered message in memory and on disk. Execution-event saves no longer
  block the undo.

## [0.5.5] — 2026-09-28

### Added

- **Planner replies stream as they are written.** Every planner — the API
  providers and the harness planners alike — now shows its reply text as it
  arrives instead of after the turn settles, and a turn that is corrected
  withdraws the text it already streamed. The settled reply still wins: when a
  turn ends, its text replaces whatever was streamed for it, so a retry cannot
  leave a half-answer on screen. A reply that is a plan is never shown as
  prose; it keeps streaming as the "building plan" display until it becomes a
  plan marker.
- **A token line under the conversation.** The TUI and VS Code show what the
  session has used — input, output and cached tokens, per-currency cost, and
  how full the planner's context window is — taken only from what the provider
  or runner reports, and left out where none reports. No prices are guessed.
- **Research subagents draw as their own blocks.** A subagent announced by the
  planner gets a block carrying its brief, model and, when it finishes, its
  outcome and the digest it handed back; its own calls and thinking sit under
  it, and its usage is counted into the token line. A subagent's text no longer
  leaks into the planner's reply. A reloaded session regroups the subagent's
  saved steps rather than showing them loose or twice.
- **Readable command rows, with ctrl+o for everything.** A tool call reads as
  `Name(keyArg)` with one preview line of its output instead of a raw argument
  blob; a refused command, a denied path and a broken command read
  differently. ctrl+o expands or collapses full detail — arguments, whole
  output, subagent children and digests — for the whole conversation at once.
- **Queue a prompt while the planner is working.** A message sent mid-turn is
  held and sent when the turn ends, drawn under the conversation with how to
  take it back — Esc in the TUI unsends the newest one and puts its text back
  in the input, and VS Code withdraws one from the queue badge. The planner
  keeps running either way. ctrl+L clears the TUI conversation but keeps the
  token line.

### Changed

- **Double-Esc stops the planner in the TUI.** With the input already empty,
  the first Esc arms the stop and the second confirms it, so a stray tap cannot
  cancel a turn; the status line says what is armed. VS Code draws a planner
  approval as a card that names what is being approved and who decided it, and
  offers an expand-all button for the conversation.
- **The TUI's piped research log matches the chat pane.** Steps print as
  `Read(src/auth.ts)` rather than `read_file auth.ts`.
- **Adding a task mid-run applies at once.** A planner edit waits for the
  running batch only when it reaches a task a runner is executing. Added
  tasks, and edits to tasks that are not running, land in the plan
  immediately while the running tasks carry on.
- **`S` stops a run in the TUI.** The plan pane's footer names it. A run with
  no task running reads as idle, so Execute can start it again.
- **Cancelling a task keeps its worktree.** Runners are often cancelled
  because they look stuck after finishing, so the work is no longer thrown
  away. Mark complete can still land it, and the next attempt replaces it.
  Removing the task from the plan still discards it.

### Fixed

- **Finished tasks stay finished when the planner rewrites the plan.** A
  planner that answered "add a task" with the whole plan could send finished
  tasks back as pending, and they ran again. That happened both when nothing
  was running and when the change had been queued until the batch finished.
  A task that is done, running or waiting on you now keeps its status and
  content whatever the planner writes, and one the planner leaves out is put
  back. A queued change is applied once, and a reload no longer applies it
  again. A queued change the planner cannot apply is reported, and the run
  continues.
- **A task whose terminal was closed no longer counts as running forever.**
  Closing a task's tmux window, or losing the tmux server, left the task and
  its run "executing" with nothing left to finish them. The task now gets its
  verdict from what the runner printed: done if the completion marker is
  there, failed if not.
- **A runner that hits its usage limit pauses its task instead of failing
  it.** The task waits on you with its worktree kept, so you can retry once
  the limit resets. The run holds rather than spending the same limit on the
  next tasks.
- **A task that passed but could not be merged waits on you.** It no longer
  shows as failed, which contradicted its completion marker. The notice says
  what stopped the merge, such as a worktree that is gone, and the work is
  kept.
- **Reopening a plan keeps a worktree that still holds unmerged work.** The
  crash-recovery cleanup deleted every worktree still marked active, including
  one whose runner was still working under another host. It now keeps any
  that holds commits or edits, and says which tasks they belong to.
- **One "Started" notice per task in the TUI.** A task start could be
  announced several times.

- **The planner conversation draws each turn once.** While a run is going, a
  planner turn reaches the surfaces on two subscriptions at the same time; the
  TUI now shows one reply and one approval card for it, and a reply a reload
  has already drawn is not spoken again.
- **A harness planner's one-shot plan streams to the "building plan"
  display.** `ordewell plan` with research off showed an empty plan display
  while the model wrote the plan, because only the API providers' token stream
  was forwarded.
- **A planner conversation no longer breaks after a turn gives up on its tool
  calls.** When a model kept asking for tools past the turn's budget, the
  history was left with calls nothing had answered, and OpenAI-compatible APIs
  then refused every later message in that session.
- **The command classifier refuses a command name the shell computes.** A
  substitution in the command position (`$(printf rm) -rf build`), a brace
  list, or a path glued onto a short flag (`grep -f/etc/passwd`) is now
  refused or prompted instead of running unprompted; computed arguments are
  confined like any other path, and bash's `|&` reads as a pipe. This narrows
  the planner's exploration envelope ([ADR-0008](docs/adr/0008-planner-exploration-envelope.md)),
  it does not widen it.
- **VS Code names a check you made as yours.** A task you marked complete
  reads "Marked by you" rather than presenting your decision as a model
  review.

## [0.5.4] — 2026-09-26

### Fixed

- **The VS Code chat panel follows light themes.** The focused chat input,
  hovered and expanded task cards and inline code no longer render as dark
  blocks, hover highlights and the runner chip in the model badge are visible,
  and muted text stays lighter than body text. Thanks to @directsol (#20).

## [0.5.3] — 2026-09-26

### Fixed

- **CLI commands work after the daemon restarts.** A session the new daemon
  had not adopted answered "Session not found" to every task command until
  you ran `ordewell sessions load`; it is now adopted from the workspace and
  the command goes through. The TUI recovers the same way after it restarts a
  stopped server.
- **`ordewell plan --no-chat` counts its tasks.** It printed "Plan: 0 tasks"
  over the tasks it had just made; it now reports them, and says "1 task".
- **npm no longer rewrites the `ordewell` package's `bin` path on publish.**

## [0.5.2] — 2026-09-26

### Added

- **Each project's own environment reaches its planner and agents (ADR-0016).**
  However Ordewell was started — a desktop launcher, another directory, a
  daemon already running for another project — the planner and every task's
  agent now get the project's variables: from its `.envrc` when direnv is
  installed and you have allowed it, then from an untracked `.ordewell/env`
  (`KEY=value` lines), which wins. A `CLAUDE_CONFIG_DIR` there picks the Claude
  Code account a project's agents run under, and task summaries are read from
  that account's transcripts. A blocked `.envrc`, an `.ordewell/env` that git
  tracks, and variables that change how processes load (`PATH`,
  `NODE_OPTIONS`, `LD_PRELOAD`, …) are never applied, and each is reported once
  per run. `ORDEWELL_DIRENV=false` leaves direnv out.
- **Choose how many AI tasks run at once, anywhere.** `ordewell parallel [<n>]`,
  `/parallel [<n>]` in the TUI and in VS Code's chat, and "Ordewell: Set
  Parallel Tasks" in the Command Palette set it; any whole number from 1 up is
  accepted — there is no longer a ceiling of 5. A change applies to a run
  already going: tasks waiting for a slot start at once.

### Fixed

- **A retry resumes a run its failure paused.** Retrying the task whose failed
  verdict halted a full run now starts it and carries on with the plan; it used
  to reset the task to pending and run nothing until the plan was run again. A
  retry after a single-task run still runs only that task.
- **Finished agents no longer pile up.** The agent a verdict leaves open for
  you to read is closed when the run is merged, cleaned up or discarded, and
  when a conflict repair or retry starts a new agent in the same worktree.
  Before, every task left an agent process running, in a worktree that no
  longer existed, until the daemon stopped.
- **A task stopped at an agent's question says so.** When Claude Code stops on
  its folder-trust or Bypass Permissions confirmation — which it shows even in
  Auto mode, in a folder it has never been trusted in — the task now warns that
  it is waiting for you and where to answer, instead of looking busy forever.
  Ordewell never answers these for you. A task that has gone quiet reads
  "quiet — t opens its terminal" in the TUI instead of "working".
- **OpenCode tasks no longer die in narrow VS Code terminals.** OpenCode's TUI
  exits with SIGILL (code 132) below about 45 columns, and each parallel task
  used to open beside the last one, halving the width every time. The agent now
  always gets at least 80 columns; task terminals open without taking focus, so
  parallel tasks share one side group as tabs, and each tab is named after its
  task's order and title rather than a slice of its id.
- **The TUI status line follows the run.** It names the tasks actually running,
  says when the run is only waiting on you, and stops naming a task once it
  finishes. A task's start is logged as a plain line instead of a research step
  that never settled.
- **The CLI finds the session the TUI is showing.** `ordewell handoff`,
  `terminal <n>` and the other one-shot commands default to the TUI's session
  in the same workspace, and `--session-id` accepts the short id
  `ordewell status` prints.
- **`ordewell --workspace <dir>` and `ordewell --port <n>` open the TUI**, as the
  help says, instead of failing as an unknown command; `ordewell handoff` is now
  listed in the help.

## [0.5.1] — 2026-09-26

### Added

- **A conflicted task repairs its own conflict first (ADR-0015).** When a
  passed task's landing conflicts, Ordewell now starts a bounded repair: the
  same task runs again in its kept worktree, on its own runner, model and
  mode, and is asked to merge the latest integration branch in and resolve the
  conflict so both sides' intent survives. The repair only counts when its
  marker appears, its branch really contains the integration tip it started
  from, no conflict markers are left, and the normal landing goes through
  cleanly — a repair that only claims to have done this waits for you like any
  other conflict. `conflictRepairAttempts` (default 2; env
  `ORDEWELL_CONFLICT_REPAIR_ATTEMPTS`, VS Code
  `ordewell.conflictRepairAttempts`) caps how many repairs one task gets; 0
  turns repair off and every conflict waits for you as before. A failed or
  exhausted repair never halts the run and never overwrites the task's own
  pass verdict — Mark complete, retry and resolve-as-a-task all still work.
- **Conflicting tasks name their conflicting files.** The task row, the
  conflict notice and the handoff on every surface — TUI, `ordewell handoff`,
  VS Code and the daemon's API — show which files conflicted, and the *Merge
  all* handoff names the tasks that only landed after a repair, with their
  files, so review knows where to concentrate. The files are cleared when the
  task merges or is retried.
- **Task worktrees resolve the workspace's own packages to their own code.** A
  worktree's `node_modules` is now a real directory mirrored entry by entry
  from your checkout: your own workspace packages resolve to the worktree's
  source, while every other dependency links live to the shared install. A
  package the main checkout no longer has falls back to the copy it can still
  reach, never to a broken link. Cleanup never touches your own
  `node_modules`, and `worktreeSetupCommand` behaves as before.
- **Fewer conflicts in the first place.** `CHANGELOG.md` and
  `packages/*/CHANGELOG.md` union-merge (`.gitattributes`), so two parallel
  tasks appending entries land cleanly; and the planner is told not to give
  parallel tasks the same append-only file to edit.

### Changed

- **Rewind forks the conversation instead of cutting it.** `/rewind` and
  `ordewell rewind <n>` now copy the conversation up to just before the chosen
  message, together with the current task list, into a new session and switch
  to it. The original session keeps its whole conversation, so you can go back
  with `/sessions` or `ordewell sessions load`. The message you rewound to is
  returned in full — `ordewell rewind` prints it so you can resend or edit it.
  Still refused while the planner is answering.
- **The TUI asks before it rewinds, then hands the message back.** Choosing a
  message in the `/rewind` picker, or typing `/rewind <n>`, opens a
  confirmation that quotes the whole message and says the conversation will be
  forked and the code left unchanged. Pick *Restore Conversation* (`1` or
  Enter) to switch to the fork with that message already in the input, ready to
  edit and send; *Never mind* (`2` or Esc) closes it and nothing happens. The
  rewind targets the daemon lists now carry each message's full text.
- **Page keys and the mouse wheel keep the plan selection on screen.** PgDn
  selects the first task fully visible at the top of the new page, PgUp the
  last at the bottom, and at either end they select the last or first task. The
  wheel scrolls freely and moves the selection only if it would leave the pane.
  The `↑↓ to follow` hint is gone, since the selected task is always visible.
- **Integration branches no longer pile up once their work is merged.** After a
  Merge all that merges everything, the run is cleared up: its worktrees, task
  branches and `ordewell/<run-id>/integration` branches go in every repository,
  and the handoff closes on every surface. When a run starts, it also deletes
  other runs' `ordewell/…` branches that your checked-out branch already
  contains — never one a worktree has checked out, one of a run that still has
  a worktree, or one holding work you have not merged. In a folder of
  repositories each repository is decided on its own. A blocked, conflicting or
  failed Merge all deletes nothing, and a sweep that fails only warns.

### Fixed

- **The welcome no longer jumps from the top to the bottom at launch.** The chat
  pane now hangs off the top while its content fits and shows the newest lines
  only once it overflows. The startup refresh no longer posts a "Refreshed…"
  notice; a typed `/refresh` still does.
- **The plan pane no longer scrolls the whole list when you press up.** After
  moving the cursor down past the bottom of the pane, pressing up used to
  scroll everything with the cursor stuck to the bottom row. The pane now keeps
  its place: the cursor walks up to the top visible task, and only then does
  the list scroll — by exactly that task's height, at whatever height each task
  has.
- **You can add the first task to an empty plan.** In the plan pane, `a` was
  swallowed when there were no tasks, and Tab moved focus into a pane that is
  hidden until a task exists. Tab now stays in chat while the plan is empty,
  focus returns to chat when the last task is removed, and the cursor can no
  longer land on row -1 — so the first task you add is selected. Without a
  session, `/add-task` now says to describe a goal first.

## [0.5.0] — 2026-09-25

### Added

- **Each AI task can run in its own git worktree (#12).** In a git repository,
  every AI task gets a worktree on its own branch instead of the shared
  workspace root, so tasks that edit the same files can run side by side
  without overwriting each other. A task that passes its verdict is committed
  and merged into one integration branch per run, lowest plan order first; its
  dependents start only once its work is on that branch. A merge conflict stops
  the task and keeps its worktree — it is never resolved automatically; resolve
  it by hand and mark the task complete, retry it, or add a task that resolves
  it. Nothing is merged into your checked-out branch until you ask: at the end
  of a run you review the diff, merge, discard the run or clean up its
  worktrees — `/handoff` in the TUI, `ordewell handoff` on the CLI, the handoff
  card in VS Code. Uncommitted changes to tracked files hold a run until you
  stash them or choose to run without isolation (`ordewell run --stash` /
  `--without-isolation`). The planner stops ordering tasks just because they
  touch the same file when isolation is on. Worktrees link `node_modules`,
  `.env*` and agent config from your checkout; set `worktreeSetupCommand`
  (`ORDEWELL_WORKTREE_SETUP`) to prepare them another way. Turn the feature off
  with the `worktreeIsolation` setting or `ORDEWELL_WORKTREE_ISOLATION=false`;
  in a folder with no git repository in it nothing changes.
- **A folder of git repositories isolates them together (ADR-0014).** Open a
  folder that holds several independent repositories and each AI task gets a
  task workspace laid out like the folder: a worktree of every repository at
  its usual path, all on one branch name, so relative paths between them keep
  working. A task lands in every repository it changed or in none — if its
  merge conflicts in one, what it merged in the others is taken back and the
  task waits for you, with the conflicting repository named, and its
  dependents wait with it. Repositories directly inside the folder are found on
  their own; list others, or pick a subset, with the `workspaceRepos` setting
  (`ORDEWELL_WORKSPACE_REPOS`, comma-separated). Loose files and folders beside
  the repositories, and any repository that cannot be isolated (one with no
  commits yet), are shared live with every task and named when the run starts;
  the planner is told about them so it does not run two tasks that edit one at
  the same time. Each repository's worktree links its own `node_modules`,
  `.env*` and agent config, plus anything matching the new `worktreeLinks`
  setting (`ORDEWELL_WORKTREE_LINKS`), such as `*.tfstate` or `.terraform/`;
  `worktreeSetupCommand` runs once per repository, in its worktree, with
  `ORDEWELL_REPO` (its path in the folder) and `ORDEWELL_MAIN_REPO` (the real
  repository) set. Uncommitted changes in any repository hold the whole run,
  and Stash stashes every one of them. At the end of a run, Merge all merges
  every repository or none: if any would conflict, has a merge of yours in
  progress, or has uncommitted edits to a file the run changed, it merges
  nothing and says which repository and why. On git older than 2.38 it merges
  repository by repository instead and says which landed. The review diff has
  a section per repository, and discard and clean-up cover all of them.
  `ordewell handoff`, `/handoff` in the TUI and
  the VS Code handoff card show each repository. A repository that itself holds
  other repositories that are not submodules is not isolated, since its
  worktrees would leave them out: tasks run in the workspace root with a notice
  naming them, and ignoring them in git or making them submodules brings
  isolation back.
- **Fork and rewind a planner conversation (#9).** Rewind cuts the conversation
  back to just before one of your messages; fork continues in a copy of the
  conversation and its tasks while the original stays as it was. Both act on
  the conversation only — the task list is kept as it is — and work with any
  planner. TUI and VS Code `/fork` and `/rewind`; CLI `ordewell fork` and
  `ordewell rewind [n]`; in VS Code also the Command Palette ("Ordewell: Fork
  Conversation" and "Ordewell: Rewind Conversation").
- **Condense a planner conversation on request (#10).** `/compact` in the TUI
  and VS Code (also "Ordewell: Compact Conversation" in the Command Palette) or
  `ordewell compact` replaces the conversation with a summary the planner
  writes, keeping the last two exchanges as they were. The tasks are untouched,
  the summary is shown to you, and a failed or stopped compaction changes
  nothing.
- **The planner can read a running task's recent output (#3).** A task read
  may ask for `output` — the clean-rendered tail of what the task is printing
  right now, with `outputLines` and `outputSince` to page through it — so the
  planner can look at a task that seems stuck instead of guessing. It uses the
  existing task-read channel, so it works the same for every planner and reads
  nothing outside what Ordewell captured.

### Changed

- **Internals reorganized behind narrower modules.** The planner conversation
  has one owner, each task run is one record from spawn to verdict, a task's
  output (the live tail and the final summary) has one owner, and terminal
  rendering is a pure module. No behaviour change is intended beyond the fixes
  below.

### Fixed

- **A task's summary is its own.** When parallel tasks ran in one directory, a
  task could be summarized from another task's transcript; transcripts are now
  matched by the task's completion marker, and a dependent's prompt no longer
  carries its predecessor's marker id. Claude Code transcripts are now found
  for a working directory with a dot in its path, or one long enough that
  Claude Code shortens its name.
- **A stale runner can no longer decide a newer attempt.** A retry, cancel,
  Mark complete, stop or plan load that landed while a verdict was being read
  was overwritten by that verdict; a retried task's runner could be dropped by
  the previous attempt's exit; and a terminal that outlived a stop could fail
  or pass the task's next attempt.
- **Marking a task complete while its runner was starting is no longer undone**
  when the runner comes up.
- **One-shot plan changes and queued mid-run edits appear in the conversation**,
  so the planner's replayed dialogue and the plan no longer drift apart.
- **Two sessions saved in the same second with the same goal** — a conversation
  forked twice — no longer overwrite each other's file.

## [0.4.23] — 2026-09-23

### Fixed

- **The planner can use models you allowlist mid-session (#17).** Adding a
  model to a runner's allowlist during a session showed it to the planner, but
  its edits assigning that model were refused as "does not offer model" when
  the session's start-up model discovery hadn't listed it. The planner now uses
  the allowlist in force on each turn and the latest discovered model catalog.
  Clearing the allowlist mid-session also lifts the restriction; before, it
  fell back to the list the session started with.

## [0.4.22] — 2026-09-23

### Fixed

- **Codex tasks now run with full access under autonomous mode.** A task moved
  onto Codex, or added by hand, took the first mode Codex lists — its
  workspace-write sandbox — instead of the mode the autonomous toggle selects.
  With approvals off, a sandboxed Codex task could not ask for more access, so
  it stopped at the first blocked command. New and retargeted tasks now land on
  the toggle's mode (`fullAccess` when autonomous mode is on), and a planned
  task with no mode resolves the same way. Existing tasks keep the mode they
  have — change it per task or regenerate the plan.

## [0.4.21] — 2026-09-22

### Fixed

- **Dependent tasks now receive their predecessor's real final message, not a
  frozen frame of the runner's UI.** The output summary captured as context for
  dependent tasks was the raw terminal tail — for interactive runners that is
  mostly TUI paint (spinner lines, the `ctx:` status bar, cursor-positioned
  fragments) with the actual answer scattered or absent (#14). Capture is now
  screen-rendered and cut at the completion marker, so everything below the
  marker — the persistent status bar, spinner and input gutter — is dropped.

### Added

- **The summary prefers the agent's own session transcript.** Claude Code
  (JSONL transcripts), OpenCode (its SQLite store) and Codex (rollout files)
  all write a clean, structured record of the conversation. When the runner's
  transcript can be located for the task's working directory and start time,
  the dependent task now reads the agent's actual prose; the cleaned terminal
  capture remains the fallback when no transcript exists (#16). The terminal
  is untouched as the source of verdict evidence — this changes only what is
  summarized for downstream consumers. Thanks to @directsol for verifying the
  Codex reader against a live rollout store.

## [0.4.20] — 2026-09-22

### Fixed

- **OpenCode tasks no longer sit waiting for a manual Enter to start.** In a
  tmux window or a VS Code terminal tab, OpenCode's `--prompt` flag only
  pre-fills its TUI's composer — it never submits it, unlike Claude Code's and
  Codex's own interactive prompts. A task's window opened with the prompt
  visibly typed in but idle, and a human had to press Enter in the terminal
  before it would run. The runner now sends that Enter itself right after
  launch.

## [0.4.19] — 2026-09-10

### Fixed

- **Expanding a task in the plan dock now collapses any other open task.** The
  cards acted like independent toggles, so opening several meant closing each
  one by hand before the list was readable again. They now behave as an
  accordion: at most one task body is open at a time.

## [0.4.18] — 2026-09-07

### Fixed

- **A long OpenCode planning turn no longer fails with "fetch failed".** The
  turn is one HTTP request held open for its whole duration, and OpenCode
  sends no response headers until it ends — so Node's global `fetch`, which
  gives up after 300 seconds, abandoned any turn past five minutes while the
  server was still planning. The request is the turn's transport, not its
  work: the reply is now read back out of the session instead of the turn
  being lost, and a turn still in progress keeps the planner watchdog fed.
  Failures that stay unrecoverable name the underlying cause rather than
  reporting a bare `fetch failed`.

## [0.4.17] — 2026-09-02

### Added

- **A third built-in skill, `improve-codebase-architecture`.** Adapted from
  [Matt Pocock's skill of the same name](https://github.com/mattpocock/skills):
  scans the codebase for deepening opportunities and presents them prioritized
  directly in chat (the original's HTML report has no analog here — the
  planner is read-only and can never write a file), then splits however many
  candidates the user wants to act on into ordered plan tasks instead of
  grilling through a single live refactor. Two selected candidates that touch
  overlapping files are made dependent on each other so independent runners
  never edit the same file in parallel. Invoke with `/improve-codebase-architecture`.

## [0.4.16] — 2026-08-31

### Fixed

- **The VS Code extension no longer false-positives "The planner stopped
  responding" while Claude Code is still actively working.** The webview's
  idle watchdog reset only when a progress event reached it, but Claude
  Code's adapter deliberately drops every raw line belonging to a native
  subagent before it becomes an event. A subagent doing long nested
  exploration produced nothing for over two minutes, starving the watchdog
  into interrupting a session that was never actually stuck. Liveness is now
  signaled at the shared raw-line boundary, below any adapter's content
  filtering, so it no longer depends on what a given runner chooses to
  surface — closing the same gap for every harness planner, not just Claude
  Code.
- **`/skill-name` now expands anywhere in a message, not only when it is the
  entire message.** `resolveSkillInvocation` substituted a skill invocation
  only when a message matched it exactly, so `/grilling do this` sent the
  literal, unexpanded token to the model even though the TUI and VS Code
  webview both highlighted it as recognized. Any whitespace-bounded
  `/skill-name` token is now spliced in wherever it appears.
- **Pressing Tab on a highlighted `/model set` suggestion no longer crashes.**
  It called `modelCmdPrefix(text)`, a function that was never defined
  anywhere in the codebase. A model row is only ever completed onto
  `/model set`, so that prefix is now inlined directly.

## [0.4.15] — 2026-08-31

### Fixed

- **A brand-new project directory can now be initialized instead of just
  being refused.** `assertWorkspaceIsProject` (the 0.4.9 confinement-boundary
  check — see below) rejected any workspace without a `.git`/`.ordewell`/
  manifest marker, but nothing ever bootstrapped one: there was no `init`
  command, and `.ordewell/` was only ever created lazily on first session
  save, after this check had already thrown. Starting `ordewell` in a
  genuinely fresh folder had no way through. The check itself is unchanged —
  an unmarked directory is still never admitted silently — but the TUI now
  offers an explicit "Initialize this as a new workspace?" prompt on
  rejection, and only on confirmation does it create `.ordewell/` and retry.

## [0.4.14] — 2026-08-27

### Fixed

- **Changing a subtask's model, runner, effort or mode no longer shows an
  empty picker.** Every per-task picker (`o`/`R`/`e`/`M`/`D` and their
  `/task-*` slash commands) looked a task up with a flat `state.tasks.find`,
  which only sees top-level tasks — a subtask lives nested under its parent's
  `subtasks`. That silently produced the generic empty-picker fallback
  ("Nothing to show yet…") for any subtask, and crashed a few command paths
  outright. All of those lookups now use the existing recursive task-tree
  search.
- **A VS Code subtask assigned to a different runner than its parent now gets
  its own runner's model catalog.** The per-task card passed its own
  parent-scoped model and mode lists straight through to every subtask card,
  so a subtask running on a different agent than its parent saw the wrong
  agent's models (or none). Subtasks are now scoped to their own
  `assignedRunner`.
- **VS Code's per-task model dropdown re-discovers when opened**, the same
  way the TUI's already did. Discovery only ran on activation, a config
  change, or a webview reconnect, so a catalog left degraded by a cold runner
  CLI at one of those moments never healed on its own — even after the CLI
  was clearly working, an already-assigned task's dropdown stayed empty until
  the window was reloaded.
- **The planner's `/model` picker now shows which provider each model comes
  from**, matching every other model picker in the TUI. It was the only one
  that dropped this, so two same-named models from different providers (e.g.
  OpenCode's own catalog vs. an OpenRouter-backed one) were indistinguishable.

## [0.4.13] — 2026-08-26

### Fixed

- **OpenCode (or any installed-but-not-"enabled" runner) no longer shows the
  wrong models, or none at all.** Model discovery was scoped to
  `enabledRunners` — a setting meant only to control which runners the
  planner may auto-assign tasks to — but the per-task Runner dropdown and the
  planner backend pills let you pick *any installed* runner regardless of
  that setting. Picking one outside `enabledRunners` left its catalog
  undiscovered: the VS Code extension's degraded-discovery fallback then
  silently substituted another runner's models (typically Claude Code's),
  and the TUI's task-model picker showed an unexplained empty list. Discovery
  now covers every installed runner, and the TUI's picker explains an empty
  catalog the way the planner's already did ("No `<runner>` models discovered
  yet — run `/refresh`"). (#1)

## [0.4.12] — 2026-08-26

TUI plan pane and VS Code chat-panel fixes, plus a live-resizing PTY for
in-editor agent terminals.

### Added

- **The agent PTY resizes live.** `script` allocates its PTY at 0×0 off a
  pipe, so a TUI reading its size via `ioctl` rendered as garbage until
  something called `stty`. The wrapper now sets the tab's real size before
  the agent starts and keeps a control channel (fd 3) open so later tab
  resizes reach the PTY slave too.

### Fixed

- **The TUI plan pane can now reach subtask rows.** Enter on a task with
  subtasks used to expand it and open its prompt editor in the same step,
  which hijacked every following key — including up/down — into the text
  draft. There was no key sequence that actually landed the cursor on a
  3.1/3.2 row, so subtasks read as collapsed away even though the plan tree
  had them. Enter now only reveals subtask rows on a parent's first press; a
  second enter (or any row without subtasks) opens the editor as before, and
  escape backs out of that browsing state one level at a time instead of
  leaving the plan pane. Editing a subtask's prompt no longer has its
  keystrokes swallowed as pane shortcuts, and a plan refresh no longer
  silently collapses a subtask being edited.
- **Task output in the VS Code chat panel no longer shows raw ANSI escapes.**
  Runner output is PTY text full of colour/cursor codes meant for a real
  terminal; the webview's `<pre>` rendered them as literal garbage. Escapes
  and control bytes are now stripped per chunk, and CR-only redraws are
  split onto separate lines instead of being jammed together.
- **Checkpoint summaries are truncated to a single line.** Multi-line
  reasoning could spill across the CLI notice and the extension's
  `CheckpointPanel`; both now show only the first line, capped at 120
  chars, with the full text still available via the panel's title tooltip.

## [0.4.11] — 2026-08-20

Planner and skills rework, task-idle visibility, TUI/session isolation, and a
targeted hardening of credential redaction in response to the 0.4.9 disclosure
follow-up.

### Added

- **The `grill-me`/PRD toggles are replaced with a general skills system.**
  Built-in `grilling` and `to-spec` skills (backed by `SkillsService` and a
  global skills data dir) are now invoked via slash commands, across core,
  CLI, VS Code and web.
- **Running tasks now surface when they go idle.** An `idleSince` state —
  tracked per task, emitted by the VerdictEngine and cleared when output
  resumes — shows a static idle icon in the TUI and the VS Code chat view for
  a task that is running but has produced nothing recently.

### Changed

- **Review mode is removed** from the planner prompts, settings service and
  session management (and cleaned out of the VS Code extension and web server
  routes). No tests reference it any longer.
- **Concurrent TUI sessions are isolated.** `ordewell tui` now spawns its own
  private daemon on a free port by default, so two terminals against the same
  workspace no longer pull each other's tasks into view (shared-port handoff
  for VS Code/web-UI is opt-in via `--port`/`ORDEWELL_PORT`), and that owned
  daemon self-terminates if its spawning CLI dies with a signal it can't
  deliver (e.g. `kill -9`).
- **CLI session pointers and config migration are scoped and fixed.** The
  machine-global `~/.config/ordewell/last-session.json` pointer is now
  `<workspace>/.ordewell/last-session.json`, so a one-shot command can no
  longer silently fall back to a session from an unrelated terminal.
  `migrateOldConfigDir()` now lifts each file independently, so a real `.env`
  with API keys stranded in `~/.config/ordewell` is no longer skipped once
  `settings.json` had already migrated.

### Fixed

- **A long, plain-word secret under an unambiguous credential name is now
  redacted.** Research output where the value carries no digit, no mixed case
  and no punctuation — a passphrase like `password: "correcthorsebatterystaple"`
  or `secret: "batterystaple"` — previously leaked through the identifier
  bypass. An unambiguous name (`password`, `secret`, `privateKey`,
  `passphrase`, `credentials`) with a value ≥12 chars is now treated as key
  material even without a digit. The length floor keeps short
  settings-references (`secretStoreKey: 'cohereKey'`) from being rewritten, so
  config-shaped code is still left intact — a deliberate, documented
  false-negative trade-off for sub-floor no-digit values.
- A stale `grill-me` seed left in `~/.ordewell/skills` by a build from before
  the rename to `grilling` is now pruned on upgrade, so it stops lingering
  in the skill list forever. Only untouched seeds are removed — anything a
  user added or modified under that name is left alone.

## [0.4.10] — 2026-08-17

Planner and TUI fixes, and a read/edit channel that lets the planner work on
the plan during a conversation instead of only regenerating it.

### Added

- **The planner can read and edit tasks mid-conversation.** A `task_query`
  read channel and validated `task_ops` editing during an active session,
  with batch reference semantics, an enriched plan/catalog context block,
  AI↔MAN type coherence, model and task-mode validity checks, topological
  dependency repair, and re-arming of failed or completed tasks that releases
  their blocked dependents. The shared edit rules live in `TaskEditValidator`
  so the `Session` and `TaskOps` seams cannot drift apart. See
  [ADR-0012](docs/adr/0012-the-task-query-read-channel.md).

### Fixed

- **Foreign control codes no longer reach the terminal.** Everything the TUI
  shows that it did not write itself — a planner turn, a research result, a
  task title, a runner's error — routinely carries terminal control codes, and
  only literal tabs were being stripped. These are not text: `width()` measures
  an escape as zero columns because the terminal acts on it rather than
  printing it, so a cursor-forward shifted the pane divider and painted the
  plan pane over the chat, an erase-in-line wiped the row beneath it, an
  unclosed colour bled down the screen, and a BEL rang once per frame — every
  120ms during a run. Whole sequences are now dropped rather than just their
  ESC byte, across three paths that had no sanitizing at all: streamed planner
  reasoning, every string in a normalized plan, and pastes.
- **A failed planner turn no longer leaves a prompt with no reply.** The user
  message was appended to the transcript and research log before the model was
  called, so a turn that threw left both holding a message the session never
  answered — replayed into the next turn, and shown against a plan on disk that
  had neither. A failed turn now undoes exactly its own writes, while a
  `task_ops` turn that persisted before throwing keeps its edits.
- **`/model` and `/planner` switches take effect mid-session.** `WebConfig`
  cached the resolved provider on first read and held it for the life of the
  session, so a switch left the transport pinned to the original provider while
  `apiKey` — which reads live — handed it a key belonging to someone else.
- **A Claude Code planner no longer answers as its own subagents.** Claude Code
  replays a subagent's transcript on the planner's stream, parented to the tool
  call that spawned it; read as the planner talking, an exploration agent's
  commentary opened the reply — often an answer to a prompt the user never sent
  — and its tool calls padded the research log. Subagent traffic is now dropped
  at the adapter, leaving the spawning `Agent` call and its result as the
  planner-level record.
- **A harness planner no longer loses its own research.** Backgrounding an
  exploration agent ended the turn on "I'll report back once they land", and
  everything said afterwards — including the finished research — arrived with no
  turn open and reached no one. The planner is now told to await its agents
  inside the reply, and a turn that backgrounds one anyway is asked to wait for
  the results while a turn is still open, at most twice.
- **A closed turn's straggling work stays out of the next turn.** Tool activity
  arriving after a turn ended — a backgrounded subagent finishing, a late read —
  was held and replayed into the following turn, where it read as research done
  for the user's new message. Only pre-first-turn startup warnings are held now.
- **Planner messages no longer run together.** Each Claude Code message, and
  each OpenCode text part, opens a paragraph after the first — as Codex's
  already did — instead of being concatenated onto the previous sentence.

## [0.4.9] — 2026-08-17

Completes the command-policy hardening started in 0.4.8. Four advisories
publish alongside this release with full technical detail now that the fixes
are shipped:

- [GHSA-r72g-cw5r-pxv2](https://github.com/ordewell/ordewell/security/advisories/GHSA-r72g-cw5r-pxv2)
  — command classifier bypass, high. Fixed here, including the approval-scope
  collisions found in maintainer review.
- [GHSA-q8mp-gq5v-28w8](https://github.com/ordewell/ordewell/security/advisories/GHSA-q8mp-gq5v-28w8)
  — credentials in researched files written to the session file and sent to
  the model provider, medium. Fixed here.
- [GHSA-px4h-42r5-qvhf](https://github.com/ordewell/ordewell/security/advisories/GHSA-px4h-42r5-qvhf)
  — unauthenticated daemon attack chain, high. Fixed in 0.4.8, disclosed here.
- [GHSA-7898-43ch-jgqv](https://github.com/ordewell/ordewell/security/advisories/GHSA-7898-43ch-jgqv)
  — plugin install code execution, critical. Fixed in 0.4.8, disclosed here.

**Upgrading does not undo a credential disclosure that already happened.** If
planning sessions ran in a workspace where credentials were readable, read
GHSA-q8mp-gq5v-28w8 — session files written before 0.4.9 may hold them in
plaintext, and rotation rather than upgrading is the remedy for anything a
provider or a commit already received.

### Fixed

- **The permitted command tier is a per-binary flag allowlist, not a binary
  denylist.** A binary that was previously permitted with any flag at all is
  now only permitted with the flags it's declared read-only with; an
  unrecognised flag is refused rather than allowed.
- **Bare positional ref-writes are refused.** `git branch <name>` and
  `git tag <name>` create or move a ref with no flag involved, so the guard
  covering the delete/move flag forms (`-d`, `-M`, `--delete`, ...) never saw
  them and they classified as read-only. A positional ref name is now refused
  unless `-l`/`--list` marks it as a filter pattern.
- **Shell keywords and compound-command openers are refused.** The classifier
  reads a segment's first token as the command to classify, so `{ ... }`,
  `if ... then ... fi`, `for`, `while`, `time` and `export` sat in that
  position while the command they introduce went unclassified — `if rm -rf
  src; then :; fi` really did run `rm -rf src`. These are now refused
  outright, and `source`/`.` join `eval`/`exec` rather than prompting, where
  one approval would otherwise cover every other script sourced that session.
- **Approval grants no longer collide across distinct operations.** Grant
  scope was the multiplexer name plus its first non-flag argument, which
  let approving one operation (`npm run test`, `az group list`, `aws s3 ls`)
  silently authorise a different one (`npm run <other-script>`, `az group
  delete`, `aws s3 rm`). Scope is now the binary plus up to two leading
  non-flag arguments before the first flag.
- **The daemon refuses to treat an arbitrary directory as a workspace.** A
  workspace root now has to carry a project marker (`.ordewell` or a VCS
  directory); without one, the filesystem root or any system directory could
  become the confinement boundary for every read, search and permitted
  command the planner runs.
- **Session identifiers are unguessable.** Session ids were timestamp-based,
  letting an attacker who knew roughly when planning started enumerate the
  identifier space.
- **Credentials are redacted from research output.** A planner that read a
  configuration file during research previously put its credentials into the
  provider payload, the persisted session file, and — since the session
  directory lives inside the workspace with no ignore rule — a commit waiting
  to happen. Redaction is now applied where a tool result is constructed, so
  one application covers every sink downstream, and the state directory gets
  a match-everything ignore file written inside it on first save. An
  unambiguously named credential whose value looked like an identifier
  (`password: "TopSecretValue123"`) initially slipped past the rule that
  exists to leave setting names alone; the credential name now wins.
- **The plan surface marks which tasks run without permission prompts.** The
  TUI and VS Code extension now surface a task's `autonomous: true` tag on
  its mode.

## [0.4.8] — 2026-08-11

Hardening release across the daemon and command-handling paths. This entry was
written deliberately neutral at the time, while the advisories were still
private; the detail is now public in
[GHSA-px4h-42r5-qvhf](https://github.com/ordewell/ordewell/security/advisories/GHSA-px4h-42r5-qvhf)
(unauthenticated daemon attack chain — this is the release that breaks that
chain) and
[GHSA-7898-43ch-jgqv](https://github.com/ordewell/ordewell/security/advisories/GHSA-7898-43ch-jgqv)
(plugin install code execution — fixed in full here). Note that 0.4.8 does
*not* fix the command classifier bypass
([GHSA-r72g-cw5r-pxv2](https://github.com/ordewell/ordewell/security/advisories/GHSA-r72g-cw5r-pxv2))
or the credential disclosure
([GHSA-q8mp-gq5v-28w8](https://github.com/ordewell/ordewell/security/advisories/GHSA-q8mp-gq5v-28w8));
both need 0.4.9.

No API changes. Upgrading is recommended for all users. Per this project's security
policy, fixes ship forward and are not backported to 0.4.6 or 0.4.7.

## [0.4.7] — 2026-08-10

No functional changes. Re-releases 0.4.6, whose npm and VS Code Marketplace
publishes never completed after being pushed as a tag — both registries
reject re-publishing a version number they already have on file.

## [0.4.6] — 2026-08-09

### Added

- **The planner model survives a planner switch.** Switching back to a planner
  restores the model (and thinking effort) last used with it instead of forcing
  a re-pick; with nothing remembered it falls back to the first model in that
  planner's catalog, and the model is left unset only when no models have been
  discovered. The memory lives in the same `settings.json` as `modelAllowlist`,
  so the TUI, the CLI and the VS Code extension all share it.

## [0.4.5] — 2026-08-04

### Fixed

- **Text in a task's tmux terminal is selectable and copyable.** The runner
  session sets `mouse on` for wheel scrolling, which hands mouse events to tmux
  and so takes the emulator's own drag-select with it — and tmux's replacement
  selection lands in a paste buffer no other application can read, so copying a
  stack trace out of a task's terminal was impossible. Drag-release now copies
  and leaves copy mode, piped through a detected clipboard binary (`wl-copy`,
  `xclip`, `xsel`, `pbcopy`, `clip.exe`) that also backs the default
  double-click, triple-click, `Enter` and `y` copy paths; `set-clipboard on`
  carries the cases no local binary can, such as viewing over SSH. Each option
  is applied independently, so an older tmux without `copy-command` (pre-3.2)
  no longer loses the scrollback bindings that followed it.

## [0.4.4] — 2026-08-04

### Fixed

- **TUI text is selectable and copyable again.** The TUI captured the terminal's
  mouse to read wheel events, and an app that captures the mouse takes
  drag-to-select with it — Shift+drag is not the universal escape hatch it is
  claimed to be (Terminal.app wants Fn, iTerm2 Option, tmux swallows it first).
  Copying a task prompt or an error out of the transcript matters more than a
  three-line wheel notch, so the mouse is left to the terminal by default and
  the wheel is opt-in via `/mouse on` (persisted as `ORDEWELL_TUI_MOUSE`).
  `pgup`/`pgdn` now scroll the plan pane as well as the transcript, and
  alternate scroll is disabled while the TUI is up so an uncaptured wheel cannot
  arrive as arrow keys and quietly replace the draft with a history entry.
- **The planner no longer says the same thing twice in chat.** One turn reaches
  the TUI over the session socket *and* as the last assistant entry of the plan
  the REST call returns, and while a run is live there are two subscriptions to
  that one channel — so a turn taken during execution was transcribed twice. The
  socket is now the live path, the REST reply is only a fallback for a turn it
  did not carry, and a repeat of the newest turn is dropped rather than appended.
- **Codex and OpenCode tasks open their real TUI in tmux.** Opening a task's
  terminal showed `codex exec` / `opencode run` log lines scrolling past instead
  of the agent's interface, which is the whole point of running tasks in a tmux
  window — you could watch, but not steer. One `headless` flag was deciding two
  unrelated things: whether the run is unattended (so the agent must never stop
  to ask permission) and whether it gets a terminal. A tmux window is both at
  once, so those are now separate axes and the tmux transport asks for the
  interactive shape. Claude Code, which had no non-interactive branch in its
  invocation, is unaffected.
- **Codex no longer stalls on its own approval and directory-trust prompts.**
  Both are questions `codex exec` never asks and its TUI asks by default — an
  orchestrated task has nobody to answer them, so it would sit on a menu
  forever. The interactive invocation now carries `-a never` and pre-trusts the
  task's workspace directory, matching what `exec` did implicitly.
- **VS Code tasks keep their permission-skipping flags.** The extension's
  terminal was treated as "not headless" and so lost them, meaning a task could
  block on a permission prompt in a tab nobody was watching.

## [0.4.3] — 2026-08-02

### Added

- **`ordewell --version`.** It was never implemented — the flag fell through to
  `Unknown command`, which read as a broken install rather than a missing
  feature. `version` and `-v` answer the same way, printing a bare version
  string so scripts can compare it without parsing.

## [0.4.2] — 2026-08-02

### Fixed

- **The runner selection survives a restart.** Enabled runners were held only in
  the daemon's memory, so closing and reopening Ordewell threw the choice away
  and silently reinstated the environment's defaults. They now persist to the
  same `settings.json` the model allowlist uses.

### Changed

- **One key convention for every multi-select in the TUI.** `/runners` is now a
  multi-select like `/allowlist` and `/task-deps`: space toggles, enter confirms
  the whole set, escape discards. It previously applied each toggle immediately
  on enter, with escape merely closing. Single-select pickers (`/planner`,
  `/model`, per-task assignment, sessions, keys) still confirm on enter.
- The selection mark in a picker is spaced off the cursor arrow, which rendered
  as one smudged glyph at most terminal font sizes.

## [0.4.0] — 2026-07-31

First public release.

### Added

- **Planner as a conversation.** One continuous chat that researches the repo
  read-only, asks when a goal is vague, and whose final message *is* the plan
  ([ADR-0002](docs/adr/0002-planner-as-conversation-loop.md)).
- **Per-task model routing.** Every task carries its own runner, model, thinking
  effort and mode, chosen by the planner across the whole plan and editable
  before anything runs.
- **Harness planners.** Claude Code, Codex or OpenCode can act as the planner on
  a subscription you already hold, with no separate API key
  ([ADR-0009](docs/adr/0009-coding-agents-as-planners.md)).
- **Evidence-based verdicts.** A task completes only when its unique completion
  marker appears in the runner's output; exit code is kept as diagnostic
  evidence and the model is never the tie-breaker.
- **Three surfaces over one core** — a VS Code extension, a full-screen terminal
  UI ([ADR-0006](docs/adr/0006-tui-pure-core-thin-driver.md)), and a CLI where
  every slash command is also a subcommand.
- **Read-only exploration envelope.** Reads run in parallel, anything reaching
  outside the workspace asks once, and commands that would write are refused
  ([ADR-0008](docs/adr/0008-planner-exploration-envelope.md)).
- **Runner plugins.** Claude Code, Codex and OpenCode are built in; any other
  CLI agent is a manifest, not a code change.
- **Windows support** across every surface except the tmux-backed TUI
  ([ADR-0010](docs/adr/0010-windows-support.md)).
- Deep-interview planning modes: `grill-me`, PRD drafting, TDD augmentation,
  review and verify.

[0.4.5]: https://github.com/ordewell/ordewell/releases/tag/v0.4.5
[0.4.4]: https://github.com/ordewell/ordewell/releases/tag/v0.4.4
[0.4.3]: https://github.com/ordewell/ordewell/releases/tag/v0.4.3
[0.4.2]: https://github.com/ordewell/ordewell/releases/tag/v0.4.2
[0.4.0]: https://github.com/ordewell/ordewell/releases/tag/v0.4.0
