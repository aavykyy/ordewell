---
status: accepted
---

# 0051 — OpenCode Go limits come from the selected login, read in place

## Problem

The planner footer and a task log draw each runner's *Account limits*. Codex
and Claude Code report theirs over their own account protocols, on a process
that is started for the read and asks nothing of a model. OpenCode has no such
operation: its v2 API lists integrations, providers and every stored secret,
but no Go quota, and starting it to read one runs its provider plugins, which
refresh a Console sign-in close to expiry and write the result back. OpenCode's
services answer a Go quota over HTTP, to the credential that pays for the
Go models. So Ordewell either holds that credential for the length of one
request or shows nothing. Reading it means reading another tool's secret
store, which is a security boundary and needs a decision on record.

## Decision

**The host reads the one login OpenCode would pay for a Go model
with, from OpenCode's own store and nowhere else, and sends it only to
OpenCode's fixed quota addresses.** No OpenCode process is started, no model
is called, and nothing is refreshed, written, copied or kept beyond the read.

- **Which login (G1).** The one OpenCode itself selects for the `opencode-go`
  provider. A Console login (integration `opencode`) wins, because OpenCode
  rebinds a Console-configured provider to it; only without one does the
  `opencode-go` integration's key serve. Within an integration it is the
  connection OpenCode's own switch ranks first: active, then newest. Two
  connections both marked active name no one login, and nothing is read. v1's
  `auth.json` (or `OPENCODE_AUTH_CONTENT`) is read only when there is no v2
  store, and only its exact `opencode-go` entry. After a refusal there is no
  fallback to another login, workspace or organization.
- **Where it is (G2).** OpenCode's data directory as it resolves it
  (`$XDG_DATA_HOME/opencode`, or the XDG default under home), its database
  `OPENCODE_DB` or `opencode.db`, under the workspace's environment as an
  OpenCode task would see it (ADR-0016).
- **How it is read (G3).** Through the runtime's own `node:sqlite`, in a
  worker thread so a slow disk or a writer's lock never stalls the
  host, with a deadline. The worker opens the store read-only (immutable for a
  WAL store that no writer has open, so no WAL files are created beside it),
  ranks connections on their ids alone, and reads the value of the selected
  row only. It runs no migration and no write. The read is repeated only when
  the store's files change. A runtime without `node:sqlite`, or with a Node before
  22.16 (VS Code 1.90 runs Node 20), reads a v2 store as unsupported, and never
  falls back past it to `auth.json`.
- **What is accepted (G4).** A Console OAuth sign-in to the official Console,
  or a key. An external login, a sign-in to another Console server, an
  environment-only key and an in-memory store are unsupported. A sign-in within
  a minute of expiry is not sent; OpenCode refreshes it when it next runs.
- **Where it goes (G5).** A sign-in goes to
  `GET https://opencode.ai/console/api/go/status`, with `x-org-id` when the
  sign-in names an organization. A key goes to
  `GET https://opencode.ai/zen/go/v1/usage`. Both URLs are fixed: a login's own
  server, a provider's base URL and a redirect are never followed. Each request
  has a ten-second deadline, a 64 KiB answer bound, and is cancelled with the
  read.
- **What is shown (G6).** Three windows: five hours, the week and the plan
  month, the month worded `Monthly` with no fixed length. The Console's meters
  are allowance amounts, not spending, so only the ratio of each meter's used
  amount to its limit is shown. It is computed exactly from whole-number
  strings, and with no limit there is no share. The key route's percentages
  are shown as given. A reset that is not reported stays unknown.
- **Whose footer (G7).** The limits meter `opencode-go/…` models only. A task
  log draws them while the provider serving the task is `opencode-go`: the
  provider named by the latest attempt's own usage, under its current
  assignment, else the assigned model's. A task on Zen, a third party or no
  named model draws none. Browsing an older attempt keeps these live limits
  attached once, beside the existing attempt and task-total accounting. The
  planner footer draws only its currently selected harness's account, and Go
  only for a selected `opencode-go/…` model. A vendor API or unknown planner
  draws no account limits. Context comes first (`Planner ctx` for the planner,
  `ctx` for a task), then limits, then reported cost, in one compact row.
  The TUI truncates the row to the terminal width; it adds no details or wrap.
- **Refusals (G8).** 401 is signed out, 404 and the key route's
  `EntitlementError` are unsupported, and any other 403 is a denial that keeps
  nothing. 429 and 5xx keep the same login's last read, stale, and a
  `Retry-After` holds every read of that account until it passes. A throttled
  quota read is never an exhausted quota.

The VS Code extension host and the local daemon compose the same core
collectors and `AccountLimitMonitor`. The daemon owns one monitor per workspace
with connected session subscribers, binding every collector to that workspace's
environment. Sessions in that workspace share reads; another workspace shares
none of its login data. Connecting or reconnecting sends the latest snapshot,
including an initial empty one, over the existing session socket in a typed
host-owned frame with its own revision, independent of run snapshots. Model
usage invalidates at the monitor's normal pace. The last disconnect, session
replacement without another consumer, or daemon shutdown disposes the monitor
and aborts its reads; a late answer reaches no surface. No live quota data
enters saved plan state, a transcript or planner context.

## Testing decisions

The reader is tested against stores built in the test with OpenCode's own
`credential` schema and `auth.json` shape, through the real worker, with its
start counted. The collector is tested with an injected `fetch` that answers
the Console's and the key route's shapes. No test reads a real login or
reaches the network.

## Out of scope

- A pre-release build's own `opencode-<channel>.db` is found only through
  `OPENCODE_DB`: the channel is compiled into the binary, and asking the binary
  starts its runtime and logging.
- Whether a Console login serves Go is decided by the Console's config, which
  is not fetched; a Console login with no Go plan shows none, even beside a Go
  key OpenCode might then use.

## Considered options

- **Start OpenCode and ask it.** Rejected: there is no quota operation, and
  loading its providers refreshes and rewrites a Console sign-in.
- **`opencode auth export`, or the `credential` API.** Rejected: both fetch
  every stored secret before filtering.
- **Ship a SQLite library.** Rejected: a native module needs a VSIX per
  platform; a WASM one adds a large dependency to read one row.
- **Run `opencode debug paths db` to find the store.** Rejected: it starts the
  CLI runtime, which logs and may check for updates, on a path most installs
  resolve the same way.
- **Keys only, Console sign-ins unsupported.** The position until 2026-10-25,
  when one authorized read with a real sign-in answered the Console route for
  the member's organization. Dropped for that reason.

## Consequences

- A Go account's limits show in VS Code and the TUI without any OpenCode
  process running; the daemon acquires them for the TUI.
- The Console route is the one the Console's own page reads, not a published
  API. A shape it no longer matches reads as a failed read, never as zero.
- A host whose Node predates 22.16 shows no Go row for a v2 login: its
  snapshot is `unsupported`, which draws nothing.

## History

- 2026-10-25 — accepted.
- 2026-10-26 — the daemon supplies workspace-scoped live limits to the TUI, and planner footers follow the selected harness and model (G7).
