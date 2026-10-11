# 0028 — Planners never run the repository's config

**Status:** accepted — amends [ADR-0026](0026-one-envelope-for-every-planner.md), [ADR-0027](0027-web-reads-in-the-planner-envelope.md) and [ADR-0008](0008-planner-exploration-envelope.md)

## Problem

A planner researches a repository before anyone has approved anything about
it (ADR-0008). ADR-0026 bounds what it may *do*: commands through
`run_command`, its runner's own requests through one envelope, no file
writes. It says nothing about what its runner *loads* from the repository at
start, and each runner loads code from there.

Checked live on 2026-10-11, each in a throwaway repository that was never
trusted unless stated:

- **Claude Code 2.1.296**, launched as a planner is (`-p`, stream-json,
  `default` mode, Ordewell's `--settings` ask rules): the project
  `.claude/settings.json`'s `SessionStart` and `UserPromptSubmit` hooks ran,
  its `apiKeyHelper` ran, its `env` block applied (an `HTTPS_PROXY` in it
  broke the API call), and a stdio server in `.mcp.json` was started before
  the first turn. Claude Code's documentation says as much
  ([permissions, "What runs before you trust a folder"](https://code.claude.com/docs/en/permissions)):
  the trust dialog guards interactive sessions, and `-p` skips it.
  ADR-0026's History, which says only a *trusted* repository's hooks and
  `enableAllProjectMcpServers` apply, is wrong.
- **Codex 0.162.0**: in a repository the user's config marks trusted, a stdio
  server in its `.codex/config.toml` was started for a planner's thread
  (`read-only` sandbox, `on-request`). Codex's own users trust their
  repositories as a matter of course: this machine's config trusts its home
  directory and every Ordewell worktree it has run in.
- **OpenCode 2.0.26**: a plugin in the repository's `.opencode/plugin/` ran
  when `opencode serve` started, before any session, and a local server in
  its `opencode.json` started with the planner's session. Ordewell's
  `OPENCODE_CONFIG_CONTENT` is the last config layer, so its permission policy
  wins for tools, but a later layer cannot unload a plugin or a server an
  earlier one declared.

Each is the repository choosing a command that runs as the user, with the
user's credentials, before the planner reads a line. The ask rules ADR-0026
added (c1db0bd) decide tool calls; none of this is a tool call.

Two smaller gaps sit beside them. Claude Code's `Read`, `Grep`, `Glob` and
`LS` have no ask rule, so an allow rule from a trusted folder's settings — an
`additionalDirectories` entry, a `Read(…)` rule, a project skill's
`allowed-tools` — lets a path read outside the workspace skip
`can_use_tool` and the envelope. And `pathScope.ts` judges containment
lexically, so a symlink the repository ships, pointing outward, reads as
inside: acceptable while Claude decided in-workspace reads itself, not once
Ordewell decides them.

## Decision

**A planner runs nothing the repository's config names: no hook, no settings
environment, no helper command, no plugin, and no MCP server the user has not
approved. Instruction files are text, and Ordewell gives them to the planner
itself. Tasks are unchanged.**

### Claude Code planners

- **User settings only.** The planner is launched with `--setting-sources
  user`, so neither `.claude/settings.json` nor `.claude/settings.local.json`
  is read: their hooks, `env`, helper commands (`apiKeyHelper`,
  `awsAuthRefresh`, `awsCredentialExport`, `otelHeadersHelper`), allow rules,
  `additionalDirectories`, plugins and MCP switches are gone, and so are the
  project's skills, agents and commands, which can carry hooks and
  `allowed-tools` of their own. Checked live: with it, none of the probes
  above ran.
- **No hooks at all.** `--settings` carries `disableAllHooks: true`. A user's
  own hook is not the repository's, but it runs on the planner's tool calls
  and can write files, which the envelope forbids every planner.
- **Every read reaches the envelope.** `--settings` asks for `WebFetch`,
  `WebFetch(domain:*)`, `WebSearch`, `mcp__*`, `Read`, `Grep`, `Glob` and
  `LS`. An ask rule beats an allow rule from any source (ADR-0026, History).
  A path tool's request is allowed at once when its target is inside the
  workspace — a `Grep` or `Glob` without a path searches the workspace — and
  asked as `external_path` otherwise, as today. Containment of an existing
  target is judged on its resolved path, so a symlink pointing outward asks.
- **The project's instructions are text.** User-only settings also drop the
  project's `CLAUDE.md`. Ordewell reads `CLAUDE.md`, `.claude/CLAUDE.md` and
  `CLAUDE.local.md` at the workspace root, with the files their `@` imports
  name inside the workspace, and appends them to the planner's system prompt,
  bounded in size. The user's own `~/.claude/CLAUDE.md` still loads.
- **The user's own servers stay.** User-scope servers and claude.ai
  connectors still load (checked live). Local-scope servers — the user's own
  entries for this project in `.claude.json`, under the planner's
  `CLAUDE_CONFIG_DIR` — are dropped by user-only settings; they are the
  user's, not the repository's, so Ordewell passes them back explicitly in
  the planner's `--mcp-config`.

### Project MCP servers, every runner

A project MCP server is one the repository declares: `.mcp.json` for Claude
Code; the `mcp` entries of the project's `opencode.json`/`opencode.jsonc` or
`.opencode/opencode.json[c]` for OpenCode; the `mcp_servers` of the project's
`.codex/config.toml` for Codex. Each runner is stopped from reading them
(above and below), and Ordewell reads them itself:

- **Not started unless approved.** Before the planner's first spawn, each
  server is put to the session's approval policy as kind `mcp_server`. The
  card names the server, its transport and exactly what would run: the
  command and arguments with any environment it sets, or the URL with the
  names of the headers it sends. Variables written as `${VAR}` are shown as
  written, and the card says the runner fills them in from the user's
  environment.
- **Remembered per repository and definition.** The scope is
  `mcp-server:<name>@<hash>`, where the hash covers the whole definition. A
  person's approval is remembered across sessions in Ordewell's own data
  directory (`~/.ordewell`), never in the repository, keyed by the repository
  root, the server's name and that hash; a changed definition hashes
  differently and asks again. A mode's answer is not remembered (ADR-0026).
- **Passed as approved.** An approved server is handed to the runner as the
  definition Ordewell parsed and showed — in the planner's `--mcp-config` for
  Claude Code, in `OPENCODE_CONFIG_CONTENT` for OpenCode, in the thread's
  `mcp_servers` for Codex — so what starts is what was shown, never what the
  runner would re-read from the file. Its tools then reach the envelope as
  any MCP tool does (`mcp_tool`, ADR-0026).
- **Full asks nobody.** Under `auto` in Full, and under `allowlist`, an
  unremembered server is not started. The refusal is recorded like any other
  decision, so every surface shows it, and its detail names the allowlist
  entry that would start it. A Guarded session's approval is remembered and
  also starts it in Full later. Under `allow`, it starts. Either way the
  planner is told which of the repository's servers it does not have, so
  work that needs them goes into the plan's tasks.
- **The allowlist names a definition, not a name.** `mcp-server:<name>@<hash>`
  in the planner allowlist starts that exact definition in every mode. A name
  alone would start whatever command the next repository puts under it. A
  `!mcp-server:…` exclusion wins over a remembered approval, and
  `!mcp-server:*` turns project servers off.
- **Remote servers follow the same rule.** A URL the repository chose can
  receive the user's headers and the planner's tool arguments.
- **Decided once per conversation.** The answer is kept for the
  conversation's respawns and resumes; a new conversation decides again, and
  remembered approvals answer it without asking. A one-shot plan has no
  approval channel, so only remembered approvals start a server for it.
- **A file Ordewell cannot read is a server it does not start.** A
  definition it cannot parse is skipped, and the planner is told which file
  and why.

### OpenCode planners

- **No project config.** The planner's server runs with
  `OPENCODE_DISABLE_PROJECT_CONFIG=1`. Checked live on 2.0.26: no project
  plugin loaded, no project server started, and `AGENTS.md` was not read;
  1.18.35's source skips the same: project `opencode.json[c]`, every project
  `.opencode` directory (plugins, custom tools, commands, agents) and the
  `AGENTS.md`/`CLAUDE.md`/`CONTEXT.md` walk-up.
- **No language servers.** The planner's config sets `lsp: false`. A
  language server started for a file the planner reads can run the
  repository's toolchain (`rust-analyzer` builds, an ESLint config is code).
  2.0.26 started none on a read, with a `tsserver.js` planted in
  `node_modules`; 1.18.35's `read` warms each file it reads in its language
  servers (by source).
- **Instructions as text.** Ordewell gives the planner the first of
  `AGENTS.md`, `CLAUDE.md` and `CONTEXT.md` found from the workspace up to its
  repository root, in OpenCode's order.

### Codex planners

- **The repository is untrusted for the planner's thread.** The thread's
  config marks the workspace and every directory above it
  `trust_level = "untrusted"`. Codex keys trust on the project root, not the
  working directory, so marking the working directory alone does not hold
  in a subdirectory (checked live); every ancestor covers whatever root
  Codex settles on. Checked live: a trusted repository's project server was
  not started and its `AGENTS.md` was not read. Its hooks ran in neither
  case: Codex runs a project hook only once the user's config records its
  hash as trusted, which untrusted also turns off.
- **Instructions as text.** Ordewell puts the repository's `AGENTS.md` files
  — `AGENTS.override.md` where present, from the repository root down to the
  workspace, as Codex orders them — into the thread's developer
  instructions.

### What the repository's config can do, and how the planner launch stops it

| runner | item | can | planner launch |
| --- | --- | --- | --- |
| Claude Code | hooks (settings, skill and agent frontmatter, plugins) | run commands | user-only settings, `disableAllHooks` |
| Claude Code | `env` | redirect traffic (`HTTPS_PROXY`, `ANTHROPIC_BASE_URL`), change the runtime | user-only settings |
| Claude Code | `apiKeyHelper`, `awsAuthRefresh`, `awsCredentialExport`, `otelHeadersHelper` | run commands | user-only settings |
| Claude Code | `.mcp.json`, `enableAllProjectMcpServers`, `enabledMcpjsonServers` | start a command, reach a URL | not read; approval |
| Claude Code | allow rules, `additionalDirectories`, `allowed-tools` | skip `can_use_tool` | user-only settings; ask rules |
| Claude Code | `enabledPlugins`, `extraKnownMarketplaces` | install and run plugin code | user-only settings |
| Claude Code | `statusLine`, `fileSuggestion` | run commands (interactive only) | user-only settings |
| Claude Code | `CLAUDE.md`, imports | text | injected by Ordewell |
| OpenCode | `plugin`, `.opencode/plugin(s)` | run code in the server at start | project config off |
| OpenCode | `mcp` | start a command, reach a URL | project config off; approval |
| OpenCode | `.opencode/tool(s)` | define tools that run code | project config off |
| OpenCode | `provider` options, `formatter`, `lsp` | redirect traffic, run commands | project config off; `lsp: false` |
| OpenCode | commands, agents, modes | prompts and permissions | project config off |
| OpenCode | `instructions`, `AGENTS.md` | text | `AGENTS.md` injected; other instruction files not read |
| Codex | `mcp_servers` | start a command, reach a URL | untrusted; approval |
| Codex | hooks, `notify` | run commands | untrusted |
| Codex | `model_provider`, `model_providers`, base URLs, `otel` | redirect traffic | untrusted |
| Codex | `shell_environment_policy`, profiles, exec policies | shape the shell | untrusted; the shell stays sandboxed |
| Codex | `AGENTS.md` | text | injected by Ordewell |

The workspace's own environment (ADR-0016) is unchanged: it holds only what
direnv was allowed to export and an untracked `.ordewell/env`.

### Tasks are unchanged

A task, an ops task included, runs the repository's code by design and keeps
every native capability of its runner (ADR-0020, ADR-0027): its settings,
hooks, project servers and instruction files load as its runner loads them,
and its launch is byte for byte what it was.

## Key properties

- **Nothing runs before a person or a standing rule says so.** A planner on a
  repository nobody has looked at runs the user's own configuration and
  Ordewell's, nothing else.
- **What runs is what was shown.** An approved server is passed as parsed,
  and a changed definition is a new question.
- **Instructions stay, as text.** The planner still reads the project's
  conventions; it no longer runs anything they come with.
- **One residual per runner's own reading.** Ordewell reads the files the
  runners would have read; a runner version that adds another source of
  project config is outside this until the live check covers it, which is
  why the History records the versions checked.

## Considered options

- **Keep project settings and add deny rules.** Rejected: hooks, `env`,
  helpers and `.mcp.json` are not permissions, and no rule reaches them.
- **Point Claude Code at an empty `CLAUDE_CONFIG_DIR`.** Rejected: it drops
  the user's login, settings and servers with the repository's.
- **Start project servers in Full without asking.** Rejected: a server is a
  command the repository chose, which is the thing this ADR stops; Full's
  allowance is for web reads alone (ADR-0027).
- **Approve a server by name.** Rejected: the name is the repository's to
  choose, so it would approve whatever the next repository puts under it.
- **Let the runner re-read an approved server from the file.** Rejected: the
  file can change between the approval and the start.
- **Untrusted for Codex by `CODEX_HOME`.** Rejected: a fresh home loses the
  user's login and config with the repository's.

## History

- 2026-10-11 — proposed after the live finding above; Claude Code 2.1.296,
  codex-cli 0.162.0, OpenCode 2.0.26 (and 1.18.35 by source).
- 2026-10-11 — implemented and checked live through Ordewell's own planner
  and task launches, on Claude Code 2.1.296, codex-cli 0.162.0 and OpenCode
  2.0.26, in one throwaway repository holding a project hook and an
  `apiKeyHelper` that each write a marker, an `HTTPS_PROXY` in the settings
  `env` pointing at a recording proxy, a stdio server in `.mcp.json`,
  `.codex/config.toml` and `opencode.json` that writes a marker, and an
  OpenCode plugin that writes one; Codex ran with the repository trusted.
  For every planner with the servers refused: no marker, the proxy unused,
  and the planner quoted a secret word from the repository's `CLAUDE.md`
  (Claude) or `AGENTS.md` (Codex, OpenCode), which it now has only as text.
  With the server approved, each planner started exactly it. For every task:
  the server started again; Claude's task ran both hooks and the
  `apiKeyHelper` and went through the proxy (it then failed on the helper's
  empty key, as that fixture meant it to); OpenCode's task loaded the plugin;
  the Codex and OpenCode tasks answered. Codex's trust entry in its config
  was unchanged after the planner's untrusted thread.
- 2026-10-11 — OpenCode 2.x finding and fix. On 2.0.26 an approved project
  server started, but the planner's call to its tool failed ("Unable to
  execute"): the server is passed in the 1.x config shape, which drops
  `codemode`, so 2.x listed its tools only inside code mode's `execute`, and
  the planner's request was not read as that server's tool. Now a 2.x
  planner's approved servers are replaced at runtime with `codemode: false`,
  as Ordewell's own server already was, from the transport fields of the
  definition shown (a local server's command and environment, a remote one's
  URL and headers); held servers are never sent. Replaced before anything
  lists the servers, a local one starts once; replaced later, OpenCode stops
  it and starts the new one. Its tools are then asked about as `mcp_tool`, as
  on 1.x, Claude Code and Codex. `execute` stays refused for planners: it runs
  model-written code over every MCP tool, past per-tool approval, and its
  refusal says to call the tool directly. On a 2.x without the runtime route,
  the planner is told the server is not usable on its OpenCode version, and
  the timeline shows it refused as `unsupported`. Checked live on 2.0.26:
  Guarded, approved — the server started once and the planner's call went
  through the approval and returned; Full with no allowlist entry — not
  started, no marker.
