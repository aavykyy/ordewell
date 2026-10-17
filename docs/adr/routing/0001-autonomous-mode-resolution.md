---
status: accepted
folds:
  - "0031 — The planner says read-only, not a mode"
---

# 0001 — Autonomous mode resolution: the level picks the mode, the planner says only read-only

## Problem

Generating a plan means picking a runner mode per task — Claude's
`default`/`acceptEdits`/`auto`/`bypassPermissions`, OpenCode's `build`/`plan`, Codex's
own set. Three things made that hard to just ask the planner to do:

- Mode names are runner-specific, and the conventions disagree. OpenCode has no
  mode safer than `build`; Codex differs again.
- The planner was observed defaulting to the least autonomous mode
  (`default`/"ask before edits"). Reading the prompt afterwards, the cause was
  plain: the mode list anchored on whatever came first, and the autonomous
  mode's own description ("use only when you don't need supervision") was
  scaring it off.
- We did not want a global toggle that silently rewrites plans after the fact.
  What the plan says is what runs, or the plan stops being worth reviewing.

## Decision

Mode resolution is **decided at planning, never runtime-overridden**, driven by **manifest tags** (`autonomous` / `safe` / `readOnly`), the planner's one per-task answer — **read-only or not** — and a **global user setting with two named levels**, *Full* and *Guarded*.

Concretely:

- **The plan is the source of truth.** The level is read only when a task is
  planned — a generated plan or a planner edit; the orchestrator never replaces
  `task.taskMode` at spawn. A user who changes the level after generating sees
  no change to planned tasks until they regenerate. That
  is deliberate — it is the same rule `/model set` follows.
- **Two levels, one boolean.** The setting is a boolean (`autonomousMode`,
  `autonomousDefault`, TUI `autonomous`, VS Code `ordewell.autonomousMode`,
  default on). **Full** is on: each runner's `autonomous`-tagged mode.
  **Guarded** is off: each runner's `safe`-tagged mode. `/auto full` and
  `/auto guarded` select them (`ordewell auto full|guarded` likewise); `on`, `off`
  and `auto` stay as aliases, and a bare `/auto` in the TUI reports the current level
  instead of flipping it.
  *Amended by [ADR-0030](../supervision/0030-global-run-settings.md):* the level is saved
  machine-wide in `settings.json`, not in `~/.ordewell/.env` or VS Code's
  `ordewell.autonomousMode`, which is removed; existing values are copied over
  once, and `ORDEWELL_AUTONOMOUS_MODE` stays as an override Ordewell never
  writes. Still read at generation, never at spawn.
- **Manifests declare what autonomy means for that runner.** Core never
  hardcodes mode IDs. Each manifest tags one mode `autonomous: true` and one
  `safe: true`, and its read-only mode, if it has one, `readOnly: true` (the
  built-in `plan` modes):
  - **Claude Code:** `bypassPermissions` ("Bypass permissions") is
    `autonomous`; `auto` (`--permission-mode auto`, where Claude's own
    classifier approves or blocks each action) is `safe`. `default` ("Ask
    before edits") stays selectable with no level tag, so it is offered under
    both. Claude Code still accepts `--permission-mode default` although it no
    longer lists it.
  - **Codex:** `fullAccess` (`danger-full-access`, approvals `never`) is
    `autonomous`; `agent` (the workspace-write sandbox, approval policy
    `on-request`, `approvals_reviewer=auto_review` — Codex's risk-assessing
    subagent) is `safe`. The manifest expresses both per mode in
    `features.modeSettings` (`approvalPolicy`, `approvalsReviewer`). The
    Codex connector supplies these to `thread/start` and `thread/resume`;
    terminal invocation flags are not part of the manifest.
  - **OpenCode:** `build` wears both tags — an honest no-op, since OpenCode has
    nothing safer than build, rather than a mystery.
- **The planner says read-only, not a mode** (detailed below). It marks a task
  `readOnly: true` when it must not change files, and names no mode. Ordewell
  fills the mode in when the task is planned: the runner's `readOnly` mode, or
  the runner's mode for the level. A planner edit that asks for no change
  keeps the task's mode when its runner offers it, so a mode the user picked
  survives. A read-only task on a runner with no read-only mode is refused.
- **Manual per-task override in the UI wins at every level.** The dropdown
  offers every mode the runner has, and the user's own edits are not checked
  against the level.

### The planner says read-only, not a mode (ADR-0031)

**The planner says whether an AI task is read-only. Ordewell turns that into
the task's mode when the task is planned: the runner's read-only mode, or else
the runner's mode for the user's level. The planner never names a mode. The
user still picks any mode per task by hand.**

One per-task choice is real: a review, an audit or an analysis that must not
change files. Each built-in runner has a mode built for it, `plan`.

#### What the planner says

- **`readOnly: true`** on a task that must not change any file. Absent or
  `false` otherwise. A task that must run commands — tests, scripts, builds —
  is not read-only even when it changes no file: the read-only modes refuse
  them, and the planner is told so. It is the only mode-related field in the plan JSON,
  `submit_plan` and `edit_plan`.
- **`taskMode` is not the planner's.** In a submitted plan it is ignored, and
  `submit_plan` says so in its warnings. In an edit it is refused, with
  `readOnly` named as what to use instead.
- **The prompt and the catalog tools lose the mode lists.** `list_runners` and
  `task_query`'s catalog say which runners have a read-only mode; the plan
  block shows `read-only` on a read-only task and no mode otherwise.

#### What Ordewell fills in

When a task is planned — a submitted plan, or a planner edit that adds,
updates, merges, splits or re-arms one:

| the planner says | the task's runner | the task gets |
|---|---|---|
| `readOnly: true` | has a read-only mode | that mode |
| `readOnly: true` | has none | refused, naming runners that have one |
| `readOnly: false` | — | its current mode if the runner has it and it is not read-only, else the level's mode |
| nothing | — | its current mode if the runner has it, else the level's mode |

"Current" is the mode a task already has. A new task has none, so it gets the
level's mode or the read-only one. A user's hand-picked mode therefore
survives a planner edit that does not ask for a change, and a move to a runner
that offers the same mode.

- **An edit is a change, so silence keeps what is.** An update or re-arm
  works the mode out again only when it says `readOnly`, moves the task to
  another runner, or turns a manual task into an AI one. A read-only task stays
  read-only through a move or a split unless the planner says
  `readOnly: false`: a move must not hand it write access quietly, and a move
  to a runner without a read-only mode is refused.
- **Subtasks inherit read-only.** A subtask runs as a task of its own, so a
  read-only task's AI subtasks are read-only too, in a submitted plan or an
  added task, unless a subtask says `readOnly: false`.
- **A manual task cannot be read-only.** It runs in no mode. A submitted plan
  ignores the mark on one and `submit_plan` says so in its warnings; an edit
  that asks for it is refused.
- **An ops task cannot be read-only.** It runs commands in the session's mode
  ([ADR-0020](../isolation/0020-ops-tasks-and-merge-gates.md)), and a read-only mode
  refuses them: Claude Code under `plan` declined to run the one command an
  ops task existed for. A submitted plan ignores the mark on one and
  `submit_plan` says so in its warnings; an edit that asks for it, or turns a
  read-only task into an ops task without `readOnly: false`, is refused.
- **A merge is read-only only when every merged task was.** One task that
  writes makes the merged task write; its "current" mode is the first such
  task's.
- **A whole plan restated over an existing one** — a planner rewrite — says
  read-only or not for every task, so that answer stands. A task it names that
  was planned before and is not read-only now keeps its earlier mode when the
  runner offers it, as an edit would.

#### Manifests

A runner with no `readOnly`-tagged mode has no read-only mode. The one exception
is a plan parsed with no runner modes at all, where a read-only task falls back
to `plan`, as any other falls back to `build`: the guess that keeps it from
writing.

#### The user's choice and saved plans

- **The per-task mode dropdown** on every surface, and the CLI's mode commands,
  keep every mode the runner offers. A user moving a read-only task to another
  runner lands it on that runner's read-only mode, found by tag, not by id.
- **Saved plans load as they are.** Their tasks already carry concrete modes,
  including modes the planner chose under the old rule. Nothing is migrated.

## Considered options

- **The planner picks each task's mode, steered and checked.** It was the
  design until ADR-0031: the prompt listed the level's modes with the default
  first, the parser swapped an invalid or opposite-level mode, and the
  planner's edits were refused a mode only Full allows under Guarded. Dropped:
  nearly every mode bug came from it, and each fix added a rule the planner had
  to be held to while its misreadings of runner-specific names stayed:
  - A task the planner added landed on the generic `build`, which Claude Code
    runs as `acceptEdits` whatever the level.
  - A task moved to another runner kept a mode that runner does not have.
  - Merges and splits carried modes no check had seen.
  - Under Guarded, an edit could still name a mode only Full allows; a whole
    plan had it swapped silently, so the planner believed its mode stood.
  - The planner misread runner-specific names: twice in one session it took
    OpenCode's `build` for Claude's `bypassPermissions`.

  Meanwhile the user thinks in two settings, Full and Guarded, and the planner's
  other picks — Claude's `acceptEdits` or `default` over the level's mode — were
  rare and rarely wanted. The portfolio judgment it kept was rarely used.
- **The mode is decided when the task starts.** Rejected: `/auto` would then
  reach tasks already planned, as ADR-0030's run settings do. The user chose
  the plan as the record of what runs: a plan read under Guarded would run
  under Full after a later switch.
- **Dropping the per-task choice altogether.** Read-only work would either run
  with write access or need a separate task type.
- **Replacing the dropdown with a read-only toggle.** It would take Claude's
  "Ask before edits" and "Edit automatically" away from the user for one task,
  and saved plans with those modes would need converting.
- **Mapping a planner's `taskMode: "plan"` to read-only.** A second way to say
  the same thing, and the one the planner was getting wrong.
- **A read-only task on a runner without a read-only mode falls back to the
  level's mode.** The task would run with write access the planner said it must
  not have.
- **Runtime override** — the setting rewrites modes at spawn, including on
  already-generated plans. Rejected: it makes "what the plan says" differ from
  "what runs", which is the exact silent state this project refuses to create.
  It also erases the planner's per-task judgment.
- **Hard parser override** — the setting forces every non-plan AI task to the
  autonomous mode at parse time, ignoring what the planner emitted. Rejected
  for the same reason plus a concrete artifact: the plan JSON would show a mode
  the planner did not emit, with no signal why.
- **Per-runner toggle** (`ordewell.autonomousByRunner`). Rejected: manifest
  tags already absorb runner heterogeneity; a per-runner map adds state and UI
  for a marginal case, and one-off overrides already exist as the per-task
  dropdown.
- **Positional safe fallback** — with the setting off, resolve to the
  first-listed manifest mode. Rejected: reordering a manifest would silently
  change that behavior.
- **Parser rewrites `plan`** — when off, map `plan`→`build` for OpenCode.
  Rejected twice over: it makes the task *more* permissive, the opposite of
  what off means; and dropping `plan` from manifests entirely would break
  saved plans.
- **Remove `plan` mode as a product decision** — analysis can happen in the
  other modes. Rejected: a review or audit that must not change files is a
  real need, and `plan` is the mode built for it.
- **Claude's `default` as the `safe` mode.** It was, until the two levels were
  named. Rejected then: a level whose every action waits for a person is not
  "auto"; Claude's `auto` mode trades the prompt for its own classifier, which
  is what the level means. `default` stays one pick away.
- **"Auto mode" as the label of `bypassPermissions`.** It was. Rejected: it
  collided with Claude's real `auto` mode.

## Consequences

- The level is generation-time only. Already stated above; worth repeating
  because it is the property users ask about.
- Manifest authors must tag at least one mode `autonomous` and one `safe`, or
  the level's mode falls back to the last non-`plan` mode. A runner without a
  `readOnly` mode takes no read-only task from the planner. The builtin
  manifests tag all three.
- OpenCode resolves to `build` at either level. The setting is effectively a
  no-op for OpenCode-only plans. Correct, not a bug: there is nothing for it to
  switch between.
- "Guarded" is not the least-privileged choice on every runner: it trades a prompt
  for a reviewer's judgement. A person who wants every action to wait for them
  picks `default` (Claude) by hand, which no level selects.
- `bypassPermissions`' manifest description no longer carries the "use only in
  sandboxed/CI environments" caveat. That caveat is what anchored the planner
  away from autonomous modes in the first place — a self-inflicted bug caused
  by our own copy. Manifest descriptions are prompt material, not core logic;
  editing them does not violate the no-hardcoded-modes rule.
- The planner cannot ask for a mode between read-only and the level's, such
  as Claude's "Ask before edits". The user picks it by hand.
- The level decides the planner's tasks; it never overrides a human's
  explicit choice.
- `ModeResolver` loses `buildModeGuide`, `filteredBuildModes` and
  `resolveTaskMode`, and gains the fill-in table above as one function; the edit
  path and the plan parser both call it. The Guarded ceiling on planner edits
  goes: the planner can no longer name a mode for it to refuse.
- The plan block, `list_runners`, the catalog read and `edit_plan`'s
  summaries show `read-only` and which runners take it, never a
  mode name. The approval card a Guarded user
  answers still names the mode: it is for the user.
- `submit_plan`'s silent swap is gone with `resolveTaskMode`, so its
  `coerced` list no longer misses mode changes: there are none to report.
- Under Full, every task the planner writes runs on the runner's autonomous
  mode unless it is read-only. That was the default already; it is now the only
  outcome.

## History

- 2026-07-31 — accepted: one on/off toggle, `/auto`.
- 2026-10-01 — the two states named *Full auto* and *Auto*; Claude's `safe` mode
  moved from `default` to `auto`, Codex's `safe` mode gained the auto reviewer.
- 2026-10-05 — the levels renamed *Full* and *Guarded*: *Auto* collided with Claude
  Code's own `auto` permission mode (`/auto auto`), and *Guarded* holds on every
  runner, where a classifier does not. `auto` stays an alias of Guarded.
- 2026-10-09 — aligned with [ADR-0025](../runners/0025-structured-only-runners.md).
- 2026-10-12 — the level is saved in the global `settings.json` ([ADR-0030](../supervision/0030-global-run-settings.md)).
- 2026-10-12 — the planner's edits get the level's mode when they name none, and Guarded refuses a mode only Full allows.
- 2026-10-12 — the planner says read-only instead of naming a mode (ADR-0031).
- 2026-10-12 — subtasks inherit read-only; a manual task cannot be read-only; a
  user's runner change keeps read-only by tag; the no-modes fallback is named
  (ADR-0031).
- 2026-10-13 — the modify-plan prompt left the list of what shows `read-only`
  (the one-shot modify path is gone); `submit_plan` reports `readOnly` on a
  manual task as ignored, as it does `taskMode` (ADR-0031).
- 2026-10-14 — an ops task cannot be read-only, and the planner is told a task
  that runs commands is not read-only; both found in a live run (ADR-0031).
- 2026-10-17 — ADR-0031 folded in as *The planner says read-only, not a mode*.
