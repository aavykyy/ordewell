---
status: accepted
amends: ["0008", "0011", "0026"]
---

# 0027 — Web reads in the planner envelope

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
Ordewell's own `fetch` and `web_search` carry the rest.** Under `auto`, Full
and Guarded allow web reads without asking; nothing else in either level
changes. An explicit `ask` still asks.

### Decide centrally, carry natively

| planner | search | fetch |
| --- | --- | --- |
| Claude Code | native `WebSearch`, asked as kind `search` | native `WebFetch`, asked as kind `fetch` |
| Codex | native `web_search` (`cached`) where the policy would allow it unasked; otherwise Ordewell `web_search` | Ordewell `fetch` (MCP tool) |
| OpenCode | native `websearch` (and 1.x `codesearch`), asked as kind `search`; Ordewell `web_search` on 2.x with no search provider chosen | Ordewell `fetch` (MCP tool); native `webfetch` denied |
| API | Ordewell `web_search` | Ordewell `fetch` |

- **Claude Code.** `plannerAsk` gains a `search` kind for `WebSearch`, so it
  reaches the policy instead of the read-only denial. `WebSearch` runs at
  Anthropic, which already holds the conversation the query came from.
  `WebFetch` stays native because it does not follow a redirect to another
  host: it hands the new URL back, and fetching it is a new request the policy
  decides. It stays native only while that holds; the live check confirms it
  on the version in use. Claude Code raises `can_use_tool` only when its own
  rules say ask, so an allow rule — the user's, or one a repository commits
  to `.claude/settings.json` — would run a web read past the policy. The
  planner is launched with `--settings` ask rules for `WebFetch`, `WebSearch`
  and `mcp__*`; an ask rule beats an allow rule from any source,
  `--allowedTools` included, so every web read reaches the policy. Project
  settings no longer load at all
  ([ADR-0028](0028-planners-never-run-repository-config.md)).
- **Codex.** `web_search` runs at OpenAI and raises no permission request, so
  the policy cannot decide it call by call. It is decided once per planner
  spawn, before the planner's token is issued, so the thread's search and
  the token agree: on where the policy would allow a search through OpenAI
  without asking — `auto` at either level, `allow`, or a `web_search:openai`
  allowlist entry,
  and never past a `!web_search:*` exclusion or a zero budget — off
  otherwise, and then the planner searches through Ordewell's `web_search`,
  which can ask. The decision is asked again before every turn; when it
  changes, the planner is respawned on `thread/resume` with the new
  `web_search` and a new token, so a change of autonomy level, an exclusion
  or a budget of 0 reaches the next turn. Codex has four modes: `disabled`;
  `cached`, answered from an OpenAI-maintained index with no external
  access; `indexed`, which reaches out where the index gates it; and `live`,
  which retrieves without restriction and whose `openPage` and `findInPage`
  actions open URLs the model chose. A planner thread is pinned to `cached`
  when on, never to the `live` a full-access sandbox or a user's config
  would otherwise pick: a thread's `disabled` holds against a top-level
  `web_search = "live"` and the legacy `[tools] web_search`, and profiles
  cannot override it, since `app-server` refuses `--profile`. Each search's
  queries, and any page it opened or searched in, are shown in the research
  timeline. Because the query never reaches Ordewell, neither the secret
  check nor the budget applies to it. Codex's shell has no network
  (ADR-0026), so it fetches through Ordewell's `fetch`.
- **OpenCode.** `webfetch` is denied: OpenCode follows redirects itself, and
  Ordewell would vet only the first URL. `websearch` and `codesearch` stay
  native and ask, so the policy decides each as a search: without asking
  under `auto`, once per session under `ask`, with the secret check and the budget
  applied to the query. They send it to a third party — Exa in 1.x, and in
  2.x the search provider chosen in OpenCode, Exa unless another was picked
  — and the approval names that party. They stay native because a
  provider's own search carries its own limits, while Ordewell's DuckDuckGo
  search is a single scraped endpoint that would carry every OpenCode
  planner's searches alone. On 2.x with no search provider chosen,
  `websearch` asks the user to pick one through `question`, which a planner
  is denied, so the search ends "Web search cancelled" and the model takes
  it for a refusal. A 2.x planner session therefore reads the last config
  layer that sets `websearch` from `/api/config`; with no provider there,
  `websearch` and `codesearch` are denied on the session and its
  instructions name Ordewell's `web_search`. A provider picked in
  OpenCode's own UI lives in its database, out of the API's reach, so such
  a planner also searches through Ordewell. Every OpenCode planner is told
  to fall back to Ordewell's `web_search` when `websearch` fails or is
  cancelled.
- **Ordewell's tools for harness planners.** The Ordewell MCP server's planner
  tools gain `fetch` and `web_search`, the same tools the API planner has,
  behind the same policy. Every harness pre-authorizes the server's tools
  (ADR-0022), so the policy, not the harness, decides each call. For a
  harness planner they are fallbacks: their descriptions send the model to
  its own web fetch or web search first. What each runner is offered
  follows what it already has. A planner token can hide planner tools: they
  are left out of the list, refused when called, and left out of the
  runner's pre-allowed tools and instructions. Claude Code's token hides
  both, since offered both it took Ordewell's over its native `WebFetch` and
  `WebSearch`. Codex's token hides `web_search` while its native search is
  on and keeps `fetch` always. OpenCode is offered both: `fetch` because its
  `webfetch` is denied, `web_search` as the fallback above.

### The policy

| approval mode | fetch | search |
| --- | --- | --- |
| `auto`, Guarded | allowed without asking | allowed without asking |
| `auto`, Full | allowed without asking | allowed without asking |
| `ask` | asks once per origin | asks once per session per provider |
| `allowlist` | only an origin the allowlist names; otherwise refused | only a provider the allowlist names; otherwise refused |
| `allow` | allowed | allowed |

- **A fetch is scoped by origin, a search by provider.** A fetch's scope is
  `<origin>/*`; a search's is `web_search:<provider>`, where the provider is
  who receives the query: `anthropic` (Claude Code's `WebSearch`), `openai`
  (Codex's), `opencode` (OpenCode's `websearch` and `codesearch`) or
  `duckduckgo` (Ordewell's `web_search`). Allowlist entries use the same
  form, so `web_search:duckduckgo` lets Ordewell's search run without asking
  in every mode, `allowlist` included.
- **An `!` exclusion wins in every mode.** `!https://internal.example.com/*`
  holds in Full as it does in Guarded, and `!web_search:*` refuses every
  search on every runner, Codex's native one included.
- **Web reads can be turned off.** `!web_search:*`, `!https://*` and
  `!http://*` together refuse every web read; a web-read budget of 0 does
  the same. The planner allowlist setting and the CLI help say so.
- **The allowlist still applies in every mode,** so a scope pattern
  (`https://docs.example.com/*`) lets a fetch run without asking under `ask`.
- **The policy reads the configured setting, not only the effective mode.**
  `effectiveApprovalMode` maps Full's `auto` and an explicit `allowlist` to the
  same `deny`; the web-read policy has to tell them apart, because only the
  first allows web reads.
- **This narrowly revisits "Make Full autonomy `allow`"**, which ADR-0026
  rejected, for web reads only, and at both levels.

  Guarded asked once per origin and once per session per provider until
  2026-10-13. That prompt was the one check that needed a person, and it
  checked the least: it showed an origin, not what the URL carried, and was
  granted once per origin, so every read after it went unseen anyway. The
  guards below run on every read, and the tasks the same session runs read
  the web natively, without the planner's checks. A user who wants to see
  each new origin sets `ask`. A web read changes nothing: it is a GET or a
  HEAD sent by Ordewell, with nothing of the user's attached. The Full tasks
  the planner plans already have the network, so refusing the planner the same
  reads protects nothing they cannot reach. And a planner that cannot read
  documentation plans an upgrade by guessing, which ADR-0008 already rejected.
  Every other command stays on the allowlist in Full; an effect is still an
  ops task.

### Safety that does not depend on a person

Under `auto` nobody sees a web read before it happens, at either level, so
what guards it has to hold without one:

- **A hardened SSRF guard, with the connection pinned to the vetted address.**
  The guard parses the address rather than matching strings: IPv4-mapped and
  NAT64 IPv6 are unwrapped and judged as the IPv4 they carry; loopback,
  link-local, private, shared (100.64.0.0/10), unique-local (fc00::/7),
  unspecified, 0.0.0.0/8 and multicast are blocked. Every DNS answer is
  checked, and the connection goes to an address that passed, so a second
  resolution cannot swap it. This is required, and it applies to every
  redirect hop, not only the first URL.
- **DNS last.** A lookup is itself a request: `<data>.attacker.example`
  would leave through DNS even for a read that is then refused. So the
  checks that need no network run first — the secret check on the text as
  given, then the scheme and any literal address — then the exclusion, the
  budget and the approval, and only a read that passed all of them has its
  host resolved and every answer vetted.
- **A redirect to another origin is a new read.** Ordewell follows
  redirects itself, one hop at a time. A hop to the same origin is followed;
  a hop to another origin is put to the policy again, with its exclusion,
  grant and budget, so a redirect cannot carry a fetch past any of them. A
  redirect to a non-HTTP scheme, or from https to http, is refused.
- **GET or HEAD only, with nothing attached.** Ordewell sends no credentials,
  cookies or auth headers of its own.
- **An outbound secret check on every URL and every query.** It looks for the
  secrets Ordewell holds (task and planner tokens, provider keys), the values
  of sensitive environment variables, and well-known token formats. Environment
  references are identified by `_URL`, `_URI`, `_PATH`, `_FILE` and `_DIR`
  names, never by a slash or colon in a secret's value. A hit is
  refused, and recorded without the URL or query. Encoding defeats it: a
  secret in base64, reversed or split across requests passes. It narrows
  exfiltration through a URL; it does not close it.
- **A web-read budget per planner turn.** A session counts the fetches and
  searches of each planner turn — the planner's and its research subagents'
  together, every runner's path that reaches the policy, a cross-origin
  redirect hop included — against `plannerWebReadBudget`
  (`ORDEWELL_WEB_READ_BUDGET`), and a new turn starts a new count. A read is
  counted before its approval resolves, so reads raised in parallel cannot
  all pass at once, and given back if it is then refused; one its caller
  cancels after it was allowed keeps its count. Past the budget,
  reads are refused with a message the planner can report. A budget of 0
  turns web reads off. A read-only task's attempt counts its own reads
  against the same setting, apart from every planner turn and every other
  attempt (ADR-0046).
- **Every decision is recorded in the research log**: what was asked, the path
  that carried it, and why it was allowed or refused (mode, grant, allowlist,
  exclusion, SSRF guard, secret check, budget), so the timeline shows it in
  every surface.

### Search backends

Search is zero-configuration. A harness planner uses its provider's own search
— Claude Code's `WebSearch`, Codex's `web_search`, OpenCode's `websearch` —
which needs no setup and carries the provider's own limits. Ordewell's own
`web_search` serves API planners, and is the fallback for a harness planner
whose provider-side search the policy turned off. It goes through a small
internal provider seam whose only implementation today is DuckDuckGo's lite
endpoint, reached through the same pinned transport as a fetch; the seam exists
so a later backend is one class, not a refactor.

- **The provider names itself to the policy.** The provider id flows into the
  `search` decision, so `ask`'s once-per-session approval names the backend
  and says a third party receives the query.
- **A backend that pushes back is backed off.** A 429 or 403, an HTTP 202
  (lite answers 202 only to serve its challenge), or a results-less page
  carrying DuckDuckGo's challenge markup (`challenge-form`, `anomaly.js`,
  `anomaly-modal`) marks the provider unavailable for a short cooldown shared
  across sessions in the process, growing on repeated push-backs and reset by a
  successful search. The page is parsed first, and the markers are matched as
  markup, never as words, because lite echoes the query: a search for
  "recaptcha react" must not start a cooldown. Searches blocked together in
  one cooldown window count once. The cooldown is checked before the
  web-read policy, so a search that would only answer "temporarily
  unavailable" neither prompts an `ask` user nor spends budget; it answers at
  once — no request goes out — telling the planner to fetch a documentation URL
  it already knows. A plain parse miss on a 200 with no challenge markup is
  not a block.
- **A shared, short-lived cache of public responses.** Results and pages
  fetched without credentials, and not marked private by the response, are
  shared between planners for a short time. A cache hit still passes the
  policy: a page cached for one session is not read by an `ask` session that
  has not been granted its origin, and an excluded origin is excluded from
  the cache too. A page is keyed by the URL asked for, so a body another
  origin answered through a redirect is never cached; neither is a truncated
  one. The cache is bounded by entry count and by total bytes.

**Later.** Keyed search backends (the Brave Search API, a self-hosted SearXNG)
and provider-native search for API planners are deferred to their own issue.

### Research subagents

Research subagents get `fetch` and `web_search`, and still never prompt
(ADR-0008, T6):

- **Under `auto`,** at either level, without condition beyond the policy:
  nothing would prompt.
- **Under `ask`,** only an origin already granted in the session or covered by
  the allowlist, and search only once the session has granted it. Anything
  that would ask is refused, with the message to report the gap in the
  digest.
- **They share the planner's budget.** A subagent's reads go through the
  session's one policy and count toward the same turn.

### `curl` and `wget` in `run_command`

- **Approval is per origin.** The scope is the program and the origin
  (`curl https://api.github.com/*`), so approving one site approves no other,
  and a command naming several origins asks for each in one prompt (ADR-0008).
  The program is the lower-cased basename, with a trailing `.exe` removed,
  including under POSIX for Git Bash. Path-named executables (`./bin/curl`,
  `/usr/bin/curl`, `/tmp/wget`) are refused: the research shell resolves these
  clients by name from PATH, and a repository script cannot reuse their grants.
  Web scopes never match filesystem path patterns. Default command URL
  exclusions do not exclude this vetted scope
  form; explicit origin and command exclusions still win.
- **Every URL and value-taking flag passes the outbound secret check before DNS or approval.**
  The same helper and live held credentials as the web-read policy apply;
  refusals withhold the command and URL.
- **The host passes the SSRF guard** before the command is asked about.
  Unlike a fetch, its host is resolved before the approval, so the name of a
  command that is then declined has already been looked up. Curl receives a `--resolve host:port:address` entry for each URL hostname,
  using an address the guard vetted, with IPv6 addresses bracketed. The
  inserted entries follow the initial `-q`, and the final command is
  classified again with only those exact generated resolve values trusted.
  Caller-supplied `--resolve` stays refused. Curl's raw URL hostname must use
  only ASCII letters, digits, hyphens and dots, or be a bracketed IPv6 literal;
  IDNs and percent-encoded hosts are refused before URL normalization can
  make the vetted name differ from what curl reads.
- **Flags are a positive list.** Only flags known not to write, send data or
  read a config run without a fresh approval; the data and credential flags
  below are the exceptions, and any other flag refuses. So `-o`, `-O`,
  `--output-dir`, `-D`, `-c`, uploads (`-T`) and the trace and save flags are
  refused. The only curl output path admitted is `/dev/null`. `wget` refuses
  unless its output is standard output or it is `--spider`.
- **Data and credential flags ask every time** and are never remembered:
  `-d` and the `--data` family, `-F`, `-u`, `-H`, `-b`, `-e`, `--netrc`, a URL
  with userinfo, and `-X` other than GET or HEAD. Literal `--data-urlencode`
  with `-G` is a query; reading its data from a file still asks every time.
- **Following redirects asks every time,** since the origin it reaches is not
  the one approved: `curl -L`, and `wget` unless redirects are turned off.
- **Startup files are not read.** The run disables `.curlrc` and `.wgetrc`,
  which a workspace environment (ADR-0016) could otherwise point at a file the
  repository ships. Curl gets `-q` as its first argument; wget gets
  `--no-config`, `--no-hsts` and `--no-netrc` so its cache cannot write and its
  default credential file cannot attach credentials. Both clients disable
  environment-selected proxies. These flags are inserted before classification,
  so the classifier reads exactly the string that runs (ADR-0011, B6).
  Only GNU Wget 1.x is supported. Wget2 is refused, including when installed
  as `wget`: after approval, a config-disabled version probe redirects XDG
  paths to `/dev/null` and Windows `LOCALAPPDATA` to `NUL`, preventing the
  probe itself from creating a home directory. The probe follows certain
  literal `cd` targets; uncertain navigation refuses. Under cmd, probe words
  containing quotes, variable expansion markers or metacharacters refuse
  before any probe runs. The host used for verification has GNU Wget 1.21.4. An extracted
  GNU Wget2 2.1.0 reproduced writes to `.wget-ocsp` and `.wget-ocsp_hosts`
  under its XDG data directory with the old suppression flags. Its ordinary
  version probe also created the data directory; the redirected probe left
  the temporary home empty. Wget2's [database initialization and defaults](https://github.com/rockdaboot/wget2/blob/master/src/options.c)
  and [database saving](https://github.com/rockdaboot/wget2/blob/master/src/wget.c)
  include HPKP, OCSP and TLS-session storage beyond Wget 1.x's HSTS cache.
- **In Full and allowlist mode, `curl` and `wget` stay refused,** whatever
  the allowlist says.
  Every planner has a vetted `fetch`, and a command line's redirect, resolve
  and config surface is not something an allowlist rule can bound.
- **A refusal says where the work belongs.** A refused read sends the
  planner to its own web fetch tool — `WebFetch` for Claude Code, Ordewell's
  `fetch` for the rest — which the policy decides. A refused command that
  sends data or changes something (`-d`, `-T`, `-O`, `wget -P`, `--post-data`
  and the like) says the planner should not do it itself, and sends it to
  the plan as an ops task, with a change task beside it if it writes files.

### `git ls-remote` in `run_command`

- **A destination the command line spells out is refused,** not asked: a URL
  of any scheme, an address, an scp-style `host:path`, a
  `transport::address` or a path. Git connects through its own transport,
  which resolves the host itself and follows a redirect, so none of the
  guarantees above (an origin grant, the SSRF guard, a pinned address) can
  hold for it. The refusal names neither the command nor the destination.
- **A remote the repository configures asks, under its whole line.** The
  grant is the command as written, `-C`, flags, remote and patterns
  included. It is the whole line when anything else on it could pick the
  repository: a `cd` or `chdir`, a wrapper (`env -C`, `env -u HOME`), whose
  own words reach no scope, or any other command that asks, which may move
  the shell under a name no list holds (a cmd.exe drive switch, `cd..`). So
  `git ls-remote --heads origin` covers neither `upstream` nor `origin` of
  another repository, and an approval of another git command covers no
  listing. A silent read beside it (`| head`) leaves the grant its own.
  `git.exe`, as Git Bash names it, is held to the same rules.
- **Its remote and patterns pass the outbound secret check before approval,**
  as a web command's URL does: protocol v2 sends the patterns to the server
  as ref prefixes. The check reads the words as written, so a listing the
  shell rewrites first is refused: a variable, a substitution, a brace list,
  an unquoted glob or a `~` anywhere in it, `-C $DIR` included. A quoted
  pattern is sent as written and asks.

GNU Wget 1.x has no curl-style host-to-address override preserving the
original hostname for HTTP and TLS, so it still resolves again at connection
time. Curl pins the named URL hosts, but an explicitly approved redirect to
another host is still outside that pin set. A configured remote's address is
the repository's to choose and is not vetted before `git ls-remote` runs.
These residuals require phase 2.

### Phase 2: filtering at the network

Planned, not decided here in code: an egress filtering proxy, reachable
through ADR-0011's sandbox network namespace, as the only route out of it.
Redirects, rebinding, `curl`, the native tools and, later, runners would then
be guarded where the connection is made, not only where a URL is read. It is
filed as its own issue.

## Key properties

- **One policy for every planner.** Whether a web read runs no longer depends
  on which CLI is planning; only how its bytes travel does.
- **Reading is not acting.** Web reads are the only thing `auto` grants
  unasked. In Full, commands, MCP tools and paths keep ADR-0026's allowlist
  and `curl` stays refused; in Guarded, they still ask, `curl` included.
- **The envelope bounds the planner, not the work.** It governs what the
  planner does while it researches. Effects belong in ops tasks
  (ADR-0020), which run in the session's mode and keep every native
  capability of their runner: a Claude task loads the user's and the
  project's settings and MCP servers with no ask rule added and no tool
  hidden, a Codex task thread keeps its own `web_search` and config, an
  OpenCode task session keeps its own permissions, and no change or ops task passes
  through the web-read policy, the budget or `run_command`'s `curl`/`wget`
  rules. How an ops task is authorized beyond plan approval — the mandate,
  issue #23 — is deliberately out of scope here. Read-only tasks withhold
  native web tools and read through Ordewell's `fetch` and `web_search` under
  this policy, as a research subagent does: never asking, with a budget per
  attempt (ADR-0046).
- **Absent is denial (T5).** An `ask` web read with no approval channel, a
  dismissed card or a timeout is refused, as before.
- **The secret check narrows, it does not close.** A Full planner that read
  an injected instruction can still put data in a URL, encoded past the check,
  to an origin the injection named. The tasks it plans already have that
  channel; the budget and the research log bound and record it.
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
- **Deny OpenCode's `websearch` and `codesearch`, searching through
  Ordewell's `web_search`.** First chosen, then dropped: both already reach
  the policy once they ask, so denying them bought no control, and it moved
  every OpenCode planner's searches onto one scraped endpoint built for
  people.
- **Leave Codex's search mode to its defaults.** Rejected: a full-access
  sandbox or a user's config selects `live`, which opens pages the model
  chose with no guard Ordewell runs.

## History

- 2026-10-10 — accepted and implemented: one web-read policy for every
  planner, Full allows web reads, a hardened SSRF guard with pinned
  connections, the outbound secret check, a zero-configuration search
  (provider-native for harness planners, one internal DuckDuckGo provider for
  API planners and as fallback, with a shared back-off and cache), web reads
  for research subagents and per-origin `curl`/`wget`; an egress proxy planned
  as phase 2. OpenCode's `websearch` and `codesearch` stay native instead of
  being denied, and Codex's modes were verified on codex-cli 0.162.0.
- 2026-10-11 — reconciled with what shipped and checked live (Claude Code
  2.1.296, codex-cli 0.162.0, OpenCode 2.0.26): DuckDuckGo results parsed from
  real markup, with challenge detection and the cooldown ahead of the policy;
  DNS resolved only after the exclusion, the budget and the approval;
  cross-origin redirects re-decided and never cached; a bounded cache; search
  scoped by provider, with `web_search:<provider>` allowlist entries, `!`
  exclusions and a budget of 0 to turn reads off; one budget per session and
  turn, shared with subagents; Claude planners given ask rules for `WebFetch`
  and `WebSearch`; per-runner exposure of Ordewell's `fetch` and
  `web_search`; Codex's search re-decided before every turn; the OpenCode 2.x
  no-provider fallback; `curl` pinned with `--resolve`, the shell's web
  commands secret-checked, Wget2 refused; refusals pointing reads to the
  planner's own fetch tool and effects to an ops task. Task launches are
  unchanged.
- 2026-10-11 — curl/wget follow-ups: path-named clients refused, flag values
  secret-checked, origin exclusions overriding remembered grants and rechecked
  after approval, unsafe cmd probe words refused, raw curl hostnames bounded
  before pinning, and environment references identified by variable name.
- 2026-10-11 — the Claude planner reads user settings only, so a
  repository's allow rules cannot skip the policy either
  ([ADR-0028](0028-planners-never-run-repository-config.md)).
- 2026-10-13 — Guarded reads the web without asking under `auto`, as Full
  does; the once-per-origin and once-per-session prompts move to an explicit
  `ask`. Codex planners in Guarded get their native `cached` search. `curl`
  and `wget` are unchanged: they are shell commands, and Guarded still asks
  about them per origin.

- 2026-10-21 — read-only tasks withhold native web tools because they have no task web-policy channel (ADR-0046).
- 2026-10-25 — read-only tasks read through Ordewell's `fetch` and `web_search` under this policy, never prompting, each attempt with a budget of its own (ADR-0046).
- 2026-10-25 — a read its caller cancels after it was allowed keeps its count; only a refused one is given back.
- 2026-10-29 — `git ls-remote` naming its destination is refused; a configured remote asks under its whole line, its remote and patterns secret-checked.
- 2026-10-29 — a listing after a `cd` is granted under the whole line, and `git.exe` is read as git.
- 2026-10-29 — a listing beside a wrapper, `chdir` or anything else that asks is granted under its line; one the shell rewrites is refused.
