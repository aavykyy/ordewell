# 0032 — Runner state outside the workspace

**Status:** accepted — amends [ADR-0008](0008-planner-exploration-envelope.md), [ADR-0026](0026-one-envelope-for-every-planner.md) and [ADR-0028](0028-planners-never-run-repository-config.md)

## Problem

Each runner keeps some state of its own outside the repository, and tells the
model about it. Two kinds reached Ordewell's planners:

- **Memory.** Claude Code's auto-memory lives under
  `<CLAUDE_CONFIG_DIR>/projects/<project>/memory/`. The CLI puts its index,
  `MEMORY.md`, and instructions for using it into the system prompt. Codex
  has a memory feature too (`features.memories`), built from past sessions.
- **Saved tool output.** A tool result too long for the context is saved to a
  file, and the model is told to read it back. Claude Code saves to
  `<CLAUDE_CONFIG_DIR>/projects/<project>/<session>/tool-results/`. OpenCode
  saves to `~/.local/share/opencode/tool-output/`, one folder shared by every
  session and project.

Both sit outside the workspace, so a planner's read of them is an outside
read: Guarded asks, Full refuses. Since ADR-0028 every Claude planner read is
asked, so this now covers Claude's saved output too. Before ADR-0028 the CLI
allowed that read itself. The live session logs show the effects:

- A Claude planner in Full had the memory index in its prompt, and every read
  of a file it listed was refused; it retried eight times.
- A saved result could not be read back, so the planner worked from the
  2KB preview.

A third gap sat next to these. A planner with no approval channel (the
one-shot planner) had every runner read refused, even inside the workspace,
because the envelope refused before it looked at the path.

## Decision

**A runner's own memory is off in every Ordewell run, planner and task alike.
A planner reads what its runner saved for it this session as it reads the
workspace. The workspace and that saved output are read even when nobody can
be asked.**

### Memory is off

| Runner | How |
|---|---|
| Claude Code | `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1` in the process environment. It wins over a setting that turns memory on, and the CLI then leaves the memory instructions and index out of the system prompt. |
| Codex | `codex app-server -c features.memories=false`, on the process: the flag covers both reading memories into a thread and building them. |
| OpenCode | Nothing to do: it has no memory of its own. |

There is no setting to turn it back on. A plan or a task then depends on the
repository and the user's own instruction files, which every runner still
loads: user-level `CLAUDE.md` and `AGENTS.md` (ADR-0028). It does not depend
on notes outside the repository that no reviewer sees, that differ by runner,
and that go stale: the note behind the live failure already pointed at an old
commit. A runner's memory outside Ordewell is untouched.

Ordewell does not add a memory of its own. What the notes held is already
reachable: the roadmap in issues, the current state in `git log` and the
changelog, and lasting know-how in skills, committed for every runner
(ADR-0024). A note that every later planner reads is also one more place a
bad or injected instruction could persist. If planners clearly miss context,
a project memory can be designed then, committed in the repository.

### A planner reads back its own saved output

Each adapter answers one question, `savedOutput(abs)`: is this resolved path
output its runner saved for this session? A read the answer covers is part of
the envelope, like the workspace: it never asks, in any mode, and an `!`
allowlist exclusion does not apply to it.

| Runner | What it covers |
|---|---|
| Claude Code | The folder `<CLAUDE_CONFIG_DIR>/projects/<any>/<session>/tool-results/`, for the session id the CLI reported. That id is unique to the planner's session, and `--resume` keeps it, so the folder holds nothing else. The project segment is the CLI's own name for the working directory, so any is accepted. |
| OpenCode 2.x | Only the exact files this session's results named. A saved result carries `metadata.truncated: true` and `metadata.outputPath`. Its `external_directory` request names only the folder, so it is matched to the `read` call it came from, whose `path` names the file. The folder itself is never covered: other sessions' and projects' output is in it. |
| OpenCode 1.x | Nothing: its saved output was not checked, so a read of it is asked about as any outside read. |
| Codex | Nothing: it shortens a long result in place and saves no file. |

Safeguards:

- The path is resolved on disk before it is judged, so a link planted in the
  folder is judged where it points, and that is an ordinary outside read.
- Only reads. Planners never write (ADR-0026).
- Nothing is assumed about a layout the runner did not report. If a runner
  version moves its folder or renames its fields, the rule matches nothing,
  and the read is asked about or refused as before.

The saved file holds output the planner was already given in part. Its tool
call passed the envelope before the runner saved it.

### Nobody to ask

The envelope judges a read before it looks for an approval channel. Without
one, a read inside the workspace or of the session's saved output is allowed,
and everything else is refused as before.

## Key properties

- Memory never enters a run, so a plan does not depend on which runner made it.
- Nothing becomes readable that the runner did not save for this session.
- The workspace and saved output read the same in Guarded, Full, an explicit
  allowlist mode and a one-shot planner.
- A change in a runner's layout fails closed.

## Considered options

- **Let planners read memory, read-only.** Rejected: it keeps a
  runner-specific source of context, which goes stale, and gives every later
  plan a note it trusts. Read-only access also does not stop the CLI's
  instructions to write to it.
- **A setting to keep a runner's memory on.** Rejected: nobody asked for it,
  and on a planner it would bring back the half-loaded index unless the
  envelope also opened the memory folder.
- **An Ordewell project memory now.** Deferred, as above.
- **Treat the saved-output folder as a standing approval** (logged, and
  switchable by `!`). Rejected: nobody has a reason to exclude a copy of
  output the planner already had, and workspace reads are not logged either.
- **Allow OpenCode's whole tool-output folder.** Rejected: it is shared by
  every session and project.
- **Page Ordewell's own tools' output so nothing is saved.** Not needed for
  this: the runners' limits are their own and change, and their own tools
  save too. It stays open as an improvement of its own.
- **Leave it.** Rejected: the planner retries a refused read, and loses the
  output it was told to read.

## History

- 2026-10-13 — accepted after live checks on Claude Code 2.1.296, codex-cli
  0.162.1 and OpenCode 2.0.27:
  - Claude: with a marker note in a scratch project's memory, `-p` saw it
    with memory on, and neither it nor the memory section with
    `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1` or `autoMemoryEnabled: false`, nor
    with the variable set over `autoMemoryEnabled: true`. A 340KB result was
    saved under `<session>/tool-results/` and read back unasked; with a
    `Read` ask rule the read was refused. `--resume` kept the session id.
  - Codex: `-c features.memories=…` changes the flag `codex features list`
    reports; long output is shortened in place.
  - OpenCode: a 60,000-line MCP result was saved to `tool-output/tool_<id>`,
    named in `session.tool.success` as `metadata.outputPath`. A `read` of it
    under the planner's rules raised `external_directory` for the folder,
    after the `session.tool.called` that named the file; once allowed, the
    read returned the file.
- 2026-10-13 — implemented, and checked live through Ordewell's own Claude
  Code planner (2.1.296, Haiku) under an allowlist-only approval policy with
  nobody to ask: a 1.1MB Grep result was saved under the session's
  `tool-results/`, the planner read it back twice and answered from its last
  line, and no outside-read decision was made.
