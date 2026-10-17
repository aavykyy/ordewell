---
status: accepted
amends: ["0009"]
folds:
  - "0039 — The detected planner is derived again on a runner-list refresh"
---

# 0038 — A runner install verdict is not permanent, and a refresh derives the detected planner again

## Problem

`RunnerInstallation` decides which runners are on this machine by running
`<command> --version` ([ADR-0009](../planner/0009-coding-agents-as-planners.md)). The
verdict was cached per process and never revisited, and nothing could revisit
it: the daemon and the VS Code extension injected only `filterInstalled` and
`plannerUsability`, `RunnerInstallation.clear()` was never called, and the one
refresh surface — the runner list — asked only the Codex sandbox again.

So a CLI installed while a host was running stayed invisible until a restart.
Both the pool and `InstalledPlanner` carried comments promising the opposite
("the cached answer is asked afresh", "an agent installed later joins on the
next probe"); the sandbox probe already honoured that policy
([ADR-0033](../planner-envelope/0033-codex-planner-without-its-sandbox.md)), and the install probe
did not.

The detected planner had the same flaw. ADR-0009's keyless first run picks the
first installed coding agent as the planner when the user has chosen no planner
and holds no vendor key. The probe ran once per host — daemon start
(`packages/web/server/main.ts`) or extension activation
(`ExtensionHost.start`) — and its answer lived in two module globals
(`recorded`, `installedAgents`).

The runner-list refresh already asked the host again for the Codex sandbox
([ADR-0033](../planner-envelope/0033-codex-planner-without-its-sandbox.md)) and,
once install verdicts expire (below), for the install verdicts — but not for the
agent detection. So a CLI installed while a host ran became *selectable* yet
never became the *default*: the planner pills still said "no key", and the
auto-enabled runner set stayed the startup one, until a restart or a window
reload. It bit the long-lived hosts — a VS Code window left open, or a shared
daemon — and not the TUI, which starts a fresh daemon each launch.

## Decision

### Install verdicts expire (ADR-0038)

**A "not installed" verdict is not permanent. It expires after a short window,
and a runner-list refresh forgets it at once so the next probe re-runs it. An
"installed" verdict is kept for the process.**

- **Only the miss goes stale.** A missing CLI is the verdict that changes while
  a host runs — the user installs it and expects the next look to see it. An
  installed one cannot change without the binary going away, and a CLI that
  disappears fails its spawn with the real error, which this shallow probe is
  not trying to predict.
- **The refresh is the trigger; the TTL is the backstop.** `getInstalledRunners`
  (daemon) and `ModelDiscovery.push` (VS Code) call `RunnerInstallation.refresh()`
  where they already refresh the sandbox probe, so `ordewell runners` and a
  webview refresh notice a just-installed CLI. The expiry covers the paths with
  no refresh, such as opening the planner picker.
- **No extra spawn for a present binary.** A refresh re-probes only the misses;
  a runner already found installed stays cached.

### The detected planner is derived again on a refresh (ADR-0039)

**A runner-list refresh derives the detected planner again, the same trigger
that already re-probes the Codex sandbox and the install verdicts.**

- **Both refresh paths do it.** The daemon's `getInstalledRunners` (GET
  `/api/runners`) and the extension's `ModelDiscovery.push` re-run
  `detectInstalledPlanner` before they read the enabled set.
- **It cannot demote.** Within a process the installed set only grows — an
  installed verdict is kept for the process, above — so re-deriving can only
  move the fallback toward an agent that is actually installed, in list order.
- **Only the fallback moves.** A saved runner choice or a vendor key still wins,
  exactly as before; nothing else is derived here.
- **Still not per turn.** A planning turn reads the derived answer; it does not
  re-probe. The property ADR-0009 guards — one probe, not one per turn — holds.

## Key properties

- A runner installed while the daemon or the extension host runs is offered
  after a refresh, without a restart.
- The install probe and the Codex sandbox probe now answer to the same policy:
  one probe per process, asked again on a runner-list refresh.
- A refresh never costs a spawn for a runner that is already known to be
  installed.
- Installing an agent while a daemon or a VS Code window runs makes it the
  planner default after a refresh, with no restart.
- The refresh surfaces are the ones a user already has: the runner list
  (`ordewell runners`, the webview toggle panel) and a webview opening.
- The probe stays cheap: cached positives cost no spawn, so a healthy host
  re-derives for free and only a genuinely missing agent is re-checked.

## Considered options

- **Leave it; restart to see a new install.** Rejected: a user who installs a
  runner and clicks refresh expects to see it, and the code already said so.
- **Re-probe every runner on every refresh.** Rejected: a process spawn per
  installed runner on each refresh, for an answer that cannot have changed.
- **Expire installed verdicts too.** Rejected: there is no staleness to fix, and
  it would re-probe a present binary on every window.
- **Watch the filesystem for new binaries.** Rejected: over-engineered for this;
  the refresh the surfaces already have is the trigger.
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

- 2026-10-17 — accepted and implemented: a "not installed" verdict expires and a
  runner-list refresh forgets it.
- 2026-10-17 — accepted and implemented: a refresh derives the detected planner
  again (ADR-0039, folded into this ADR).
