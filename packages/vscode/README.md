# Ordewell for VS Code

**Plan once, run it across Claude Code, Codex and OpenCode, and review one branch.**
One goal becomes an ordered plan of tasks, each on the runner and model that fits it.
Nothing runs until you approve the plan.

![Ordewell in VS Code: a goal typed into the panel becomes a plan with a runner and model on each task, three tasks run in parallel, and the supervisor reports on the result (sped up in places)](https://raw.githubusercontent.com/ordewell/ordewell/main/assets/readme/vscode-panel-loop.gif)

## Features

- **An editable plan.** Every task carries a runner, model, thinking effort and
  mode. Change any of them, add or remove tasks, and rewire dependencies without
  losing completed work.
- **A planner that talks back.** It researches your workspace without modifying it,
  asks when your goal is vague, and then hands you the plan.
- **The right model for each task.** Assignments are made across the whole plan and
  shown to you before anything runs.
- **Isolated execution.** Each task works in its own git worktree, and passing work
  lands on one integration branch. A handoff card at the end lets you review the
  diff, merge it, or discard it.
- **Skills your team shares.** Write a skill once and commit it. The planner
  attaches it to the tasks it fits, and it shows as a chip on each task card.
- **Done means reported.** A task completes when its agent reports it done through
  Ordewell's own tools, never because a model thinks the work looks finished.
- **No extra API key.** Claude Code, Codex or OpenCode can be the planner, using the
  subscription you already have.

## Getting started

1. Install the extension.
2. Open the Ordewell panel from the activity bar.
3. Type a goal. With Claude Code, Codex or OpenCode installed, the first usable one
   plans for you with no API key. Choose another planner in the planner bar.
4. Review the plan, then approve it to run.

To plan with an API key instead, set `ordewell.openAiApiKey` (OpenRouter) or
`ordewell.apiKey` (Gemini), or export `OPENROUTER_API_KEY` or `GEMINI_API_KEY`. A key
you have set takes priority over the installed agent.

Each runner you want to use (Claude Code, Codex or OpenCode) must be installed and
on your PATH. If a runner appears greyed out right after installing it, reload the
window so the extension picks up the new PATH.

Skills are `SKILL.md` folders: type `/name` in the panel to load one into the
conversation, and attach task skills as chips on a task's card. See
[Writing skills](https://github.com/ordewell/ordewell/blob/main/docs/skills.md).

The Command Palette offers **Ordewell: Rewind Conversation**, **Fork
Conversation** and **Compact Conversation**. Isolation can be configured under
`ordewell.worktreeIsolation` and related settings.

## What the extension sends

Once a day, the extension asks ordewell.ai whether a newer version is out. The
request carries the version you run and a random install ID, kept in
`~/.ordewell/version-check.json` and shared with the command line. Nothing else
is sent: no code, prompts, paths, file names or account details. Like any
server, ordewell.ai sees the IP address the request comes from.

The first time Ordewell starts on a machine, the extension shows a notice saying
this and sends nothing. If it cannot write that file, it shows no notice and
never sends anything. The Marketplace handles updates, so the extension shows no
update line.

Turn it off by turning off VS Code's telemetry (`telemetry.telemetryLevel`).
`ORDEWELL_NO_VERSION_CHECK=1` and `DO_NOT_TRACK=1` turn it off too. Turned off,
nothing is sent and no install ID is written.

## Also available

The same project ships a command line and a terminal UI:

```bash
npm install -g ordewell
```

## Links

- [Documentation](https://ordewell.ai/docs)
- [Source code](https://github.com/ordewell/ordewell)
- [Report a bug](https://github.com/ordewell/ordewell/issues)
- [How did your first run go?](https://github.com/ordewell/ordewell/discussions/115) Tell us what worked and where you got stuck.

Licensed under the [Apache License 2.0](https://github.com/ordewell/ordewell/blob/main/LICENSE).
The Ordewell name and logos are not covered by this license.
