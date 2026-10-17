# 0001 — Autonomous mode resolution

**Status:** accepted — amended by [ADR-0030](../supervision/0030-global-run-settings.md) (where the level is saved)
and [ADR-0031](0031-the-planner-says-read-only-not-a-mode.md) (the planner says read-only, not a mode)

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
- **The planner says read-only, not a mode**
  ([ADR-0031](0031-the-planner-says-read-only-not-a-mode.md)). It marks a task
  `readOnly: true` when it must not change files, and names no mode. Ordewell
  fills the mode in when the task is planned: the runner's `readOnly` mode, or
  the runner's mode for the level. A planner edit that asks for no change
  keeps the task's mode when its runner offers it, so a mode the user picked
  survives. A read-only task on a runner with no read-only mode is refused.
- **Manual per-task override in the UI wins at every level.** The dropdown
  offers every mode the runner has, and the user's own edits are not checked
  against the level.

## Considered options

- **The planner picks each task's mode, steered and checked.** It was the
  design until ADR-0031: the prompt listed the level's modes with the default
  first, the parser swapped an invalid or opposite-level mode, and the
  planner's edits were refused a mode only Full allows under Guarded. Dropped:
  nearly every mode bug came from it — added tasks on the generic `build`,
  modes carried to runners without them, unchecked merges and splits, a swap
  the planner never heard about — and the planner misread runner-specific mode
  names. The portfolio judgment it kept was rarely used.

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
- 2026-10-12 — the planner says read-only instead of naming a mode ([ADR-0031](0031-the-planner-says-read-only-not-a-mode.md)).
