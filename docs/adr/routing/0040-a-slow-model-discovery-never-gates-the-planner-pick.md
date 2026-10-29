---
status: accepted
amends: ["0009"]
---

# 0040 — A slow model discovery never gates the planner pick

## Problem

ADR-0009 picks a harness planner's model from the runner's discovered catalog:
`selectPlanner` restores the remembered model if the catalog still lists it and
falls back to the catalog's first entry otherwise. So a planner switch needs the
target backend's catalog, and `PlannerSelection.change` awaited it before it
wrote the configuration or pushed anything.

A catalog comes from a runner CLI, and some CLIs are slow to answer: `opencode
models` boots a background service first. Three things made that wait worse than
it had to be:

- **The pick sat dead.** The webview learns the new planner only from the host's
  planner-state push, which came after the discovery. The pill stayed on the old
  planner for the whole wait.
- **A failed answer was never remembered.** Only a non-empty catalog was cached.
  An empty or fallback-only result (no providers configured, a service that did
  not start) was re-run on every planner switch and every refresh.
- **The retry doubled the wait.** A discovery that came back empty ran its whole
  command list a second time, to give a cold CLI a warm second chance — even
  when the first pass failed fast and plainly (a rejected flag, a busy port),
  which a second pass cannot change.

Discovery was also in series (one cold runner held up every other runner's
catalog), and the planner pills — which need only the configuration and the
install probe — were pushed after the whole discovery loop.

## Decision

**The catalog is still the authority on the planner's model, but the planner
pick never waits on it to be shown, and a discovery that failed is not repeated
at once.**

- **The pick is shown at once and settled by the host.** The webview lights the
  clicked pill as pending. The host's next planner-state push — confirming,
  declining or reporting a failure — clears it. `selectPlanner` and the
  configuration write are unchanged: nothing is saved early, and the webview
  never decides. A host that fails a switch still pushes its state.
- **Pills first, catalogs after.** The extension pushes the planner pills
  before it discovers models, since they read the configuration and the install
  probe alone.
- **Runners are discovered together.** `ModelResolver.modelsForRunners` runs
  them concurrently, deduped, and `ModelDiscovery` shares one in-flight lookup
  per runner, so a switch and a refresh that overlap spawn the CLI once.
  `clear()` ends sharing, so a refresh never joins a lookup that began before it.
- **A degraded result is remembered briefly.** A fallback list or an empty one
  is kept for a short window (60 s), the same shape as
  [ADR-0038](0038-runner-install-verdicts-expire.md)'s negative install verdict.
  A runner-list refresh forgets it at once. A real catalog is cached as before.
- **Retry only a timeout.** The cold-start retry runs only when a command was
  killed by its own timeout — the server was still starting. A non-zero exit or
  an empty answer is an answer, and repeating it only doubles the wait.
- **The daemon waits only where the catalog decides.** A settings write waits
  for a catalog only when it switches planners with no model of its own, the
  one write `selectPlanner` judges by the incoming catalog. An explicit model,
  a key, an allowlist or a run setting lands at once, and so does an effort
  whose catalog is already held. A settings read waits only when the model it
  reports is one only the catalog can place. Planner writes land in the order
  they were made, so a pick made while a switch waits is applied after it.

## Key properties

- Clicking a planner pill moves the pill immediately, however slow the target
  CLI is; the model it lands on is still the one `selectPlanner` decides.
- A planner switch that fails or is declined does not leave a pill lit.
- A CLI that cannot list models is asked again after the window or a refresh,
  not on every switch.
- One cold runner no longer delays another's catalog, and two overlapping
  lookups never both start the same CLI.
- A settings change other than a planner switch never waits on a runner
  listing its models.

## Considered options

- **Leave the switch gated on discovery.** Rejected: the pick looked frozen for
  as long as the slowest CLI took, to compute a model the pill does not show.
- **Write the new provider first, resolve the model after.** Rejected: it saves
  a provider with the previous backend's model for a while, and a failure in
  between leaves that half-applied state. The host keeps one write, after the
  catalog is known.
- **Cache a failed discovery until a refresh.** Rejected: a transient failure
  (a cold start, a PATH not yet set) would then persist; the window bounds it.
- **Retry on every non-zero exit.** Rejected: a rejected flag or a busy port
  cannot heal on a retry, and it would double every lookup of a CLI whose first
  command always fails.
- **Let a later pick cancel a waiting switch.** Rejected: the client that sent
  the switch applies its answer when it arrives, so it would show the switch
  while the daemon plans with the pick. In order, the last one made wins on
  both.
- **A longer or exponential window.** Rejected: unmeasured, and a refresh already
  gives the user an immediate retry.

## History

- 2026-10-17 — accepted and implemented. OpenCode v2 dropped `models --verbose`
  (a fast non-zero exit); its manifest now asks `api model.list` second, which
  carries the same catalog with per-model variants, before the plain `models`.
- 2026-10-29 — the web daemon's settings routes wait for a catalog only where
  it decides the answer, and land planner writes in order.
