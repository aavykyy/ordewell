---
status: accepted
amends: ["0009", "0011", "0026"]
---

# 0033 — A Codex planner without its sandbox

## Problem

Codex's Linux sandbox is bubblewrap, which needs unprivileged user
namespaces. Ubuntu 23.10 and later restrict those through AppArmor
(`kernel.apparmor_restrict_unprivileged_userns=1`) and ship no `bwrap`
profile, so on a stock install every command Codex runs in its sandbox dies
with `bwrap: loopback: Failed RTM_NEWADDR`. The fallback ADR-0009 added,
`use_legacy_landlock`, no longer helps: codex-cli 0.162 panics there with
"filesystem-restricted execution requires bubblewrap".

ADR-0009 made both failing fatal for a planner, because a Codex that could
run no command answered from memory. That was written when Codex's shell was
its only way to read the workspace. Since ADR-0026 every planner also has
`run_command`, which runs in Ordewell's process, outside Codex's sandbox, under
ADR-0008's classifier. The Claude Code and OpenCode planners plan on that same
host with no OS sandbox under their commands: ADR-0011's sandbox is
bubblewrap there too, and cannot start either. Only Codex was refused, so on stock Ubuntu a user who picked Codex as
the planner got an error asking for `sudo`.

Codex's own TUI does not show the problem when the user's config is
`sandbox_mode = "danger-full-access"`: nothing is sandboxed there, so bwrap
never starts.

## Decision

**On a host where no Codex sandbox backend starts, a Codex planner starts
with Codex's own shell switched off, and reads through `run_command` alone. A
Codex task that needs a sandbox is still refused.**

- **The shell is off, not unsandboxed.** The thread gets
  `features.shell_tool = false` and `features.unified_exec = false`. The
  sandbox stays `read-only`, and file changes are still declined.
- **Nothing else can start a process.** Checked live on codex-cli 0.162.1:
  with both features off, the model and its subagents list no shell tool, and
  code mode's `exec` cannot import `node:fs` ("unsupported import in exec").
  The thread raised no command approval.
- **The instructions say so.** The planner's instructions say it has no shell
  of its own on this machine and must run every command, reads included,
  through `run_command`.
- **The user is told once.** A note at the start of the planner's first turn
  says Codex's sandbox could not start, that its own shell is off, and how to
  get it back: allow user namespaces, or install an AppArmor profile for
  bwrap. Codex's own bubblewrap `configWarning`, if it sends one, is dropped,
  since the note already covers it.
- **Only with Ordewell's tools.** The shell is switched off only when the
  planner has the Ordewell server. A planner without it would have no way to
  read, and is refused as before. In practice every harness planner has the
  server (ADR-0025).
- **Tasks are told, not surprised.** A task has no second shell, and
  switching its mode to Full access would rewrite the plan (ADR-0001). So the
  probe's answer goes into the runner catalog: each Codex mode the manifest
  tags `sandboxed` (`agent`, `plan`) carries an `unavailable` reason on this
  host, and Full access does not. The planner is not offered them: `list_runners`
  shows Codex without a read-only mode, a read-only task cannot be assigned to
  it (ADR-0031's refusal names the runners that can), and under Guarded a task
  on Codex is refused rather than moved to Full access. `submit_plan` and
  `edit_plan` refuse such a mode with the reason, as does a hand edit on any
  surface, and a task already holding one fails at spawn, before a worktree is
  made, with the same reason. The reason names the options: Full access,
  another runner, or fixing the host.
- **One probe per daemon, asked again on a runner-list refresh.** The answer
  is cached; refreshing the runner list (and a daemon restart) probes again,
  so a host fixed while Ordewell runs is noticed. The surfaces show one line,
  *Codex sandbox unavailable on this host: read-only and Guarded modes are
  off*, with a link to the troubleshooting page.
- **The probe's decision is unchanged.** macOS (Seatbelt) and Windows are never probed,
  and a working bubblewrap or Landlock backend keeps Codex's shell as before.

## Key properties

- A Codex planner on stock Ubuntu plans, under the same command rules as the
  Claude Code and OpenCode planners on the same host.
- No command runs with less containment than before: the commands Codex's
  sandbox would have refused now cannot start at all, and `run_command`
  commands are exactly as contained as they are for every planner.
- The planner is still read-only. The sandbox stays `read-only`, file changes
  are declined, and `run_command` keeps ADR-0008's classifier.
- The degraded state is visible: the note names what is missing and both
  fixes, and the runner list says which Codex modes are off.
- A task is never assigned a Codex mode the host cannot run, so the failure
  shows when the plan is made, not only when the task starts.

## Considered options

- **Keep refusing.** Rejected: it makes Codex unusable as a planner on the
  most common Linux desktop install, for a guarantee the other two planners
  do not have there either.
- **Plan with Codex in `danger-full-access`.** Rejected: its own shell would
  run outside both its sandbox and ADR-0008's classifier.
- **Fix the host from Ordewell** (ship an AppArmor profile, or set the sysctl).
  Rejected: both need root, and they change the machine, not Ordewell. The
  note names them for the user to choose.
- **Fall back to another planner runner.** Rejected: the user chose Codex,
  and a silent switch would change which model plans.
- **Turn the shell off on every host, so Codex always reads through
  `run_command`.** Not now: on a host where Codex's sandbox works, its own
  read-only shell is as contained as `run_command` in ADR-0011's sandbox, and
  it is the shell Codex is built around.
- **Hide the sandboxed modes instead of listing them as unavailable.**
  Rejected: a user would not learn why Codex offers only Full access, and a
  saved plan's task would fail with a generic "no such mode".
- **Fall back to Full access for a Guarded task on Codex.** Rejected: it
  hands a task access nobody chose (ADR-0001).

## History

- 2026-10-13 — accepted and implemented. Checked live on codex-cli 0.162.1,
  kernel 7.0 with `apparmor_restrict_unprivileged_userns=1`, where both
  sandbox probes fail: a raw app-server thread with both features off listed
  no shell tool in the planner or its subagent; Ordewell's own Codex planner
  ran `cat MARKER.txt` through `run_command`, answered with the file's word
  and showed the note once; and `plannerToolsLive` passed for Codex without
  its sandbox-probe stub, which is removed.
- 2026-10-13 — the probe is launched in its own process group and killed, group and all, when it times out, instead of being left running.
- 2026-10-14 — Codex's sandboxed modes are marked unavailable in the catalog while the probe fails, so they are not assigned and a task holding one fails at spawn with the reason.
- 2026-10-20 — ADR-0011's sandbox runs `run_command` where the host has one; on a host where Codex's sandbox cannot start, it cannot start either.
