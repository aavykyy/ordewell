<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="assets/readme/logo-dark.png">
    <img src="assets/readme/logo-light.png" width="380" alt="Ordewell">
  </picture>
</p>

<p align="center">
  <strong>Task orchestration for coding agents.</strong><br>
  Turn a goal into an editable plan. Run it with your coding agents. Review and merge.
</p>

<p align="center">
  <a href="https://ordewell.ai"><strong>Website</strong></a> ·
  <a href="https://ordewell.ai/docs">Documentation</a> ·
  <a href="https://ordewell.ai/news">News</a>
</p>

<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-Apache_2.0-blue.svg" alt="License: Apache 2.0"></a>
  <a href="https://www.npmjs.com/package/@ordewell/cli"><img src="https://img.shields.io/npm/v/@ordewell/cli" alt="npm"></a>
  <a href="https://github.com/ordewell/ordewell/actions/workflows/ci.yml"><img src="https://github.com/ordewell/ordewell/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <a href="https://github.com/ordewell/ordewell"><img src="https://img.shields.io/github/stars/ordewell/ordewell?style=social" alt="GitHub stars"></a>
</p>

<p align="center">
  <img src="assets/readme/workflow.svg" width="900" alt="Describe your goal, review and edit the plan, run independent tasks in parallel with Claude Code, Codex and OpenCode, then review the diff and choose when to merge.">
</p>

Describe what you want to build. Ordewell explores your repository, asks clarifying
questions, and turns your goal into a plan you can read and edit. When you're ready,
run it: independent code tasks can work in parallel in separate worktrees when
worktree isolation is enabled. Review the combined diff and merge it into your
branch. By default, submitted build plans wait for your approval. Run settings
let you automate execution and merging.

Claude Code, Codex and OpenCode are supported out of the box, and can be mixed
freely within one plan.

This README describes 0.11.0. See the [published releases](https://github.com/ordewell/ordewell/releases)
for versions available to install and their release notes.

## Features

- **An editable plan.** Change any task's prompt, runner, model, effort or mode, add
  or remove tasks, and rewire dependencies without another round trip to the model.
- **Choose models per task.** Choose each AI task's model and thinking effort,
  and review every assignment before execution. Planning uses your selected
  planner model and counts against its usage too.
- **Worktree isolation for code tasks.** With isolation enabled, code tasks work
  in separate worktrees. Passing changes land on an integration branch for review
  and merging. Ops tasks run in your checkout.
- **Skills your team shares.** Write down how your team works once, as a skill in
  your repository. The planner attaches it to the tasks it fits, whichever agent
  runs them.
- **Operations in the right place and order.** A deploy, a cloud CLI call or a
  push runs as an ops task at the workspace root. With isolation enabled, it
  waits for the changes it depends on to be merged into your branch. When the
  planner can state the exact commands, it adds a script task: Ordewell runs it
  with no model, under your approval and run settings. You can review its body as
  written or pre-approve exact commands with the effect allowlist.
- **Completion is recorded.** An AI task's `task_complete` report with status
  `done` passes its completion check. Reports marked `failed` or `blocked`, or a
  runner exit without a report, do not pass. Script tasks use their exit status.
  This records the reported outcome; review the diff and test evidence before
  merging. Each task's log is available live.
- **Task handoffs.** Each task leaves a summary and optional numbered findings
  with evidence. Dependents get whole findings and can pull the full handoff;
  a loop's check sees what its fix claims and verifies it against the code.
- **A supervisor for the run.** The planner keeps watching after you approve a
  plan: at Watch it writes you a note when a task fails or gets stuck, and at Act
  it may retry, stop or edit tasks itself, within limits. `/settings` sets the
  supervisor level, merging automatically and the rest of your run settings.
- **Read-only tasks.** A review, an audit or a prototype lands no changes; its
  report is its result. With isolation enabled, it can test ideas through sealed
  commands in a throwaway worktree, without network or access to your home
  directory. Without isolation, its commands cannot write the workspace;
  commands needing sealing are refused if no sandbox is available. A task in a
  single-repository worktree can save a prototype as a patch for a later task.
- **Check-and-fix loops.** A check and the tasks that fix what it finds repeat
  until the check passes or its rounds run out, with no planner turn in
  between.
- **Research tasks.** A read-only task can be research: its report goes back to
  the planner, which wakes to read it while you keep talking. The planner
  decides how many to start, within the run's Parallel limit.
- **A planner that cannot write.** It reads, asks, and plans. Commands that would
  change your repository are refused, and an effect such as a push reaches the
  world only as a script task or an ops task in the plan.
- **No extra API key.** A coding agent you already pay for can be the planner. An API
  key from any of 25 providers works too, and an API planner compacts its own
  context before it overflows.
- **Your agents' limits in view.** The footers show what your Codex, Claude Code
  and OpenCode Go accounts have used of their plan's windows, beside context
  and cost.
- **Use it where you work.** A terminal UI, a VS Code extension, a CLI for scripts
  and a local API, all sharing one core.

## Installation

```bash
npm install -g ordewell
```

For VS Code, install [Ordewell from the Marketplace](https://marketplace.visualstudio.com/items?itemName=ordewell.ordewell)
or run `code --install-extension ordewell.ordewell`. In Cursor, Windsurf or VSCodium,
get it from [Open VSX](https://open-vsx.org/extension/ordewell/ordewell). The
extension bundles its own core and needs nothing from npm.

**Requirements:** Node.js 20.3 or newer, at least one of Claude Code, Codex or
OpenCode, and git for task isolation. On Windows, run the terminal UI under WSL.

## What Ordewell sends

Once a day, Ordewell asks ordewell.ai whether a newer version is out. The request
carries two things: the version you run and a random install ID, kept in
`~/.ordewell/version-check.json` and shared by the CLI and the VS Code extension.
The ID is replaced every 30 days. Nothing else is sent: no code, prompts, paths,
file names or account details. Like any server, ordewell.ai sees the IP address
the request comes from.

The first time Ordewell starts on a machine, it shows a notice saying this and
sends nothing. The first check happens on a later start. If Ordewell cannot write
that file, it shows no notice and never sends anything. When a newer version is
out, Ordewell shows one line naming it.

To turn the check off, set `ORDEWELL_NO_VERSION_CHECK=1` or `DO_NOT_TRACK=1`, or
turn off VS Code's telemetry for the extension. Turned off, Ordewell sends
nothing and writes no install ID.

## Quick start

Run `ordewell` in your project to open the terminal UI, then type a goal. The first
run lets you pick a planner and runners with `/planner` and `/runners`.

The same workflow is available from the command line:

```bash
export AI_PROVIDER=claude-code      # plan with Claude Code, Codex or OpenCode

ordewell plan --goal "Add rate limiting to the public API"
ordewell run
ordewell handoff review             # read the diff
ordewell handoff merge              # bring it onto your branch
```

Between `plan` and `run`, the plan is yours to edit:

```bash
ordewell task-runner 2 opencode     # move a task to another agent
ordewell task-model 3 sonnet        # or just change its model
ordewell task-deps 3 1,2            # make it wait for tasks 1 and 2
```

Tried it? [Tell us how your first run went](https://github.com/ordewell/ordewell/discussions/115).

## See it in action

<p align="center">
  <img src="assets/readme/hero-plan-to-run.gif" width="900" alt="A real run in Ordewell's terminal UI: a goal becomes a four-task plan, Claude Code, Codex and OpenCode run independent tasks in parallel, and a final verification task completes the plan. Sped up stretches are marked.">
  <br>
  <sub>A real run, sped up where marked. <a href="https://ordewell.ai/assets/demo.mp4">Watch the full 48 seconds</a>.</sub>
</p>

## How it works

1. **Describe your goal.** The planner explores your workspace without modifying
   it and asks clarifying questions.
2. **Review the plan.** Read the tasks and their dependencies. Edit prompts, agent
   assignments and models before execution. To automate execution, turn autorun
   on in `/settings` and submitted build plans start automatically. Script tasks
   still follow their consent rules.
3. **Run the tasks.** Each AI task starts a coding agent session; script tasks
   run their commands without a model. Independent tasks run in parallel;
   dependent tasks wait for the work they need. With worktree isolation enabled,
   code changes stay on separate branches. Follow each task's progress live.
4. **Review and merge.** Ordewell combines the changes for your review. Read the
   diff and test evidence, then merge into your branch or discard the run. You
   can also enable automatic merging or allow an Act supervisor to merge in
   `/settings`. If a task or a merge needs your attention, Ordewell shows you where.

Autorun and automatic merging are off by default, and the supervisor starts at
Watch. During planning, research tasks can start without build-plan approval,
and script tasks can run with consent under your approval and run settings.

The commits Ordewell writes (a task's merge, work a task left uncommitted, a
conflict repair, the merge into your branch) end with a `Planned-with: Ordewell`
line, a git trailer that `git interpret-trailers` reads. Commits a coding agent
made itself are not changed. To leave the line out, run `ordewell trailer off`
(or set `"plannedWithTrailer": false` in `settings.json`); the next commit
follows it.

The planner only reads; tasks run as you, in the mode the plan assigns. A new
installation starts in Guarded, where a task gets its runner's safe mode; Full
gives it the runner's autonomous mode. For exactly what each part can touch and
what to use for untrusted repositories, see
[SECURITY.md](SECURITY.md#what-each-part-can-touch).

Without a git repository, or when isolation is disabled, tasks share the workspace
folder. With isolation enabled, a code task in a workspace containing several
repositories gets a worktree of each isolated repository; its changes land in all
of them or none. Ops and script tasks run at the workspace root. Dependencies,
environment files and loose files beside a repository group can still be shared
between worktrees. See
[isolation and handoff](https://ordewell.ai/docs#isolation) for details.

## Documentation

The [documentation](https://ordewell.ai/docs) covers the planner options, skills,
commands, configuration and platform notes. Design decisions, including the options
that were rejected, are recorded as [architecture decision records](docs/adr/), and
[CONTEXT.md](CONTEXT.md) defines the project's vocabulary. To write your own
planner or task skills, see the [skills guide](docs/skills.md). If Codex's
sandbox cannot start on your machine, see [troubleshooting](docs/troubleshooting.md).

## Where it's going

- **Next:** bounded, standing consent for running on its own ([#23](https://github.com/ordewell/ordewell/issues/23)), an escalation inbox across surfaces ([#30](https://github.com/ordewell/ordewell/issues/30)) and a daemon that resumes plans after a restart ([#31](https://github.com/ordewell/ordewell/issues/31)).
- **In 0.11.0:** a planner that can start consented script tasks ([#107](https://github.com/ordewell/ordewell/issues/107)), read with a sandboxed shell that can loop and script ([#64](https://github.com/ordewell/ordewell/issues/64), [#109](https://github.com/ordewell/ordewell/issues/109)), keep talking while research tasks report back ([#111](https://github.com/ordewell/ordewell/issues/111)), and plan check-and-fix loops ([#118](https://github.com/ordewell/ordewell/issues/118)).
- **Shipped in 0.10:** the supervisor, which watches a run and, if you let it, acts within limits you set.

The full roadmap, and where to help, is in [#21](https://github.com/ordewell/ordewell/issues/21).

## Contributing

Contributions are welcome. Please read [CONTRIBUTING.md](CONTRIBUTING.md) for the
build order and project layout, and report security issues through
[SECURITY.md](SECURITY.md) rather than the public tracker.

## Acknowledgements

The grilling, spec, architecture and TDD skills are
adapted from [Matt Pocock's skills](https://github.com/mattpocock/skills) (MIT).

## License

Ordewell is licensed under the [Apache License 2.0](LICENSE). The Ordewell name and
logos are not covered by this license; see [NOTICE](NOTICE).
