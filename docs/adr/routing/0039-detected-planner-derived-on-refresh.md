# 0039 — The detected planner is derived again on a runner-list refresh

**Status:** accepted — amends [ADR-0009](../planner/0009-coding-agents-as-planners.md)

## Problem

ADR-0009's keyless first run picks the first installed coding agent as the
planner when the user has chosen no planner and holds no vendor key. The probe
ran once per host — daemon start (`packages/web/server/main.ts`) or extension
activation (`ExtensionHost.start`) — and its answer lived in two module globals
(`recorded`, `installedAgents`).

The runner-list refresh already asked the host again for the Codex sandbox
([ADR-0033](../planner-envelope/0033-codex-planner-without-its-sandbox.md)) and, since
[ADR-0038](0038-runner-install-verdicts-expire.md), for the install verdicts —
but not for the agent detection. So a CLI installed while a host ran became
*selectable* yet never became the *default*: the planner pills still said "no
key", and the auto-enabled runner set stayed the startup one, until a restart
or a window reload. It bit the long-lived hosts — a VS Code window left open,
or a shared daemon — and not the TUI, which starts a fresh daemon each launch.

## Decision

**A runner-list refresh derives the detected planner again, the same trigger
that already re-probes the Codex sandbox and the install verdicts.**

- **Both refresh paths do it.** The daemon's `getInstalledRunners` (GET
  `/api/runners`) and the extension's `ModelDiscovery.push` re-run
  `detectInstalledPlanner` before they read the enabled set.
- **It cannot demote.** Within a process the installed set only grows —
  ADR-0038 keeps an installed verdict — so re-deriving can only move the
  fallback toward an agent that is actually installed, in list order.
- **Only the fallback moves.** A saved runner choice or a vendor key still wins,
  exactly as before; nothing else is derived here.
- **Still not per turn.** A planning turn reads the derived answer; it does not
  re-probe. The property ADR-0009 guards — one probe, not one per turn — holds.

## Key properties

- Installing an agent while a daemon or a VS Code window runs makes it the
  planner default after a refresh, with no restart.
- The refresh surfaces are the ones a user already has: the runner list
  (`ordewell runners`, the webview toggle panel) and a webview opening.
- The probe stays cheap: cached positives cost no spawn, so a healthy host
  re-derives for free and only a genuinely missing agent is re-checked.

## Considered options

- **Leave it; restart to pick up a new default.** Rejected: the refresh
  re-probes the sandbox and the installs but not the planner, so it re-asks the
  host everything except the one answer the keyless path depends on.
- **Re-probe on every planning turn.** Rejected, as before: spawns per turn,
  and it could move the planner under a live conversation. The refresh is the
  trigger.
- **Re-probe only while no agent was found.** Rejected: a needless special
  case. Re-deriving is safe because the set only grows and a saved choice or a
  key wins.

## History

- 2026-10-17 — accepted and implemented.
