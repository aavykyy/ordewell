# 0017 — The shared conversation view, drawn once in core

**Status:** accepted

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
  accumulated text a settled `planner_message` replaces; a turn can retract
  streamed text (`planner_text_retracted`) without ending. The stream stays
  provisional and the settled messages authoritative.
- **One message per meaning (M1).** Thinking is `planner_thinking_delta` from
  every backend — `segmentId` where the backend streams it in segments (the API
  loops), none where it does not (harness planners) — and the view folds a run
  of it into one block either way. `plan_token` means only the "building plan"
  display (J1); prose streamed outside a turn is not sent at all, since no
  surface draws it. A second name for the same thing made every consumer
  handle both, and the one that forgot (`plan --verbose`) dropped a backend's
  thinking silently.
- **`planner_message` stays authoritative (A1).** When a turn settles, the
  message replaces its final segment's streamed text. Streamed text is never
  written to the transcript, so a reloaded session cannot resurrect text the
  turn's classification overruled.
- **JSON envelopes stream as `plan_token` (J1).** A reply that is a plan or
  task-ops envelope never decays into visible prose; it is the "building plan"
  display, and becomes a plan marker block when it settles.
- **Usage only from reports (U1).** Usage records carry only what a provider or
  runner itself reported — tokens, cached tokens, a stated context window,
  a stated cost. No price table, no estimate: prices go stale, and a
  subscription runner has no per-token price at all. Absent means "not
  reported", never zero. The token line is one `usage` block, always last; the
  context fill is derived only for the planner's own calls, and omitted when
  either half is unknown.
- **The saved subset for reload (R1).** `fromTranscript` rebuilds the view a
  session reopens with from its persisted transcript, research log and pending
  turns: settled messages, tool rows, subagent blocks and digests, then inputs
  still waiting for a turn to land, and the token line. Pending user messages
  keep their skill-load notices; wake-up digests keep their run-update role.
  The live view adopts these inputs when their turn starts or its transcript
  lands, so each input is drawn once. It
  deliberately leaves out thinking and everything that was only ever streamed —
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

## Rejected

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
