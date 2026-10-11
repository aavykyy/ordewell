# 0002 — Planner as a conversation loop (messages only)

**Status:** accepted, implemented

Ordewell's planner used to emit several distinct typed artifacts over the course of planning: `QueuedMessage[]` (parsed from `<<ORDEWELL_QUESTION>>` tags in model output), `PrdArtifact` (a structured JSON with `status`/`feedback` fields and a state machine of `pending`/`approved`/`rejected`), and the task plan itself. Each artifact had its own field on `LegacyPlanState`, its own Session operation (`continueResearchWithAnswers`, `approvePrd`, `rejectPrd`, `generatePlanFromPrd`), and its own host-side routing branch (a ladder in `extension.ts` that inferred which operation to call from plan state). The interview mode was observed dying after one question: `Planner.continueResearchWithAnswers` lacked the fallback guard that `generate` had, so when the model emitted `READY_FOR_PRD` instead of a tagged question, it fell straight to PRD synthesis.

We decided to collapse the planner to a single messages loop — "the LLM either thinks, executes commands, or sends messages to the user, very similarly to OpenCode." There is one channel: assistant messages in, user messages out, until the planner commits the plan as JSON.

## Key properties

- **One persisted dialogue.** `conversationHistory: { role, content, timestamp, kind? }[]` on `LegacyPlanState` is the single source of truth for both UI redisplay and model context. Tool-call results are NOT stored here — they live in the AI service's tool-use history; `researchLog` is the persisted tool trace for the UI.
- **Two operations.** `Session.startPlanning(goal, runners)` kicks off research and the first planner message; `Session.continueConversation(userMessage)` handles every reply after it. The host routes with one branch: the user replied → `continueConversation(text)`.
- **The model decides transitions, with no tokens and no quotas.** The planner reads the conversation and decides when to move from questions to an outline to the commit. There is no `<<ORDEWELL_QUESTION>>` tag, no `READY_FOR_PRD` sentinel and no status field. The base workflow tells it to ask before planning when the goal is vague or a decision materially changes the outcome (storage, library, scope, API shape), and that a clear goal needs no questions. A deeper interview is a skill the user invokes (`/grilling`, `packages/core/skills/grilling/`), substituted into the planner's message: one question at a time with a recommended answer, exploring the codebase instead of asking when it can, until shared understanding.
- **The final commit is auto-detected JSON.** When the planner decides the user has confirmed the outline, its next response IS the `{tasks:[...]}` JSON. The system runs `extractJsonObject` on every planner response; if it parses as a plan, the plan is loaded; otherwise it is rendered as a chat message.
- **A PRD is markdown in the conversation.** A planner reply that carries an `ORDEWELL_PRD` block is captured — even in the same turn as the plan JSON — into `prdMarkdown` on the plan and saved to `.scratch/<slug>/PRD.md`. There is no PRD state machine. A spec from the conversation is the `to-spec` skill's job.
- **Research interleaves with conversation.** Tool calls and questions happen within the same turn; the model explores more when it needs grounding mid-dialogue. The AI service maintains authoritative tool-use history across turns; `researchLog` is the persisted UI trace.
- **No Approve/Reject buttons.** Pure chat. The user types "approve" or "change X"; the planner decides what to do.
- **Silent degradations are made visible, not machined away.** An empty planner reply (a budget model after tool use) gets a nudge and then a visible "(The planner returned an empty response …)" message rather than a blank bubble. A hallucinated tool (`create_task`, `create_file`) is answered by restating the planner's role — read-only research, agents execute later — and the commit channel, raw JSON in the reply. The plan format's id example reads "unique-task-id (any short unique string)", because a `uuid-string` example made a model call a nonexistent uuid tool.
- **The line can be forked, rewound and condensed** — always as a transcript edit, so it works the same on a vendor API planner and a harness planner (ADR-0009):
  - **Fork** copies the conversation and the task list into a new persisted session, leaving the original untouched.
  - **Rewind is a fork from a point.** It copies the transcript up to just before a chosen user message, with `researchLog` cut at the same point, into a new session the daemon adopts like a fork. The original — file, transcript, live planner context — is untouched. The opening goal and a compaction summary are floors a rewind cannot cross. The rewound message's text comes back with the fork, so a surface can offer it for editing and resending. The fork has no live context, so its first message replays the shortened transcript on every backend.
  - **Compaction** (`/compact`) asks one hidden planner turn for a summary; the transcript becomes a `compaction` entry holding it plus the last two user messages and their replies verbatim, and the live context is reset. The summary must be wrapped in tags, because a harness planner returns a crashed agent's error as a normal reply; nothing is written until the summary is in hand, so a failure or a stop is a no-op. Anything else the summary turn emits, task ops included, is discarded.
  - **The task list rides along as-is.** A rewind keeps tasks the discarded turns created; a fork starts with the tasks the original had. Run state cannot travel to a session with no run: in-progress and checkpointed tasks become pending and planner turn inputs still waiting stay behind (`forkPlanState` is the one place that decides).
  - **Busy rules.** All three are refused while a planner turn is in flight and allowed while a run executes. A message sent while a summary is being written is refused (`ConversationBusyError`, a 409 from the daemon), before the planning abort slot is touched, so a stop still reaches the summary turn.
  - **VS Code** offers `/fork`, `/rewind [n]` and `/compact` (and Command Palette entries) through `Session` directly, since it does not use the daemon. It locks the input during `/compact`. A fork or a rewind is loaded as a saved session, which replaces its single `Session` and stops its run, so it asks first while one executes; a compaction redraws only the transcript in place.
- **Old sessions were wiped.** No migration from the artifact shape; the saved-sessions store was cleared on the first run of the loop.

## Considered options

- **Keep the `<<ORDEWELL_QUESTION>>` tag as a UI hint,** deleting only the
  `QueuedMessage` field. Rejected: the tag is load-bearing presentation state,
  not just a hint, and keeping the parser gadget was the thing being removed.
- **Keep a typed `PrdArtifact` internally** to drive `generatePlanFromPrd`,
  invisible to the user. Rejected: "messages only" means one channel, not one
  channel plus a hidden JSON shape the user had explicitly asked to see gone.
- **PRD as conversation history only, no field on the plan.** Rejected: re-feeding
  the full PRD as history on every generation turn bloats context — a single
  `prdMarkdown` field is cheaper to re-render and re-feed.
- **A lightweight UI-hint token for transitions** (`<<PRD>>`/`<<OUTLINE>>`
  sentinels the UI parses for affordances). Rejected: reintroduces parser
  machinery, and the token would ride into conversation history as raw text.
- **User-driven transitions** — the model never stops asking on its own; the
  user types `/prd` or `/outline` to force phases. Rejected: contradicts the
  point of the interview (the model decides when it's done) and adds friction.
- **A numeric minimum-questions floor** ("ask at least 3 questions"). It was the
  first fix for the one-question failure. Rejected: a quota is machinery standing
  in for judgement. Prompt guidance carried the depth instead, and now the
  `grilling` skill does. Weak models may still under-interview; that is a model
  strength observation, worth reporting when testing.
- **Commit gates that bounce a plan once** — when it arrived before three planner
  turns in interview mode, or with PRD mode on and no PRD written. They existed
  while the interview and the PRD were mode toggles, as nudges that never
  blocked. They went with the toggles they were keyed to; the skills that
  replaced the toggles carry their own instructions.
- **The interview and the PRD as planner-mode toggles** (`grill-me`, PRD on/off,
  each a hardcoded prompt block). Replaced by a general skills system: built-in
  skills (`grilling`, `to-spec`) invoked by slash command, with no settings
  surface.
- **One PRD message, no separate preview.** Rejected: it skips the seam-check
  between preview and full document, so the expensive full PRD gets rewritten
  every time the model misread the goal.
- **Lean preview that expands silently on accept.** One user gate, two model
  turns — but it loses the explicit accept step between preview and full PRD.
- **Fenced JSON inside prose** (`Here's the plan:` + a fence the system
  extracts). Rejected: buys marginal narration value at the price of another
  parser gadget.
- **A user-triggered Generate Plan button.** Rejected: same objection as
  user-driven transitions, plus a UI affordance the redesign was removing.
- **Keep the four operations, relabeled.** Rejected: keeps the multi-artifact
  surface and the host routing ladder this ADR exists to delete.
- **Three operations: start + continue + a separate `commitPlanFromJson`.**
  Rejected: invents a seam where there is none — the commit is just "the
  planner's final message happened to be JSON".
- **Deterministic slug from the goal string** (kebab-case it). Rejected:
  produces ugly, ambiguous slugs on long goals.
- **User-prompted slug via a VS Code input modal.** Rejected: breaks the
  chat-only thesis.
- **A distinct research phase before conversation.** Rejected: less
  OpenCode-like, and the interleaving of exploration with questions is the
  behavior being copied on purpose.
- **On-demand-only research** (no upfront pass). Rejected: risks
  under-grounded questions in the early turns, where they matter most.
- **Collapse `researchLog` into `conversationHistory`** (one store, tool
  results included). Rejected: file contents bloat both persisted state and
  model context; the model receives them via the API tool-use stream, not by
  re-reading history.
- **Drop `researchLog` entirely** — tool calls are ephemeral, only prose
  persists. Rejected: loses the tool-call evidence trail across a reload.
- **Have the model summarize tool results into prose** (tool history
  ephemeral). Rejected: same loss — raw detail the model may need in a later
  turn is gone.
- **Mirror tool results into `conversationHistory`** (it becomes the full API
  message history). Rejected for the same context-bloat reason as the
  collapse option.
- **Migrate old sessions** with a `migrateLegacyPlan` on load. Rejected: the
  shape change is large enough that preserving old state costs more than it
  saves. Both variants (full one-shot, and a version field with read-only legacy
  loading) were dropped for that reason.
- **Ship core + VS Code first,** CLI and web later. Rejected: two behaviors
  in one codebase is exactly the mess CONTEXT.md warns against. Rejected in
  the shim variant too, for the same reason.
- **Rewind in place** (truncate the transcript). It was the first rewind.
  Rejected: the discarded turns were gone for good, so a user who rewound to
  try another direction could not go back. A fork from a point costs a session
  file; the in-place cut cost the conversation.
- **Both an in-place rewind and a fork-from-point.** Rejected: two operations
  under one name, differing only in whether history survives, is the kind of
  distinction users learn by losing work.
- **Reconstruct the plan as it was at the rewind point.** Rejected: it needs
  versioned plan snapshots per turn and a rule for tasks that ran since — whose
  effects are in the working tree, not the transcript. Keeping the task list
  as-is makes the result obvious: the conversation moved, the plan did not, and
  the planner sees the real plan in its per-turn block.
- **Compaction as a deterministic prune, with no summary turn.** Rejected: the
  transcript holds no tool output to prune, so what makes it long is the
  dialogue itself, and only a model can say which of it still matters.
- **Compaction through a harness agent's native `/compact`.** Rejected: only
  some harnesses have it, it leaves Ordewell's persisted transcript at full
  length, and the two would drift.

## Consequences

- The host's phase-routing ladder is gone; every surface routes a reply with
  one branch.
- The UI's Approve/Reject PRD buttons and Generate Plan button are gone from
  every surface. The user types in the chat.
- `extractJsonObject` is the single parsing seam for the planning phase; it
  existed for plan parsing and also serves as the commit-detector.
- The AI services (`OpenAiService`, `GeminiService`) are stateful across
  conversation turns — they maintain the tool-use message history internally,
  not just within one call. This was the largest implementation cost.
- The interview's depth rests on the prompt and the skill, not on structure. A
  weak model can still transition too early; the user can say "keep asking".
- A future reader sees no `queuedMessages`, no `PrdArtifact`, no
  Approve/Reject buttons and no mode toggles for the interview — this ADR is the
  "why."

## History

- 2026-07-03 — implemented: the stateful loop, one routing branch per surface;
  the minimum-questions floor removed in favour of prompt guidance.
- 2026-07-04 — depth guidance in the interview prompt; the PRD and early-commit
  nudges; hallucinated-tool steering.
- 2026-08-20 — the interview and PRD toggles replaced by skills (`/grilling`).
- 2026-09-25 — fork, rewind (first in place, then as a fork from a point) and
  compaction (#9, #10).
- 2026-10-11 — a fork leaves waiting planner turn inputs behind, not a mid-run edit queue ([ADR-0029](0029-the-supervisor.md)).
