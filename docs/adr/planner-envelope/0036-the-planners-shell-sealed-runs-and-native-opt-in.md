---
status: accepted
implemented: partial
amends: ["0008", "0011", "0026"]
note: "sealed runs are implemented (#109); the native-shell opt-in waits for #110"
---

# 0036 — The planner's shell: sealed runs instead of refusals, and the harness's own shell as an opt-in

## Problem

The classifier refuses what it cannot read: a shell keyword (`for`, `while`,
`if`), inline code for an interpreter, code piped into one, output
redirection, a computed command name (ADR-0008). Each refusal tells the planner
to run the inner command directly or describe it as a task. So a planner
cannot loop over files, reshape an output with a few lines of Python, or keep
an intermediate result in a file, all of which are ordinary steps in
research, and "describe it as a task" turns a read into a runner session.

Teaching the classifier these constructs would have it read more of a language
it already misreads. ADR-0008's history is mostly cases where it judged a
different command from the one the shell ran, and ADR-0011 expects more of
them. The classifier is the right gate for commands that need the user's
environment (the network, credentials, files outside the workspace). It is the
wrong tool for making arbitrary local computation safe.

ADR-0011 runs every planner command in an OS sandbox where the platform has
one, and (B7) leaves relaxing the classifier because of it to an ADR of its
own. With nothing writable but a scratch folder, no network and no home
directory, a command can compute anything and change nothing, and whether the
classifier can read it stops mattering.

Separately, harness planners' own shells are withheld (ADR-0026): every
command goes through `run_command`. Each harness is built around its own shell
tool, and some users want their planner to use it.

## Decision

**Where the planner's sandbox runs, a command the envelope would refuse
without asking runs sealed instead: with the workspace read-only, a scratch
folder writable, no home directory and no network. What the classifier allows
or asks about is unchanged, and where no sandbox runs a refusal is still a
refusal. Separately, a user may let a harness planner use its own shell, held
to the same limit on writes and with none of the user's credentials in
reach.**

### Sealed runs

- **The profile (S1).** On ADR-0011's backend (bubblewrap on Linux, Seatbelt
  on macOS): the workspace mounted read-only; the session's scratch folder
  writable and set as `TMPDIR` and `HOME`; outside the workspace, only what
  programs need to start (the system's executables, libraries and a minimal
  set of configuration files), and nothing of the user's home or any other
  repository; none of the environment Ordewell runs with beyond what programs
  need to find themselves and print (`PATH`, the locale), since credentials
  live there too; no network; a fresh `/dev`, `/proc` and `/tmp`; limits on
  processes, memory and wall time; and it dies with its parent. What it can
  read outside the workspace is fixed by the profile, the same for every
  command, and holds no user data, so no path is asked about. Where the
  platform offers a throwaway overlay, the workspace may be mounted with one
  instead of read-only, so a tool that writes a cache beside the code still
  runs; nothing written reaches the workspace either way. The profile takes
  one more writable directory as a parameter, none by default, for a
  read-only task's sealed commands in its own throwaway worktree (#104).
- **What runs sealed (S2).** A command runs sealed when the planner asks for
  it (`run_command` with `sealed: true`), or when the envelope would refuse it
  without asking: the classifier's `refuse`, or a command the approval mode
  refuses without asking (`allowlist`, which Full uses by default). In the
  sealed profile a write outside scratch fails and a network call fails, so a
  destructive command only reports an error. Everything else keeps ADR-0008
  and ADR-0026 as they are:
  the classifier, path confinement, the allowlist, the approval card under
  Guarded, and ADR-0011's sandbox with the network its tier gives.
- **What still refuses (S3).** A command a `!` exclusion names, sealed or not:
  an exclusion is the user's never. A command the user denied on the card: a
  denial is an answer, not a classification to route around.
- **The planner is told (S4).** The result says the command ran sealed and
  what that means (no network, the workspace read-only, no home), so a loop of
  `az` calls that fails on the network is understood rather than retried. The
  research timeline marks the step as sealed.
- **Research subagents get it too (S5).** A sealed run never asks anything,
  which is what a subagent needs (ADR-0008, T6): what would have asked runs
  sealed for them.
- **Where no sandbox runs (S6)**, on Windows or a Linux host without
  unprivileged user namespaces, a refusal is a refusal as today, and the
  planner surface's one notice (ADR-0011, B5) also says that loops and scripts
  are unavailable for that reason.
- **The classifier is not widened for convenience (S7).** A construct it
  cannot read is not taught to it to save a refusal; where a sandbox runs, it
  runs sealed. Fixes for commands it misreads go on as before.

### Network, in stages

1. **Now: none.** A sealed run has no network. A loop of cloud reads runs as
   allowlisted commands one call at a time, or as a script task the user
   approves ([ADR-0035](../supervision/0035-effects-are-consented-and-recorded.md)).
2. **With the egress proxy (#88):** a sealed run reaches the network only
   through the proxy, under the web-read policy (ADR-0027): exclusions, the
   budget, and private addresses refused on every connection. It still has no
   home directory, so still no credentials: public reads only.
3. **In a lease with a credential broker (#93, #97, #99):** read-scoped
   credentials attached by the broker. Decided with the lease's ADR.

### The harness's own shell, as a user's opt-in

- **What it is (N1).** A user setting, VS Code `ordewell.plannerNativeShell` and
  elsewhere `ORDEWELL_PLANNER_NATIVE_SHELL`, lets a harness planner use its own
  shell (Claude Code's `Bash`, OpenCode's `bash` or `shell`) beside
  `run_command`. A Codex planner already keeps its own shell, inside its
  read-only sandbox with no network (ADR-0026), so for Codex the setting
  changes nothing. It is off by default and never comes from the repository:
  it is refused from a workspace's environment files and is never a workspace
  setting (ADR-0016, ADR-0026, #92).
- **Its contract (N2).** The opt-in is offered for a harness only once each of
  these holds on the installed version, checked live:
  1. No file writes outside a scratch folder, enforced by an OS sandbox around
     the shell: the harness's own where it can be held to this, Ordewell's
     otherwise.
  2. None of the user's credential stores is readable from the shell: cloud
     CLI configuration, git credentials, SSH keys, package-registry tokens. The
     shell can read the workspace and run local tools, but cannot act on the
     user's accounts. So it is a second way to read and never a second route
     to effects, which stay script tasks and ops tasks (ADR-0035).
  3. Every command it runs reaches the research timeline from the harness's
     own event stream, as `run_command`'s commands do.
  4. The repository's config still runs nothing (ADR-0028).
- **Network (N3)** is whatever the harness gives its shell. An injected
  instruction could then send workspace contents to an address it chose. That
  is the residual the opt-in accepts, and the egress proxy (#88) is its guard
  once it exists. The harness's own login stays readable from its shell, as it
  is for every runner task today (#93).
- **A harness that cannot be held to N2 (N4)** is not offered the opt-in, and
  the setting says why. Cloud reads that need the user's credentials stay on
  `run_command`, classified and allowlisted, whether or not the opt-in is on.

## Live checks

Checked live on 2026-10-21 on macOS 26 (Seatbelt), against Claude Code 2.1.304
and OpenCode 2.0.32. Each harness was launched as Ordewell launches its planner
(Claude: `-p` stream-json, `default` mode, `--permission-prompt-tool stdio`,
`--setting-sources user`, `--settings` with `disableAllHooks` and the ask
rules; OpenCode: `opencode serve` with `OPENCODE_DISABLE_PROJECT_CONFIG=1`, the
planner policy in `OPENCODE_CONFIG_CONTENT` and as session rules), with its
shell let through: Claude's `Bash` not withheld, OpenCode's `shell` asked
rather than denied, every ask answered allow. Fixtures: a throwaway repository
whose config carries hooks, an `.mcp.json`, an `opencode.json` server and an
OpenCode plugin, each writing a marker; canary credential files (`~/.aws`,
`~/.config/gcloud`, `~/.azure`, `~/.ssh`, `~/.npmrc`, `~/.git-credentials`,
`~/.netrc`, `~/.config/gh`, `~/.docker`, `~/.kube`) in a temporary folder
standing for the home directory; two canary credential variables
(`GITHUB_TOKEN`, `AWS_SECRET_ACCESS_KEY`) in the launch environment. The user's
real `~/.ssh`, `~/.azure` and `~/.config/gh` were read into `/dev/null`, the
keychain through `security find-generic-password -w` (exit code only) and
`git credential-osxkeychain` (byte count only), and `ssh-add -l` tried the
agent. Unsandboxed, every one of them was readable. Two routes were tried for
each harness: its own sandbox, and Ordewell's backend built on this branch:
the sealed profile (S1) with the network on (N3), wrapped around the harness's
shell.

| N2 check | Claude Code, its own sandbox | Claude Code, Ordewell's sandbox | OpenCode 2.0.32, Ordewell's sandbox |
| --- | --- | --- | --- |
| 1. writes only to scratch | holds, until a user setting widens it | holds | holds |
| 2. credential files, keychain, ssh-agent | unreadable | unreadable | unreadable |
| 2. credentials in the environment | readable | dropped; the harness's own environment still readable | dropped; the harness's own environment still readable |
| 3. no saved setting bypasses it | fails: three user settings widen writes | holds with the prefix in `--settings` `env` | holds with `shell` in `OPENCODE_CONFIG_CONTENT` |
| 4. every command in the event stream | holds | holds, and each asks first | holds, and each asks first |
| 5. repository config runs nothing | holds | holds | holds |

- **Claude Code's own sandbox.** `--settings` set `sandbox.enabled`,
  `failIfUnavailable`, `allowUnsandboxedCommands: false`,
  `autoAllowBashIfSandboxed`, `filesystem.allowWrite` (scratch),
  `filesystem.denyWrite` (the workspace) and `filesystem.denyRead` (`~/` and
  the canary folder). Writes reached scratch and Claude's temporary directory,
  `/tmp/claude-<uid>`, which every Claude Code session of the user shares and
  whose other sessions' task outputs stay readable; with `CLAUDE_CODE_TMPDIR`
  the session gets its own instead. A background command, a subagent's `Bash`,
  `Monitor` and `dangerouslyDisableSandbox: true` were all held. Credential
  files under a denied path, the keychain (`security` exit 44) and the agent
  were out of reach, but both canary variables were in the shell's
  environment, and `sysctl kern.procargs2` on `$PPID` returned the Claude
  process's own environment with them. Each new network host reached
  `can_use_tool` as `SandboxNetworkAccess`. Other layers' `enabled: false`,
  `allowUnsandboxedCommands: true` and `excludedCommands` did not loosen it.
  Each of three user settings, added in turn to `~/.claude/settings.json`,
  made a folder outside scratch writable: `sandbox.filesystem.allowWrite`, an
  `Edit(…)` allow rule, and `permissions.additionalDirectories`. A setting
  the user saved for interactive work therefore widens the planner's shell,
  and `--settings` cannot take an entry back. 2.1.304 ignores an untrusted
  project's allow rules and `additionalDirectories`; its sandbox keys apply
  and did not widen the sandbox either.
- **Claude Code under Ordewell's sandbox.** Claude's sandbox off;
  `CLAUDE_CODE_SHELL_PREFIX` names a launcher, which receives the whole
  command string as one argument and runs it with `/bin/zsh -c` under the
  profile; `CLAUDE_CODE_TMPDIR` names a short per-session folder (Claude warns
  above about 30 bytes) that the profile makes writable, since Claude writes
  the shell's working directory there after every command. N2.1 and the files,
  keychain and agent of N2.2 held on the same paths as above, and the canary
  variables were gone. A settings `env` block in a lower layer replaced a
  prefix set only in the process environment, which took the command out of
  the sandbox; set in `--settings` `env`, the prefix won. With Claude's own
  sandbox off, every `Bash` and `Monitor` call reached `can_use_tool` before it
  ran. Claude's start-up shell snapshot runs the user's shell profile outside
  both sandboxes. It is not a tool call and reads none of the repository's
  config.
- **OpenCode 2.0.32** has no OS sandbox of its own. Its shell is the `shell`
  of the last config layer that sets one, or else `SHELL`. With `SHELL`
  naming the launcher in the server's environment, N2.1 and N2.2 held as for
  Claude, including `background: true`, a subagent's child session and a
  `workdir` outside the workspace. A `shell` key in a config layer beat
  `SHELL`: the command ran unsandboxed and wrote outside. Ordewell's
  `OPENCODE_CONFIG_CONTENT` setting `shell` beat one in an `OPENCODE_CONFIG`
  file standing for the user's global config. Each `shell.created` event names
  the shell the call ran in. A saved `always` permission skips the question
  but not the shell. A user's global plugin can still choose the shell, as
  code that already runs in the server as the user (by source). OpenCode 1.x
  is not installed here and was not checked.
- **The event stream (N2.3).** Claude: every command was a `tool_use` in
  stream-json, a subagent's carrying `parent_tool_use_id`, and the launcher
  logged one invocation per `tool_use` (`Bash`, background `Bash`, a
  subagent's `Bash`, `Monitor`). OpenCode: each was a `session.tool.called`, a
  `permission.asked` and a `shell.created` on `/api/event`, child sessions'
  included, again one launcher invocation each.
- **The repository's config (N2.4).** No marker was written in any run made
  with the planner's launch, on either route.
- **Environment credentials, either route.** A sandboxed command on macOS can
  read the argv and environment of any non-platform process of the user,
  the harness's own included, through `sysctl kern.procargs2`. This was shown
  from inside the sealed profile against a `node` process holding a canary.
  N2.2 for variables therefore needs the harness itself started without the
  user's credential variables, beyond its own login (N3).
- **Codex** was not checked: N1 changes nothing for it.

## Considered options

- **Teach the classifier loops** (unroll a literal `for` list, parse compound
  commands). Rejected: every construct it learns is another place to read a
  different command from the one the shell runs (ADR-0008's history), for a
  guarantee the sandbox gives outright where it runs.
- **Run every planner command sealed, and drop the classifier where a sandbox
  runs.** Rejected: cloud CLIs and `gh` need the network and the user's
  credentials, and sealing them breaks the reads ADR-0026 exists for.
- **Give sealed runs the network now.** Rejected until #88: an unclassified
  command with a network can carry anything it read to any address.
- **Seal with the home directory mounted read-only**, as ADR-0011's profile for
  classified commands does. Rejected: an unclassified command would read
  `~/.ssh` with none of the path checks that ask about it today.
- **Seal also what the user denied on the card.** Rejected: a denial is the
  user's answer about that command, sandbox or not.
- **The harness's own shell by default on the local backend.** Rejected: the
  planner runs as the user, with every credential on disk, before anything is
  approved, and Ordewell cannot see every native command before it runs
  (ADR-0026). Inside a lease that holds the boundary itself, native tools can
  be the default; that belongs to the lease's ADR (#97, #101).
- **The native shell with the user's credentials in reach.** Rejected: it would
  be a second route to effects, around ADR-0035's consent.
- **A user setting that turns the classifier off for `run_command`.** Rejected:
  without a sandbox, nothing would stand between an unread command and the
  user's files and credentials.

## Consequences

- Where a sandbox runs, the planner can loop, pipe into an interpreter and keep
  scratch files, and the refusals that said "describe it as a task" become
  sealed runs.
- Hosts without a sandbox keep today's refusals, and the notice says so.
- ADR-0011's B7 is amended: a verified sandbox turns a refusal into a sealed
  run, and changes nothing else about the tiers.
- Research subagents can run what the planner can, sealed.
- The opt-in needs live checks per harness before it is offered. Until a
  harness passes them, its planner has `run_command` alone.
- Seatbelt has no PID namespace, so on macOS a sealed run's processes are
  killed as one process group, at its end, at its wall-time limit and when
  Ordewell dies. A process that leaves the group with `setsid` outlives the
  run, still sealed. Its process and memory limits are counted on top of what
  the user already runs and what every macOS program maps as it starts. A
  sealed run there can still read the command lines of the user's other
  processes, which `sysctl` hands out under no rule a Seatbelt profile can
  deny, though not their environments; Linux's PID namespace hides them.
- Homebrew's data directories are hidden from a sealed run on macOS; its
  configuration stays readable, since git and OpenSSL stop on a file the
  sandbox denies rather than one that is missing.
- When this is implemented, SECURITY.md's envelope description and "What each
  part can touch" name sealed runs and the opt-in, CONTEXT.md gains *Sealed
  run*, and ADR-0008, ADR-0011 and ADR-0026 are rewritten where they say a
  refused command never runs and a harness's shell is withheld.

## History

- 2026-10-15 — accepted. Not yet implemented; sealed runs need #64 first.
- 2026-10-21 — sealed runs implemented (#109) on Seatbelt and bubblewrap, for `bash`, `run_command` and research subagents; the native-shell opt-in waits for #110.
- 2026-10-21 — live checks of N2 on Claude Code 2.1.304 and OpenCode 2.0.32 (#110), recorded under Live checks.
