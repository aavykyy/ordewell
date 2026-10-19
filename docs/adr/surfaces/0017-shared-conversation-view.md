---
status: accepted
---

# 0017 — The shared conversation view, drawn once in core

## Problem

The planner conversation existed for a long time (ADR-0002), but what a surface
showed of it was each surface's own business. The TUI and the VS Code webview
each accumulated their own presentation state out of the `SessionMessage`
stream — and that accumulation diverged: one surface rendered a research step
the other dropped, a retransmit on reconnect showed blocks one surface had
already settled, and every new message type had to be taught to both
renderers. Replies were opaque to boot: before #48, a harness planner's
prose arrived only when the turn settled, and before #49 nothing on screen said
what a session had consumed, even where the runner reported it honestly.

## Decision

**Build the view once in core and draw it per surface.** Core owns
`reduceConversation` (ADR terms: the [conversation view](../../../CONTEXT.md)) which
folds every `SessionMessage` — plus a surface's own local entries — into an
ordered list of **display blocks** (`core/src/conversation/blocks.ts`):
messages, thinking, tool rows, subagent blocks with their children, approvals,
plan markers, and the one usage line. A surface adapts the block list to its
own presentation; it never re-derives the conversation from raw messages.

- **Turns, segments, retractions (E1).** A planner turn
  (`planner_turn_started` … `planner_turn_ended` under one `turnId`) is the
  unit of streaming. Reply text arrives as `segmentId`-keyed segments whose
  accumulated text a settled `planner_message` settles in place; a turn can
  retract streamed text (`planner_text_retracted`) without ending. The stream
  stays provisional and the settled messages authoritative.
- **One message per meaning (M1).** Thinking is `planner_thinking_delta` from
  every backend — `segmentId` where the backend streams it in segments (the API
  loops), none where it does not (harness planners) — and the view folds a run
  of it into one block either way. `plan_token` means only the "building plan"
  display (J1); prose streamed outside a turn is not sent at all, since no
  surface draws it. A second name for the same thing made every consumer
  handle both, and the one that forgot (`plan --verbose`) dropped a backend's
  thinking silently.
- **`planner_message` stays authoritative (A1).** When a turn settles, the
  message carries the reply's runs: every run of reply text the turn's
  surviving calls streamed, in order, each with its segment and the time it
  began — for an API planner the text before its tool calls and the final
  segment, for a harness planner every run, text from turns continued while it
  waited for background agents included. Each run's text settles its own
  segment in place, wherever in the turn it streamed; only a run that never
  streamed (a note the conversation wrote in the planner's place) goes last,
  and a segment the reply no longer contains goes. `content` stays the whole
  reply as the planner is told it, so whatever prints, replays or compacts the
  reply is unchanged. Settling never takes a run back. A corrective retry takes
  back only what it answers in place of — the discarded attempt's reply and the
  plan display it streamed — never the narration before that attempt's tool
  calls, which stays and is saved with the turn's reply. The settled runs are
  saved where they streamed: the reply's transcript entry keeps each run's text
  and start time beside its content. Streamed text that was retracted or that
  the turn's classification overruled is never written, so a reloaded session
  cannot resurrect it. A message without runs (a note, an older daemon)
  replaces the turn's final segment.
- **JSON envelopes stream as `plan_token` (J1).** A reply that is a plan or
  task-ops envelope never decays into visible prose; it is the "building plan"
  display, and becomes a plan marker block when it settles.
- **Usage only from reports (U1).** Usage records carry only what a provider or
  runner itself reported — tokens, cached tokens, a stated context window,
  a stated cost. A source's own estimate is shown as stated, marked `≈`; a
  billed amount has no mark. A cost whose every contribution ran on a
  subscription reads `≈$7.89 API-equivalent`. The ledger keeps the reported
  cost's provenance per currency (any estimate marks the sum), and the runner's
  session billing fact with the source and the planner or attempt it belongs
  to, saved and broadcast even without a cost, so a backend switched to before
  its first cost is not shown as the old one's subscription. No price table or
  estimate made by Ordewell: prices go stale, and a subscription runner has no
  per-token price at all. Absent means "not reported", never zero. A turn's
  `result` states its own token sum: a call whose usage did not stream is taken
  from it once, as a turn total that never moves the meter. The usage line is one `usage` block, always last. Every
  count stays in the ledger, the saved session and the broadcast, but surfaces
  draw none of them: they draw the main model's context (`ctx 61k (6%)`, the
  share only when the window is known, nothing before a call was measured) and
  the cost its runner reported, worded once in core (`usageText`) so the TUI,
  `ordewell status` and VS Code cannot disagree. The meter is derived only from
  the main model's own calls, never a subagent's or a session breakdown's. It
  counts what a call left in the context the way that runner's own UI counts
  it, shows what a compaction left or nothing until the next call, and reads a
  window any stream of the Ordewell session was told for that model, saved with
  the plan. The plan's Tasks total is the cost summed per currency, followed by the runners
  that reported none (`codex reports no cost`) once an attempt of theirs has
  ended having reported usage; a price table stays forbidden.
- **The saved subset for reload (R1).** `fromTranscript` rebuilds the view a
  session reopens with from its persisted transcript, research log and pending
  turns: settled messages — a reply run by run, each at the time it began among
  the tool rows, and an entry saved without runs as one message after the
  research it settled — tool rows, subagent blocks and digests, then inputs
  still waiting for a turn to land, and the usage line. Pending user messages
  keep their skill-load notices; wake-up digests keep their run-update role.
  The live view adopts these inputs when their turn starts or its transcript
  lands, so each input is drawn once. It
  deliberately leaves out thinking and everything that streamed and never settled —
  no `transcriptAt` beyond what the transcript itself records, and no reliance
  on the in-flight view. What reload shows is what was saved, not what was seen.
- **Expansion is one toggle per surface (X1).** Collapsed is the default: a
  command row reads `Name(keyArg)`, a subagent is one line, and one detail flag
  (the TUI's ctrl+o, VS Code's header button) shows arguments, full output,
  subagent children and digests. The flag is surface state, keyed on block
  ids that stay stable for as long as the block exists — never stored in core.

### Queued prompts

A prompt typed while a planner turn is in flight is held, the same way on both
surfaces. (It used to be the TUI's alone, its reducer taking from both ends of
an array by hand, while VS Code locked the input for the whole turn and showed
"queued" only for the Session's run-time edit queue — a different thing under
the same word.)

- **One hold, in core (Q1).** `conversation/promptHold.ts` owns the queue as a
  plain immutable list with four operations: hold, drain the oldest when a
  turn ends, unsend the newest, and give everything back when a turn is
  stopped. It is pure, so the TUI keeps it in reducer state and the VS Code
  host keeps it in a field; neither re-implements the ordering.
- **The host holds it in VS Code (Q2).** `ConversationViewHost` holds the
  prompts the webview sends with `holdPrompt`, draws them through
  `heldPrompts`, and answers `unsendPrompt` with `promptUnsent` — the host,
  not the webview, decides what comes back, so a prompt already drained cannot
  also reappear in the input. The next one goes when the host's handling of the
  turn has returned, not on `planner_turn_ended`, which arrives while the turn
  is still unwinding. A new or reloaded session drops the hold with the view.
- **The same keys on both surfaces (Q3).** The input stays live during a turn.
  Esc takes back the newest queued prompt while one is waiting; otherwise the
  first Esc warns and a second within about two seconds stops the turn. Outside
  a turn Esc clears the input, as before.
- **No list for mid-run edits (Q4).** A message sent during a run is a live
  planner turn (ADR-0029), taken at once, so nothing waits for a batch
  boundary and no surface lists edits above the input. The prompt hold above
  is the only thing a surface draws as queued.

## Considered options

- **Per-surface views, one per client.** That was the status quo: two
  accumulators drifting, and every new message type rendered differently in
  each. The view is also what lets a reloaded session and a live one draw the
  same way — two implementations would have to re-prove *that* separately.
- **A price table for cost estimates.** A model id does not fix what it costs
  (routing, caching and subscriptions all change it), so any table's answer
  would be fiction presented as a number. Cost shows only where a source
  reported its own.
- **Persisting the full event log** so reload could replay it. It would save
  every streamed semi-state (deltas, retractions, thinking) at persist time
  forever, and freeze the message stream into an interface a transcript format
  change could never shed. The transcript is the record; the view over it is
  derived.
- **A component-tree TUI** (see [ADR-0006](0006-tui-pure-core-thin-driver.md)).
  Rejected there per D1; the conversational view strengthens the point — a
  block list is renderable as strings, and that is all the renderer has ever
  needed from a state.
- **Per-block focus and expansion** — one expanded flag per block, navigated
  with keys, remembered per block. It is more keys and more state than the use
  case needs: what a user wants is *all* the detail or *none*, and the user
  chose a single toggle, as in Claude Code. A per-block flag would also have to
  live in surface state keyed on block ids, growing with the conversation, for
  a distinction nobody asked for.
- **One settled message per reply, replacing its final segment** (the design
  until 2026-10-18). A harness planner's reply joins the text on both sides of
  its tool calls, so one message could not replace one segment: the turn's
  other segments were taken back first, and the joined reply landed after the
  last tool row — live, and again on reload, since the transcript stamped it
  at commit time. It read as said after the calls it announced. A corrective
  retry took back every segment the turn still showed, an API planner's
  narration between its tool calls included. Settling run by run keeps
  `content` whole for everything that keys on it.
- **Holding queued prompts in the webview.** It cannot tell whether the turn has already
  ended on the host, and the host is where a held prompt has to be sent from.
- **A mutable queue object in core.** The TUI reducer would have had to copy it
  on every action to stay pure; a list with functions over it suits both
  surfaces as is.

## History

- 2026-09-27 — accepted; queued prompts moved into core the same day.
- 2026-10-11 — the pending plan edit list removed with the queue behind it ([ADR-0029](../supervision/0029-the-supervisor.md)).
- 2026-10-11 — reload includes pending turn inputs and adopts them on replay or settlement.
- 2026-10-16 — a surface that (re)joins a session is given its live state as well as its transcript. The session socket greets with the planner's approval requests still waiting beside the run (its held edit's preview included), and numbers every broadcast per session; the TUI tells one broadcast's copies apart by that number rather than by content, and reconciles its cards and approval prompt with the greeting on every load. A reloaded VS Code webview replays the waiting requests after the transcript, and drops a card answered while it was away. Seen live: a TUI that reconnected kept the preview of a proposed task the session had already dropped, and a webview reload erased a waiting card nothing could then answer.
- 2026-10-18 — a reply settles run by run where each streamed, and its transcript entry keeps its runs beside its content (A1, R1); a corrective retry keeps the narration before a discarded attempt's tool calls. Seen live: a coding-agent planner's "I'll read README.md now" sat below the Read row it announced, joined with the rest of the turn, live and after a reload.
- 2026-10-19 — surfaces draw the main model's context and the reported cost only, no token count (U1). Seen live: a task whose context grew from 28k to 61k over 24 calls showed 1.19M in / 1.13M cached, because every call's full prompt, cache reads included, was added up.
- 2026-10-19 — stated costs distinguish a source's estimate from billing, and subscription equivalents from per-call spend; the ledgers retain runner-session billing facts (U1).
- 2026-10-19 — the meter counts a call's context as its runner does and resets on a compaction, and a window reported anywhere in the session is known to every later stream (U1). Claude Code states a window only on a turn's last line, so a task, often one long turn, showed no share for its whole run even with the planner on the same model.
- 2026-10-19 — a turn whose calls did not stream has their tokens taken once from its result (U1). A session billing fact is kept with the source that stated it, so a planner switched before its first cost is not shown as the old one's subscription.
- 2026-10-19 — the Tasks total names a runner as reporting no cost only once an attempt of it has ended having reported usage (U1). Claude Code states a cost only at a turn's end, so a first Claude Code task read as `claude-code reports no cost` for as long as its turn ran.
