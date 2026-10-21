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
directory, a command can compute anything and change nothing (on Linux
without exception; macOS keeps three residuals, below), and whether the
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
to the same limit on writes and with none of the user's credential stores in
reach.**

On Linux the profile below is the whole guarantee. On macOS it holds for files,
home directory, environment and network, and three things no Seatbelt rule
closes stay open to a sealed run ([What holds on Linux and on
macOS](#what-holds-on-linux-and-on-macos)).

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
  command, and holds no user data (on macOS but for the here-document files
below), so no path is asked about. Where the
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

### What holds on Linux and on macOS

Linux's PID namespace leaves a sealed run no other process to look at, and its
mount namespace leaves it no file of the user's but the workspace, so S1 holds
as written. On macOS, Seatbelt enforces S1's files, home directory,
environment and network. Three things it promises are not held there, because
no Seatbelt rule gates them (checked on macOS 26). They are open to every
command in the planner's sandbox, sealed or not.

1. **Other processes' command lines and environments.** A command can read the
   command line of the user's other processes, and the environment of those
   that are not Apple platform binaries, through `sysctl` `kern.procargs2`
   (the numeric MIB `{1, 49, pid}`). Node, Homebrew's Python and dev servers
   are exposed, and their environments often hold API keys and tokens. Neither
   the profile's `sysctl-read` rule nor its `process-info*` rules reach it,
   and macOS has no seccomp to filter the call.
2. **The user's existing launchd jobs.** A command inherits the bootstrap port
   to launchd, and through it can read the definition of a loaded job,
   environment variables included (`launchctl print`); start one, which then
   runs outside the sandbox, as the user (`launchctl kickstart`; with `-k` the
   call fails); unload one (`launchctl bootout`, `launchctl remove`); and
   enable or disable one persistently (`launchctl enable`, `disable`). It
   cannot load or submit a new job: the profile's `(deny job-creation)`
   closes that.
3. **The shared here-document files.** macOS's `/bin/sh` (bash 3.2) writes a
   here-document to `/private/tmp/sh-thd-N` whatever `TMPDIR` says, so the
   profile allows reads and writes of names of that pattern, and `/tmp` is
   otherwise out of reach. A command can read or overwrite such a file while
   another process of the user is using it, which makes them a channel at
   names it can guess. Removing the allowance breaks here-documents.

So on macOS the promises that none of the user's credentials is in reach and
that a sealed run changes nothing hold as follows: nothing of the user's
files, home directory or Ordewell's own environment is readable and nothing is
written outside scratch, but for the here-document files; and what a process of
the user holds in its environment or command line, and the state of the user's
launchd jobs, are not out of reach. A value read this way is returned to the
planner like any command's output. To leave the machine it needs a later step
that has the network, since a sealed run has none:

- a web read (a fetch or a search, ADR-0027) is checked for an `!` exclusion,
  the web-read budget, private and loopback addresses, and a secret check on
  its URL or query, which looks for Ordewell's own secrets, the values of
  sensitive variables in Ordewell's environment and well-known token formats.
  That check narrows what a URL carries and does not close it: an encoded or
  split value passes, and so does a value from another process's environment
  that has none of those shapes. Under `auto`, in Guarded and in Full, a web
  read is not asked about;
- `curl` and `wget` through `run_command` go through the same checks on their
  URLs and are approved per origin; in Full and under `allowlist` they are
  refused whatever the allowlist says, and then run sealed, with no network
  (ADR-0027);
- any other command that reaches the network (`gh`, `git ls-remote`, a cloud
  CLI) asks, and the card shows the command, or the user's allowlist rule
  admits it without asking; in Full it runs only if allowlisted, and
  otherwise runs sealed, with no network.

Mitigations to come: the egress proxy (#88), through which the sandbox's
network is planned to go, and a container or VM backend (#99), where other
processes are not visible, which closes the first two for good. Stage 2 below
gives a sealed run a network of its own, so on macOS the secret check would be
what stands between a value read this way and a URL; the proxy's ADR decides
that with this in view.

### Network, in stages

1. **Now: none.** A sealed run has no network. A loop of cloud reads runs as
   allowlisted commands one call at a time, or as a script task the user
   approves ([ADR-0035](../supervision/0035-effects-are-consented-and-recorded.md)).
2. **With the egress proxy (#88):** a sealed run reaches the network only
   through the proxy, under the web-read policy (ADR-0027): exclusions, the
   budget, and private addresses refused on every connection. It still has no
   home directory, so no credentials of its own: public reads only.
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
     to effects, which stay script tasks and ops tasks (ADR-0035). What a
     process of the user holds in its environment or command line is not a
     store: on macOS it is the residual above, which Ordewell's Seatbelt
     does not close for a native shell either.
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

## Considered options

- **Teach the classifier loops** (unroll a literal `for` list, parse compound
  commands). Rejected: every construct it learns is another place to read a
  different command from the one the shell runs (ADR-0008's history), for a
  guarantee the sandbox gives outright where it runs.
- **Run every planner command sealed, and drop the classifier where a sandbox
  runs.** Rejected: cloud CLIs and `gh` need the network and the user's
  credentials, and sealing them breaks the reads ADR-0026 exists for.
- **Sealed runs off by default on macOS until the egress proxy (#88).**
  Rejected by the maintainer on 2026-10-21, with the three residuals above
  known. A value read through them still needs a later step with the network
  to leave the machine, and that step goes through the envelope's checks
  (above). And sealed runs are what lets the planner loop and run a script on
  macOS: without them every refusal there is a refusal again, which is the
  problem this ADR starts from. The residuals are stated instead, in
  SECURITY.md with advice for macOS users, and closed where they can be by
  the proxy and a container or VM backend.
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
  sealed run there still has the three residuals above: what the user's other
  processes hold in their command lines and environments, their launchd jobs,
  and the shared here-document files. No Seatbelt rule closes them; Linux's
  PID and mount namespaces leave a sealed run none of them. SECURITY.md says
  so to macOS users.
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
- 2026-10-21 — the three macOS residuals recorded (other processes' command lines and environments, existing launchd jobs, the shared here-document files), and sealed runs kept on by default there.
