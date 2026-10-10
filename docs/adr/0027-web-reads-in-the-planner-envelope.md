# 0027 — Web reads in the planner envelope

**Status:** accepted — amends [ADR-0026](0026-one-envelope-for-every-planner.md), [ADR-0008](0008-planner-exploration-envelope.md) and [ADR-0011](0011-sandboxing-the-planners-shell.md)

## Problem

ADR-0026 put every planner inside one envelope so that what a planner may do
no longer depends on which CLI is planning. Web reads, a fetch or a search,
were left out of it, and each planner answers them differently:

- **Claude Code** raises `WebSearch` as `can_use_tool`, but `plannerAsk`
  (`ClaudeCodeAdapter.ts`) knows only MCP tools, `WebFetch` and path tools, so
  a search falls to kind `other` and is denied with `READ_ONLY_DENIAL` — "the
  planner is read-only: it changes no files", which is not why it was denied.
- **OpenCode** has `websearch` (and `codesearch`) set to `allow` in its
  planner policy (`openCodeOrdewell.ts`), so a search never reaches the
  approval seam at all.
- **API planners** call Ordewell's own `web_search`, which goes through the
  approval policy; in Full, `effectiveApprovalMode` turns `auto` into `deny`,
  so every search and every fetch is refused.

Three planners, three answers: the drift ADR-0026 was written to stop.

Full cannot fetch anything at all. A Full planner asked to plan an upgrade
cannot read the library's changelog or migration guide, while the Full tasks
it plans run with unrestricted network. The level that is meant to need
nobody is the one that cannot look anything up.

What the envelope does permit is weaker than it reads:

- **The SSRF guard has gaps.** `HttpWebFetcher.isPrivateIp` matches a few
  string prefixes. It misses IPv4-mapped IPv6 in the form WHATWG `URL`
  serializes it to — `[::ffff:a9fe:a9fe]` is 169.254.169.254, the cloud
  metadata address, and `[::ffff:7f00:1]` is loopback — as well as
  100.64.0.0/10, fc00::/7, 0.0.0.0/8, 64:ff9b::/96 and multicast. It checks
  only the first DNS answer, and `fetch` resolves the name again when it
  connects, so a name that answers public to the check and private to the
  connection (rebinding) gets through.
- **OpenCode's `webfetch` follows redirects itself.** Ordewell vets the first
  URL; the address OpenCode ends up at is never seen.
- **`curl` and `wget` through `run_command` are approved per program.** An
  approval is scoped to `curl`, so one "yes" covers every site afterwards.
  No SSRF check runs on the host, and `-o`, `-O` and `wget`'s default
  download write files but classify as `ask`, not `refuse` — an approval can
  write.

And search does not scale. Ordewell's search scrapes DuckDuckGo's lite page,
which is built for people and pushes back on automated traffic, so it does not
hold up when many planners search at once. Research subagents get neither
`fetch` nor `web_search` (`SUBAGENT_EXCLUDED` in `researchTools.ts`), because
both could prompt and a subagent never may (ADR-0008, T6).

## Decision

**Every planner web read, a fetch or a search on any runner, is decided by one
Ordewell web-read policy. The bytes travel the cheapest path that is still
trustworthy: provider-side search and Claude's `WebFetch` stay native, and
Ordewell's own `fetch` and `web_search` carry the rest.** Full allows web
reads without asking; nothing else in Full changes.

### Decide centrally, carry natively

| planner | search | fetch |
| --- | --- | --- |
| Claude Code | native `WebSearch`, asked as kind `search` | native `WebFetch`, asked as kind `fetch` |
| Codex | native `web_search`, set from the policy at thread start | Ordewell `fetch` (MCP tool) |
| OpenCode | Ordewell `web_search` (MCP tool) | Ordewell `fetch` (MCP tool); native `webfetch` denied |
| API | Ordewell `web_search` | Ordewell `fetch` |

- **Claude Code.** `plannerAsk` gains a `search` kind for `WebSearch`, so it
  reaches the policy instead of the read-only denial. `WebSearch` runs at
  Anthropic, which already holds the conversation the query came from.
  `WebFetch` stays native because it does not follow a redirect to another
  host: it hands the new URL back, and fetching it is a new request the policy
  decides. It stays native only while that holds; the live check confirms it
  on the version in use.
- **Codex.** `web_search` runs at OpenAI and raises no permission request, so
  the policy cannot decide it call by call. It is set when the planner thread
  starts: on where the policy would allow a search without asking, off
  otherwise, and then the planner searches through Ordewell's `web_search`,
  which can ask. What the implementation verifies about it on the running
  codex-cli — which mode a planner thread gets, and whether that mode opens
  pages the model chose — is recorded with it; if live mode opens
  model-chosen URLs, planner threads pin it to the cached mode. Codex's shell
  has no network (ADR-0026), so it fetches through Ordewell's `fetch`.
- **OpenCode.** `webfetch` is denied: OpenCode follows redirects itself, and
  Ordewell would vet only the first URL. `websearch` and `codesearch` leave
  `allow` and are denied too; they send the query to a third party just as
  Ordewell's search does, and Ordewell's tools are the path the policy
  decides.
- **Ordewell's tools for harness planners.** The Ordewell MCP server's planner
  tools gain `fetch` and `web_search`, the same tools the API planner has,
  behind the same policy. Every harness pre-authorizes the server's tools
  (ADR-0022), so the policy, not the harness, decides each call.

### The policy

| approval mode | fetch | search |
| --- | --- | --- |
| `auto`, Guarded | asks once per origin | asks once per session |
| `auto`, Full | allowed without asking | allowed without asking |
| `ask` | asks once per origin | asks once per session |
| `allowlist` | only an origin the allowlist names; otherwise refused | refused |
| `allow` | allowed | allowed |

- **An `!` exclusion wins in every mode.** `!https://internal.example.com/*`
  holds in Full as it does in Guarded.
- **The allowlist still applies in every mode,** so a scope pattern
  (`https://docs.example.com/*`) lets a Guarded fetch run without asking.
- **The policy reads the configured setting, not only the effective mode.**
  `effectiveApprovalMode` maps Full's `auto` and an explicit `allowlist` to the
  same `deny`; the web-read policy has to tell them apart, because only the
  first allows web reads.
- **This narrowly revisits "Make Full autonomy `allow`"**, which ADR-0026
  rejected, for web reads only. A web read changes nothing: it is a GET or a
  HEAD sent by Ordewell, with nothing of the user's attached. The Full tasks
  the planner plans already have the network, so refusing the planner the same
  reads protects nothing they cannot reach. And a planner that cannot read
  documentation plans an upgrade by guessing, which ADR-0008 already rejected.
  Every other command stays on the allowlist in Full; an effect is still an
  ops task.

### Safety that does not depend on a person

In Full nobody sees a web read before it happens, so what guards it has to
hold without one:

- **A hardened SSRF guard, with the connection pinned to the vetted address.**
  The guard parses the address rather than matching strings: IPv4-mapped and
  NAT64 IPv6 are unwrapped and judged as the IPv4 they carry; loopback,
  link-local, private, shared (100.64.0.0/10), unique-local (fc00::/7),
  unspecified, 0.0.0.0/8 and multicast are blocked. Every DNS answer is
  checked, and the connection goes to an address that passed, so a second
  resolution cannot swap it. This is required, and it applies to every
  redirect hop, not only the first URL.
- **GET or HEAD only, with nothing attached.** Ordewell sends no credentials,
  cookies or auth headers of its own.
- **An outbound secret check on every URL and every query.** It looks for the
  secrets Ordewell holds (task and planner tokens, provider keys), the values
  of sensitive environment variables, and well-known token formats. A hit is
  refused. Encoding defeats it: a secret in base64, reversed or split across
  requests passes. It narrows exfiltration through a URL; it does not close
  it.
- **Per-planner request budgets.** Fetches and searches are counted per
  planner; past the budget they are refused with a message the planner can
  report.
- **Every decision is recorded in the research log**: what was asked, the path
  that carried it, and why it was allowed or refused (mode, grant, allowlist,
  exclusion, SSRF guard, secret check, budget), so the timeline shows it in
  every surface.

### Search backends

Search goes through a pluggable search provider: DuckDuckGo stays as the
zero-configuration fallback; the Brave Search API and a self-hosted SearXNG
are the others.

- **Configured from user-only settings,** never from the repository, as
  ADR-0026 and ADR-0016 do for the approval settings: a VS Code user setting
  that a workspace cannot override, or an `ORDEWELL_` variable refused from a
  workspace's environment files. An API key is a secret, and an endpoint the
  repository could choose would receive every query.
- **The configured endpoint is the only address that skips the SSRF guard,**
  because a self-hosted SearXNG usually sits on a private address, and the
  user, not the planner, named it. It is used for the search call alone,
  never for a fetch.
- **A shared, short-lived cache of public responses.** Results and pages
  fetched without credentials, and not marked private by the response, are
  shared between planners for a short time. A cache hit still passes the
  policy: a page cached for one session is not read by a Guarded session that
  has not been granted its origin, and an excluded origin is excluded from
  the cache too.

### Research subagents

Research subagents get `fetch` and `web_search`, and still never prompt
(ADR-0008, T6):

- **In Full,** without condition beyond the policy: nothing would prompt.
- **In Guarded,** only an origin already granted in the session or covered by
  the allowlist, and search only once the session has granted it. Anything
  that would ask is refused, with the message to report the gap in the
  digest.

### `curl` and `wget` in `run_command`

- **Approval is per origin.** The scope is the program and the origin
  (`curl https://api.github.com/*`), so approving one site approves no other,
  and a command naming several origins asks for each in one prompt (ADR-0008).
- **The host passes the SSRF guard** before the command is asked about.
- **Flags are a positive list.** Only flags known not to write, send data or
  read a config run; any other flag refuses. So `-o`, `-O`, `--output-dir`,
  `-D`, `-c` and the trace and save flags are refused, and so is `wget`
  unless its output is standard output.
- **Data and credential flags ask every time** and are never remembered:
  `-d` and the `--data` family, `-F`, `-T`, `-u`, `-H`, `-b`.
- **Following redirects asks every time,** since the origin it reaches is not
  the one approved: `curl -L`, and `wget` unless redirects are turned off.
- **Startup files are not read.** The run disables `.curlrc` and `.wgetrc`,
  which a workspace environment (ADR-0016) could otherwise point at a file the
  repository ships.
- **In Full, `curl` and `wget` stay refused,** whatever the allowlist says.
  Every planner has a vetted `fetch`, and a command line's redirect, resolve
  and config surface is not something an allowlist rule can bound.

### Phase 2: filtering at the network

Planned, not decided here in code: an egress filtering proxy, reachable
through ADR-0011's sandbox network namespace, as the only route out of it.
Redirects, rebinding, `curl`, the native tools and, later, runners would then
be guarded where the connection is made, not only where a URL is read. It is
filed as its own issue.

## Key properties

- **One policy for every planner.** Whether a web read runs no longer depends
  on which CLI is planning; only how its bytes travel does.
- **Full reads; it still does not act.** Web reads are the only thing Full
  gains. Commands, MCP tools and paths keep ADR-0026's allowlist, and `curl`
  stays refused.
- **Absent is denial (T5).** A Guarded web read with no approval channel, a
  dismissed card or a timeout is refused, as before.
- **The secret check narrows, it does not close.** A Full planner that read
  an injected instruction can still put data in a URL, encoded past the check,
  to an origin the injection named. The tasks it plans already have that
  channel; budgets and the research log bound and record it.
- **The native paths keep residuals until phase 2.** The pinned connection is
  Ordewell's: Claude's `WebFetch` resolves the host itself, so rebinding
  against it is open, and the provider-side searches run where Ordewell cannot
  see them.
- **The cache never widens the policy.** Every hit is decided as a fetch or a
  search would be.
- **Nothing here widens the shell (ADR-0011, B7).** `curl` and `wget` are
  narrower than before; the sandbox is not a reason for more `auto` commands.

## Considered options

- **Route all web traffic through Ordewell's fetcher.** Rejected: it
  centralizes every byte every planner reads in one process, which is the
  wrong shape at fleet scale, and it gives up provider-side search, which
  carries the provider's own ranking and summaries.
- **Keep Full web-less.** Rejected: it leaves the level meant to run alone
  unable to read documentation, while its tasks have the network.
- **Allow `curl` in Full, with its flags parsed.** Rejected: redirects,
  `--resolve`, `--connect-to`, proxies, config files and URL globbing are too
  large a surface to bound by parsing a command line, and a vetted `fetch` is
  already there.
- **Rely on approvals.** Rejected: an approval is a person, and an autonomous
  fleet of planners has none to ask. The guards above have to hold without
  one.
- **Keep OpenCode's `webfetch`, vetting its first URL.** Rejected: OpenCode
  follows redirects itself, so the check would not see the address that is
  read.

## History

- 2026-10-10 — accepted: one web-read policy for every planner, Full allows
  web reads, hardened SSRF guard with pinned connections, outbound secret
  check, pluggable search providers, web reads for research subagents,
  per-origin `curl`/`wget`; an egress proxy planned as phase 2.
