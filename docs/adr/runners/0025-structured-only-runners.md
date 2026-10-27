---
status: accepted
supersedes: ["0007"]
folds:
  - "0007 — Runners execute inside tmux, terminals open on demand"
---

# 0025 — Structured-only runners

## Problem

Terminal fallback made every runner feature carry two contracts: protocol events
and messages, or scraped screens and injected keystrokes. Completion and
checkpoint markers also allowed a broken MCP attachment to go unnoticed. All
three built-in runners now have structured connectors, and the offline pipeline
and VS Code integration harnesses exercise them with a fake `claude` executable
on PATH. Keeping the obsolete path no longer serves a supported runner.

## Decision

**Ordewell drives runners only through structured connectors: `claude-code`,
`codex` and `opencode`. Ordewell's MCP tools must be connected for every
coding-agent session, both task runners and coding-agent planners.**

- Check the runner's MCP attach state after spawn, and a coding-agent planner's
  again before every turn. If attachment fails, dispose the process and its
  token and respawn once with a fresh token; a planner respawn resumes the
  conversation from its native session id. A task whose runner stays alive and
  still reports `pending` is held with that reason after the wait's generous
  cap, not failed, so its dependents stay on the plan; a runner that reports the
  server `failed` still fails the task. A coding-agent planner turn fails
  either way, and a planner that cannot be re-attached fails its turn without
  the prompt being sent. Never send the prompt without tools.
- Completion evidence is only a `task_complete` call bound to the attempt's
  token. `VerdictEngine` checks the current generation; only `done` passes.
  `blocked` and `failed` end without a pass and carry a reason. A process exit,
  even with code zero, cannot imply completion. Manual Mark complete remains
  the user's explicit override.
- Checkpoints use only `checkpoint({question})`; the call remains open until
  answered or withdrawn. No completion or checkpoint text markers are parsed.
- `IRunner` and `IRunnerSession` are the single runner contracts. Events,
  messages, interrupt, approvals, native session id and task tools are mandatory
  session methods. Mid-turn steering remains an optional adapter feature;
  an adapter without it uses the turn-end queue (ADR-0023).
- Remove terminal transport, PTY/tmux machinery, plugin runners and their
  install/list commands. Built-in manifests hold identity, command, discovery
  and mode settings; terminal-only invocation fields are absent. Leftover
  manifests in `~/.ordewell/plugins/` are ignored, with one notice at host
  startup. No unknown runner is silently routed to a terminal.
- Task logs are the inspection surface: Enter on a task in the TUI's plan pane,
  and Open chat in VS Code (once an attempt has started). `ordewell terminal`, `/terminal`, `t` and
  Structured/Terminal badges are removed. tmux is not required.

API planners keep their existing validated JSON plan, edit and query envelopes;
these are not completion-marker fallbacks. This decision does not widen the
planner exploration envelope (ADR-0008).

## Key properties

Two rules hold for every transport, and other ADRs rely on them. ADR-0013 and
ADR-0014 cited ADR-0007 (folded in under *Considered options*) for them; D2 is
its rule T7:

- **A runner is handed a `cwd` and nothing more (D1).** Git never enters
  `IRunner`, `RunnerRegistry` or a runner adapter: isolation prepares a
  directory ([ADR-0013](../isolation/0013-worktree-isolation.md)) and
  `IRunner.spawn` takes it as `cwd`.
- **Task ids are scoped by plan session (D2).** Task ids are only unique within
  one plan — every planner names its first task `task-1` — and one daemon serves
  many plans through one shared runner. `PoolAwareRunner` therefore tags each
  spawn with its plan session id (`planSessionId`), which keeps two plans'
  identically named tasks apart wherever something is keyed by task, the
  attempt's MCP token among them. For the same reason a plan's stop-all and its
  count of running sessions come from the sessions that plan spawned, never from
  the shared runner, so one plan's stop cannot kill another plan's tasks.

## Expected successor: a generic Agent Client Protocol (ACP) connector

A generic **Agent Client Protocol (ACP) connector** is the expected successor
for third-party harnesses. It is not implemented by this decision and does not
replace the native built-in connectors yet. The following findings were checked
on 2026-10-09.

ACP uses JSON-RPC 2.0 over stdio. Protocol v1 is stable; the Rust and TypeScript
SDKs reached 1.0 on 2026-06-25. Zed and JetBrains maintain the protocol.
[Transports](https://agentclientprotocol.com/protocol/transports),
[updates](https://agentclientprotocol.com/updates).

`session/new` accepts client-supplied `mcpServers`. Stdio MCP support is required;
HTTP is optional and capability-negotiated. `session/load` restores a session
with history replay; `session/resume` reconnects without replay. Both require
the corresponding advertised capabilities. Agents **SHOULD** connect to the
client's supplied MCP servers, so protocol support alone does not prove that
Ordewell's tools attached. Every agent must be verified against the same
attachment constraint before admission.
[Session setup](https://agentclientprotocol.com/protocol/session-setup).

A turn is `session/prompt` plus streamed `session/update` notifications, with
`stopReason` in the final response. Permissions arrive through
`session/request_permission` and must be answered; ignoring a request can stall
the agent. `session/cancel` cancels work, and pending permission requests must
receive a cancelled outcome. An ACP stop reason describes a turn, not evidence
that an Ordewell task is complete.
[Prompt turn](https://agentclientprotocol.com/protocol/prompt-turn).

The published directory lists 37 agents at this check. It lists native implementations in Cline, Cursor, Copilot CLI
(public preview), Gemini CLI, Goose, Kiro and OpenCode, plus adapters for Claude
Code/Claude Agent and Codex. Gemini's CLI reference still labels
`--experimental-acp` experimental, while its dedicated ACP guide documents
`--acp`; a connector must check the installed version rather than assume the
flag. Directory membership does not establish MCP or permission compatibility.
[Agents](https://agentclientprotocol.com/overview/agents),
[Gemini CLI reference](https://geminicli.com/docs/cli/cli-reference/),
[Gemini ACP mode](https://geminicli.com/docs/cli/acp-mode/).

Protocol v1 has no standard mid-turn message injection. Our inference is that
ADR-0023 would degrade to queue-until-turn-end on a generic v1 connector, with
cancel and a new prompt for force send. The v2 prompt lifecycle remains an
unsettled proposal: it separates prompt acceptance from processing but does not
yet specify queueing or steering. Do not promise native-connector delivery
semantics from that draft.
[v1 prompt turn](https://agentclientprotocol.com/protocol/prompt-turn),
[v2 prompt lifecycle](https://agentclientprotocol.com/rfds/v2/prompt).

Antigravity adapters also carry a terms risk: Google's additional terms restrict
third-party software accessing the service and allow account suspension or
termination. ACP availability alone is not authorization to use such an adapter;
its supported access path and applicable terms need checking before adoption.
[Antigravity terms, section 6](https://www.antigravity.google/terms).

## Considered options

- **Keep terminal as fallback.** Previously adopted; rejected because screen
  scraping, keystroke delivery and a second session lifecycle burden every
  runner feature, with no supported runner needing them.
- **Runners execute inside tmux, terminals open on demand (ADR-0007).** The
  terminal transport's last design, and what this decision removes. Every AI
  runner had run headlessly (`HeadlessRunner`: piped stdio, one-shot, prompt
  baked into argv), with the orchestrator scanning raw output for
  `<<<ORDEWELL_CHECKPOINT>>>` and `<<<ORDEWELL_DONE_...>>>` markers
  (`VerdictEngine`); the TUI dropped `task_output` outright, so a user could not
  see what a runner was doing, let alone type into it. The ask (the #24
  follow-up): every spawned runner a real, interactive terminal a user can open
  and type into, while Ordewell keeps watching and still advances the dependency
  graph. Tasks ran in a **tmux window** instead of a piped subprocess
  (`TmuxRunner`, beside `HeadlessRunner`, both behind
  `ITerminalSession`/`ITerminalRunner`): one shared tmux session per port
  (`ordewell-<port>`), one window per task attempt, and `ordewell tui` opened a
  real OS terminal window attached to a task's window on demand (`t` in the plan
  pane, or `/terminal <id>`), computing the tmux target itself from port and task
  id because the daemon is always local. Output was captured by `tmux pipe-pane`
  into a per-session log tailed by byte offset; windows outlived the task (a
  login shell after the exit code) until a cancel, a retry or daemon shutdown;
  tmux was automatic with no setting, and a host without it fell back to
  `HeadlessRunner` with a notice. It went with the whole terminal transport
  (*Keep terminal as fallback*, above). Its full text, including the
  interactive-versus-headless permission-flag rules (`-a never` and a
  `projects.<cwd>.trust_level` override on Codex's interactive shape only), is in
  git history: `git log --follow -- docs/adr/runners/0007-tmux-backed-runners.md`.
  Its three rejected alternatives stay here, because a take-over feature would
  meet them again:
  - **A pty-multiplexer built into the TUI's own render loop (M2).** Rejected:
    the TUI's whole render model is pure `render(state) → string[]`,
    home-and-overwrite (ADR-0006); attaching a live runner needs raw ANSI
    passthrough, a fundamentally different mode. Doing this over the daemon's
    WebSocket (since a runner may not be spawned from the same process as any
    given TUI client) would also mean building bidirectional binary streaming
    plus resize propagation from scratch — reimplementing tmux, worse.
  - **Capture-pane polling with prefix-diffing (M3).** Rejected in favor of
    `pipe-pane` + file tailing: diffing periodic snapshots needs a resync
    heuristic whenever the pane's scrollback is exceeded between polls, which can
    re-emit already-seen content and double-count a checkpoint marker.
    `pipe-pane` gives an exact append-only byte stream tmux is already designed
    to produce.
  - **Spawn a real OS terminal emulator as the *only* transport (M4, no tmux
    underneath).** Rejected: it would only work with a local GUI, failing
    silently on every SSH/headless box — which is a large fraction of where a
    terminal-based TUI actually runs. tmux underneath means the daemon-side
    execution and the checkpoint/verdict machinery keep working identically
    whether or not a GUI is ever attached; opening a terminal is a pure
    convenience on top, not a requirement for the pipeline to run.
- **Keep markers as the no-tools fallback.** Previously adopted; rejected
  because an attach failure would silently downgrade completion, checkpoints
  and planner tools. Respawn once, then hold the task (or fail the planner
  turn) visibly.
- **Keep plugin runners but refuse to run them.** Rejected because installation,
  registry entries and pickers would advertise an unusable choice. Ignore old
  manifests with a notice instead.
- **Build a generic connector first.** Rejected as a prerequisite: native
  connectors already cover the supported runners. ACP is the expected next
  route for third-party harnesses, subject to the gaps above; retaining terminal
  and markers while waiting would preserve the ambiguity this decision removes.

## Consequences

One process/session contract owns every task. A missing tool connection fails
before the coding agent receives work. The fake `claude` harness verifies the
real connector and tool path without a model or API key. Supporting another
runner requires a structured connector and verified Ordewell tool attachment;
a manifest alone is insufficient. Native Windows runner execution needs no
tmux; the TUI remains unverified on native Windows (ADR-0010).

## History

- 2026-07-31 — ADR-0007 accepted: tmux automatic, no setting.
- 2026-09-29 — ADR-0007: the transport became a setting (ADR-0018); tmux stays automatic within the terminal transport.
- 2026-10-02 — ADR-0007: structured the default; the terminal transport, and tmux with it, a fallback.
- 2026-10-04 — ADR-0007: a runner manifest may carry a command line per major version; OpenCode 2.x uses one.
- 2026-10-09 — ADR-0007: the transport setting removed; terminal is only the per-connector fallback (ADR-0018).
- 2026-10-09 — accepted and implemented; supersedes ADR-0007.
- 2026-10-10 — the TUI task-log surface corrected to Enter on a task in the plan pane.
- 2026-10-17 — ADR-0007 folded in under Considered options; D1 and D2, the two rules other ADRs cited to it, are Key properties here (D2 was its T7).
- 2026-10-21 — a task whose runner never reports the server connected is held with a reason instead of failed, while a `failed` report still fails it; a planner turn fails either way.
- 2026-10-25 — the VS Code control reads "Open chat", not "Open log".
- 2026-10-27 — a coding-agent planner's attach is checked before every turn, not only after spawn: a live process whose tools are gone is respawned once on a fresh token and resumed, and a turn that cannot re-attach fails without being sent.
