---
status: accepted
---

# 0038 — A runner install verdict is not permanent

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

## Decision

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

## Key properties

- A runner installed while the daemon or the extension host runs is offered
  after a refresh, without a restart.
- The install probe and the Codex sandbox probe now answer to the same policy:
  one probe per process, asked again on a runner-list refresh.
- A refresh never costs a spawn for a runner that is already known to be
  installed.

## Considered options

- **Leave it; restart to see a new install.** Rejected: a user who installs a
  runner and clicks refresh expects to see it, and the code already said so.
- **Re-probe every runner on every refresh.** Rejected: a process spawn per
  installed runner on each refresh, for an answer that cannot have changed.
- **Expire installed verdicts too.** Rejected: there is no staleness to fix, and
  it would re-probe a present binary on every window.
- **Watch the filesystem for new binaries.** Rejected: over-engineered for this;
  the refresh the surfaces already have is the trigger.

## History

- 2026-10-17 — accepted and implemented.
