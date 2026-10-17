# 0043 — A change of scope reaches the planner and flags tasks, and the enabled runners have one store

**Status:** accepted — extends [ADR-0003](0003-per-runner-model-allowlist.md) and [ADR-0022](0022-ordewell-mcp-server.md)

## Problem

The user decides which runners and models a plan may be built from: the enabled
runners and each runner's allowlist. They change it between turns, and two
things went wrong:

- **The planner kept planning from a picture that had moved.** It reads the
  catalog every turn (ADR-0003, C1), but nothing told it that a change had
  happened, so tasks already in the plan sat on a runner the user had switched
  off, or on a model they had taken off the list, and neither the planner nor
  the user was told.
- **Two surfaces kept two lists.** The terminal UI saved the enabled runners in
  the settings file; VS Code kept them in its own `enabledRunners` setting. A
  toggle in one did not reach the other, and a plan built in one surface used
  the list the other had not seen.

## Decision

**The planner is told on its next turn what changed in the user's scope, tasks
outside the new scope are flagged and still run as assigned, and the enabled
runners are saved in one place.**

### Runners changed

- The session remembers the scope the planner was last told
  (`AssignmentScope`: enabled runners, allowlists, and the models discovery
  found). On the next planner turn, if it reads differently (`scopeChange`), the
  context carries a `<runners_changed>` block: runners switched on and off, each
  allowlist's change, and the plan tasks the new scope no longer covers, with
  what happens to each. A model discovered in between is not read as the user
  changing the list.
- The block suggests, it does not instruct: it points to `list_runners` and
  `list_models` (or `<available_models>`) and says the planner may move the
  tasks or tell the user why it left them.
- A turn that fails or is stopped does not consume the note: the told scope is
  restored, so the next turn carries it again. The first turn of a conversation
  carries none; it already starts from the current catalog.

### Flag only

- A task on a runner that is switched off, or a model off its runner's
  allowlist, is **flagged** on every surface ("codex is switched off", "Opus 4
  is not in the allowlist"): VS Code's card badge, the TUI row, the planner's
  note. The runner being off settles the matter before its model is looked at.
- It **still runs as assigned**. The allowlist and the enabled runners shape
  what is planned, not what is started (ADR-0003, P1), and the plan is the
  source of truth (ADR-0001). Moving it is the user's or the planner's call. A
  completed or skipped task is history and is never flagged; a failed one is
  noted as one a retry would run on the old assignment.

### One store for the enabled runners

- The enabled runners are saved in the settings file (`enabledRunners`), which
  the terminal UI, the daemon and VS Code all read. VS Code's own
  `ordewell.enabledRunners` is retired: a list set there is copied once, unless
  the file already holds a choice, and the setting is cleared. An empty list is
  not copied: it was one window's "none", and as the file's choice it would
  empty the catalog of every surface on the machine.
- A change is made on the file as it is now (`updateEnabledRunners`), never on
  a copy read earlier, so a toggle in one surface does not undo another's. A
  save checks the file just before replacing it and redoes the change if
  another process saved first; the check and the swap are one step under a
  lock file beside it (`<file>.lock`, created exclusively, and taken over once
  stale, from a process that died holding it). Saves are written beside the
  file and renamed over it, and the file is watched, so a running surface
  picks up another's toggle.

## Key properties

- The planner learns of a change once, on the turn after it, and again only if
  that turn did not happen.
- Nothing is moved, blocked or refused because of a change of scope.
- A runner toggled in VS Code is toggled in the terminal UI and the daemon, and
  the reverse.

## Considered options

- **Tell the planner nothing; it reads the catalog anyway.** The catalog says
  what is allowed, not what changed, so it cannot tell that a task it wrote
  earlier is now outside.
- **Move or block flagged tasks automatically.** Rejected: it rewrites the plan
  at spawn time (ADR-0001), and a task the user assigned by hand on purpose
  would change under them.
- **Refuse to start a flagged task.** Rejected for the same reason: the
  allowlist is advice (ADR-0003, P1), and a runner switched off may still be
  installed and wanted for this task.
- **A block that instructs the planner to reassign.** Rejected: the user may
  want the task where it is.
- **Keep VS Code's setting and mirror it into the file.** Rejected: two writers
  with no owner; the one that wrote last would win.
- **Write the file whole after reading it earlier.** The earlier behaviour; a
  second process's change was undone.

## History

- 2026-10-17 — accepted and implemented: `<runners_changed>` on the planner's next turn, flags for tasks outside the scope, and the enabled runners in the shared settings file.
- 2026-10-17 — the stamp check and the swap are serialized across processes by a lock file; `ordewell status` flags tasks outside the scope too.
