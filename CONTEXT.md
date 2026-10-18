# Ordewell — Domain Glossary

The shared vocabulary for Ordewell. When code, issues, plans, or refactor proposals
name a domain concept, use the term as defined here. Synonyms listed under *avoid*
are deliberately not used — they blur a distinction the project cares about.

This file is the vocabulary the rest of the documentation is written in (see
[AGENTS.md](AGENTS.md)), and it grows as terms get resolved during design.

---

## Planning & execution

**PlanStore** — the deep module owning all plan-shaped state: the task tree
(`planTasks`), the flattened index (`allTasks`, `taskMap`), and `planRunners`.
Owns structural CRUD (`add`/`remove`/
`update`), status mutations (`markCompleted`/`markFailed`/
`markInProgress`/`retry`), the named run-preparation op (`resetForRun` — flip
AI tasks to approved, preserving completed ones unless the plan was freshly
generated), runner-set validation, and the `rebuild` internal seam. Completed
and failed are read from `task.status` alone — there is no second record — so
`isCompleted`, `completedCount`, `isAllComplete` and the scheduler's
dependency checks always agree. The store owns its task objects: `load` copies
what it is given, the getters return readonly views, and `snapshot()` is the
detached copy a caller may keep or persist. The TaskOrchestrator is a
pure scheduler that calls `store.markCompleted(id)` instead of mutating task
state directly; Session owns the store and routes plan mutations through it.
*Avoid:* "the task list", "the plan state" — PlanStore is the module; the
plan is the artifact.

**Session** — the deep module owning one plan's full lifecycle: generation,
execution, mutation and persistence. It
*hosts* the planner conversation but does not own it: `startPlanning`,
`continueConversation`, `isConversationActive`, and the **Planner turn**'s
`isPlannerBusy` and `abortPlannerTurn` are thin delegations to a
**PlannerConversation**, which reaches plan state, persistence and scheduling
only through the host interface Session hands it.
**`createSession(deps)` is the composition root**: hosts pass injected adapters
(`config`, `runner`, `registry`, `fsAdapter`, `broadcast`, `modelResolver`,
`settings`, and optionally `aiService`/`planner`/`isolation`/`taskOutput`/
`saveSession`) and it builds every collaborator — PlanStore, the
TaskOrchestrator, the **SessionCatalog**, the approval chain, the web fetcher, the
**SessionEventRelay**, the live planner transport — and wires them, so the
Session constructor only receives them. The deps are the test seam
(`makeSession` builds through `createSession` with a persistence fake); no test
reaches into private fields, and none spies on a module export. The Session is
transport-agnostic. The orchestrator's observer is subscribed once for the
session's lifetime (not per-operation), killing the double-subscribe class of
bug — and it is the orchestrator's *only* notification channel: refresh
signals travel over it and become `status_update` broadcasts (there is no
separate `onRefresh` callback for a surface to wire). **Live planner turns**
are the Session's alone: every reply goes through its **PlanTurns**, which
holds the scheduler's new starts for the turn and lets them go when it ends,
so no surface is told or has to act.
The Session adds to the relay's observer only the saves some events owe, each
made before the event is announced: a task that settles on its own
(`onTaskSettled` — completed, failed or awaiting the user) is saved as it
settles, so a shared run does not wait for its end to record a verdict.
These execution-event saves are *background* saves: one that lands in the
middle of a planner turn does not settle that turn (see *PlannerConversation*).
Mutation is an internal seam — every structural plan mutation *and every
settled conversation turn* (plan commit, task-ops apply, planner message) runs
one `mutatePlan` ritual (store op → persist → broadcast). The ritual covers plan
edits only. User controls that change task state through the orchestrator
(execute, approve the review, reschedule, stop, retry, cancel, mark complete or
not done, force start, run one task, continue a task, the two ways past a dirty
tree, Merge all, clean up or discard a run, a task message, force sending or
withdrawing a queued one, interrupting a structured turn, a checkpoint answer,
cancelling a scheduled resume)
are saved before any surface hears of them too: a synchronous one holds its
`status_update` until the save, and an asynchronous one (`withSave`) saves
before each `status_update` announced while it runs, and once more when it
ends — a hold across its spawns and git work would stall every task's status
and let an `execution_complete` it causes overtake the update held back. The
saves made while it runs are background saves, as are a task control's own;
so is the run going on when a planner turn lets its start hold go, which is
saved before its statuses go out the same way. `generatePlan` and `loadPlan` persist
the plan they adopt directly. Direct (non-planner) edits go one step further
through `editPlan`, which adds the reschedule they owe an armed scheduler:
nothing else wakes one after a hand edit, because no planner turn ends to let
a start hold go, so a task the edit unblocked would sit ready and never start. PlanStore is the single source of truth for task
state; `LegacyPlanState.tasks` is written from it (a `snapshot()`, never the
live tree) at persist and status-broadcast time and never read back into it. The old
`syncStoreFromPlan` (plan → store direction) is removed — there is only one
direction (store → plan, at persist). Emits
**SessionMessage** (the plan-lifecycle events) through the `broadcast` seam;
catalog/config messages (`setModels`, `setRunnerList`, …) stay on the host.
The web pool and the VS Code extension are the two real adapters that justify
the seam. Planner progress is broadcast-only: `ResearchProgress` is translated
to SessionMessage by the Session's relay, and there is no
per-call progress override for a surface to bypass it with. The web pool
itself holds only what earns its keep — the session registry
(`Map<sessionId, Session>`), the WS fan-out, and the session-creating
operations; routes reach a session's interface via `pool.session(id)` instead
of per-verb forwarders, and the pool never caches plan state (the Session is
the plan's owner).
Session boundaries are hard: every way a plan stops being the Session's ends
its **plan scope** in one place (see there). `loadPlan` of a *different* plan
then adopts the new one (the first user send reseeds from the adopted plan's
own transcript, and inputs the adopted plan still holds are replayed), and
hosts call `Session.reset()` on "new session" for a full wipe with a freshly
minted identity. Nothing from one session may surface in another — a
long-lived Session (VS Code hosts exactly one) otherwise presents the previous
session's tasks to the planner as the current plan.
*Avoid:* "the pool" (that's the web transport host), "the session manager" —
Session is the lifecycle owner, not a registry.

**Plan scope** (`Session.dropPlanScope`) — everything a Session holds that
belongs to the plan it holds, and goes with it: the run (stopped, with its
agents), the planner turn in flight (abandoned, its uncommitted subagent steps
dropped before anything saves), what that turn deferred (its **turn effects**,
reported as not done), the waiting turns' callers, the conversation,
supervision and loop-guard memory, the planner usage ledger, the execution log
and the planner's open prompts. It ends in one teardown, used by all four ways
a plan stops being the Session's: a new plan (`startPlanning`/`generatePlan`),
another session adopted (`loadPlan` of a *different* plan object), `reset`,
and `destroy`. The scopes the user granted end with it at a session boundary
(adopt, reset, destroy — ADR-0008), and are kept by a new plan started on the
same Session. A host never stops the run or the runners itself around these
calls. Re-adopting the *same* plan object (approval) is not a scope end.
*Avoid:* "session reset" for the adopt or new-plan cases — only `reset` also
mints a new identity and clears the model cache.

**SessionCatalog** (`services/SessionCatalog.ts`) — what one session may
assign, behind one interface: the enabled runners, their manifest modes, the
models discovery found for them, and the allowlist narrowing those. Built in
`createSession` and handed to the Session and the *PlanEditor*, so the
planner's per-turn block (`queryCatalog`), its tools (`live`), a user's direct
edit (`edit`, `runner`) and planning (`planning`) all read the same state —
settings are read live at each call, never captured, so a runner enabled or an
allowlist edited mid-session counts (#69). The per-runner discovered models are
**merged into, never replaced**: discovering one runner must not forget
another's, because coercion clamps thinking efforts against whatever was last
found. `admit(runner, models)` is how an admitted runner keeps its models there
(an empty discovery never displaces what is known), which `PlanEditor.admitRunner`
calls alongside adding the runner to the plan. `reset()` drops it all at a
session boundary. The default runner set (`DEFAULT_RUNNERS`, `models/Task.ts`)
is defined once for the store, the orchestrator and the Session.
*Avoid:* "model cache" for the whole thing — the cache is one part of it, and
the *ModelResolver*'s own cache is a different one that this overlays.

**SessionEventRelay** — the one place a surface's view of a Session is made:
it turns orchestrator events (task changes, ticks, review, checkpoints,
isolation, execution complete) and planner progress into **SessionMessage**
broadcasts, holds status updates back while a mutation is in flight, and
gathers a turn's subagent runs until the Session's next persist folds them
into the research log. It never persists; where an event owes a save, the
Session saves before handing the event on. Built by `createSession`, tested
directly against a fake broadcast.
*Avoid:* "the broadcaster" — `SessionBroadcaster` is the transport callback the
relay sends through, not the relay.

**PlannerConversation** — the deep module owning the planner conversation
(ADR-0002) end to end: the persisted dialogue record (`conversationHistory` and
the planner's `researchLog`), the live model context behind it, and every turn
from the user's message to a settled outcome. Planner turns settle through one
path: the first turn and every later turn get the same read draining (the
task-query channel), task-ops validation and bounded corrective retries, and
commit through the host's `mutatePlan` ritual. It builds the per-turn prompt
blocks (the always-on catalog block and the current-plan block, whose edit
protocol prose lives beside the applier as `taskOpsProtocol` in `TaskOps.ts`).
The live model context — a vendor service's message list, a harness planner's
process and native session id — is disposable: `reset()` drops it, and the
next turn is replayed from the transcript (`reset` runs before every replay,
so a harness planner never resumes its own memory on top of the replayed
one). A turn that throws before anything was persisted rolls its own writes
back (`snapshot`/`restore`); once anything has been persisted, memory already
matches disk and the rollback declines. A background save — a task settling
mid-turn — does not count: the turn still rolls back, and the undo is saved
through the mutation ritual so disk follows memory. Transcript edits are whole-array
operations (`append`, `replace`), so compacting a conversation is a
transcript edit plus a `reset`; forking and rewinding copy it instead
(`clone`, `cloneBefore`) and leave it as it was. It owns the **Planner turn**
too, so no surface keeps its own abort controller or busy flag, and a turn that
settles after its plan was swapped out never writes into the new one.
*Avoid:* "chat" or "thread" for the module — the conversation is the thing; the
AI service only holds a disposable copy of it.

**Planner turn** (`PlannerTurn`; `Session.isPlannerBusy`,
`Session.abortPlannerTurn()`) — the one piece of planner work holding a
session's conversation at a time: a reply (merge and split requests included),
a compaction, the conversation's opening, or one-shot plan generation.
Starting one creates its abort signal, and a caller's own signal is relayed
into it. A turn that continues the dialogue is refused while another is live
(`ConversationBusyError`, 409 from the daemon) — except a reply sent during a
reply, which **PlanTurns** takes in the next turn instead; one that starts a
fresh plan supersedes it. `abortPlannerTurn` *stops* the turn: it still settles, with
whatever the backend had, as `stopped`. A **Force send** stops it the same way,
marked as stopped by one, and the forced message's turn follows. A turn whose plan is dropped under it —
a new plan, another session adopted, the session closed — is *abandoned*:
stopped, the conversation freed at once, and whatever it settles is discarded
(`PlannerTurnDiscardedError`) instead of committed. So is a reply cut off by
something other than its own stop (an `IAiService.reset`), since what such a
call hands back is a fragment.
A turn that throws while stopped or abandoned surfaces as a typed error whatever
the backend named its own — `PlannerTurnStoppedError` or
`PlannerTurnDiscardedError`, the original kept as `cause` — one-shot generation
included, so a surface checks the type, never an SDK's abort error. The daemon
answers both as 409 (`planner_turn_stopped`, `planner_turn_discarded`) without
logging a fault.
*Avoid:* "planning abort" or "generating" for it — both named a surface's copy
of this state, and the copies drifted; *Avoid:* confusing it with **Turn**, the
streamed span a surface draws under one `turnId`: every user turn is a planner
turn, but a compaction or a one-shot generation streams no Turn.

**Turn effects** (`TurnEffects`) — what one planner turn leaves for its end:
the starts it deferred behind its own held task edit (ADR-0029), whether that
edit landed, and whether the planner submitted a whole plan, which autorun
starts (ADR-0030). Made fresh for each reply and for the conversation's
opening, and settled once in a `finally`, however the turn ends: when its edit
landed, the deferred starts go through the command seam again, as edited;
when it did not — the turn stopped, failed, was discarded, or its edit was
refused as it landed — each is reported "Not done: … waited for an edit that
did not land." A plan scope ending abandons them the same way, whether the
edit landed or not, so none runs on the next plan. Nothing of one turn's
effects carries into the next.

**SessionMessage** — the single union every delivery surface consumes: the
plan-lifecycle events (`plan_generated`, `planner_message`, `status_update`, …)
plus the planner streaming variants (`planner_text_delta`,
`planner_thinking_delta`, `plan_token`, `research_step`, `research_step_done`,
…). Each meaning has one message: all planner thinking, whatever the backend,
is `planner_thinking_delta`, and `plan_token` is only the "building plan"
display of a streaming JSON envelope, never reply prose. Produced only behind the Session's
`broadcast` seam; the core-internal `ResearchProgress` union never crosses
into a surface. Surfaces adapt it to their own presentation protocol (VS Code:
`ConversationViewHost` folds it into core's conversation view and sends the
webview block patches; web: raw JSON over WS) but never
re-map `ResearchProgress` themselves.
Isolated execution (ADR-0013) travels on it too: each `status_update` task
carries `isolation` (`state: none | active | integrated | conflict | kept`, plus
its branch and worktree) — absent altogether while the plan has no isolation
run, so a shared-root plan's updates are exactly what they were;
`isolation_blocked` says a run did not start on a dirty tree; and
`isolation_handoff` (integration branch, base ref, landed tasks) is sent when an
isolated run settles, *before* `execution_complete`.
Under ADR-0014 a task's `isolation` also names the `repos` it changed and, while
it is conflicted or failed to land, the `conflictRepo` that stopped it;
`isolation_blocked` names the dirty `repos` of a group; and `isolation_merge`
carries what *Merge all* did, blocked repos and all, to every surface;
`run_closed` follows it when the Session cleared the run up.
*Avoid:* "event", "progress callback" for this concept — and do not add a
per-call progress override; the broadcast seam is the only channel.

**ResearchStep outcome** — how one research tool call ended, as data:
`success | failure | refused | denied | not_executed`, derived once by
`classifyOutcome` and carried on every `research_step_done` alongside the
model's `toolCallId`. A surface renders the outcome and matches a result to its
pending call **by id** — never by tool name, which crosses results in a parallel
tool round, and never by re-parsing refusal text. See ADR-0008.
*Avoid:* treating `success: false` as one undifferentiated failure — a refused
`rm`, a denied path, and a broken command are three different things to a user.

**Planner** — the cheap, read-only model that researches the repo and emits *the
plan*. Never writes code. See `docs/why-a-separate-planner.md`. Interactive
surfaces talk to it through the **conversation loop** (ADR-0002): one persisted
dialogue where the model thinks, executes read-only commands, or sends
messages, until its final message IS the plan JSON. There are no question
tags, phase sentinels, or question quotas — the model decides transitions,
like a normal chat session.
*Avoid:* "the AI", "the agent" (ambiguous with executors).

**PlanRepair** — the one owner of "the model emitted something unusable —
correct it and retry". `repairLoop` is the bounded driver (first reply →
interpret → corrective re-send) behind plan generation
(`generatePlanWithRepair`) and the Session's task-ops settlement;
`classifyPlannerReply` decides what a planner
reply *is* (plan, task ops, a botched attempt at either, or prose) and owns
the envelope keys (`PLAN_ENVELOPE_KEY`/`TASK_OPS_ENVELOPE_KEY`, defined in
JsonExtractor) plus every corrective prompt text. A conversation turn's
reply settles through `settleReply`, built on `repairLoop` beside it, on
both planner families (see **Corrective retry**). Policies (PRD nudge, ops
validation, abort guards) stay at the call sites — inputs to the loop, not
part of it.
*Avoid:* hand-rolling a retry loop or a corrective prompt at a call site —
adapt `repairLoop` instead.

**Corrective retry** — a re-send a planner reply is owed when it cannot
settle as it stands, made by `settleReply` in the same way for an API planner
and a harness planner (ADR-0009): one nudge per turn for an empty reply
(naming the call that was denied, if one was), and up to `MAX_JSON_REPAIRS`
(2) re-emits for a botched envelope — for a plan cut off by the output limit,
the terser re-emit, after freeing context where Ordewell holds it. What the
discarded attempt streamed is retracted before the retry answers, the plan
display included. The families differ in exactly two explicit options: only
an API planner can compact its context (`compactHistory`), and only a harness
planner's reply joins every segment of its call, so it retracts them before
settling as prose (`replyJoinsSegments`). How one call runs — tool rounds, or
an agent's turn — is the caller's `send`.
*Avoid:* counting a harness planner's wait for its backgrounded subagents as
one — that turn is continued on the user's behalf, and its text stays in the
reply; *Avoid:* counting a task-ops validation retry (the conversation's own
`repairLoop`) against this budget — it is a separate, later loop.

**Context compaction** (`contextCompaction.ts`) — comes in two kinds that share
a name and nothing else: this entry's *reactive/proactive* compaction, which
Ordewell triggers on its own, and the *user-triggered* **Compaction** below,
which the user asks for. This one is the recovery for a plan
emission cut off by the output-token limit (a long research phase, especially
with subagents, bloats the planner context until the final JSON no longer
fits). Truncation is detected two ways — the unbalanced-JSON heuristic
(`PlanParseError.truncated`) and the provider's `finish_reason === 'length'`
(`ResearchTurn.finishReason`) — and the retry then differs from a normal JSON
repair: `ResearchChat.compactHistory()` prunes raw tool transcripts in place
(subagent digests are kept whole — a digest already *is* the compressed
research thread) before `truncatedPlanReEmitPrompt` asks for a terser
re-emit. The one-shot fallback prompt is bounded the same way by
`compactResearchResults`. Compaction also runs proactively
(`withProactiveCompaction`, wrapped around the chat by both planner loops):
providers report exact prompt tokens per turn (`ResearchTurn.promptTokens`,
via `stream_options.include_usage` / Gemini `usageMetadata`), and a turn at or
past `COMPACTION_LIMITS.proactivePromptTokens` compacts immediately so the
plan emission is never the first moment context pressure surfaces — the
reactive repair is the backstop, not the primary path.
*Avoid:* a truncation retry that re-sends the same context — it will be cut
at the same point again.

**Compaction** (`Session.compactConversation()`) — the user-triggered kind: the
user decides a planner conversation has grown unwieldy and asks for it to be
condensed, on a live turn rather than after a cut-off. One hidden planner turn,
through whichever planner is configured, asks for a summary of the goal,
decisions, constraints, open questions, key file and code findings and where the
plan stands. The live context is pruned of bulky tool output first
(`IAiService.pruneContext`, the same pruning **Context compaction** does), or
the whole transcript is replayed into the turn when no live context matches. The
transcript then becomes a `compaction` entry — the summary, visible, always
first — followed by the last two user messages and their replies verbatim, and
the live context is reset so the next message replays from that shorter record
on every backend alike — unless the compaction was abandoned with its plan,
whose drop already reset it, and a second reset would cut off the turn that
has the backend since. The summary must arrive inside `<conversation_summary>`
tags: a harness planner reports a failure as an ordinary reply, and the tags are
how a dead agent is told apart from a summary. Anything else the turn emits —
task ops included — is discarded, so the task list is untouched, and nothing is
written until the summary is in hand, so a failed or stopped turn leaves the
conversation as it was. Refused while a planner turn is in flight and when the
conversation has two user messages or fewer; a message sent while it runs is
refused in turn (`ConversationBusyError`, 409 from the daemon), since the reply
would share the live context the compaction resets. **Rewind** stops at the summary
(its entry plays the part the goal did) and **Fork** copies the compacted
transcript. Only the planner conversation compacts, never a runner. TUI and
VS Code `/compact` (VS Code also "Ordewell: Compact Conversation", cancellable
from its progress notification, with the chat input locked while it runs); CLI
`ordewell compact`; the daemon route is
`POST /api/plans/:id/conversation/compact`. It announces itself with a
`planner_message` carrying the summary.
*Avoid:* "summarize" for the operation — the result replaces the transcript; and
"clear", which loses what was decided.

**conversationHistory** — the planner dialogue persisted on the plan state:
`{ role: 'user' | 'assistant', content, timestamp, kind? }[]`. The single source of
truth for UI redisplay. Tool-call results are NOT stored here — they live in
the AI service's in-memory tool-use history; `researchLog` remains the
persisted tool trace. A reloaded session resumes by replaying this transcript
into a fresh model context; the tool history is gone. Written only by
**PlannerConversation**: conversation turns, mid-run ones included, and a
**Compaction**, which replaces it with
a summary and its last two exchanges. A **Rewind** never writes it: the
shortened copy goes to a new session. Every
write is persisted and broadcast through Session's `mutatePlan` ritual.

**Rewind** (`Session.rewindConversation(index)`) — fork the conversation from
just before one of the user's messages: a new persisted session holds the
transcript up to that message (`conversationHistory.slice(0, index)`), the
planner's `researchLog` up to the same point, and the current task list, taken
through the same `forkPlanState` as a **Fork**. The original session, its
file, its transcript and its live planner context are untouched, so nothing
said is lost and the user can go back. `index` is the message's position in
`conversationHistory`, and `rewindTargets()` lists the candidates with a
one-line preview — every user message except the opening goal, since a
conversation without its goal is a new session (after a **Compaction**, the
summary entry stands where the goal did). The task list rides along as it is
now, including tasks created after that message: a rewind moves where the
conversation resumes, not what the plan is (ADR-0002, updates of 2026-09-25).
The rewound message's full text comes back with the fork (`rewoundMessage`) so
a surface can offer it for resending or editing. The fork has no native
planner session, so its first message replays the shortened transcript on
every backend alike. The daemon adopts it at once (see **Adopt**) and answers
`{ sessionId, goal, plan, rewoundMessage }`. Refused while a planner turn is in
flight (`ConversationBusyError`, 409), because the copy would hold a message
without its reply; allowed while the original executes, since the fork carries
no run. TUI and VS Code `/rewind` (picker) or `/rewind <n>` (VS Code also
"Ordewell: Rewind Conversation") switch to the fork; CLI `ordewell rewind [n]`
makes it the current session and prints the rewound message.
*Avoid:* "undo" — nothing about the plan is undone, and the original is kept.

**Fork** (`Session.forkConversation()`) — copy the conversation and its task
list into a new persisted session and continue there; the original, its file
and its live planner context are untouched, so either side can be forked
again. The fork carries no run: tasks caught in progress or at a checkpoint
become pending, finished ones keep their status, and planner turn inputs still
waiting (`pendingTurns`) and any other per-run record stay behind. What travels is decided in one place,
`forkPlanState`, which lists fields rather than spreading the plan, so a field
added to the plan later stays behind until someone decides it should travel.
The daemon adopts the fork immediately (see **Adopt**); its first message
replays the copied transcript. A **Rewind** is a fork made from an earlier
point in the conversation. Refused mid-turn like a rewind; allowed while the
original executes. TUI `/fork` switches to the fork; `ordewell fork` makes
it the current session; VS Code `/fork` ("Ordewell: Fork Conversation") loads
it like a saved session, which replaces the extension's one in-process
`Session` — so it asks first when a run is executing, since loading stops it.
*Avoid:* "branch" — that word belongs to git and to worktree isolation.

**PRD (prdMarkdown)** — a planner reply that wraps the full markdown in an
`ORDEWELL_PRD_START/END` block (with a slug). Core saves it to
`.scratch/<slug>/PRD.md` (the Matt Pocock to-prd convention) and keeps
`prdMarkdown` on the plan. No built-in skill or prompt asks for the block; the
`to-spec` skill writes its spec straight to `.ordewell/spec.md` instead.
*Avoid:* "PrdArtifact", "PRD status machine" — deleted; the PRD is a message
plus a saved file, not a typed state.

**Skill** — a folder with a `SKILL.md` (the Agent Skills format) read by one
loader (`SkillsService`), and the only thing Ordewell calls a skill (ADR-0024).
The folder name is the skill's identity (`/name`, the names in a plan,
`ordewell skills`); frontmatter carries `name` (which should match the folder),
`description`, `applies-to: planner | task` (default `planner`) and Claude
Code's `disable-model-invocation` and `user-invocable` (unmarked = both). It lives in one of two scopes: **global**
`~/.ordewell/skills/` (built-in seeds plus the user's own; tasks never write
it) or **workspace** `.ordewell/skills/` (committed, so it reaches worktrees
through git). On a name clash global wins and the workspace copy is reported
as shadowed. The built-in planner skills are user-only; the built-in `tdd` task skill is model-invocable (ADR-0024). Ordewell never ships, reads, or
references runner-native skill mechanisms (`.claude/skills`, OpenCode plugins,
etc.) to deliver a skill. Research subagents (`spawn_research_agent`, ADR-0005)
are always-on for the planner, not a skill.
*Avoid:* "mode toggle", "skill toggle" — a skill is chosen per message or per
task, never switched on in settings; "skill file", "slash command" for these —
those are runner-side concepts.

**Planner skill** — a skill with `applies-to: planner`: instructions for the
planning conversation. The user loads it with `/name`; the message text stays
as typed and the planner is sent the body beside it. A model-invocable one can
also be loaded by the planner through the `load_skill` MCP tool, which is
tool-only: the catalog appears in the prompt only when tools are attached.
*Avoid:* "mode", "persona".

**Task skill** — a skill with `applies-to: task`: instructions for a runner
working one task. It reaches a runner only by being named in the task's
`skills` in the plan; Ordewell injects its body into the task prompt at spawn,
for any runner, and snapshots it on the attempt. Unresolved names are a warning
at submit and a failed start before the runner is spawned. A task's skills are
listed in the planner's `<current_plan>` block and returned by `task_query`.
`/name` on a task skill is a directive to the planner to attach it, not a
load. The built-in `tdd` is one; TDD applies to a task only when the skill is
attached.
*Avoid:* "task toggle", "augmentation" for the skill itself.

**Skill-load entry** (`SkillLoad`) — the transcript entry recording that a skill
was loaded into the planner conversation: invoker (`user` or `planner`), name,
scope, path, and a snapshot of the body as loaded, so a resume, fork or rewind
replays what the live conversation was given. Surfaces show it as a one-line
notice with the path. For a task skill named by `/name` it carries no body, only
the directive to attach.
*Avoid:* "skill message", "skill event".

**Executor / Runner** — an external coding-agent CLI (Claude Code, Codex,
OpenCode) that runs *one task* in its own session through a structured
connector. `RunnerRegistry` holds their built-in manifests: identity, command,
model discovery and mode settings. External plugin manifests are ignored with
one notice at host startup.
*Avoid:* "backend", "provider" (provider means the LLM vendor, below).

**Runner connector** (`RunnerConnector`, in the `CONNECTORS` registry) — what
Ordewell holds for a runner it drives over the runner's own protocol: the
adapter that serves it as a harness planner (ADR-0009) and as a structured
task's runner (ADR-0018), its *Ordewell tool binding*, and optionally how it
words a usage-limit reset. The registry is keyed by runner id; a runner without a connector cannot run. Adding a runner
to it is the one place a runner's planner, task connector and Ordewell tools are
declared, so none of the three can drift apart.
*Avoid:* conflating it with `RunnerRegistry`, which holds *manifests* (identity
and mode/discovery settings for the built-in runners); "adapter table".

**Runner process** (`RunnerProcess`, `harness/runnerProcess.ts`) — the one OS
process a connector's adapter drives, whatever its protocol: launched under the
cleaned runner environment in its own process group, its output decoded as
UTF-8, its stderr tail kept for the failure message, its end observable, and
its whole tree killed on dispose (**Kill tree**). Its end is the process's
`close`, after stdout has drained — acting on `exit` reported a runner's last
line as never having arrived — and a last line left unterminated when the pipe
closed is flushed rather than dropped. Its `start` runs the adapter's handshake
and takes the process down if that throws. The stdio adapters and OpenCode's
server both build on it, so a lifecycle fix lands once; the protocol stays in
the adapter.
*Avoid:* spawning or killing a runner in an adapter directly.

**Ordewell tool binding** (`OrdewellToolBinding`) — how one connector hands its
runner the Ordewell MCP server (ADR-0022). It covers the runner's names for the
server's tools (`toolName`/`toolNames`), which of the runner's permission
requests are for them and so are never refused or left waiting
(`isOrdewellAsk`, by the tool's exact name or the server's, never a prefix
another server's name could extend), what the runner's own status word for the server means
(`attachState`), and the runner-specific injection that writes the server into
its launch or configuration. Every supported connector has one. Task runners
and coding-agent planners must connect their tools before receiving a prompt;
a failed attach is respawned once, then fails (ADR-0025).
*Avoid:* "MCP adapter", "tool prefix" (a prefix is how two of the runners happen
to name a tool, not the concept).

**Attach state** (`AttachState`: `connected | pending | failed`) — a runner's
report on the Ordewell server's connection, in one vocabulary for every runner.
`pending` is the only state worth waiting through; `awaitAttach` polls until the
runner says `connected` or `failed` or the deadline passes, and a runner that
never attaches is respawned once before the task or planner turn fails. That
rule is `spawnAttached`, the one spawn step task runners and harness planners
share: it issues the token, starts the adapter, kills a spawn that did not
attach along with its token, and throws `McpAttachError` after the respawn.
*Avoid:* "healthy", "ready" (this is a report by the runner, not a probe of ours).

**OpenCode server API** (`openCodeTransport`) — the HTTP protocol work OpenCode's
two server APIs share: 1.x (`/event`, `OpenCodeAdapter`) and 2.x (`/api/event`,
`OpenCodeV2`). The event names and shapes differ, so each version reads its own
frames; how a turn is streamed, how a permission request is answered, how a
child session is tied to the call that spawned it (held until named, then
replayed tagged with that subagent) and how a turn is settled are one
implementation, so a behaviour fixed for one version is fixed for both.
*Avoid:* "transport" alone for this — **Transport** is the runner session
contract, and OpenCode's HTTP protocol is one implementation of it.

**Transport** — how Ordewell drives a task's runner: its programmatic
protocol, with structured events in and messages out. Every `IRunnerSession`
has this contract; runners without a task connector cannot run tasks. There
is no transport setting, discriminator or terminal fallback. Every coding-agent
session requires Ordewell MCP attachment, checked after spawn with one respawn
before failure (ADR-0025).
*Avoid:* "mode" (that is permission mode, ADR-0001), "backend", "provider".

**Waiting for input** — a structured task whose turn ended without a `task_complete`
call: `awaiting_user` with a saved reason, `input | checkpoint | conflict |
files-changed` (a checkpoint wins over input; `files-changed` is an *ops task*
that changed tracked files, ADR-0020), or `usage-limit` when what ended it was
the runner's usage limit (see *Usage-limit resume*). No verdict is guessed. The
first clean turn end of an attempt gets the *completion reminder* instead; after
that the user answers or marks the task complete. A pending runner approval is *not* waiting
for input — it arrives mid-turn, leaves the status alone, and "waiting for
approval" is derived from the task's pending approvals.
*Avoid:* "idle" (a silence guess, and its timer still runs during a turn),
"paused", "blocked" (a dependency term).

**Completion reminder** (ADR-0018, W1) — the one message Ordewell sends a
runner whose turn ended cleanly without a `task_complete` call, telling it to
call the tool with `done` and its full report, or `blocked` and the reason, or
to say what it needs from the user. Once per attempt, for every task kind; not
after a failed or interrupted turn, a usage limit, or while a user message is
queued or owed. It goes through the task message seam marked `from: 'ordewell'`,
the task stays `in_progress`, and the task log draws it as Ordewell's line, not
the user's. The report before it remains the fallback summary. It is not
completion evidence: if the next turn also ends without the call, the task
waits for input.
*Avoid:* "nudge" (the planner's corrective prompts), "auto-complete".

**Continue** — a retry of a completed, failed or skipped structured task, or
of one paused on a usage limit (see *Usage-limit resume*), that resumes its
saved runner session (Claude's `--resume`, Codex's `thread/resume`) with
the user's message as the next turn.
It is verified and landed like any attempt, is not offered on conflicts, and
leaves dependents alone, as retry does. It never crosses runners: a saved
session records the runner that owns it (`Task.runnerSessionOwner`, else the
runner of the last attempt, via `sessionOwner`; a session saved with neither is
given the task's runner as the plan loads, before a move can lose it), and
Continue is offered only
while the task is assigned to that runner; after a move, Retry carries the work
over (see *Carry-over*). `continuability` is the one rule, and
a status carries only whether it holds (`continuable`), never the session id.
The first turn is the message plus a short reminder of the checkpoint
protocol (`composeContinuationPrompt`), not the original prompt; how the task
ends is the runner's instructions, applied again on the resumed session.
In an isolated run its task workspace starts at the integration tips and
restores the previous attempt's unlanded work, including uncommitted edits
saved on `ordewell-preserved/` branches before the kept worktrees go. A conflict
in any repo restores none of it: the agent gets the integration tips and the
exact preserved branches and inspection commands. A shared run's edits remain
in its checkout. The continuation message states which happened, so the
saved session does not assume missing edits still exist.
A session the runner
cannot find fails the attempt with a message that suggests Retry; a fresh
session is never started in its place.
*Avoid:* "resume" for the user action (that is the protocol flag), and "retry"
for it — a retry starts a fresh attempt with no message; "continue" across
runners.

**Usage-limit resume** (`readUsageLimitReset`, `UsageLimitWaits`,
`cancelScheduledResume`; ADR-0018, U1) — a task whose runner stopped on its
account's usage limit is `awaiting_user` with reason `usage-limit`, and the run
holds. The limit counts only under the *in-flight rule*. When the runner's message names the reset (Claude Code and Codex do,
read by their connectors' `usageLimitReset`; OpenCode does not), the task carries a `resumeAt` saved with the plan, and at
that time it is retried as a *Continue* of its saved session. Tasks paused on
one runner share one wait — the latest of their resets — and resume together;
the hold on the run is released once nothing waits on a reset, whether or not
a task failed meanwhile (ADR-0034). A held run stays open: with nothing at work
it is neither handed over nor merged at its end, and sends no
`execution_complete`. A plan loaded after its time resumes at once; a loaded
plan holds no run, so only its paused tasks resume and the rest of the plan
waits for Execute. Without a time, after a
cancel or a stop, or when the resumed attempt hits the limit again at once, the
task waits for a manual retry. *Resume now* (`resumeNow`) resumes it early, in
its saved session, once the user says the limit has reset — from the task row,
a message sent to it (after the reset notice), or `retry_task` from `session` —
with every task waiting on that runner's reset. One the asked task cannot take
(no free slot, no approval) is refused before anything changes, and a task it
sweeps along that cannot start keeps waiting for its reset. Surfaces show "Resumes at
8:10pm" with *Resume now* and *Don't resume*.
A runner change, whether a direct edit or a planner edit, cancels that task's
resume and makes it ready for the next scheduler slot on its new runner, as a
*Carry-over*, and a run the pause held goes on.
Other tasks on the old runner keep their shared wait; changing only the model
keeps the resume because the limit belongs to the runner's account.
*Avoid:* "rate limit" for it — a provider's per-minute throttle is retried
inside the runner and is not this; "paused" for any other wait.

**Carry-over** (`carryOver` attempt kind, `Task.carriedFrom`; ADR-0018, U1) —
the next attempt of a change task that was moved to another runner after an
attempt of the earlier one left work: a task paused on a usage limit, which
the scheduler starts, or any other task with a saved session, which the user's
Retry starts. A session cannot cross runners, so it is a fresh session given
the task's prompt, but its worktree restores the paused attempt's work as a
*Continue*'s does, and its prompt says the files come from a previous attempt
on the old runner and may be unfinished. If that work conflicts with what
landed meanwhile, it starts fresh from the integration tips, and its prompt and
the task log name the preserved branches. `carriedFrom` is saved with the plan
until the attempt runs; a Retry after a move sets it from the session's owner,
and any other retry clears it. An ops task carries nothing over.
*Avoid:* "continue" or "resume" for it — no session is resumed.

**In-flight rule** (`saidInFlight`, `classifyRunnerStop`; ADR-0018, U1;
ADR-0044) — a usage limit is acted on only when it ended a turn Ordewell
started, or refused one it was starting. Limit words left by a turn that had
already ended did not stop the runner and pause nothing. Where a runner's
protocol names the cause in a field, the field decides over the words: Codex's
`codexErrorInfo` `usageLimitExceeded` is the limit (its reset read from
`account/rateLimits`), and any other named cause (`rateLimitExceeded`, a
provider's throttle) is not, however its words read. The same reading serves
tasks, the planner and the supervisor's wake-ups.
*Avoid:* "rate limit" for the account limit.

**Planner resend** (`PlannerResend`, the plan's `plannerResend`; ADR-0044) —
what follows a planner turn that ended on the planner's own usage limit. The
turn shows as a failure; the inputs it took (the user's message, a wake-up)
stay pending on the plan, and a wait is saved with it, so a reload keeps it. At
the reset plus a minute they go again as one turn, with whatever arrived
meanwhile; a user's message sent meanwhile is answered at once as saved, not
held for hours. With no reset known, a relapse within five minutes of a
resend, a cancel (`/resend cancel`, `ordewell resend cancel`, VS Code's *Don't
resend*) or a planner that moved to another runner, nothing is sent on its own:
what waits is *held* and goes with the next input. The supervisor keeps no
wait of its own.
*Avoid:* "retry" for it — the user did not ask again; "usage-limit resume",
which is a task's.

**Task log** (`TaskLogEvent`, `reduceTaskLog`, `TaskLogRecorder`) — what a
structured task did, at full fidelity (ADR-0018, O1b/P1): normalized events —
text by **text run** and thinking, tool calls with their results (long ones
trimmed to head and tail), subagents, usage, turns, the message queue, runner approvals
(requested, decided, withdrawn), the **runner commands** a user ran and what
they printed, the runner's own compactions, and what it loaded as it
started — streamed live as
`task_log` and appended to `.ordewell/sessions/<session>/tasks/<task>/<attempt>.jsonl`,
one file per attempt, numbered from what is on disk. `reduceTaskLog` folds the
same events into display blocks live and on reload, so the two draw alike: each
text run streams into a block of its own, which its complete copy settles
wherever it now sits; a log saved before runs carried an id has one stream for
every run, into the latest block only. The file goes with its session. Every task attempt uses this log. The planner reads
a saved attempt with `task_output` (optional `attempt` and event-type `kinds`),
through bounded text pages and its shared task read budget.
*Avoid:* "transcript" (the planner conversation's saved record), "output"
(the lossy plain-text channel `VerdictEngine` reads — nothing that needs
fidelity reads it), and reading a verdict from the log.

**Runner approval** (`runner_tool`, `RunnerApprovals`) — a structured task's
runner asking to use a tool its mode does not cover (ADR-0018, A1). It rides
the planner's approval seam (`PendingApprovals`, `resolveApproval`) carrying
the task id, with no timeout, and shows as a card in the task log — never in
the planner conversation. The answers are *Allow*, *Allow for this task* (the
runner's own session-scoped grant, offered only when it proposed one) and
*Deny* with an optional note the agent reads; `resolveApproval` takes the
whole decision from any answerer, a person or later the supervisor (#28). The
task stays `in_progress`: "waiting for approval" is derived from its pending
requests. Cancel, stop and retry deny them before the runner goes; one the
runner cancels itself, one still open when its turn ends, or one whose process
ends, is *withdrawn*. OpenCode's `build` mode (`--auto` on 2.x)
answers its own requests: they are logged as requested and decided, never
carded.
*Avoid:* "permission prompt" for Ordewell's side (that is Claude's protocol),
and "awaiting approval" as a task status.

**Permission ledger** (`PermissionLedger`) — the one table every runner
adapter's permission requests go through (ADR-0026): an Ordewell tool, named
exactly, is allowed at once; a task's request under an auto-approving mode is
answered at once; both are logged as decided. Anything else is held open — a
task's with the runner's own grants, a planner's with what it is for — until
it is answered, withdrawn by the runner, or cancelled because its turn ended.
An HTTP answer settles only when its reply succeeds; a failed reply is logged
and leaves the request open for another answer, including an automatic one.
An adapter supplies only how to read its runner's request and how to reply,
so the same request logs the same events on every runner.
*Avoid:* "permission queue" (requests are answered in any order).

**Task message** (`sendMessage`, `QueuedTaskMessage`) — a message sent to a
structured task while its attempt lives (ADR-0018 M1, ADR-0023). Ordewell owns
the queue, and a message is in exactly one state: *queued* — waiting in
Ordewell's queue for the running turn to end, removable; *handed over* — the
runner accepted it into the running turn and owes a delivery, no longer
removable, since no runner can recall one; *delivered* — the runner reported
that the model has it, mid-turn (`message_delivered`) or as the message that
opened a turn (`turn_start`); or *undelivered*. Sent with no turn running, it
opens a turn at once. The queue lists queued and handed-over messages until
delivery; a message handed over and then let go of by the runner is queued
again. Completion evidence that arrives while one is undelivered is held, and
a message the runner reads voids it.
*Avoid:* "queued prompt" (the planner conversation's hold); "sent" or
"delivered" for a handed-over
message — the write or POST succeeding is not delivery.

**Runner command** (`RunnerCommand`, `commands()`, `invokeCommand`) — a slash
command a task's runner offers that task, as the runner reported it (#66): one
of its built-ins (`/compact`, `/model`), a skill, or another command — the
user's or the project's own. With a task's chat open, its composer's slash
namespace is that runner's alone: `/` completes the runner's list and
`/name args` runs it as a turn of its own, queued behind a running turn and
never handed into it. Ordewell carries it and logs it (`command`,
`command_output`, `compaction`, `runner_loaded` in the **Task log**); what it
does is the runner's business (#24). A runner that reports none has none, and
a `/name` typed to it goes as text.
*Avoid:* "slash command" alone (Ordewell's own TUI commands are slash
commands too, and never run from a task's chat), and calling a runner's
`/compact` a **Compaction** (that is the planner conversation's).

**Runner-reported model switch** (`model_switched`, `model_drifted`,
`Session.followRunnerModel`, `PlanEditor.followRunnerModel`; ADR-0041) — a
task's runner moved to another model. When a model command sent through the
task's chat preceded it, however the message was routed, it is the user's own
choice (`model_switched`): the plan follows it as a visible direct edit, saved
and announced as `task_updated` — the alias resolved to the id the runner lists,
written even off the allowlist, effort only when the runner reports one. When no
command preceded it (`model_drifted`) it is stated in the *Task log* and never
written. The log's `model_switched` line is written from the write-back's
outcome, so it never claims an edit that did not land, and once the switch's
attempt has ended it says nothing of the plan, which may be another one by then.
Only the Claude Code
connector reports a switch; Codex and OpenCode get no synthesized `/model`,
since runner commands are never interpreted. While a task's runner is live its
model and effort are locked for every actor (`liveModelRefusal`), a cleared
model included, and so is its runner (`liveRunnerRefusal`): stop, edit,
continue is the way from outside. A planner edit leaves alone a model it
did not change, so the allowlist never undoes the user's switch; it still
clamps that task's effort to the model's variants unless a runner may hold it.
*Avoid:* "model override" and "fallback" for it; *Avoid:* writing the plan from
a drift.

**Mid-turn delivery** — a task message reaching the model at the runner's next
step boundary, after the tool call in flight and inside the same turn
(ADR-0023): Claude Code by a `user` line on stdin, read when echoed; Codex by
`turn/steer`; OpenCode 1.x by `prompt_async` while busy. It is a per-adapter
optional adapter capability (`steer`); without it — OpenCode 2.x — messages
wait for the turn to end, the *turn-end queue*. Offered
one message at a time, in the order sent; a refusal leaves the rest for the
turn's end.
*Avoid:* "interrupt" (nothing in flight is stopped — that is *force send*),
"injection" (the rejected hook route), and "steer" outside the adapter seam
and Codex's protocol (it names the call, not the delivery).

**Force send** (`forceSend`, `forceSendQueued`; "Send now" on the surfaces) — interrupt
the running turn, stopping the tool call in flight, and deliver a message as
the turn that replaces it, ahead of everything still queued (ADR-0023,
F1–F4). The task stays `in_progress` through the switch. With no turn running
it is a plain send. A queued or handed-over message can be force sent; a
handed-over one is not sent twice — the interrupt makes it go first. On Codex the interrupt stops the agent waiting,
not the command, which runs to its end. TUI `ctrl-s`, VS Code *Send now* /
`Ctrl+Enter`.
In the planner chat (`Session.forceSendPrompt`, F5) it is turn-scoped: it
stops the **Planner turn** in flight the way a stop does — the turn's
**Turn effects** settle as for any stop — and **PlanTurns** answers the forced
message alone in the turn that replaces it, ahead of every input waiting;
nothing can start in between. It never stops, halts or edits the run's tasks.
The stopped turn ends with `forceSent` on its `planner_turn_ended`, so a
surface keeps the prompts it holds, in order, instead of handing them back as
it does after a stop; the forced message carries `forced` on its
`planner_turn_started`, its transcript entry and its pending input, so a
reload still marks it. Daemon `POST /api/plans/:id/converse/message/now`.
*Avoid:* "force-start" (starting a task past its dependencies), "priority" or
"urgent" message, and "interrupt" for the whole action — a plain interrupt
ends in waiting for input, a force send does not.

**Undelivered message** (`message_undelivered`) — a task message that can no
longer reach the runner: its process exited, its turn failed, or it was sent
to a session already ended. Every surface reports it with its text; a message
is never removed from the queue without being delivered, taken back, or
reported undelivered.
*Avoid:* "dropped" — that is an adapter reporting that a handed-over message
went unread at the turn's end (`message_dropped`), which puts it back in the
queue, not out of it; and "lost".

**Checkpoint** (task) — a task asking a person to approve its work before it
goes on: the `checkpoint` tool call. The task is `awaiting_user` with reason
`checkpoint`, and its status carries the whole question (`checkpoint`).
Answered with approve — which carries no note — or reject with a reason: the
TUI task view's *checkpoint card* (`enter` replies with the composer text as
the reason and the task goes on in the same session following it; `ctrl-y`
approves; `ctrl-g` rejects, with nothing typed a plain no), `/checkpoint <id> approve|reject [reason]`, `ordewell checkpoint`,
or the VS Code card. A runner approval waiting in the same task is answered
first. The turn that asked it ending — an interrupt, a force send — withdraws
it, and the task goes back to in progress.
*Avoid:* "runner approval" (a tool request mid-turn, not a question about the
work), "pause", and "merge gate" (a scheduling wait).

**Ordewell MCP server** — the one MCP server Ordewell runs (ADR-0022):
Streamable HTTP on `127.0.0.1` at a random port, started on first
use by the process that owns the session (the daemon or the VS Code extension
host) and shared by every session in it. Its configuration is injected into a
runner when Ordewell spawns it — structured task runners and the three harness
planners only — with its tools pre-authorized so no call ever prompts. Who sees
which tools is decided by the caller's *task token* or *planner token*, never
by running separate servers. Attachment is checked after spawn, with one
respawn before failure. API planners use JSON envelopes instead of this server.
*Avoid:* "the task server" / "the planner server" (there is one server; the
token decides the role), "MCP bridge", "plugin".

**Task token** — the credential that binds one structured task attempt to the
*Ordewell MCP server*: one session, one task, one attempt generation (the
generations `VerdictEngine` tracks). It lists only `task_complete` and
`checkpoint`, is revoked when the attempt ends, and a call carrying it after
that is refused. It reaches the runner only in the injected MCP configuration,
as an HTTP header — never in a prompt and never on a command line.
*Avoid:* "session token" (*Session* is the plan's lifecycle module, and the
token is narrower than a session), "attempt id", "API key".

**Planner token** — the credential that binds one session's harness planner
conversation to the *Ordewell MCP server*. It lists only the planner tools:
`list_runners`, `list_models`, `task_query`, `task_output` and `load_skill`,
which read Ordewell state and the planner skill catalog; `run_command`, the
planner's research shell, inside the planner's envelope (ADR-0026); `fetch`
and `web_search`, behind the *web-read policy* (ADR-0027); and
`submit_plan` and `edit_plan`, the only writes, which
go through the same validation and commit path as the plan and `taskOps`
envelopes. A token can hide planner tools a runner already has natively:
Claude Code's hides `fetch` and `web_search`, Codex's hides `web_search`
while its own search is on. Revoked when the planner process is disposed.
*Avoid:* "session token", "admin token", and describing the planner as
write-capable — it writes nothing but the plan, and only through validation.

**Planner allowlist** — the planner's standing approvals (ADR-0026): command
rules (`gh issue list`, `gcloud * * list`), MCP tool rules (`mcp:find-*`) and
scope patterns (`https://docs.example.com/*`, `web_search:<provider>`,
`mcp-server:<name>@<hash>`), with
`!` exclusions that always win. What it covers runs
without asking anyone, in every *approval mode*; file writes are refused
whatever it says. `curl` and `wget` command rules cover origins, and never
permit those programs in Full or allowlist mode. Data, credentials and redirects
require fresh approval on every invocation. The built-in list holds read-only
families only.
*Avoid:* "whitelist", "pre-approved scopes" for the rules (a rule names an
operation by its words, a scope is what one approval remembers).

**Approval mode** — what happens to a planner request the *planner allowlist*
does not cover: `ask` the user, refuse it (`allowlist`), or run it (`allow`).
The default, `auto`, follows the autonomy level: Guarded asks, Full refuses
and the plan carries the change as an *ops task*. Web reads are the one
exception: `auto` allows them at both levels (ADR-0027).
*Avoid:* conflating it with a task's mode or the autonomy level itself.

**Web-read policy** — the one decision every planner fetch and search goes
through, on every runner, whichever path carries the bytes (ADR-0027,
`webReadPolicy.ts`). A fetch is scoped by origin, a search by the provider
that receives the query (`web_search:anthropic`, `openai`, `opencode`,
`duckduckgo`). It runs the secret check, the *planner allowlist*'s
exclusions, the *web-read budget* and the *approval mode*, and resolves a
fetch's host only after all of them. Planner-only: tasks never pass through it.
*Avoid:* "SSRF check" for the whole decision (the guard is its last step).

**Project MCP server** — an MCP server the repository declares for its
runner (`.mcp.json`, the project's `opencode.json`, `.codex/config.toml`).
A planner's runner never reads these itself (ADR-0028); Ordewell does, and
starts one for a planner only once approved, by a person or a
`mcp-server:<name>@<hash>` allowlist entry naming its exact definition. A
person's approval is remembered per repository and definition, outside the
repository. Tasks load them as their runner does.
*Avoid:* "user MCP server" (the user's own servers load for every planner
unasked), "trusted server" (no runner's trust setting decides it).

**Web-read budget** — how many web reads one planner turn may make in a
session, the planner's and its research subagents' together
(`plannerWebReadBudget`, `ORDEWELL_WEB_READ_BUDGET`); 0 turns web reads off.
*Avoid:* "per-planner budget" (it is per session and turn, shared with
subagents), "query budget" (that is the *Task query* read budget).

**Completion call** — a `task_complete({status, summary, reason?})` call made
with a task's *task token*: the only runner completion evidence. It is handed
to `VerdictEngine`, which alone produces the verdict after checking the current
generation. Evidence held behind an undelivered message is superseded when
that message is read. Only `done` passes; `blocked` and `failed` carry their
reason. The
`summary` is the task's *Report*.
*Avoid:* "self-report" or "the model says it's done" (it is the runner's
explicit signal bound to the attempt, not a judgement anyone weighs), and
"tool verdict" (the tool produces no verdict).

**Report** — the `summary` of the completion call that settled a task's
attempt, kept whole with its verdict as `outputSummary.report` (cut at 20,000
characters, saying so in what is kept). It is the task's result as its
readers get it: `task_query` and `task_output` return it ahead of any log
tail, and a dependent's *Prior task outputs* carry it in place of the tail,
cut to 4,000 characters per dependency. A call superseded by a later turn or
a message read mid-turn leaves no report. The **output summary**
(`outputSummary`) is what a task's end left behind: the verdict reason, the
report, and a `logTail` of the last turn's text only when there is no report
— an attempt that ended without a completion call, or a session saved before
reports were kept. The task prompt tells a runner the report is its whole
result, a read-only task's findings included, and never to write it to a
file instead.
*Avoid:* "log tail" for the report (the tail is a cut of the screen; the
report is what the runner chose to say), "task output" (that is the live
`output` read).

**Spawn toolkit** — the shared process policy behind the runner adapters:
`planDirectLaunch` (`utils/launch.ts`), runner environment cleanup
(`services/harness/runnerEnv.ts`), and process-group launch and disposal
(`utils/processTree.ts`). `StructuredRunner` drives the connectors through
these seams; `PoolAwareRunner` (web) wraps it behind the full `IRunner`
interface, including per-session `stop`. `utils/shell.ts` retains the shared
ANSI stripping helper (`stripAnsi`). Tests hit the pure functions and injected
process seams.
*Avoid:* re-declaring launch, environment or process helpers inside an adapter.

**Runner interface** (`IRunner`, `interfaces/IRunner.ts`) — spawns one
`IRunnerSession` per task attempt and owns stopping sessions and counting
active ones. Every session supplies its turn state, structured events, message
queue, interrupt, approvals, native session id and task tools alongside plain
output and exit notifications. `AbstractRunner` and `AbstractRunnerSession`
share lifecycle plumbing; `FakeRunnerSession` is the test seam. Structured
methods are mandatory, with no optional capability or transport discriminator.
*Avoid:* "terminal runner", "terminal session" for these interfaces.

**Task attempt** (`TaskAttempt`, inside TaskOrchestrator) — one run of one
task, from the moment the scheduler claims it to the moment it ends. It holds
everything that has to die with the run: the attempt number, the phase
(`starting` while the async spawn is in flight, `running` once the runner is
up, `integrating` while *Landing* settles its verdict), the live
`IRunnerSession`, and the runner, working directory and start
time — plus its *attempt kind* and,
in an isolated run, whether that directory is its worktree and the landing in
flight. The orchestrator keeps one
`Map<taskId, TaskAttempt>`, and every way a run ends — verdict, cancel, release,
mark complete, retry, a failed spawn, stop, plan load — goes through the one
`endAttempt`, which also clears the verifier state an interrupted run leaves
behind. Ending an attempt is also what invalidates a spawn still in flight: the
late session is compared by identity against the task's *current* attempt, so
it is killed rather than resurrecting a stopped task or displacing a newer run,
and it takes back only its own claim — a task marked complete meanwhile stays
complete. A verdict obeys the same identity rule: the attempt stays live while
its summary is read, and the verdict lands only if that attempt is still the
task's current one, so a cancel, retry, mark complete, stop or plan load in that
window is never overwritten by a stale verdict. A verdict whose settling throws
fails its attempt and says why; nothing it raises goes unhandled. Every start —
the scheduler's, a run or force start, a retry's, a continue, a resume, a
repair — takes its claim at one point (`TaskOrchestrator.claim`), which checks
in the same synchronous step that the task is in the user's approval record,
that no Stop came since the start was admitted (see *Start admission*), and
that a slot is free, and marks the attempt claimed before anything is awaited.
The scheduler also judges each task again right before claiming it — every
readiness gate — because a start it awaited, a user control or a concurrent
tick may have changed it, so it never starts held, finished or newly blocked
work, nor more than `maxParallelSessions` at once.
The working directory is decided in one place (`attemptKind.attemptCwd`): the
workspace root for an attempt that acts from the checkout, else what the
`IsolationRunController` gives it — the workspace root when the run does not
isolate, or in an isolated run the worktree `WorktreeIsolation.prepare` made for
the attempt. A passed verdict keeps the attempt live through its merge,
so the task completes — and frees its dependents — only once its work is on the
integration branch. Holds, retry counts and spawn counts are
deliberately *not* on the record — they describe the task across attempts and
must survive one ending. Surfaces read an attempt through `getAttempt`;
`activeSessionMap` is derived from it. Runner session ids
are unique per spawn for the same reason: a retry reuses its task id, and a
registry keyed by task let the old attempt's exit unregister the new one.
*Avoid:* "session" for this concept — the session is the runner's process, one
field of the attempt. Do not add another per-task map to the orchestrator for
state that ends with the run; put it on the attempt.

**Blocked task** (`blockingFailures`, `TaskOrchestrator.getBlockedBy`,
`TaskRowView.blockedBy`) — a task not started yet whose dependency failed or is
itself blocked (ADR-0034). The scheduler never starts it, its own dependents are
blocked with it, and every surface shows it "blocked by #N", naming the failed
tasks it waits on. Independent work keeps starting: a failure stops only what
depends on it. Nothing is stored — there is no `blocked` task status; the rule reads statuses and
dependencies, and a plan file saved with one loads it as pending — so a retry of the failed task that passes, or a *Skip* of it, unblocks its
dependents, which then start. A run with nothing running and only failed and blocked tasks left ends,
counting completed, failed and blocked; a retry of a task in it continues that
run (`TaskOrchestrator.awaitsResume`), and a planner edit made meanwhile is
reconciled into it rather than reloaded over it, leaving the failed task failed:
an edit is not a retry. A task at work — force-started, or waiting on the user —
is never blocked. A usage-limit pause holds the whole run until its reset, and a
merge gate keeps it waiting; neither is a block.
*Avoid:* "halted run" — a failure no longer halts the run; "waiting" for it — a
task waiting on its dependencies starts on its own once they complete, a blocked
one only after a retry or a skip.

**Skipped task** (`status: 'skipped'`, `TaskOrchestrator.skipTask`, the
`skip_task` command) — a task ended by *Skip*: a terminal state with no
Verdict, in which nothing the task produced lands. Its worktree and branch are
kept, as a failed task's are, so it can still be looked at, retried or marked
complete. Its dependents are released — a skipped dependency is met for the
blocked rule and the scheduler — and each is told in its prompt that the
dependency was skipped, with the reason (`skipReason`), and that its work is
not in their tree. Every surface shows it apart from done and failed (the task
row view's `skipped` status kind), and run summaries count it on its own. A
new run leaves it skipped, as it leaves a completed task done; a retry or Mark
complete takes it out of the state. The user may skip any task that is not
running or completed, a reason optional; the supervisor only at Act, with a
reason, and only a task that failed, is blocked or is waiting for input — and
it never runs a skipped task again (ADR-0029).
*Avoid:* "completed" or "done" for it — nothing of it landed; "cancelled" —
a cancel returns a task to pending.

**Attempt usage** (`AttemptUsage`, `Task.attemptUsage`) — the persisted ledger
of one task attempt: its number, runner, the runner session it ran in
(`sessionId`, as its runner reported it — what a later *Continue* of that
session resumes), its start and end timestamps, wall time, and reported usage
totals. Reports are grouped by source and the model that
actually ran; an unreported model stays unknown. Subagent shares are included
in totals once. The attempt number continues across reloads. A new attempt
starts a fresh ledger without dropping earlier attempts. Context fill follows
the latest main-runner model and clears on a switch until the new model reports
both prompt tokens and its window. `planUsage` sums all task attempts,
including subtasks, separately from the planner's own ledger. Status updates
carry both the task ledgers and the plan roll-up; surfaces reuse their planner
usage formatting. Surfaces show the sum of a task's attempts (*Task usage*), not one ledger. The
plan-level *Tasks total* stays at the top. Absent measures mean unknown, never zero or an estimate.
A runner that reports its session's running cost has that count saved with the
attempt (`runnerSessionCost`), so a *Continue* of the session counts its first
turn from there; with no count kept, that turn only sets the baseline.
*Avoid:* attributing a session cost to its last model without a reported
breakdown; *Avoid:* mixing planner usage into task totals; *Avoid:* "the task's
usage" for one attempt's ledger — see *Task usage*.

**Task usage** (`TaskUsageSummary`, `taskUsageSummary`, `TaskRowView.usage`) —
what a task spent in all: the sum of every *attempt usage* across every attempt
and every model, so a stop, a model change, a move or a continue never makes
earlier spend vanish. Its context meter is the exception, read from the latest
attempt, because only the current model's window says how full the next prompt
is. It is the line the TUI task view's footer, `ordewell status` and VS Code's
task-log panel show for one task, and the plan's Tasks total shows summed
(`12.4k in · 3.1k out · 2k cached · $0.42 · ctx 18%`): a part nobody reported,
cost included, is left out, and the line carries no wall time. A TUI plan row
and a VS Code task card draw none.
*Avoid:* "attempt usage" for it; *Avoid:* an estimated cost or "cost unknown"
filler.

**Attempt kind** (`AttemptKind`, `attemptKind.ts`) — what one attempt of a task
is: `change`, `ops`, `repair` (a *conflict repair*, ADR-0015), `continuation`
(a *Continue*, ADR-0018, which carries whether its task is ops) or `carryOver`
(a *Carry-over*, which carries the runner it left). Everything that
differs between attempts is read from it, never from loose flags: where the
attempt runs (`attemptCwd`), the prompt (`attemptPrompt`), whether the run
decides to isolate when it starts (`decidesIsolation` — not for work in the checkout),
whether the workspace's tracked files are compared across it (`checksTree` —
ops work in the checkout, which can be caught writing but not stopped), and
whether it keeps *Merge all* out (`mergeExcludes`, the one rule both the
attempt's start and the merge's start read). A repair outranks the ops mark, as
its work already sits in a kept worktree. A task's own `ops` mark has one
reading, `opsFlag` (only a literal `true`, only on an AI task), and a merge or
split derives its result's mark with `inheritedOps`.
*Avoid:* "mode" (permission mode, ADR-0001), "type" (`ai | user` on a task),
"phase" (an attempt's `starting | running | integrating` progress).

**Isolated execution** — running each *change task* in its own *worktree*
instead of the shared workspace root, then integrating the results
deterministically (ADR-0013, ADR-0014 and ADR-0020). Available when the workspace forms a *repo
group* — a git repository, or a folder of them — with a clean tracked tree in
each repository and `worktreeIsolation` on; otherwise every task runs in the
workspace root exactly as before, and `WorktreeIsolation.isActive` says which of
`disabled`, `git-missing`, `not-git`, `no-commits` or `dirty`
applied (the last two may name the repositories behind them). `not-git` is
left for a folder with no repository in it. A group's task integrates by an
atomic *landing*. An *ops task* runs at the workspace root instead, and a run
decides whether it isolates when its first change task starts, so a run of only
ops tasks never asks. The
Runner is only ever handed a `cwd` (ADR-0025) — git never enters
`IRunner`, `RunnerRegistry` or a runner adapter.
*Avoid:* "sandbox" (an OS-level sandbox is a separate concern, ADR-0011),
"clone" (a worktree shares the repository's object store).

**WorktreeIsolation** — the deep module owning every git and filesystem
operation isolated execution needs: worktree creation, the artifact bootstrap,
committing a task's work, the serialized integration merge, conflict detection,
release, orphan pruning, and the end-of-run handoff (diff, merge, discard).
`GitWorktreeIsolation` is the implementation; the orchestrator's tests use
`FakeWorktreeIsolation` from `@ordewell/core/testing`, and git behavior is
tested only against real temporary repositories. Under ADR-0014 it owns them for
every repository of the repo group.

**Worktree** — a linked git checkout on its own branch, created for one task at
`.ordewell/worktrees/<run-id>/<order>-<slug>` on branch
`ordewell/<run-id>/<order>-<slug>`. It is where that task's Runner executes.
Created when the task starts, removed when it integrates cleanly. A failed or
conflicted task's worktree is kept so its work can be inspected; a retry
discards it and starts a fresh one from the current integration tip. A
continue or a *Carry-over* restores its previous work on top of that tip, with
the preserved branches named to the agent if a conflict prevents restoration. Ignored
artifacts (`node_modules`, `.env*`, `.claude`, …) are linked in from the main
worktree so it is runnable at once — never `.ordewell/`, which stays at the main
root. `node_modules` (the root's and each workspace package's) is a real
directory whose entries are linked one by one, and whose own links are
recreated, so a workspace package resolves to the worktree's code rather than
the main checkout's (ADR-0013). Under ADR-0014 a task has one worktree per repo of the group, gathered in
its *task workspace*; each is bootstrapped from its own repo, with the
`worktreeLinks` matches linked beside the defaults, and `worktreeSetupCommand`
runs once per repo with `ORDEWELL_REPO` and `ORDEWELL_MAIN_REPO` set; a repo
where it fails gets the default links instead, with a warning.
*Avoid:* "workspace" for a worktree — the workspace is the user's checkout.

**Repo group** — the git repositories isolated together for one workspace
(ADR-0014). A folder that is not itself a repository forms one from the
repositories directly inside it, or, when `workspaceRepos` is set, from exactly
the repositories it lists, at any depth; a workspace
that is one repository is a group of one, with the repo at path `.`, so there is
one code path. A repository that contains repositories nested inside it that
are not submodules is still a group of one: the nested repositories cannot be
isolated with it, so they are shared live and named, never silently dropped
(ADR-0019). Repo names and roles are arbitrary and nothing may depend on them;
a group is a set of paths.
*Avoid:* "monorepo" (one repository holding many projects — a group is many
repositories), "multi-root workspace" (a VS Code notion, a later slice), "project"
or "package" for a repo.

**Shared path** — a loose file or folder in the workspace root that is in no repo
of the group, or a repo that cannot be isolated (no commits, or git refuses a
worktree), linked live into every task workspace (ADR-0014). For a repository
that is the workspace, the repositories nested inside it that are not submodules
are shared paths too, linked live at their real relative paths (ADR-0019); one
that the workspace's own repository ignores is shared like any other, so a nested
repository never vanishes from a task without a word. Edits to a shared path are
live and not reviewable, so the planner prompt lists them and does not run
parallel tasks that edit one. `.ordewell/` is never one. Symlinks on POSIX;
junctions for directories and hard links for files on Windows, with a copy and a
notice where a hard link is impossible. A directory that holds a deeper repo of
the group is recreated in the task workspace rather than linked, and its other
entries are shared one by one. A link that leads nowhere (an editor's lock file)
is not shared: there is nothing to share, and linking it would fail every task.
Every link points at the same path in the real workspace, never where a user's
own link leads, so a task workspace reaches nothing the workspace does not and
the planner's envelope (ADR-0008) is unchanged. Recorded in the run as `shared`,
with the repos among them in `sharedRepos`.
*Avoid:* "ignored file" — a shared path need not be ignored; "linked artifact"
for the per-repo bootstrap links (`node_modules`, `.env*`), which are recorded
and kept out of the task's commit.

**Task workspace** — `.ordewell/worktrees/<run-id>/<order>-<slug>/`, the
directory a task's Runner starts in under ADR-0014: one worktree per isolated
repo at the same relative path as in the real workspace, plus the shared paths
linked in, so the agent sees the real layout. Every worktree in it is on the same
branch name, `ordewell/<run-id>/<order>-<slug>`. For a group of one it is the
worktree.
*Avoid:* "workspace" bare — that is the user's real folder; "sandbox".

**Integration branch** — `ordewell/<run-id>/integration`, the one branch a run's
work lands on (in each repo of the group, under ADR-0014, where landing a task is
atomic across the repos it changed). Each task that passes its Verdict is merged into it with
`git merge --no-ff`, one at a time, lowest plan order first among the tasks
waiting, so the history is reproducible and each task is attributable to a merge
commit. A merge conflict is aborted and reported; before it reaches the user it
gets a bounded, evidenced *conflict repair* (ADR-0015), and only an unrepaired
or exhausted conflict is left for a person to resolve by hand, or as
`resolveConflictAsTask`. In a group, a conflict undoes the task's whole
*landing*. It is never merged into the checked-out branch until the
user asks. It outlives its run's worktrees (clean-up keeps it) and is deleted
only when given up (discard), or once it is merged into the checked-out branch:
right after a *Merge all* that merged everything, or at a later run's start,
which sweeps each repo for other runs' `ordewell/<run-id>/…` branches that HEAD
contains (`git merge-base --is-ancestor`), leaving any run that still has a
worktree. The decision is per repo: in a group, one repo's may go while
another's stays. One that holds work the user has not merged is never deleted
unasked.
*Avoid:* "result branch", "staging branch".

**Landing** — integrating one task under ADR-0014: its branch merged into the
integration branch of every repo it changed, or of none. Only repos where the
task branch has commits ahead of the integration tip are merged; a task that
changed nothing merges nothing and lands. Before the first merge each changed
repo's tip is recorded on the run as `landing` and the run is saved, so a
conflict or failure in any repo — or a crash, finished by `pruneOrphans` —
resets the merges already made back to those tips. The reset only ever touches
an Ordewell-owned integration branch, and only where what sits on the tip is
that one merge; a tip that has moved otherwise is left alone and the landing
stays recorded, which blocks further landings and *Merge all* (`partial-landing`)
rather than building on part of a task. `merged` always means the whole task
landed, and a dependent starts only then. `conflictRepo` names the repo that
stopped it. A landing that does not go through never fails the task, so it
blocks nothing: a conflict gets a *conflict repair* or waits on the user, and
one git refuses (`failed`) leaves the task `awaiting_user` with its verdict,
worktree and branch kept (ADR-0013).
The `Landing` module (`services/Landing.ts`) owns it, and conflict repair,
between the scheduler and the *isolation run controller*: given a passed
attempt it lands through the controller and answers `landed`,
`nothing-to-land`, `repair-needed` or `awaiting_user` (`conflict`,
`landing-failed`, `repair-failed`) with the words the user is told. It never
marks a task, starts an attempt or emits — TaskOrchestrator applies the answer.
It also builds the task `resolveConflictAsTask` adds (`conflictResolverTask`).
*Avoid:* "merge" for the whole of it — a landing is one merge per changed repo;
"rollback" for anything done to a user's branch — Ordewell never resets one.

**Conflict repair** — a bounded, automatic response to a conflicted landing
(ADR-0015): a new attempt of the same task, in its kept worktree, on its own
runner, model and mode (ADR-0001 — a repair is not a new task, so nothing
about it is rewritten). Its prompt is to `git merge` the current integration
tip into the task's branch, resolve the named files so both sides' intent
survives, build, test, commit, and report the task done (the `task_complete`
tool bound to the attempt's token). It counts as having
repaired the conflict only once all of: the done signal arrives;
the task branch now contains the tip the repair started from
(`git merge-base --is-ancestor`); `git diff --check` finds no leftover
conflict markers; and the landing that follows goes through clean — a repair
that fails that last check is a fresh conflict, not a claim taken at its word.
Capped per task by `conflictRepairAttempts` (default 2, persisted on the run
so a restart cannot re-spend it; 0 turns repair off). While one runs the task
is `in_progress` and its record `repairing`; each repair is counted when it
starts, and the files every repair was started for gather in `repairedFiles`. A repair that fails
evidence or exhausts its cap goes back to an unrepaired conflict — `awaiting_user`,
worktree and refs kept, every existing way out still open — and never fails
the task on its own. Every repair is logged as a notice, and a landed one is
named, with its files, in the *Isolation handoff*.
*Avoid:* "auto-merge" (there is still a real merge conflict to resolve, not a
fast-forward); "resolver" (that names `resolveConflictAsTask`, the explicit
`x` action a person asks for — a repair runs before anyone is asked); "auto-resolve" (implies the model's word stands in for the Verdict, which it never does).

**Merge all** — the handoff's one merge, `mergeRun`: every repo's integration
branch into what the user has checked out there, all or nothing, and only when
every repo of the run, with work or not, is on its *base branch* (else
`blocked`, reason `wrong-branch`, nothing merged; a repo mid-rebase is named as
such). Each repo with
work (commits ahead of its base ref) is preflighted without touching its tree —
no merge of the user's in progress, `git merge-tree --write-tree` against HEAD
shows no conflict, no uncommitted tracked edit to a file the integration branch
changes — and if any fails, nothing is merged and the answer is `blocked`, with
each repo, its reason and its files. A merge that still fails part-way is
aborted where it failed, and the answer names the repos that landed before it,
which stay merged. On git older than 2.38 there is no preflight: repo by repo,
stopping at the first failure. A group of one needs none either, since its one
merge lands or is aborted whole, so it answers `merged`, `conflict` or `failed`
as it always has. `merged` on a settled run clears it up like a discard, except
that each integration branch goes only where HEAD contains it, and the plan
forgets it; any other answer deletes nothing. During a run, Merge all is available
whenever landed work is not in the user's branch yet, including to open a
*merge gate*: it merges what has landed so far and the run goes on, its
branches kept for the tasks still to land (ADR-0020). It never runs while an
*ops task* does (`mergeExcludes`, read by both sides), and takes turns with
landings.
`RunMergeView` carries those unmerged landings to surfaces, which show their task
count. Its `waitingAtGate` says whether a task waits on that work; `paused`
means the running plan waits at a gate with no attempts active. The view is
absent once everything landed is merged. VS Code offers the action quietly
without a gate and keeps its mid-run card for a gate wait.
*Avoid:* per-repo merge — there is none, by design (ADR-0014).

**Change task** — a task whose result is a change to repository files: it runs
in a worktree and lands on the integration branch. Every task is one unless it
is marked `ops` (ADR-0020).
*Avoid:* "code task" — docs and config edits are changes too.

**Ops task** — an AI task marked `ops: true` (ADR-0020): it changes no repository files, acting instead on systems outside the repo (a
cloud CLI, a deployment, a pipeline) or on the git refs and history of the
user's branch (push, tag, reword). It runs at the workspace root, never in a
worktree, in the session's mode, and in parallel as its dependencies allow;
never while a Merge all runs (the flag is read through `opsFlag`). If it leaves a new tracked change in any repo of
the group, it waits on the user (`awaitingReason: 'files-changed'`) rather than
completing. A retry is told what the attempt before it did, since its effects
are never rolled back. The planner sets the mark and splits a mixed request into
a change task and an ops task; the user can flip it until the task starts. A
subtask runs with its top-level task.
*Avoid:* "operation" as the term (used loosely everywhere), "external effects
task", "checkout task" — it runs at the workspace root, which in a group is not
one checkout.

**Merge gate** — where an ops task or a user task that depends on change tasks
waits until their work is merged into the user's branch (ADR-0020): until the
checked-out HEAD contains the integration tip each of them landed at. The
user's Merge all opens it, as does a merge made by hand; Force start passes it
after a confirmation naming what is not merged, and the task keeps that choice
(`forcedPastGate`). A run with nothing else to do is *paused* at its gates.
There is no gate without isolation.
*Avoid:* "checkpoint" — that is a task asking the user to approve its work.

**Auto-merge at gates** — the **Run setting** *Merge automatically* (key `mergeAtGatesAutomatically`),
off by default, set with `/automerge` and independent of the Supervisor level
(ADR-0029, ADR-0030). When a task reaches a merge gate, Ordewell runs Merge all
itself through the same queue and preflight. A conflict or a dirty overlap
aborts with the user's tree untouched, and the gate waits for the user with a
notice. The orchestrator's `onAutoMerge` observer event carries the gated task
and merge result for a supervisor's wake-up; a failed automatic merge waits for
a user merge or the next run before automatic merging resumes. The run's copy
is in `runSettings`, which the scheduler reads as it decides each merge (it
holds no copy of its own); a change applies to it at once in the session it is
made in. The timeline records "auto-merged for task N", attributed to "Ordewell setting". It also merges at the end of a run (ADR-0029): the
end-of-run handoff is sent only if that merge stops. With it and an Act
supervisor's `merge_all` both off, Ordewell never merges for the user
(ADR-0013).
*Avoid:* "auto-land" — landing is a task's work onto the integration branch,
not the user's; *Avoid:* "auto-resolve" — a conflict is never resolved by it.

**Base ref** — the commit the user's checked-out branch pointed at when a run
minted its record, resolved once at that moment. The integration branch forks from it and
the review diff is taken against it, so switching or advancing the user's branch
mid-run does not retarget the run.

**Base branch** (`IsolationRepo.baseBranch`, `startedDetached`; ADR-0042) — the
branch a repo had checked out when the run minted its record, as opposed to the
*base ref*, the commit it pointed at. The base ref anchors the fork and the
review diff; the base branch is where *Merge all* lands, and the surfaces name
it ("`main` @ `a1b2c3d`"). A run that started on a detached HEAD has none and is
recorded as `startedDetached`; a record saved before the branch was noted has
neither, and is not checked.
*Avoid:* "target branch" — the merge target is the base branch by definition.

**Isolation run** — one Execute-Plan click or one manual task run's worth of
isolation: the `IsolationRun` record holding the run id, the repo group (`repos`:
each repo's path, root, base ref and integration branch; a single repository is
one repo at `.`), the shared paths, each task's branch, task workspace,
per-repo worktree and status, and the *landing* in flight, if any. Each new
task record keeps the integration tip it started from per repo and the task
branch tip before landing removes it. `task_diff` compares against that task
start, so predecessor changes are excluded even after the worktree is gone. It is plain JSON so it
can persist with the plan state, and a new run mints a new record. Task ids are
only unique within one plan, so every operation that acts on a task takes the run
it belongs to.
It persists as `LegacyPlanState.isolation` (`{ run, resolvers }`), written from
the orchestrator at persist time and saved whenever it changes; adopting a saved
plan prunes the run's orphans. A plan's record is *continued* rather than
replaced while anything has landed on it — a resumed plan's dependents need
their predecessors' work, which a fresh branch from the checked-out commit does
not have — and a record with nothing landed is discarded whole when the next run
mints its own. One with landed work that cannot be continued (it ran from another
workspace path) loses its worktrees, and its integration branch in each repo
whose HEAD already contains it; it keeps the others. A run closes
when its last attempt ends, however it ends — verdict, cancel, Mark complete or a
failed spawn — so the next one decides its own mode. The field belongs to one
plan: a fork must not copy it.
A record saved in the ADR-0013 shape (the refs on the run itself, one `worktree`
per task) is converted to a group of one when plan state is loaded, so a session
saved by 0.4.23 resumes and hands off as it would have.
The record and the open run's lifecycle are owned by the *isolation run
controller*.

**Isolation run controller** (`IsolationRunController`) — the module between
TaskOrchestrator and `WorktreeIsolation` that owns an *isolation run*'s
lifecycle: deciding at a run's start whether it isolates, shares the workspace
root or is a *blocked run*; continuing a plan's run or minting a new one; the
working directory of each attempt that is not already in the checkout (the
*attempt kind* decides which); a task's integration and a repair's evidence
check, with the record reported changed before the first merge; releasing a
worktree once any landing in flight settles; closing the run with its
*isolation handoff*; and Merge all, clean-up and discard afterwards. It holds the run record, the open run's mode, the
parked start of a blocked run and the resolver links, and reports through a
listener (changed, blocked, handoff, notice, worktrees about to go) — it never
emits orchestrator events or schedules work itself. A blocked start is handed
back to the caller to replay. An activation a Stop interrupts opens nothing: one
interrupted while git mints its run never installs that run over a newer
activation's, and discards it. The scheduler reads isolation state only through
it (`openRecord`, `isolating`, `current`). Session and the event relay reach its
Merge all, review, clean-up and discard directly — there is no pass-through on
the orchestrator — and its `requireRun` is the one guard for "no isolated run
to act on", throwing `PlanEditError`. Git stays in `WorktreeIsolation`.
*Avoid:* "isolation run" for the controller — that is the record it holds;
"WorktreeIsolation" for it — that is the git layer beneath it.

**Isolation handoff** — the end of an isolated run: for each repo, its integration
branch and base ref, and the tasks that landed, broadcast as `isolation_handoff`. What
follows is the user's: `reviewRunDiff`, `mergeRun` (a normal `git merge` into the
checked-out branch, only ever on that explicit call; once everything merged, the
run is cleared up and forgotten, so no surface offers its handoff again), `cleanupRun` (worktrees and
task branches go, the integration branch stays) and `discardRun` (everything
goes, and the plan forgets the run; task statuses are left as they are). A
conflicted task's first way out is automatic: a *conflict repair* (ADR-0015)
runs on the task's own attempt before anyone is asked, up to
`conflictRepairAttempts`. Only a conflict that repair does not clear leaves by
a hand resolution plus Mark complete, a retry, or `resolveConflictAsTask` — an
added task that merges the branch by hand and through whose landing the
conflicted task lands, if it is still conflicted by then (a retry in the
meantime replaces the conflict with a new attempt).
*Avoid:* "result", "output branch" for the handoff — it is a branch to review,
not an outcome.
Under ADR-0014 the handoff covers every repo of the group: one *Merge all*, and a
review diff with one section per repo that has changes, each headed by the repo's
path and with its paths rooted at the workspace (a repo that is the workspace
reads as before). A resolver task merges the conflicted branch in every repo
the task changed, since the conflict in one rolled back all of them.
In the terminal the same four steps are the handoff overlay (`/handoff`, opened
by `isolation_handoff` on a screen with nothing else open) and
`ordewell handoff [review|merge|discard|cleanup]`. Merge and discard are asked
about first, in both — the CLI takes `--yes` as having asked. A reloaded session
gets its handoff and its per-task marks from the plan's persisted run record, not
from a stream: the terminal reads it off the saved plan, and VS Code asks
`Session.isolationView` whenever its webview reconnects or a session is loaded
(the handoff card waits while a run executes). A conflicted task carries a **conflict mark** in the plan pane;
every other isolation state stays out of the row and appears, with the task's
branch, only in the expanded detail.

**Blocked run** — a run `isolation_blocked` turned away because tracked files are
modified (in any repo of the group, under ADR-0014, which the notice names). The daemon parks the start until it hears `continueWithStash` or
`continueWithoutIsolation`, so the run's execution stream stays open through the block, showing the ops
tasks still running, and the choice's own stream replaces it. Cancelling is `stopExecution`, not a dismissal: a
parked start swallows a re-run. A stash that succeeded is always said, with
how to get the changes back, even when a Stop came while it ran. The TUI asks with a three-way picker (Stash and
continue / Run without isolation / Cancel); `ordewell run` takes `--stash` and
`--without-isolation`, and without either releases the run and says so. The block
is broadcast from inside the call that starts the run, so every surface opens its
execution stream before making that call — one opened after it never hears the
block.

**The plan** — the typed, editable, diffable artifact the planner emits: an ordered
list of tasks with per-task model, thinking effort, runner, and mode. It is data,
not a running agent's internal state.

**Task reference (`TaskRefs`)** — how anyone names a task in *the plan*: its id,
its **label** with or without `#` (`#2`, `2`, or `#2.1` for the first subtask of
task 2), or its exact title. A label is the task's order under its parent,
written as the full path from the top level at any depth (`#3.2.1`): subtask
orders restart at 1 under each parent, so `#N` always means top-level task N and
a subtask is reachable only by its dotted label. Every read tool (`task_query`,
`task_read`, `task_output`, `task_diff`) names a task by that label, never by a
bare order. One module
both renders labels (`taskOrderLabel`, `taskRef`, `titledTaskRef`) and resolves
references against the plan tree (`resolveTaskRef`) — every planner op and read
tool, the per-turn plan block (which lists subtasks under their dotted labels),
execution commands, the CLI and TUI commands read the same grammar. The CLI
and TUI accept a unique id prefix as a fallback. A batch handle is the one
reference `applyTaskOps` adds on top, and order labels and titles in a batch
resolve against the plan as it stood before the batch began.
*Avoid:* "#N" for a subtask, resolving an order against a flattened task list;
`TaskRef` (the structural dependency-edit type) for a written reference.

**Runner set** — the ordered `runners: RunnerId[]` a plan may execute across,
carried on *the plan* and the session. Every task carries an `assignedRunner`
drawn from the set (always present, even for single-runner plans). Size is the
semantics, not a sentinel: size 1 means a single-runner plan, size >1 means a
multi-runner plan. Empty is invalid and rejected before planning.

**Assignment scope** (`AssignmentScope`, `assignmentIssue`; ADR-0043) — what the
user allows a plan to be built from right now: the *enabled runners* and each
runner's model allowlist. A task whose runner is switched off, or whose model is
off its runner's allowlist, carries an **assignment flag** (`assignmentFlag`:
"codex is switched off", "Opus 4 is not in the allowlist") on every surface; it
still runs as assigned, since the scope shapes what is planned, not what is
started. Completed and skipped tasks are never flagged. When the scope differs
from what the planner was last told (`scopeChange`), its next turn carries a
`<runners_changed>` block naming the change and the flagged tasks; a turn that
failed or was stopped keeps the note owed. The **enabled runners** are one list
in the settings file (`enabledRunners`), shared by the terminal UI, the daemon
and VS Code; VS Code's retired `ordewell.enabledRunners` is copied once and
cleared.
*Avoid:* "disabled task" for a flagged one — nothing about it is disabled.

**PlanEditor** — the module behind Session's direct plan edits: `updateTask`,
`setTaskDependencies`, `setTaskRunner`, `addTask`, `removeTask`, the
conflict-resolver task, and the requests that ask the planner to merge or split
tasks. `Session`'s methods of those names are one-line delegations; the rules (the lock on settled tasks, the runner retarget,
the derived assignment of a hand-added task, the ops mark) live here, reaching
the plan only through the session's `mutate` ritual, so every edit saves and
announces once. A refused edit throws `PlanEditError`, which a surface reads as
"you asked for something invalid" rather than "something broke"; the same error
type is what `IsolationRunController.requireRun` throws for an isolation action
on a plan with no run.
*Avoid:* "plan manager", "task editor" (the *TaskEditValidator* below only
checks); "Session" for the owner of these rules — Session hosts them.

**Runner retarget (`TaskRetarget` + `Session.setTaskRunner`)** — a task's runner
is the one assignment that cannot be edited as a single field. Its model,
thinking effort and mode are all scoped to the runner, so `claude-sonnet-4-5` on
Codex or `acceptEdits` on OpenCode are not degraded choices but unspawnable
ones. `retargetTaskRunner` (pure) preserves each of the three when the new
runner also offers it and otherwise snaps to that runner's preferred entry —
discovery already sorts models by the manifest's `preferredPatterns`, `modes[0]`
is the manifest's own first choice, and the effort goes through
`clampThinkingEffort`. An empty catalog means discovery failed, not that the
runner offers nothing, so that field is left untouched and the runner validates
last (as in `coerceAssignments`). `Session.setTaskRunner` is the one entry
point, and the *PlanEditor* behind it the one owner: async because it needs discovery, guarded before that call because listing
models spawns the runner's own CLI, and it admits the runner into `plan.runners`
— the set a planner edit checks a task's runner against, and which names every
runner the plan's tasks run on. Both surfaces route through it
(`PUT /api/plans/:s/tasks/:t` dispatches an `assignedRunner` in the body to it
rather than writing the field), so no surface owns a second copy of the clamp.

**Plan tree (`PlanTree`)** — the shared placement and dependency rules over a
plan's task tree, including a surface's structural projection. `walkPlan` and
`taskPlacement` return the task's siblings, ancestors, parent and dotted path;
`subtreeIds` includes the task and all its descendants. Removing a task detaches
dependencies on every id in its subtree and releases every descendant runner.
`dependentsOf` names the surviving tasks whose edges that removal detaches.
`TaskRefs` renders and resolves references using the same traversal.

**Dependency edit (`dependencyCandidates` + `canSetDependencies` +
`Session.setTaskDependencies`)** — dependencies may name any task in the plan
except the task itself, its ancestors and its descendants, provided no cycle
forms. The planner and user follow this same rule, across branches and at every
depth. `PlanTree` owns the target restrictions and cycle check; direct edits,
planner batches and whole-plan intake all read them. A planner batch is checked
on its final graph, so a later op may finish an earlier rewire. Its post-pass
`repairOrder` places top-level dependencies before their dependents, keeping
unrelated tasks in relative order and running or completed tasks in their slots;
a batch that requires moving a pinned task is refused, naming it. Display order
is not a requirement on a user's dependency edit.

`dependencyCandidates` takes the whole tree and offers earlier siblings of the
target (all top-level tasks when the id is omitted for a new task). Pickers may
offer this narrower list, but keep every existing dependency when a user changes
it, including those outside the offered list. `canSetDependencies` checks the
whole tree, so an edit the planner could write is not refused because a picker
cannot offer it. Both helpers are structural so the TUI's `TaskView` follows the
same rules. `Session.setTaskDependencies` throws rather than returning null so a
surface can say why (`PUT` maps it to 400, VS Code to a warning, and both re-show
the accepted list after a refusal).

**Hand-added task (`Session.addTask`, done by *PlanEditor*)** — async, and for the same reason
`setTaskRunner` is: a task with no model or mode is not a lighter task but an
unspawnable one, so an unset assignment is derived from the runner's catalog
through the same `runnerAssignment` the runner retarget uses. The runner defaults
to `plan.runners[0]` and is admitted into the plan (`admitRunner`, shared with
`setTaskRunner`) — `createTask`'s own `'claude-code'` fallback would otherwise
fail `validateAssignedRunners` on the next load of a plan that disabled it.
Dependencies naming tasks that no longer exist are dropped, not rejected: the
caller is a picker over the current plan, so a stale id means the plan moved on.
Because the derive lives here, both surfaces' add flows can send only what the
user actually typed — the TUI sends just a title.

**Direct edit vs planner edit** — the same task change is governed differently
depending on who asks. The planner path (`applyTaskOps`) refuses to modify or
remove a task that is `in_progress` or `completed`: the model does not get to
reach into work that is running or already finished. The direct path — the TUI's
`a`/`d` keys, the webview's task card, `PUT`/`DELETE /tasks/:taskId` — is the
user editing their own plan, so it allows both, and pays what that costs:
removing a running task cancels its runner first (`releaseTask` → `cancelTask`,
which bumps the verifier generation before the process dies), because a plan
that simply dropped the task could never reach the runner session again and the
orchestrator went on counting it as active — one of the ways "Execution is
running" became permanent. Removing a `completed` task drops it from the
completed set, which is safe because `removeTaskFromPlan` detaches the
dependents in the same op.
The asymmetry itself is expressed as one `actor` parameter (`'planner' |
'direct'`) on **TaskEditValidator**'s single `validateTaskEdit`, not as two
separate rule implementations — see below.
*Avoid:* adding a second copy of a rule to one side. A hand-set dependency list,
a type flip, and a model/mode assignment are all validated by
`validateTaskEdit` — the one guard the pickers, the API and the planner all
read, `canSetDependencies` included as one of the checks it runs.

**Planner rewrite** (`keepExecutionState(current, rewrite)`) — a planner
answering an edit with a whole task list instead of task ops: a `plan` turn on
a plan that already exists. While a task runs it is refused instead, and the
planner is asked for task edits (see **Live planner turn**). The rewrite is laid over the plan's execution
state, never swapped in for it — the same rule `applyTaskOps` enforces, for
the path that has no ops to check. A *settled* task (`completed`,
`in_progress`, `awaiting_user`) is kept exactly as it stands where the rewrite
names it and put back beside its old neighbour where the rewrite leaves it out;
every other task keeps its status and skip reason, and one the rewrite adds
starts `pending`. A planner restates tasks, it never witnessed one run, so no
status is ever read
from a rewrite. Without this, a planner that answered "add a task" with the
full plan echoed finished tasks as `pending` and they ran again.
*Avoid:* "regenerating" the plan for an edit — only `generatePlan` and the
first plan commit start from zero, and only `rearm` or Mark not done re-runs a
finished task.

**TaskEditValidator** (`validateTaskEdit(actor, tasks, taskId, changes,
catalog?)`) — the one checker behind both edit paths described above:
`applyTaskOps` calls it with `actor: 'planner'`, `PlanEditor.updateTask` (behind
`Session.updateTask`) calls it with `actor: 'direct'`. Only the lock rule (no touching `in_progress` or
`completed`) reads the actor; every other rule — a hand-set dependency list
(`canSetDependencies`), coherence on an AI↔MAN `type` flip, and whether an
`assignedModel`/`taskMode` is something the target runner actually offers —
describes the *task*, not who is editing it, so both actors run the same
check. A flip that is well-formed returns which fields the new type stripped
of meaning (`TaskEditCheck.clear`) — `assignedModel` (and with it the effort)/
`taskMode`/`autonomy` going to `user`, `userSteps` going to `ai` — named so the
caller can force-clear them and say what was lost, rather than leaving stale
values that describe a type the task no longer has. The `EditCatalog` a
model/mode check runs against is deliberately the same discovered models and
manifest modes the planner was already shown, in the per-turn catalog block
and in a Task query catalog answer (below) — a refusal here can never name
something invalid that the planner was never told about, or the reverse.
*Avoid:* calling `coerceAssignments` from here — that function is the silent
safety net for paths that never reach this validator (a plan committed under a
now-stale catalog); this validator refuses instead of coercing, because a
planner mid-edit has a repair loop to answer to and a coerced value it never
asked for would drift the plan without telling either side.

**Planned task** (`plannedTask` + `checkPlanInvariants`, `services/PlannedTask.ts`)
— the one intake for a task the planner writes, whichever route it took: a
submitted plan (`submit_plan`, the plan envelope) or an edit that adds, merges
or splits (`edit_plan`, `taskOps`). `plannedTask` builds the task and its
subtasks from the planner's JSON — every fallback its omissions meet (the
runner, the prompt, the slice inherited from a parent, the mode from read-only
or not) is written there once — and reports what the planner may not set (a
mode, read-only on a manual task) for the route to warn about or refuse.
`checkPlanInvariants` holds the resulting tasks to the rules a plan keeps at
every depth: unique ids, dependencies that exist and name neither the task itself
nor its ancestors or descendants, no cycle, a runner the plan may
use, an AFK task with no user steps, a manual task HITL, and ops only on a
top-level AI task. `validatePlanTasks` calls both on a whole plan; `applyTaskOps`
calls `plannedTask` for each task an op makes and `checkPlanInvariants` on the
batch's final state, so a later op may complete an earlier one; a broken rule is
named against the op that first broke it, and a rule the plan already broke
before the batch (matched by task and rule, not by wording) never blocks an
unrelated edit. A dependency cycle is a rule a task breaks, and names the tasks
on it. Flipping a task to a manual one makes it HITL, as every manual task is. An unknown
runner is an error on every route, never swapped for another. A thinking effort
lives only on the task's model (`assignedModel.thinkingEffort`); `edit_plan`'s
`thinkingEffort` change is a name for it.
*Avoid:* building a task from planner JSON anywhere else, and "fixing" a task
the planner wrote by substitution — what it may not have is refused.

**Task query** (`{"taskQuery":{"tasks":[...],"fields"?:[...],"catalog"?:true}}`)
— the planner's read channel, alongside the plan and `taskOps` envelopes
`classifyPlannerReply` already recognizes (see ADR-0012). An MCP-capable
planner reaches the same reads as the `task_query` and `task_output` tools
(*Planner token*, ADR-0022), which answer the same fields from the same live
state and spend the same per-turn budget; this envelope is the fallback for an
API planner. A harness planner must attach its Ordewell tools — respawned once,
then failed before any prompt is sent (ADR-0025) — so it has no envelope path. The per-turn
plan block is short-fields-only by design (title, status, runner, model, mode,
deps — never a task's `prompt`, `userSteps`, `verdict`, `outputSummary`, or
`userStoriesCovered`), so a query is how the planner reads what the block
leaves out before rewriting it, instead of fabricating content it never saw.
`PlannerConversation.drainTaskQueries` answers it — from live state, never
persisted to `conversationHistory` — in its own loop *before* `repairLoop`, so
a read never spends the corrective-retry budget a fumbled edit is owed. A
read lands mid-run like any other turn's (it mutates nothing). One field reads execution state: `output` (with top-level
`outputLines`, default 80 capped at 400, and `outputSince`, a previous
answer's next offset) returns the clean-rendered tail of a task that is
running right now, from `TaskOrchestrator.getLiveOutput` through the
conversation host — the planner's way to diagnose a stuck task mid-execution.
An ended task is pointed at its `outputSummary`/`verdict` instead. The answer
is kept within a character budget, trimming the tail's oldest lines and saying
so. Budgeted per user turn: three reads before every answer also nudges the
model to land the turn, six before the loop stops answering and returns a
message turn instead; a repeated identical query (`taskQuerySignature`) is
treated as already at the soft cap. `catalog: true` needs no plan yet, so it is
legal on the very first planning turn.
*Avoid:* inlining full task bodies into the per-turn plan block to sidestep
this — that is the token cost the channel exists to avoid paying on every
turn regardless of whether the turn needs it. *Avoid:* disclosing task log
file paths to the planner as a second read mechanism — it would carve `.ordewell/`
out of ADR-0008's path confinement and put the read outside the query budget;
the envelope read is bounded by construction.

**Webview modals are host modals** — `window.confirm`/`alert`/`prompt` are inert
in a VS Code webview: it is sandboxed without `allow-modals`, so Chromium ignores
the call and `confirm()` returns `false`. A `confirm()` guarding the Remove Task
button therefore swallowed every click silently. Destructive confirmation belongs
to the host (`vscode.window.showWarningMessage({ modal: true })`), which is also
the side that can name what the removal will change — `removalPrompt` lists the
dependents that `removeTaskFromPlan` is about to detach, because counting them
tells a user nothing about which edges they are losing.

**Provider** — an LLM vendor/API (OpenAI-compatible via OpenRouter, or Google
Gemini). Distinct from *runner*.

---

## Models & routing

**ModelResolver** — the single deep module owning everything the surfaces need to
know about models. Three responsibilities behind one interface: (a) per-runner
executor model discovery for the planner (`modelsForRunners`), (b) the
planner/review **picker catalog** (`pickerOptions` — fetched provider
catalogs only; shortcuts are a curated label/ordering overlay on fetched ids,
never injected as standalone entries), and (c) building the **provider model lists** that drive
routing (`refresh`). Constructed with `(registry, config)`; owns all model caches
behind one `invalidate()`. Discovery (formerly the `ModelDiscovery` class), the
OpenRouter catalog fetch, and Gemini discovery are its *implementation*, not its
interface. `fetch` and `exec` are injectable so the subsystem is testable without
network or child processes.
*Avoid:* "model service", "model manager" — and do not let callers re-assemble
`modelsByRunner` or the routing lists themselves; that leverage belongs to the
resolver.

**Harness planner** — a *runner* serving as the *planner* (ADR-0009). Selecting
`claude-code`, `codex`, or `opencode` in the provider dropdown runs the planner
conversation through that coding agent's own programmatic transport, so no API
key is requested and the user's existing subscription pays for planning. This
deliberately puts runners into the planner setting beside the vendors, against
the Provider/Runner split the rest of this glossary keeps: "what plans for me?"
is one user question and belongs in one setting. The setting is a
`PlannerBackendId` — an `AiProvider` (vendors only, a closed union) or a runner
id — and every built-in runner with a connector is a harness planner, derived
from its manifest and connector rather than listed anywhere else. `isCliProvider()` is the single
predicate that tells the two kinds apart, and it guards exactly three things —
API-key resolution (skipped), provider routing (skipped), and the planner-model
picker (fed by per-runner discovery instead of the vendor catalog). The
transport lives behind the existing `IAiService` seam (`CliAgentAiService` plus
one adapter per agent); everything above it — reply classification, the repair
loop, `ResearchProgress`, the four surfaces — is untouched. Read-only is
enforced at spawn *and* at the request surface: whatever an agent can ask a
human for is either withheld (OpenCode's `question` tool) or answered with a
refusal (its `permission.asked` events; every Codex server→client request,
including the ones whose result schema cannot express "no" and so get a
JSON-RPC error). Unanswered is not a denial to these agents — it is a hang. The
planner prompt is always *appended* to the agent's own instructions, never
substituted for them, or the agent forgets what its tools are. A planner must
also be *able* to read: Codex's sandbox is probed before its handshake
(`codexSandbox.ts`), because a bubblewrap that cannot create user namespaces
leaves its own shell running nothing. Where no backend starts, a planner's
Codex shell is switched off and it reads through `run_command` alone
(ADR-0033); a task that needs the sandbox is refused. A harness
planner also gets the *Planner token* and its tools (ADR-0022): `list_runners`
and `list_models` read the live catalog, `task_query` and `task_output` read
tasks, and `submit_plan`/`edit_plan` are the only writes, all pre-authorized.
A harness planner that cannot attach its tools is respawned once and, if that
also fails, the planner turn fails before any prompt is sent (ADR-0025); it
never falls back to a prompt-and-JSON-envelope path. API planners use the
validated plan, `taskOps` and `taskQuery` envelopes instead of this server.
*Avoid:* "CLI provider" — the thing on the other end is not a vendor. Do not
call the coding agent a "provider" in prose; it is a runner being used as the
planner.

**Planner session** (`PlannerSession`, in `CliAgentAiService`) — one harness
planner conversation or one-shot generation: its process, the *Planner token*
that process was spawned with, its native session id (a resume hint that never
outlives the session), its search decision and the subagents it reported. A
session boundary discards the session object; a spawn still in flight for a
discarded session kills its own process and revokes its token when it lands,
and a one-shot never touches the conversation's session.
*Avoid:* using it for the plan-level **Session**, which outlives many planner
sessions.

**Saved output** — a tool result too long for the context that a runner saved
to a file outside the workspace, telling the model to read it back: Claude
Code's session `tool-results/` folder, the file OpenCode 2.x names in
`outputPath`. Codex saves none. A harness planner reads its own session's
saved output as it reads the workspace, never asked and in any mode; the
adapter's `savedOutput` says what counts, after the path is resolved on disk
(ADR-0032). Not a runner's *memory*, which is off in every Ordewell run,
planner and task alike. *Avoid:* "spill file".

**agent_tool** — the `ResearchToolType` member for a harness planner's own tools
that Ordewell has no equivalent for (`Edit`, `TodoWrite`, `Task`, whatever ships
next). The agent's real name travels in `ResearchStep.toolLabel`, so a timeline
never claims a web fetch was a shell command. Well-known agent tools (`Read`,
`Grep`, `Glob`, `Bash`, `shell`) map onto the existing members instead and
render through the code path that is already there.
*Avoid:* widening `ResearchToolType` to arbitrary strings — the closed union is
what gives the surfaces' icon/label switches their exhaustiveness checking.

**runnerProvider** — the runner-internal backend a discovered model belongs to, exactly as that runner's own catalog prints it. It was `"opencode"`/`"opencode-go"` when OpenCode namespaced by backend; today most of its 414 models come back as `"openrouter"`, because the prefix names the *serving* provider. Carried on `DiscoveredModel`. Distinct from the Ordewell concept of *Provider* (LLM vendor).
*Avoid:* "provider" for this concept — use `runnerProvider`. And do not use it alone as a group header: it cannot say which agent Ordewell would spawn.

**runnerId / runnerLabel** — the runner whose catalog listed a model, stamped once at `ModelDiscovery.discover` (the only place that knows both the output and the agent that produced it). Model pickers group on the pair — `OpenCode · openrouter`, `Claude Code · anthropic` — so the header names the agent that runs the model and the backend that serves it. `runnerProvider` alone answered neither question in a flat cross-runner list.

**Planner model & effort** — the harness planner's own model and thinking effort (ADR-0009, stories 7–9), distinct from the per-task assignments the plan carries. Stored as `orchestratorModel` + `plannerThinkingEffort`; the candidates are the *runner's* `DiscoveredModel[]` and the selected model's own `variants`, never a fixed low/medium/high the agent may not declare. One stepped control per surface: `/planner` in the TUI and in VS Code walks Harness › Model › Effort (effort is skipped when the model declares no variants). The TUI saves each step on enter, with the later steps at their pre-selection, so the planner never holds one backend with another's model; VS Code saves once, at the last step, and cancelling there applies nothing. `/planner <provider>`, `/model` and `/planner-effort` remain as shortcuts, and VS Code's planner bar keeps its backend pills and model/effort selector. Each backend's last pick is remembered per planner backend id under the settings file's `plannerModels` key — the same file as `modelAllowlist`, so the TUI, CLI and VS Code extension share one memory. Switching back to a backend restores the model (and effort, when that model still declares the variant) it remembers; with nothing remembered it falls back to the first model in that backend's catalog, and only a catalog that discovers no models leaves the planner model unset. Clearing a model always clears its effort — an effort is a variant of a specific model, and one that outlives its model reaches the agent as a level it never offered. `BaseConfig.resolvePlanner` resolves provider, model and effort together and says where they came from. A model picked in this session for the planner in effect (`/model`, a `/planner` pick — held by the daemon or the extension host, not saved as such) and a vendor's configured model plan with the configured model and effort; a model picked for another planner is not this one's, which plans with its remembered model and effort, otherwise its own default. A coding agent the user named (AI_PROVIDER, VS Code's `aiProvider`, a `/planner` switch) keeps the configured model unless it is plainly a vendor's — the shape test below, or for OpenCode, whose own ids are `provider/model`, a slug its discovered catalog does not list — and is then treated the same way. A request's own model (`modelOverride`) wins for that request and is never saved. An agent that plans only because detection found it never chose the *inherited* model — `ORCHESTRATOR_MODEL` from the environment or `.env`, or VS Code's `orchestratorModel` — so it keeps that model, with the effort beside it, only when the model is one of its stable aliases (`canonicalAliases`); otherwise it plans with its remembered model and effort, otherwise its own default. A remembered model that is plainly a vendor's (`openai:…`, or an OpenRouter `org/model` slug for an agent whose ids are not `provider/model`) is read past, never deleted. Nothing derived this way is written to `plannerModels` or the configured settings. `ordewell plan` forwards the model and effort it inherited as `inherited`, which the daemon applies without judging a pick.
*Avoid:* "orchestrator model" in user-facing text — it collides with the `TaskOrchestrator`; say *planner model*. The `orchestratorModel` setting key and the `ORCHESTRATOR_MODEL` env var keep their names.

**Planner selection** (`selectPlanner`, core) — the one rule for any change of who plans, with which model and effort. It takes the current provider/model/effort, the change (any of the three), the memory and the catalog of the provider in effect afterwards, and returns the next state, the pick to remember, and — for a switch that filled in its own model — the recall the surface words its notice from. It stores nothing. Reselecting the backend already in use changes nothing. A switch with no model of its own (or the blank one legacy clients send) recalls; a switch with a model is a pick, and never inherits the old backend's effort. A new model within the same backend keeps the current effort unless the catalog lists that model with variants that lack the level, and an explicit effort is held to the same test; a cold catalog, a hand-typed id or a vendor model (which declares no variants) leaves the user's word standing. An effort on its own is remembered only with a model that is the user's own — configured, or the backend's remembered pick — never with a detected agent's inherited model or with none, and it never rewrites the configured model. The daemon (`OrchestratorPool.updateSettings`) and VS Code (`PlannerSelection`) are its callers, each with only its storage — `process.env` and the extension's configuration, both remembering through `PlannerModelMemory`; the CLI and TUI send the change to the daemon and persist to `.env` what it answers.
*Avoid:* deciding a recall, or whether an effort survives a model, in a surface.

**Stepped picker** — the TUI overlay that walks several dependent choices in one panel (`/planner`, `/settings`): the steps are listed at the top, enter saves the step at once (`/planner` then advances; `/settings` stays on the step), ←/→ jump between steps (tab/shift-tab still work) without saving the highlighted row, and esc closes from any step, keeping what was saved. A later step's options are rebuilt when an earlier choice changes. Short lists number their rows (digit keys select), labels and details are aligned in columns, and the current value carries a `(current)` marker. Numeric settings are typed (↑/↓ move by one), not picked from a list. VS Code's `/planner` is a multi-step quick pick with a Back button; VS Code's `/settings` is the Run block of the webview Settings panel, where each setting is saved as it is set.
*Avoid:* "wizard" for the TUI overlay.

**ModelAllowlistResolver** — the deep module owning the planner-visibility allowlist policy: narrowing what `modelsByRunner` the planner sees in its prompt (the nudge) and rewriting any emitted `assignedModel.modelId` outside the allowlist to `allowlist[0]` for that runner, wiping the paired `thinkingEffort` (the coerce). It walks subtasks too, never moves a task to another runner (an unknown runner is refused before coercion, see *Planned task*), and returns what it changed beside the tasks, which `submit_plan` and `edit_plan` report. `coerceAssignments` also clamps each `thinkingEffort` to a variant the assigned model actually offers (per the discovered catalog, when passed): invalid efforts snap to the nearest rung of the known effort ladder (`clampThinkingEffort`), or to undefined — the runner default — when no mapping exists. Symmetric to `ModeResolver` — both own a planner policy paired with a post-parse fix. Reads its state from `SettingsService` (`UserSettings.modelAllowlist`, keyed by `RunnerId`, id-level not variant-level). The restriction is advice to the planner only: the per-task dropdown stays full (manual override is sovereign), `loadPlan` is untouched, and the orchestrator never consults it. A set allowlist is a hard bound on what the planner sees: allowlisted ids not covered by discovery are synthesized into the prompt list rather than falling back to the full discovered list (which would leak non-allowlisted models to the planner).
*Avoid:* "model filter", "model restriction service" — and do not collapse into `ModelResolver`; the discovery/routing module stays unaware of the policy, the same way `ModeResolver` stays separate from `ModelResolver`.

**Provider model lists** — the canonical `{ openrouter[], google[] }` id lists
`resolveProvider` matches a chosen model id against to pick its serving API. The
ModelResolver is the **sole producer**: native Gemini ids are always minted with
the `gemini:` qualifier (`geminiOptionId`) so a stored `gemini:<id>` routes to
the Gemini API, never to OpenRouter's `google/<id>` namespace. Built in one place to
keep the two surfaces from diverging. The lists only route when nobody named a
planner: an explicit `AI_PROVIDER` or VS Code `aiProvider` always wins over them.
The daemon drops a vendor's list when its credential is removed, and every config
it builds reads the current lists, so a session never routes to a vendor the
settings response no longer names.

---

## Modes

**ModeResolver** — the deep module owning mode resolution (ADR-0001,
ADR-0031): the policy that gives each AI task the planner writes its runner
mode (`build`/`acceptEdits`/`plan`/…), decided when the task is planned, from
manifest `autonomous`/`safe`/`readOnly` tags, the task's *read-only* answer and
the global autonomy toggle — two named levels, **Full** (the
`autonomous`-tagged mode) and **Guarded** (the `safe`-tagged mode), saved
machine-wide in `settings.json` (ADR-0030), carried as
the boolean `autonomousMode` (`autonomousDefault`, TUI `autonomous`) and named for
users by `autonomyLevelLabel`; `/auto full|guarded` selects one, with `on`/`off` and `auto` as
aliases (`parseAutonomyLevel`). Its operations: `resolveDefaultMode` (the
level's mode for a runner), `readOnlyMode` (the runner's `readOnly`-tagged
mode, if any) and `plannedMode` (the mode a planned task lands on — the plan
parser and the planner's edits both call it). The planner never names a mode;
the user's per-task choice is never checked against the level, and nothing is
rewritten at spawn: what the plan says is what runs.
*Avoid:* "mode service", "mode manager", "auto mode" for either level, and "Full auto" /
"Auto" (the levels' old names) — Claude Code has a real `auto` permission mode
(its classifier), which is Ordewell's *Guarded* level on that runner, not a
synonym for Full — and do not confuse with
**ModelResolver** (model discovery/routing). The names differ by one letter on
purpose: ModeResolver resolves *runner modes*; ModelResolver resolves *models*.
*Avoid:* "the parser" for this policy — it lives in `ModeResolver.ts`, not the
plan parser, even though the parser calls `plannedMode`.

**Read-only task** — an AI task the planner marks `readOnly: true` because it
must not change any file: a review, an audit, an analysis whose result is a
report (ADR-0031). It runs in its runner's `readOnly`-tagged mode (`plan` on
every built-in runner), at either level, and stays read-only through a
planner's move or split unless the planner lifts it with `readOnly: false`.
Its AI subtasks are read-only too unless one says otherwise; a manual task
and an ops task cannot be one.
The planner's only say over a task's mode; a runner without a read-only mode
cannot take one. It is a request, not a task field: the task stores the mode.
*Avoid:* "plan mode task" (`plan` is one runner's mode id, not the concept),
"analysis task".

**Unavailable mode** (`RunnerModeInfo.unavailable`,
`RunnerRegistry.setUnavailableModes`, `unavailableModeReason`) — a mode a
runner's manifest declares but this host cannot run, carrying the reason. It
is listed, with the reason, but never assigned: the planner is not offered it,
a plan or an edit that puts a task in it is refused, and a task already in one
fails at start saying why. Nothing swaps it for another mode (ADR-0001). Today
only Codex's sandboxed modes become unavailable, on a failed *Sandbox probe*.
*Avoid:* "disabled mode" — the user did not turn it off; "hidden" — it is
shown.

**Sandbox probe** (`probeCodexSandbox`, `CodexSandboxAvailability`) — the
once-per-daemon `codex sandbox` check that decides whether Codex's sandbox can
start on this host. Only its `unavailable` decision makes Codex's read-only and
Guarded modes *Unavailable modes*, and a Codex planner plan with its own shell
off (ADR-0033); `docs/troubleshooting.md` says how to fix the host.
*Avoid:* "capability check".

---

## Verification

**Verdict** — the single structured outcome of verifying a finished task:
`{ outcome: 'pass' | 'fail', reason, checks[] }`. Produced by the
**VerdictEngine** (the deep verification module), applied by the orchestrator.
The verdict is owned *entirely* behind the VerdictEngine's interface; the
orchestrator schedules on the outcome, it does not re-derive it.
*Avoid:* "review result", "verification result" as separate concepts — they were
two redundant shapes for the same fact and collapse into the Verdict.

**Mark complete** — the user action of force-completing any task regardless of
runner state. Promotes the task to `status: 'completed'`, records a synthetic
`pass` Verdict with a `manual` verification check, archives the task to the
execution log, and unblocks dependents so the scheduler can advance. Distinct
from `cancelTask` (which returns a task to `pending` and places it on hold) and
from automatic completion (which is produced by the VerdictEngine when the
runner makes a **Completion call**).
A clean runner exit without a completion call is a failed verdict, never implicit
completion. It is the user's vouch for the work, and the only way to land work
no passing verdict landed: the supervisor cannot Mark complete. Works on a
*Skipped task* too, landing its kept work.
*Avoid:* "skip" for this concept — Skip lands nothing (see *Skipped task*).

**Mark not done** — the inverse user action, and the only way back out of a
completion: `markTaskIncomplete` returns a `completed` task to `pending`, drops
its Verdict and output summary, and *removes its execution-log snapshot* —
dependents are prompted from that log, so a left-behind snapshot would keep
feeding them a result that no longer exists. The task is placed on hold like a
cancel, so a running plan does not immediately re-spawn the work just un-marked
(Retry / Force Start / Run release the hold), and a plan whose status had
reached `completed` returns to `approved`. It is a no-op on any task that is not
completed. Both directions are one affordance per surface, never two: the VS
Code task-check ring toggles, and the TUI's `m` picks its direction from the
selected task's status (footer hint follows: `m done` / `m undone`).
*Avoid:* "un-skip" — a skipped task is not completed, so this does not apply to
it; "reopen" — and do not model it as `retryTask`, which counts a retry attempt
and releases the hold.

**VerdictEngine** — the deep module owning the verification state machine:
**Completion calls** from token-bound handlers, `checkpoint` tool calls and
answers, idle tracking, exit-code normalization, verdict production and the
manual "Mark complete" override. The orchestrator hands each spawned session
to `watch(task, session)` and receives verdicts through `onVerdict`; it never
re-derives them. `markComplete`, `clear` and `reset` route through the same
owner. Each callback carries its attempt's generation, from a counter that
`reset` never rewinds, so a stale callback cannot settle a later attempt. A
completion call held behind an undelivered message is invalidated when the
runner reads that message. Output only refreshes advisory idle tracking; it
is never scanned for completion or checkpoint markers. A fake `IRunnerSession`
is the test seam.
*Avoid:* "the verifier", "TaskVerifier" — use VerdictEngine.

**TaskOutputSource** (`interfaces/TaskOutputSource.ts`, default
`BufferedTaskOutputSource`) — the one owner of a task attempt's output,
injected into TaskOrchestrator through `SessionDeps.taskOutput`. It keeps a
bounded buffer fed by the session and answers `finalText` (the completion
call's summary, falling back to clean plain output for the current turn) and
`liveTail` (a bounded diagnostic window with an absolute `nextOffset`). A new
turn or a message read mid-turn clears the earlier summary and advances the
output boundary. It does not discover transcripts or render a runner's PTY.
*Avoid:* "the output buffer", "transcript capture" as the owner — a transcript
is a separate artifact, not completion evidence.

**Check** — one deterministic signal inside a verdict. `task_complete` is the
required completion check, with `exit_code` as supporting diagnostic evidence.
A manual completion has a `manual` check. `model_review`, `workspace_changes`
and `verify_command` were removed because they conflated evidence with opinion.
Verification never asks a model to break a tie. A runner exit without a
completion call fails, even with exit code zero.

**Testing strategy** — *removed.* Verification is completion-evidence based;
the planner no longer assigns a testing strategy per task. The `user_verify`
strategy is gone — a human who must confirm is modeled directly as a
`type: 'user'` task, not as an AI task awaiting verdict promotion.

---

## Planner conversation display

**Turn** — one exchange with the planner, from the user's prompt (or an
internal trigger) to a settled outcome, streamed between `planner_turn_started`
and `planner_turn_ended` under one `turnId`. Every turn-scoped message carries
that id; a message without a `turnId` does not belong to a streamed turn.
Turns settle through one classification (`PlannerTurnOutcome`: `message`,
`plan`, `task_ops`, `stopped`, `error`) and the settled message is
authoritative over anything streamed inside the turn.
*Avoid:* "the reply" for the whole turn — the turn includes tool calls,
thinking and possibly subagents; *Avoid:* overloading with the model's own
providers' "turns" — a harness planner may open turns of its own, and only ones
Ordewell opened are one of these.

**Text run** (`runId` on `assistant_text` / `assistant_text_delta`, and on a
task log's `text` / `text_delta`) — one stretch of a coding agent's reply text
under the runner's own id for it: a Claude Code text block, a Codex
`agentMessage`, an OpenCode text part. Its deltas and its complete copy share
the id, the copy replacing the deltas where the run began; a read-back of what
the stream missed reuses the id of the run it recovers. Runs carry no paragraph
break between them — whoever joins them puts one in — and a harness planner
streams each run as a segment of its own (`TurnReply`).
*Avoid:* "run" alone, which is a plan's; "message" or "block" for it — a
message holds several runs, and a block is what a surface draws.

**Segment** — a stream of reply text inside one turn a surface can show as one
growing message, keyed by `segmentId` on `planner_text_delta`. A backend that
streams prose, then an envelope, then more prose, hands over several segments;
the turn's final segment is the one a settled `planner_message` replaces.
*Avoid:* calling the segment "the reply" — only a settled `planner_message` is
that; *Avoid:* numbering segments by arrival — ids are given by the session,
not derived.

**Retraction** — `planner_text_retracted` saying streamed text was thrown away
for good: the reply it belonged to was discarded (a corrective retry, an
aborted segment). Everything a segment had streamed is dropped unless a later
`planner_message` or a later segment of the same turn replaces it; the block
the text was accumulating in ends and never returns from reload, because
retracted text is saved nowhere. A segment that streamed to the plan display
takes the turn's building plan with it, so a re-emitted plan never builds on
the botched one.
*Avoid:* "edit" — the text is not corrected, it is withdrawn whole;
*Avoid:* treating it as an error — a retracted segment is what a bounded
repair loop looks like to a viewer.

**Display block** (`core/src/conversation/blocks.ts`) — one thing a surface
draws for the planner conversation or a structured task's log: a `message`
(user, planner, agent, system or error), `thinking`, `tool`, `subagent`,
`approval`, `plan` or the `usage` token line. Built once in core by
`reduceConversation` from the `SessionMessage` stream plus the surface's own
`LocalEntry` lines, or by `reduceTaskLog` from a task's log; a block's `id` is stable for
as long as the block exists, so a surface can key its UI state on it.
*Avoid:* deriving a per-surface block shape from raw `SessionMessage`s again —
the block list is the contract (ADR-0017); *Avoid:* storing per-block UI state
(expanded/collapsed) in the block — it is the surface's.

**Conversation view** (`reduceConversation`, `EMPTY_CONVERSATION`) — the
stateful accumulator behind the blocks: every `SessionMessage` in and the view
out. Pure and reusable per surface, including `fromTranscript`, which rebuilds
the saved subset and pending turn inputs for a reloaded session. Pending inputs
follow the landed records with their skill loads and wake-up roles, and are
adopted when the live turn or landed transcript accounts for them. The newest transcript entry the view
accounts for (`transcriptAt`) is what tells a reconnecting surface what is new.
*Avoid:* calling it a chat log or a message list — it is a reducer over
messages to a drawing, and streamed semi-states live in it;
*Avoid:* a surface holding its own parallel mirror of the view.

**Run view** (`RunView`, `reduceRun`, `EMPTY_RUN`, `Session.runSnapshot()`) —
the conversation view's counterpart for a run: each task's plan fields and its
status-only fields, plus the run's merge view, usage, run settings, handoff and
last Merge all result. `reduceRun` folds `SessionMessage`s and plan snapshots
(`plan_snapshot`: a plan a surface read whole) into it, and is the one place
that decides what a plan refresh keeps: plan fields (title, dependencies,
`addedBy`, skills, …) come from the plan, absent meaning none; status-only
fields (verdict, `idleSince`, isolation, checkpoint, queued messages,
`continuable`, `awaitingApproval`, merge gate, `forcedPastGate`) stay as the
last status update said, the checkpoint question only while the task still
waits at it. A status update replaces every status field it covers. The daemon
sends `Session.runSnapshot()` as a `run_snapshot` frame right after
`connected`, so a client that joins mid-run has the run before the next update;
the session routes' load and read answers carry it too. Whether the run is
closed is the Session's word, `run_closed` (a Merge all that left nothing to
hand over, or a discard), which `reduceRun` folds into dropping the marks,
the handoff and the merge view; a merge that leaves the run going keeps them.
*Avoid:* a surface deciding for itself which task fields survive a plan
refresh — the surfaces disagreed, and one dropped checkpoints and `addedBy`;
*Avoid:* a surface guessing from a merge result, or from the saved run record,
whether the run is closed;
*Avoid:* "task state" for the whole of it — a task's status is one field.

**Turn gate** (`TurnGate`, `followTurn`, `stopTurn`) — the stop rule, beside
the conversation view: which planner turn a surface has open and which one
its user stopped. A stop ends the turn on screen at once, and whatever the
stopped turn still streams until the backend notices the abort is dropped;
usage, approvals and transcript markers are facts and still land. Both
surfaces fold session messages through `followTurn`, so a stopped reply looks
the same in the TUI and VS Code.
*Avoid:* keeping a stopped turn's late deltas "until the daemon answers" —
that was one surface's rule and the two drifted.

**Detail view (detail-all)** — the single expand-all toggle per surface: the
TUI's ctrl+o and VS Code's header button flip one `detailAll` flag that decides
whether tool blocks show their arguments and full output, subagent blocks show
their children and digest, and so on. Collapsed is the default: a row per call
(`Name(keyArg)`) and one preview line. There are deliberately no per-block
expanded states (see ADR-0017's rejected options). The TUI's ctrl+L clears the
conversation but keeps the token line.
*Avoid:* "expandable row" per block — one toggle, one place, per surface;
*Avoid:* claiming the surfaces share the flag's key — ctrl+o is the TUI's
spelling, not the concept.

**Usage record** (`UsageRecord`) — what one model call consumed, as its
provider or runner *reported* it: token counts, cached input share, the
context window when the reporter states one, and `reportedCost` only when the
source itself billed one. Every measure is optional because backends report
different subsets; absent means "not reported", never zero.
*Avoid:* filling a missing number from a price table or an estimate — prices
go stale and a subscription runner has no per-token price at all (ADR-0017);
*Avoid:* treating a record as a statement about *who* called — it says nothing.

**Usage totals** (`UsageTotals`, `PlannerUsage`) — the running sum of usage
records for the session. Token counts stay absent until some record reports
them; cost is kept per currency because two runners may bill in different ones
and no honest exchange rate folds them together. `bySubagent` holds each
research subagent's own share, which is already counted in `totals` — never
added twice. Surfaced as the one `usage` block, the token line, always last.
*Avoid:* merging currencies; *Avoid:* a "grand total" that mixes the planner's
own calls in with per-subagent sums shown alongside.

**Context fill** (`plannerContextFill`) — how full the planner's own context
window is, from its last prompt's reported input tokens against the window the
runner reports. Derived only for the planner's own calls: a subagent runs its
own model, whose window says nothing about the planner's. A reported window of
0 means "not known", and then the fill is simply omitted — never shown against
a guessed zero. The window is the reporter's own; a record that states none is
filled (`ContextWindowFill`) from the runner's own model listing or the
provider's own models endpoint for that record's model, per record so a model
change mid-stream reads its own window, and a window reported once is kept for
its model, even after the stream ran on another. A task's Continue starts from
the window its session was last measured against. Never from a table kept in Ordewell: neither known leaves the fill
unknown.
*Avoid:* calling it a percentage when either half is unknown; *Avoid:* a window
table in Ordewell.

**Subagent lifecycle** — a research subagent as a first-class block: announced
by `subagent_started` (brief and model), running its calls tagged with its
`subagentId`, ended by `subagent_finished` with an outcome
(`done | failed | stopped`) and the digest it handed back. The planner's
`spawn` tool call becomes the subagent's own block — the two never show as
separate rows. Usage is folded through the same events, tagged
`subagentId`. Persisted in the research log; a reload regroups child steps
under the subagent's block rather than duplicating them.
*Avoid:* "child session" for the concept (that is OpenCode's mechanism, not the
contract); *Avoid:* a finished subagent without an outcome claiming success —
omit or failed, never guessed.

**Queued prompt** — a message the user sent while a planner turn was in
flight, held and sent as the next turn's input rather than bounced (the
`ConversationBusyError` path stays for operations that would share the live
context, such as a Compaction). One module owns it:
`core/src/conversation/promptHold.ts`, a pure hold both surfaces keep — the TUI
in its reducer state, VS Code on the host (`ConversationViewHost`). Prompts go
out **oldest first**, one per settled turn; **unsend takes the newest** back
into the drafting input, above any draft, and the planner keeps running. A
stopped turn gives every held prompt back to the input, in the order typed; a
new or reloaded session drops them. Drawn after the conversation, never in it:
a prompt joins the conversation only once it is sent.
*Avoid:* "pending message" (that names the whole queue's existence, not one
entry); *Avoid:* treating unsend as cancel — nothing in flight is stopped; the
prompt simply never goes; *Avoid:* "queued prompt" for an input a **Live
planner turn** is still to take — core holds those, and no surface lists them.

**Supervisor** — the planner conversation that wrote the plan, taking turns
during the run it planned (ADR-0029, #27). Not a second model or process: its
notes are in the same `conversationHistory`, marked with their own message
`kind` (`supervisor`, and `wake_up` for the **Run update** it was given) so
surfaces style them apart from replies to the user. One module owns when it
wakes and how it fails: `Supervisor` (`services/Supervisor.ts`), fed run
events by **Run supervision** and batching them through `WakePolicy`. What it
may do is set by the run's **Supervisor level** and checked at the **Command
seam**.
It decides what to do next, never whether a task passed — verdicts come from
evidence. The run never depends on it: a wake-up turn that still fails after one
restart leaves the run *unsupervised* (carrying on as Off, with a notice and a
note in the transcript; `runSettings.unsupervised` says why).
*Avoid:* "agent", "orchestrator" (the scheduler is `TaskOrchestrator`),
"autopilot".

**Supervisor level** — the **Run setting** **Off** / **Watch** / **Act**,
Watch by default, set with `/supervisor` (ADR-0029, ADR-0030). Off: the planner
speaks only when the user writes. Watch: wake-up turns read and suggest;
execution tools and plan edits are refused, with a note telling it to suggest
the action to the user. Act: wake-up turns may also run, stop, retry and skip
tasks (`skip_task`, with a reason; never Mark complete), message runners, deny
approvals, edit the plan task by task (a whole new plan is refused) and merge
(`merge_all`), without asking, inside the **Loop
guards**; a task it adds is approved to run, ops tasks included
(`addedBy: 'supervisor'`, with its origin recorded in the planner
conversation). A run holds its own copy,
`runSettings.supervisorLevel`, which the Command seam reads at each call. A
tripped wake-up-rate guard or a failed supervisor lowers it for the rest of the
run; the user's `/supervisor` sets it, up or down, at once in the session it is
typed in, lifting such a lowering with the guards' memory kept. A run the
supervisor restarts itself, or a usage-limit reset resumes, keeps the level the
run had; a start of the user's copies the global value afresh (see **Run
origin**). A slim precursor of the mandate (#23): Watch is `observe`, Act
becomes `control` + `replan`.
*Avoid:* "autonomous", "autonomy" or "auto" for it — those name the runner
permission modes and the Full/Guarded autonomy level (ADR-0001), a separate
setting; a Guarded session can have an Act supervisor. *Avoid:* "mandate" until
#23 defines one.

**Run settings** — the machine-wide user settings that say how a run is
started, watched and merged: **Supervisor level**, **Auto-merge at gates**,
**Autorun**, the supervisor's retry limit and the wake-up read budget
(ADR-0030). Saved in `settings.json`, changed only by the user's chat commands
(`/supervisor`, `/automerge`, `/autorun`) or `PATCH /api/settings`, never by the
planner. A change applies at once to the session it is made in; another
session's run under way keeps its values until it ends. A run's own copy is
`runSettings` on the plan, which only **Run supervision** writes; the plan
stores no other copy.
*Avoid:* "autonomy" or "autonomy settings" for them — *autonomy* is the
Full/Guarded level only, shown on its own Setup row; *Avoid:* "plan settings"
(they stopped being per plan).

**Run supervision** (`RunSupervision`, `services/RunSupervision.ts`) — the deep
module owning one plan's run supervision (ADR-0029, ADR-0030): the run's own
**Run settings** (`runSettings`), whether a run starts afresh or continues the
last (by its **Run origin**), the user's change applied to the run at once
(`apply`), the lowerings — a tripped wake-up-rate guard to Watch, a failed
supervisor to unsupervised — the **Loop guards**' memory, and the end-of-run
handoff an Act supervisor has first. It owns the `Supervisor`, which decides
when the planner wakes. The Session forwards run events to it and reads back
only the level; the scheduler reads the run's settings through one
`runSettings()` callback as it decides, and nothing is pushed to it.
*Avoid:* "supervisor" for the module — the Supervisor is the planner
conversation taking turns; Run supervision holds the run to its settings.

**Run state** (`RunState`, in `TaskOrchestrator`; ADR-0034, ADR-0018 U1) —
where the full-plan run stands, as one value: *idle* (no full-plan run since
the plan loaded or the user stopped one; a task started on its own may still be
at work), *scheduling* (ready tasks start as slots free; a run waiting on the
user, a hold or a merge gate stays here), *held* (a usage-limit pause holds it:
it stays open and starts nothing new until the reset, a *Resume now*, a retry,
a skip or a move to another runner continues it), *ended on a failure* (every
task left is failed or blocked; a retry or a skip continues it) and *finished*
(every task completed or was skipped). `isScheduling`, `awaitsResume` and the
plan status (`running`, `completed`, else `approved`) derive from it. One
settle step (`settleRun`) decides, once nothing is at work and nothing can
start, whether the run goes on, is held, waits on the user or is over; only an
end closes the run and sends `execution_complete`. The review approval
(`isReviewApproved`) is kept apart: it says the user signed the plan off, not
where its run stands.
*Avoid:* "paused" for *held* (a task is paused on a usage limit; the run is
held), "stopped" for *ended* (Stop is the user's, and leaves the run idle).

**Run origin** (`RunOrigin`: `user` / `supervisor` / `limit-reset`) — who opened
a run, passed with the call that opens it, from the Command seam's actor down
to the scheduler's `onRunStarted`: a call of the user's or one made for them (a
planner turn they started, autorun), the supervisor's own, or a usage-limit
reset resuming what it paused. Only `user` starts a run's supervision afresh,
copying the user's settings and clearing the guards' memory; the others
continue the run before. Never inferred from what else is in flight: the user's
Execute while a supervisor's `merge_all` still merges is the user's.

**Autorun** — the **Run setting** that starts a plan when the planner submits
it, approved as if the user had pressed Execute; off by default, set with
`/autorun` (ADR-0030). The planner skips the outline gate but still asks
clarifying questions. It fires on a submission only — never on a session's load
or on the switch being turned on while a plan waits — and starts ops tasks too.
Independent of the Supervisor level and of Full/Guarded. Recorded as `run_plan`
with autorun as who asked. With autorun on and Full, the planner may also start
a task it added after the plan was approved, when it asks; both are read at the
start. A task the planner adds in the user's turn is approved as it lands when
autorun is on, in Full and in Guarded alike, read as the edit lands.
*Avoid:* "auto-execute", "auto-approve" (approval is a consequence, not the
setting), "autopilot".

**Wake-up turn** — a planner turn opened by a `WakePolicy` batch rather than by
the user: a task failed, waiting for input or approval, idle, a landing
conflict, an automatic Merge all that stopped, a usage-limit pause (one entry
per runner, however many tasks it paused), or the run finished, with passes
since the last wake-up as context. Events within `WAKE_DEBOUNCE_MS` of the
first join it; the run's end flushes at once. It has a timeout
(`WAKE_UP_TURN_TIMEOUT_MS`), a per-turn read budget from the **Run settings**
(`wakeUpReadBudget`, default 12, in place of a user turn's per-message read
cap), and the consent of the Supervisor level rather than the user's. A
crashed or hung one is retried once with the planner restarted from its saved
session id; a planner usage limit is waited out. Undelivered batches are
pending turns (`source: 'supervisor'`): a failed turn leaves them, a reload
replays them, and while the supervisor may not wake — unsupervised, or waiting
on a limit — they ride with the user's next message instead.
*Avoid:* "notification" or "event" for the turn — the event is what woke it;
*Avoid:* "supervisor turn" for a user-started turn during a run, which follows
the user's consent, not the level's — even one that delivers a run update.

**Run update** — what a wake-up gives the supervisor (`wakeUpDigest`): one
line per event that woke it, naming the task and a short detail (the verdict's
reason, the question, the request, the resume time), then the passes since the
last one. Never a log: the supervisor reads more with `task_output` and
`task_diff`. Kept in the transcript as a `wake_up` entry and drawn as its own
block; the level's rules for the turn are told after it and never saved.
*Avoid:* "digest" in user-facing text, and "summary" — a summary is what a
Compaction leaves.

**Live planner turn** — a planner turn taken at once, during a run too, while
running tasks carry on (ADR-0029). One module owns it: **PlanTurns**
(`services/PlanTurns.ts`), whose single entry `enqueue({ source, text, skills })`
takes every input after the opening — a user's message (`source: 'user'`), and
the supervisor's wake-up batches when they come (`'supervisor'`). Turns run
one at a time; inputs that arrive during one are taken together by the next,
in order. While a turn runs the scheduler starts nothing new
(`TaskOrchestrator.holdStarts`); the hold goes when the turn ends however it
ends — landed, stopped, failed, abandoned with its plan — or when it has held
for `START_HOLD_TIMEOUT_MS`, after which the turn goes on without holding the
run. Its task edits apply as it settles, to tasks not yet started; an edit
aimed at a running or completed task is refused with what would be accepted
(`lockedTaskRefusal`: stop it first, or change it after it finishes; rearm a
completed one). A batch applies whole or not at all, as `applyTaskOps` always
has, so one refused op refuses its batch. A whole plan is refused while a task
runs, and the planner is asked for task edits. Inputs wait on the plan
(`pendingTurns`), saved as they arrive and dropped in the save that lands their
turn's outcome, so a reload replays exactly what no turn answered; a turn that
fails drops the user's inputs but leaves a wake-up batch for the next turn. A
load also carries over the mid-run edits older builds queued
(`queuedMessages`).
*Avoid:* "pending plan edit" or "queued edit" for it — nothing waits for a
batch boundary; *Avoid:* "pause" for the start hold — running tasks are not
paused.

**Command seam** (`ExecutionCommands`, `Session.execute`) — the one core entry
point every execution action reaches the scheduler through: `run_plan`,
`run_task`, `stop_task`, `stop_run`, `retry_task`, `message_task`,
`answer_approval`, `merge_all`, `skip_task` (ADR-0029, #91).
It checks who asked (user, planner turn, supervisor), the Supervisor level,
plan approval and the loop guards, refuses with an actionable note, and records
each action in the timeline with who asked. No planner tool reaches into
`TaskOrchestrator` directly, and the mandate (#23) plugs in here. Plan approval
is the user's: executing the plan approves every task in it, and a task the
user starts, retries or adds by hand is approved too (`approvedTasks` on the
plan, read through `Session.isApproved`); a start from anyone else is refused
for a task outside that set, and the scheduler starts nothing outside it
either (ADR-0035), so a task the planner added since *waits for approval to
start*. A start the seam lets through is approved before it acts.
A task an Act supervisor adds is approved as its edit lands. A start a planner
turn asks for after editing that task in the same reply waits for the held
edit to land, then goes through the seam again; an edit that never lands — the
turn stopped, or the edit refused as it landed — drops the start, with a
notice, rather than running it on the unedited plan. `merge_all` is refused in a
user-started turn — the user presses Merge all — and allowed only to a
supervisor at Act; so is `skip_task`, which needs a reason from anyone but the
user. The user's Skip reaches the seam as the user.
`answer_approval` denies or escalates, never allows: allowing would widen the
mode the plan gave the task.
*Avoid:* "command surface" — that is the set of user commands by name (slash
commands and `ordewell` subcommands); *Avoid:* "action API".

**Start admission** (`StartAdmission`, `TaskOrchestrator.admitStart`) — a start
asked for and not yet claimed: one queued behind a planner turn's held edit,
one waiting on its approval card, one still opening its run. Stop counts it as
live work, so `stop_run` is never refused, or answered "stopped", while one
could still start. The user's Stop bumps the *Stop generation*, and a start
admitted under an older one never takes its claim: it is kept as refused and
said as "Not done: stopped before it could start", and a card still asking is
cleared. A restart of an idle scheduler by Execute does not bump it.
*Avoid:* "pending start" for a task — a task waiting on its dependencies is
not admitted until someone or the scheduler asks to start it.

**Waiting for approval to start** (`waitsForApproval`) — an AI task not started
yet, in a plan the user approved, outside their approval record: the planner
added it since (ADR-0035). The scheduler leaves it, and every surface says it
"waits for your approval" — VS Code's card, with an **Approve all** button, the
TUI row (`f` approves it, `/run` approves all), `ordewell status` and `ordewell
run` (`force-start <id>` approves one, `run` approves all). The user approves it
by force-starting it, by running the plan while a run is under way (which
approves every waiting task and starts each as its dependencies finish,
without restarting the run), or by executing the plan. A force start approves
and never skips an unfinished dependency: the task is queued (`queuedStarts`),
and the answer names what it waits for; it does go past a failed dependency, one
blocked behind that failure, or a merge gate, but still waits for what such a
blocked one waits on. A Stop withdraws a queued start, with or without a run. With *Autorun* on, a task the planner adds in the user's turn is
approved as its edit lands and never waits. Derived from the plan and its
record, never stored as a status.
*Avoid:* "awaiting approval" — that is a *Runner approval* a running task
waits on.

**Loop guard** — a check that stops an Act supervisor spinning, made where the
action executes (`services/LoopGuards.ts`): a retry limit per task
(`supervisorRetryLimit`, default 2) and no retry with the failed attempt's
prompt and model unchanged, at the Command seam — a start of a failed task is a
retry however it is asked for, and a skip of a task it retried counts against
the same limit; no skip of a task its own edit adds in the same reply; no run,
retry or re-arming edit of a skipped task; no re-adding a task it removed or
reverting its own edit, on the edit path; and a wake-up-rate limit (`WAKE_UP_RATE`) in the
`Supervisor`, which drops the run to Watch. What they remember
(`SupervisionMemory`, kept by **Run supervision**) lasts from the user's start
of a run to their next, and is saved on the plan (`supervision`, beside the
wake policy's undelivered events) so a daemon restart picks it up where it
was. Each refusal is a note to the model naming the guard and what would be
accepted; each tripped guard posts a supervisor message to the user, once.
*Avoid:* "rate limit" for the set — only one guard is about rate.

---

## Surfaces

**Surface** — a client that drives Ordewell: the **VS Code extension**
(webview), the per-command **CLI**, and the **TUI**. All of them consume the same
`SessionMessage` union and none holds orchestration logic, but they reach a
`Session` two ways. The CLI and the TUI talk to the **local daemon**
(`packages/web`, HTTP + WebSocket on `127.0.0.1`, with no frontend of its own);
the VS Code extension runs core's `Session` in-process and never connects to the
daemon. A session planned on one surface opens unchanged on another through the
saved-session store in `.ordewell/sessions/`, not through a shared transport
(ADR-0006).
*Avoid:* "web UI" — there is none; the web package is the daemon.

**TUI** — `ordewell tui`, the full-screen terminal surface (ADR-0006). Its core
is pure: `reduce(state, action)` returns `{ state, effects }` and `render(state)`
returns exactly one string per terminal row, so commands and layout are asserted
without a daemon or a tty. Only `terminal.ts` touches the real terminal.

**Task row view** (`taskRowView`, `core/src/taskRow/`) — what a row shows about
one task, decided once in core and drawn by both the TUI and VS Code: its
*status kind* (`TaskStatusKind`, including `quiet` — `in_progress` with a silent
runner, which VS Code words "Stalled" and the TUI marks "~"), the *row actions*
it offers (`taskRowActions`, differing by *placement*: a task or a subtask), its
ops and isolation state, and its merge gate. Task references are shared too
(`#2.1`, `#2 Deploy`). A **mark request** (`markRequestFor`) is the one reading
of Mark complete and Mark not done. Skip is not a mark: it goes to the
`skip_task` command, which ends the task as a *Skipped task* without vouching
for its work. A surface chooses words, glyphs and casing and nothing else; a row
state a surface needs and the view lacks is added to the view, not branched on
in the surface.
*Avoid:* "idle" (a silence guess, and the name of a state that is not this
one — see *Waiting for input*), "task card" (VS Code's component) and "task
line" (the TUI's) for the view itself — they are drawings of it.

**Command surface** — the set of things a user can ask for by name. It is one set
with two spellings: a TUI slash command (`SLASH_COMMANDS` in `tui/slash.ts`) and
an `ordewell` subcommand (`COMMANDS` in `commands/registry.ts`), and
`commands/__tests__/parity.test.ts` fails if a name exists in one and not the
other without a stated reason. What differs is only how a target is named — the
TUI opens a picker, the CLI takes an argument, and a CLI command given no
argument prints the options the picker would have shown. There is deliberately no
`/plan` slash command: typing the goal *is* how planning starts there, and an
alias for it only shadowed `/planner` on tab-completion. `ordewell plan --goal`
remains, because it is the only non-interactive way in.

**Catalog** (`catalog.ts`) — the one owner of the `/api/models` body's shape, for
every client of it. `normalizeCatalog` is what tags each model with the runners
that offered it, and that tagging is a rule rather than a formatting step: model
ids are scoped to the agent that listed them, so `runners` is what every
downstream scoping check reads (`runnerServes`, the allowlist guard, the
per-task model check). A second copy of the loop would be a second answer to
"can this runner spawn this id".
*Avoid:* reading `modelsByRunner` at a call site.

**Pane geometry** (`tui/geometry.ts`) — the one owner of how wide the panes are:
`planPaneWidth`, `chatPaneWidth`, `paneTextRoom`, `taskEditorRoom`,
`chatEditorRoom`. Both the reducer and the renderer ask it. They used to each
carry a copy and the copies drifted — the reducer wrapped an expanded task's
prompt at the terminal width while the renderer wrapped it inside the plan pane,
so `up` moved the caret to a position computed for a line twice as wide as the
one on screen.
*Avoid:* recomputing `cols - 4` at a call site.

**Pane layout** (`tui/layout.ts`) — the same idea one level up: the one owner of
what each pane's content *is*, and therefore how far it scrolls. `bodyRows`,
`chatLayout`/`chatScrollMax`, `planLayout`/`planScrollExtent`, `helpLayout`.
`render.ts` paints, fits and joins what comes back; the reducer imports only the
bounds, and clamps every offset where it is written. The bug that produced this
seam was a dead zone, not a lost keystroke: the offsets grew unbounded (chat) or
against a deliberate over-estimate (plan) while the renderer clamped to the real
content, so every notch back the other way was swallowed until the counter fell
under the bound. `planScroll` is an **absolute** offset that persists across
arrow presses — the cursor walks inside the viewport and it scrolls only when
the selected task's lines would leave it (`revealOffset`); `null` just means it
has not been positioned yet. A page key or wheel notch scrolls first and drags
the selection along only as far as keeping it on screen needs.
*Avoid:* estimating rows-per-task, or clamping a scroll offset only at paint time.

**Effect** (TUI) — a description of work the TUI wants done (`setModel`,
`taskAction`, `loadSessions`), returned by the reducer and executed by
`effects.ts` against `ApiClient`. Results come back as **actions**. *Avoid:*
calling these "commands" — a **slash command** is what the user types; the
effects it produces are a separate layer.

**Daemon contract** (`packages/core/src/daemonContract.ts`) — every HTTP body the
local daemon sends, as types in core: one response type per shape, plus
`ErrorBody` and its `DaemonErrorCode`. The routes build their bodies against it
(`satisfies`), `ApiClient` reads them back, and the TUI's `OrdewellApi` and the
catalog's `RawCatalog` derive from it, so a field changed on one side fails to
compile on the other. It lives in core because both packages already depend on
it; the CLI must never import the daemon's runtime. A refusal travels as a stable
`code`, mapped from core's typed errors (`SessionNotFoundError`, `NoPlanError`,
`AlreadyExecutingError`, `ConversationBusyError`, `PlannerTurnStoppedError`, …) in one table
(`routes/errors.ts`) and surfaced to callers as `DaemonError.code`. The REST plan
is the session's own plan state, not the `SerializedPlan` a socket carries.
`PATCH /api/settings` also answers `switchRecall` — which model a planner switch
landed on and why — only when the write changed the planner.
`daemonContract.test.ts` drives `ApiClient` against the real `createApp` and
`OrchestratorPool`.
*Avoid:* branching on a daemon error's message text — the message is for display,
the `code` is the contract. *Avoid:* a hand-written response type in a client or
route; add it to the contract.

**Daemon revive** (`EffectDeps.reviveDaemon`) — the TUI's answer to a server
that went away mid-session. `ensureDaemonOwned` runs once, at launch, but the
TUI outlives its daemon in every direction: the daemon crashes, another client
runs `ordewell stop --server`, a rebuild is followed by a manual restart.
Before this, the first refused connection ended the session — every later
action reported `connect ECONNREFUSED 127.0.0.1:3742` and nothing brought it
back. `runEffect` restarts the daemon and replays the effect exactly once.
*Avoid:* widening the retry past `isConnectionRefused`. Refused at the
handshake is the one errno that proves the request was never delivered, so
replay cannot be a second execution; `ECONNRESET` and `EPIPE` can arrive after
the server read the request, and retrying those starts a second run.
*Avoid:* a revive that prints. It runs with the full-screen frame on the
terminal, so `startDaemon` takes `quiet` — which also makes it throw where it
would otherwise `process.exit`, since exiting drops the user out of a
full-screen app with a half-restored terminal.

**Settings write order** — the daemon accepts a settings change *before*
`.env` records it (`persistAfterDaemon`). The reverse looks harmless and is
not: `.env` is the disk, and a failed call left it holding a choice neither the
daemon nor the screen ever saw. A planner switch writes `AI_PROVIDER` with
`ORCHESTRATOR_MODEL` and `ORDEWELL_PLANNER_EFFORT` set to whatever the daemon
resolved — the backend's remembered model, its catalog default, or nothing — so
one refused connection would have persisted a provider paired with the model of
the backend it just left, and the next daemon started from that file, silently,
with the TUI still showing the old planner.
*Avoid:* `setEnvVar` before an `await api.*` in an effect.

**Adopt** (a session) — register a session persisted in `.ordewell/sessions/`
with the running server's `OrchestratorPool`, via `POST /api/sessions/:id/load`.
Reading a session (`GET /api/sessions/:id`) yields its plan but no orchestrator;
only an *adopted* session can be executed or edited. Re-adopting a session that
is already live is a no-op — the in-memory session wins over the file, because
`Session.loadPlan` would otherwise clear its execution log (ADR-0006).
*Avoid:* "load" alone for this — the TUI's `/sessions` and `ordewell sessions
load` both *read* and *adopt*, and the distinction is what the bug was.

## Platform

**Launch plan** (`utils/launch.ts`) — the answer to "how do I start this agent
CLI on this OS", shared by structured runners, harness planners and model
discovery. `planDirectLaunch` serves every `spawn` caller and is identity on
POSIX: execvp already searches PATH. Windows resolves PATH × PATHEXT in order:
a native executable, a batch shim through `cmd.exe /d /s /c` with verbatim
arguments, then a PowerShell shim through `powershell.exe -File` (ADR-0010).
*Avoid:* calling `spawn('claude', …)` directly on Windows; CreateProcess does
not perform PATHEXT lookup. A batch command line needs the outer quote pair
that `cmd /s /c` strips. Capacity does not reorder the routes: an overflowing
batch shim still raises, whereas a line break may fall through to PowerShell.
PowerShell shims are considered even when PATHEXT omits `.ps1`.

**Runner install probe** (`RunnerInstallation`, `isInstalled`) — how a host
decides which runners are on this machine before any surface offers one: the
runner's `<command> --version` over the augmented PATH, a clean exit meaning
installed and a throw meaning not. The verdict is shallow on purpose — it says
the binary answers, never that its login works, which the agent's own first
turn reports. An *installed* verdict is kept for the process; a *missing* one
expires and is forgotten at once by `refresh()`, which a runner-list refresh
calls, so a CLI installed while the daemon or the extension host runs is offered
without a restart (ADR-0038).
*Avoid:* "health check" — that is the **Attach state** a runner reports about
itself, not this probe of ours.

**Well-known bin dirs** (`utils/shellPath.ts`, `wellKnownBinDirs`) — where a
runner might be, when PATH does not say. On Windows there is no login shell to
query, so this list is the entire safety net, and a directory missing from it is
a runner the picker greys out while the user looks at the install that just
succeeded. It covers the PowerShell one-liner installers (`~\.local\bin`,
`~\.opencode\bin`), the Node package managers (npm, pnpm, Yarn, bun — no shared
prefix), the Windows package managers (Scoop, Chocolatey, WinGet `Links`), and
Volta's Windows home. Pure in `(platform, env, home)` so a Linux box can pin it.
*Avoid:* assuming a POSIX location transfers. Volta is `~/.volta` there and
`%LOCALAPPDATA%\Volta` here; `WindowsApps` holds MSIX aliases only and is not a
substitute for WinGet's `Links`.

**Research shell** (`services/researchShell.ts`) — the interpreter the planner's
`bash` tool runs in, and the **dialect** it will be read as. POSIX resolves to
`{ file: null }`, meaning "use `shell: true`", unchanged. Windows looks for the
POSIX shell Git for Windows ships — so `AUTO_COMMANDS` (`ls`, `cat`, `wc`,
`grep`, `find`) works as written instead of needing a second Windows vocabulary —
and falls back to cmd.exe *while saying so*. `C:\Windows\System32\bash.exe` is
excluded deliberately: that is the WSL launcher, whose `/mnt/c/...` view would
make every workspace path name a different file than the one confinement checks.
*Avoid:* treating the shell choice as an adapter detail. `BaseFileSystem` owns it
because `classifyCommand` has to be told the same answer.

**Dialect** (`shellLexer.Dialect`) — what the interpreter that will run a
command treats as syntax: escape character, whether that escape survives inside
quotes, quote characters, expansion syntax, stripped executable extensions.
`escapeInQuotes` is load-bearing — cmd.exe reads `^` inside a quoted run as an
ordinary character, and honouring it as an escape let `echo "a^"b^" & del x"`
classify `auto` and run. Keyed to the **interpreter, not the OS**, so a
Windows host with Git Bash classifies as POSIX. Lexing cmd.exe input with POSIX
rules inverted specific answers rather than merely blurring them — `\` is an
escape in `sh` and a separator in cmd, so `rg pattern C:\repo\src` tokenized to
`C:reposrc` and failed containment against the workspace it named.
*Avoid:* a `platform` parameter here. The question is which language, and a
Windows box can answer POSIX.

**Kill tree** (`utils/processTree.ts`) — the one way an agent process is stopped.
On POSIX a runner is spawned as the leader of its own process group
(`spawnInOwnGroup`), and SIGTERM → SIGKILL goes to the whole group: signalling
only the direct child left the shells, MCP servers, test runs and dev servers it
started running after Stop. Having left the terminal's foreground group, a
runner no longer hears Ctrl-C, so the host passes SIGINT/SIGTERM/SIGHUP and its
own exit on to the groups it leads. Windows has no signals and the direct child
may be a cmd.exe shim rather than the agent, so `taskkill /T` walks the tree;
without it "stop" terminated the shim and left the agent running, still holding
the workspace and the subscription. One limit follows from how a runner is
started. A detached runner is a session leader (`setsid`) with no controlling
tty, so anything it does that opens `/dev/tty` — a password or confirmation
prompt — fails rather than prompting. A leader's exit does not end its group: a
crashed runner leaves shells and dev servers behind, so the group is kept until
it is empty and Stop and host teardown still reach them. After the leader exits,
the SIGKILL follow-up is sent only while the group still has members, since an
empty group's id may have been recycled.
*Avoid:* `proc.kill('SIGTERM')` at a dispose site — or a bare `proc.kill()`,
which was the last one left, in `ModelDiscovery`'s Codex app-server probe.

**Platform support** — the VS Code extension and the local daemon run on Linux,
macOS, and native Windows. The **TUI is not verified on Windows**; WSL remains
the supported answer for
that surface. Runner execution needs no tmux or per-task terminal windows
(ADR-0025). Two things about Windows are explicitly unverified rather than
claimed — Codex's read-only sandbox enforcement and `%VAR%` expansion on the
cmd.exe shim route. Argument fidelity on the PowerShell shim route was measured
on a Windows host. See ADR-0010.
