# Security Policy

## Reporting a vulnerability

**Please do not open a public issue.**

Report privately through GitHub's
[Security Advisories](https://github.com/ordewell/ordewell/security/advisories/new)
for this repository. That gives us a private thread and a CVE if one is warranted.

You can expect:

- An acknowledgement within **3 working days**.
- An assessment, with a fix or a rejection and the reasoning, within **14 days**.
- Credit in the advisory and the release notes, unless you'd rather not be named.

Please give us a reasonable window to ship a fix before disclosing publicly.

## Supported versions

Ordewell is pre-1.0 and moves quickly. Only the latest released version is
supported; fixes ship forward rather than being backported.

## What is in scope

Ordewell runs on a developer's own machine and drives coding agents against
their own repositories. The parts most worth your attention:

- **The read-only exploration envelope.** The planner researches your workspace
  but must not write to it, and must not read outside it without asking. Any way
  to make the planner mutate the workspace, or silently reach outside it, is a
  vulnerability. The design is in
  [ADR-0008](docs/adr/planner-envelope/0008-planner-exploration-envelope.md) and the classifier
  is `packages/core/src/services/commandPolicy.ts`.
- **Command policy bypass.** Prompt content that gets a would-be-refused command
  classified as safe.

  The classifier is a denylist over a real shell, not a substitute for an
  OS-level sandbox: it decides which commands the planner's shell may run, but
  it cannot make that shell incapable of harm, because every binary it permits
  keeps its own ability to execute programs and write files. `git`, `find` and
  `jq` are all Turing-complete enough to be misused by an argument the
  classifier didn't anticipate. Widening the auto-run set or fixing a
  classification gap therefore changes *which* commands are trusted, never
  *whether* trust in the classifier is well-founded — that second question is
  [ADR-0011](docs/adr/planner-envelope/0011-sandboxing-the-planners-shell.md). That ADR is
  accepted: on Linux (bubblewrap) and macOS (Seatbelt), the planner's commands
  will run under a read-only sandbox beneath the classifier. Until that ships,
  and on platforms without a sandbox, the classifier is the only barrier.
  Bypasses of the classifier remain in scope here and will be fixed as they're
  found; documenting the limit is not a decision to stop fixing them. Don't
  rely on this classifier as the only barrier between the planner and
  untrusted content in a repository — a hostile `README.md` or commit message
  the planner reads during research should not be assumed contained by it
  alone.
- **The local API server.** `@ordewell/web` binds `127.0.0.1` and, since
  `0.4.8`, authenticates every request against a bearer token minted at daemon
  startup and written to an owner-readable file; browser `Origin` headers are
  rejected outright and `Host` must name loopback at the daemon's own port.
  Local access is explicitly *not* assumed to be trusted. Anything that makes
  the daemon reachable off-host, that lets a web page in a browser reach it
  (DNS rebinding, permissive CORS), or that gets a route to serve a request
  without a valid token — on the HTTP routes or the WebSocket upgrade — is in
  scope.
- **Credential handling.** API keys are read from the environment and `.env`.
  Any path that writes a key to a log, an error message, a session file under
  `.ordewell/`, or a runner's argv is in scope.
- **Built-in runner manifests and connectors.** Injection through launch,
  mode, environment or discovery configuration is in scope. External plugin
  manifests are ignored and are not loaded or executed.

## What each part can touch

What is true today, without containers. Nothing here is an OS-level sandbox
except where [ADR-0011](docs/adr/planner-envelope/0011-sandboxing-the-planners-shell.md) says so.

- **Planners, research subagents and the supervisor only read.** They read the
  workspace and the output their own runner saved for them this session, inside
  the exploration envelope. Web reads go through the web-read policy; anything
  else outside the envelope is asked about in Guarded and refused in Full. They
  never write, and they never run the repository's own configuration (hooks,
  project MCP servers, plugins)
  ([ADR-0008](docs/adr/planner-envelope/0008-planner-exploration-envelope.md),
  [ADR-0026](docs/adr/planner-envelope/0026-one-envelope-for-every-planner.md),
  [ADR-0027](docs/adr/planner-envelope/0027-web-reads-in-the-planner-envelope.md),
  [ADR-0028](docs/adr/planner-envelope/0028-planners-never-run-repository-config.md),
  [ADR-0032](docs/adr/planner-envelope/0032-runner-state-outside-the-workspace.md)).
- **Change and ops tasks run as you**, with the runner's own native tools, in
  the mode their plan assigned
  ([ADR-0020](docs/adr/isolation/0020-ops-tasks-and-merge-gates.md)). They can read and
  write outside the workspace (caches, temporary folders, your home directory)
  and reach the network; nothing at the OS or network layer bounds them yet. A
  change task works in its own git worktree. An ops task runs in your checkout,
  after a merge gate has put what it depends on there.
- **Read-only tasks use their runner's own read-only mode**
  ([ADR-0031](docs/adr/routing/0001-autonomous-mode-resolution.md#the-planner-says-read-only-not-a-mode-adr-0031)). That
  mode differs by runner; Claude Code's plan mode, for example, may save notes
  in its own config folder. A task's result is its `task_complete` report,
  which Ordewell stores with the verdict.

In practice:

- Use **Guarded** for repositories you do not trust.
- Review the plan before it runs. Approving it is the consent point; the
  tasks then do what it says.
- Ops tasks are where effects on the outside world happen: pushes, deploys,
  cloud commands.

Planned, not yet built:

- A network egress guard for runners
  ([#90](https://github.com/ordewell/ordewell/issues/90)).
- An opt-in container setup with a credential broker and egress proxy
  ([#93](https://github.com/ordewell/ordewell/issues/93),
  [#99](https://github.com/ordewell/ordewell/issues/99)).
- Read-only tasks defined by Ordewell rather than by each runner's mode
  ([#104](https://github.com/ordewell/ordewell/issues/104)).

## What is out of scope

- The behaviour of the coding agents Ordewell spawns (Claude Code, Codex,
  OpenCode). Report those to their maintainers.
- Ordewell executing a task you asked it to execute. Running agents against your
  code is the product, not a flaw — the boundary that matters is the *planner's*
  read-only envelope.
- Vulnerabilities in dependencies with no exploitable path through Ordewell.
  Send a PR bumping the dependency instead.

Task autonomy is a related but separate boundary, and it's a user setting, not
a security control this policy governs. Some autonomy levels let a task run
without per-step confirmation; the consent gate for that is plan review —
approving a plan is the decision that authorizes what it goes on to do. Once a
plan is approved, executing it is out of scope here for the same reason the
bullet above is: a runner doing what an approved plan says is the product
working, not a boundary failing. Report a way to get a plan approved, or
autonomy granted, without the user actually doing so; don't report an approved
plan's runner behaving as planned.
