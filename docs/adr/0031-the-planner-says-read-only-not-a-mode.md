# 0031 — The planner says read-only, not a mode

**Status:** accepted — amends [ADR-0001](0001-autonomous-mode-resolution.md)

**Amends:** ADR-0001 — the planner no longer picks a runner mode per task; it
says only whether a task is read-only. "The planner is steered, not coerced",
its portfolio judgment, and the Guarded ceiling on its edits go. What stays:
the mode is fixed when the task is planned, never at spawn; the user's
per-task choice wins at every level.

## Context

ADR-0001 has the planner choose each task's mode from the runner's list,
steered towards the level's mode and checked after. In use, nearly every mode
bug came from that choice:

- A task the planner added landed on the generic `build`, which Claude Code
  runs as `acceptEdits` whatever the level.
- A task moved to another runner kept a mode that runner does not have.
- Merges and splits carried modes no check had seen.
- Under Guarded, an edit could still name a mode only Full allows; a whole
  plan had it swapped silently, so the planner believed its mode stood.
- The planner misread runner-specific names: twice in one session it took
  OpenCode's `build` for Claude's `bypassPermissions`.

Each fix added a rule the planner had to be held to. Meanwhile the user thinks
in two settings, Full and Guarded, and the planner's other picks — Claude's
`acceptEdits` or `default` over the level's mode — were rare and rarely wanted.

One per-task choice is real: a review, an audit or an analysis that must not
change files. Each built-in runner has a mode built for it, `plan`.

## Decision

**The planner says whether an AI task is read-only. Ordewell turns that into
the task's mode when the task is planned: the runner's read-only mode, or else
the runner's mode for the user's level. The planner never names a mode. The
user still picks any mode per task by hand.**

### What the planner says

- **`readOnly: true`** on a task that must not change any file. Absent or
  `false` otherwise. It is the only mode-related field in the plan JSON,
  `submit_plan` and `edit_plan`.
- **`taskMode` is not the planner's.** In a submitted plan it is ignored, and
  `submit_plan` says so in its warnings. In an edit it is refused, with
  `readOnly` named as what to use instead.
- **The prompt and the catalog tools lose the mode lists.** `list_runners` and
  `task_query`'s catalog say which runners have a read-only mode; the plan
  block shows `read-only` on a read-only task and no mode otherwise.

### What Ordewell fills in

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
- **A merge is read-only only when every merged task was.** One task that
  writes makes the merged task write; its "current" mode is the first such
  task's.
- **A whole plan restated over an existing one** — a planner rewrite — says
  read-only or not for every task, so that answer stands. A task it names that
  was planned before and is not read-only now keeps its earlier mode when the
  runner offers it, as an edit would.

### Manifests

Manifests tag their read-only mode `readOnly: true`, beside `autonomous` and
`safe`. The built-in `plan` modes of Claude Code, Codex and OpenCode wear it.
Core still hardcodes no mode id: a runner with no tagged mode has no read-only
mode. The one exception is a plan parsed with no runner modes at all, where a
read-only task falls back to `plan`, as any other falls back to `build`: the
guess that keeps it from writing.

### What does not change

- **The mode is fixed at planning.** It is stored on the task as today; the
  orchestrator never replaces it at spawn. Switching Full and Guarded changes
  tasks planned after the switch, not tasks already in the plan. This keeps
  "what the plan says is what runs".
- **The per-task mode dropdown** on every surface, and the CLI's mode
  commands, keep every mode the runner offers. A user's choice is not checked
  against the level (ADR-0001). A user moving a read-only task to another
  runner lands it on that runner's read-only mode, found by tag, not by id.
- **Saved plans load as they are.** Their tasks already carry concrete modes,
  including modes the planner chose under the old rule. Nothing is migrated.

## Considered options

- **Rejected: the mode is decided when the task starts.** `/auto` would then
  reach tasks already planned, as ADR-0030's run settings do. The user chose
  the plan as the record of what runs: a plan read under Guarded would run
  under Full after a later switch.
- **Rejected: drop the per-task choice altogether.** Read-only work would
  either run with write access or need a separate task type.
- **Rejected: replace the dropdown with a read-only toggle.** It would take
  Claude's "Ask before edits" and "Edit automatically" away from the user for
  one task, and saved plans with those modes would need converting.
- **Rejected: keep the planner's mode choice and keep adding checks.** Each
  check closed one path; the planner's misreadings of runner-specific names
  stayed.
- **Rejected: map a planner's `taskMode: "plan"` to read-only.** A second way
  to say the same thing, and the one the planner was getting wrong.
- **Rejected: a read-only task on a runner without a read-only mode falls back
  to the level's mode.** The task would run with write access the planner
  said it must not have.

## Consequences

- `ModeResolver` loses `buildModeGuide`, `filteredBuildModes` and
  `resolveTaskMode`, and gains the table above as one function; the edit path
  and the plan parser both call it. The Guarded ceiling on planner edits goes:
  the planner can no longer name a mode for it to refuse.
- The plan block, `list_runners`, the catalog read and `edit_plan`'s
  summaries show `read-only` and which runners take it, never a
  mode name. The approval card a Guarded user
  answers still names the mode: it is for the user.
- `submit_plan`'s silent swap is gone with `resolveTaskMode`, so its
  `coerced` list no longer misses mode changes: there are none to report.
- The planner can no longer ask for "Ask before edits" on a task it thinks
  risky. A user who wants that picks it by hand.
- Under Full, every task the planner writes runs on the runner's autonomous
  mode unless it is read-only. That was ADR-0001's default already; it is now
  the only outcome.
- A third-party manifest without a `readOnly` tag cannot take read-only
  tasks from the planner until it adds one.

## History

- 2026-10-12 — accepted.
- 2026-10-12 — subtasks inherit read-only; a manual task cannot be read-only;
  a user's runner change keeps read-only by tag;
  the no-modes fallback is named.
- 2026-10-13 — the modify-plan prompt left the list of what shows `read-only`
  (the one-shot modify path is gone); `submit_plan` reports `readOnly` on a
  manual task as ignored, as it does `taskMode`.
