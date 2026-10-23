---
status: accepted
---

# 0005 — Parallel read-only research subagents for the planner

## Problem

The planner's research loop is strictly sequential: one tool round at a time in `BaseAiService`, every round and its raw output in the planner's own context. Whichever model plans also does all the reading of the repository, one round after another.

## Decision

We decided to add a `spawn_research_agent` tool the planner *may* call during research: each call launches one stateless read-only research agent (opencode's `agent` tool is the design reference — `reference_projects/opencode/internal/llm/agent/agent-tool.go`, design only, no code reuse). The agent runs its own bounded tool loop on the cheap subagent model, and only its final digest returns to the planner. No settings toggle gates the tool: it is declared, and taught, wherever the service can run a subagent, and not where it cannot — a Gemini planner neither declares nor is taught it, and a call it makes anyway gets the steering text below.

## Key properties

- **One agent per call, threads followed as they emerge (opencode shape).** The original sketch batched N briefs into one call. Rejected in favor of opencode's single-`prompt` shape: the planner can spawn an agent at any research round — including a second wave prompted by the first wave's digests — instead of committing to one up-front fan-out. Parallelism comes from the planner batching several spawn calls in one reply.
- **Concurrency lives in the service layer, bounded at 3.** `BaseAiService.executeToolCalls` runs all spawn calls of a round concurrently in chunks of `SUBAGENT_LIMITS.maxConcurrent` (3); extra calls wait for a slot rather than being refused. Non-spawn tools keep their sequential order.
- **Declared only where it can run.** The tool spec lives outside `RESEARCH_TOOLS`. A service that can run a subagent — `createSubagentChat()` overridden, as the OpenAI-compatible service does — declares it (`toOpenAiTools()` includes it; `toGeminiToolDeclarations()` includes it unless the caller withholds it) and teaches it in `buildResearchToolsPrompt()`. A Gemini planner's `createSubagentChat()` returns null, so it neither declares the tool nor is taught it; a call it makes anyway gets the steering text below.
- **No new write surface, no recursion, no fetch.** Subagents get `subagentToolSpecs()` = the research toolset minus `fetch` (it can pause on user URL confirmation — a background agent must never block on a human) and minus the spawn tool itself. Inside the subagent loop, any tool call outside that allowlist is answered with a synthetic refusal — never dispatched — so the API history stays valid and nothing executes. `IFileSystem` itself has no write methods; `BaseFileSystem.bash` enforces the read-only command allowlist for both parent and subagents.
- **A subagent can never fail a plan.** `runResearchAgent` never throws: spawn errors, provider crashes, step-cap exhaustion, and aborts all degrade to a failed/partial tool result telling the planner to continue sequentially. Unsupported provider (Gemini, for now) and empty prompt both return steering text through the same path.
- **Cheap model always.** The subagent chat uses `config.researchSubagentModel` = `ORDEWELL_SUBAGENT_MODEL || orchestratorModel`. The planner model is the cheap class by design; the env override exists for the strong-planner scenario (strong orchestrator + Flash subagents).
- **Bounded everything.** `SUBAGENT_LIMITS`: 3 concurrent, 10 tool rounds per agent (with one synthetic wrap-up nudge, mirroring the parent loop), 20 k chars per tool result, 6 k chars per digest.
- **Module seam kept acyclic.** `ResearchSubagents.ts` imports `executeTool` and type-only `ResearchChat`; it never imports the services. The chat factory is injected (`BaseAiService.createSubagentChat()`, overridden by `OpenAiService`, null = unsupported), so spawn execution lives at the service layer, not in `executeTool`'s dispatcher.

## Considered options

- **N-briefs-per-call batching (original sketch).** One call carries up to 3 briefs, fanned out internally — robust for budget models that rarely emit parallel tool calls. Rejected by user direction: it forces the planner to pre-plan the fan-out and cannot follow threads that emerge mid-research. The prompt instead explicitly teaches "put several spawn calls in one reply to run them concurrently".
- **Refusing spawn calls beyond the cap.** Rejected: chunked waiting is strictly friendlier and keeps the ≤3 bound without teaching the model that spawning can hard-fail.
- **Dispatch in `executeTool.ts`.** Rejected: `BaseAiService` imports `executeTool`; spawning needs a `ResearchChat`, which only services can build — dispatching there would cycle `BaseAiService → executeTool → BaseAiService`.
- **Gemini support now.** Deferred: `createSubagentChat()` returns null in the base class, so Gemini degrades gracefully (tool never declared; hallucinated calls get steering text). The seam is one override away when wanted.
- **Subagents inherit the planner conversation.** Rejected (opencode agrees): stateless agents with self-contained prompts keep the context window flat — the whole point is digests instead of raw exploration in the planner's history.

## History

- 2026-10-23 — the tool is declared and taught only where the service can run a subagent: a Gemini planner neither declares nor is taught it, and a call it makes anyway gets the steering text (ADR-0037 R5).
