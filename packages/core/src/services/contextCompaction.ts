import { RESEARCH_TOOLS, SPAWN_RESEARCH_AGENT } from './researchTools';

/**
 * Research-context compaction: raw workspace reads are pruned to stubs so the
 * planner's context has room for what comes next — the next call of a long
 * research phase, or a plan emission the output limit cut off. Only output
 * that can be read again goes; receipts of what a tool did, and subagent
 * digests (already the compressed form of a whole research thread), stay.
 * When pruning runs ahead of a call is `plannerContextBudget`'s to decide.
 */

export const COMPACTION_LIMITS = {
  /** Pruned outputs keep this much leading text so the model still sees what was there. */
  keepHeadChars: 400,
  /** Outputs at or below this size are never pruned — the savings would not pay for the loss. */
  minPrunableChars: 1500,
  /** Aggregate research-findings budget for the one-shot fallback plan prompt. */
  researchResultsMaxChars: 60_000,
  /**
   * The newest tool rounds kept whole: the model is acting on them, and
   * pruning what it has just read only sends it to read it again.
   */
  protectedRounds: 2,
};

/**
 * The tools whose output may be pruned: workspace reads, which change nothing
 * and can be made again. A shell command, a web read, a task read and an
 * execution tool are not among them — their output is a receipt of what
 * happened (or a read the user approved, or one with a budget), and a stub
 * there would invite doing it again. A subagent's digest is already the
 * condensed form of its research.
 */
export const RECOVERABLE_READ_TOOLS: ReadonlySet<string> = new Set(['read_file', 'read_files', 'glob', 'grep', 'find_symbol', 'list_dir']);

/** Structural subset of an OpenAI-style chat message that compaction reads and rewrites. */
export interface CompactableMessage {
  role: string;
  content?: unknown;
  tool_call_id?: string;
  tool_calls?: Array<{ id?: string; function?: { name?: string; arguments?: string } }>;
}

/** What a pruning took out. */
export interface Pruned {
  removedChars: number;
  outputs: number;
}

/** Per-message framing a provider adds around the text: small, and counted so a long list of short messages is not free. */
const MESSAGE_OVERHEAD_CHARS = 12;

/** The characters a message adds to a request, read once when it joins the history. */
export function messageChars(m: CompactableMessage): number {
  let chars = MESSAGE_OVERHEAD_CHARS + (m.tool_call_id?.length ?? 0);
  if (typeof m.content === 'string') chars += m.content.length;
  else if (m.content !== undefined && m.content !== null) chars += JSON.stringify(m.content).length;
  for (const call of m.tool_calls ?? []) {
    chars += (call.id?.length ?? 0) + (call.function?.name?.length ?? 0) + (call.function?.arguments?.length ?? 0);
  }
  return chars;
}

/**
 * Why `messages` is not a history a provider accepts, or null: each tool
 * result must answer a call of the assistant message just before its run of
 * results, once. Calls left unanswered at the end are not a problem here —
 * the next message answers them.
 */
export function historyProblem(messages: readonly CompactableMessage[]): string | null {
  let open: Set<string> | null = null;
  const answered = new Set<string>();
  for (const [i, m] of messages.entries()) {
    if (m.role === 'tool') {
      const id = m.tool_call_id;
      if (!id || !open?.has(id)) return `message ${i} answers no call of the assistant message before it`;
      if (answered.has(id)) return `message ${i} answers call ${id} a second time`;
      answered.add(id);
      continue;
    }
    if (!['system', 'user', 'assistant'].includes(m.role)) return `message ${i} has role "${m.role}"`;
    open = m.role === 'assistant' && m.tool_calls?.length ? new Set(m.tool_calls.flatMap((c) => (c.id ? [c.id] : []))) : null;
  }
  return null;
}

/**
 * An API planner's message list, with what it adds to a request kept as
 * messages join or change, so budgeting a call never serializes the whole
 * history. A pruned message is replaced, never edited: a list already handed
 * to a request keeps what it sent.
 */
export class ChatHistory<M extends CompactableMessage> {
  private messages: M[] = [];
  private sizes: number[] = [];
  private total = 0;
  private lastUser = -1;
  private changes = 0;

  constructor(
    initial: readonly M[] = [],
    /** What one message adds to a request, as its provider sends it. */
    readonly sizeOf: (m: M) => number = messageChars,
  ) {
    this.append(...initial);
  }

  /** What `messages` add to a request, sized as the history sizes its own. */
  charsOf(messages: readonly M[]): number {
    return messages.reduce((n, m) => n + this.sizeOf(m), 0);
  }

  get chars(): number { return this.total; }

  get length(): number { return this.messages.length; }

  /** Where the newest user message stands; -1 before any. */
  get lastUserIndex(): number { return this.lastUser; }

  /** Moves on every change: what was read before an await still holds only if it has not moved. */
  get version(): number { return this.changes; }

  view(): readonly M[] { return this.messages; }

  last(): M | undefined { return this.messages[this.messages.length - 1]; }

  append(...added: M[]): void {
    this.changes++;
    for (const m of added) {
      if (m.role === 'user') this.lastUser = this.messages.length;
      const size = this.sizeOf(m);
      this.messages.push(m);
      this.sizes.push(size);
      this.total += size;
    }
  }

  /** Take `next` in place of the whole list in one step; refused, changing nothing, when a provider would refuse it. */
  replace(next: readonly M[]): void {
    const problem = historyProblem(next);
    if (problem) throw new Error(`Refused a history a provider would not accept: ${problem}.`);
    this.messages = [];
    this.sizes = [];
    this.total = 0;
    this.lastUser = -1;
    this.append(...next);
  }

  /**
   * Prune recoverable reads oldest first until `charsToFree` are gone or none
   * is left. The {@link COMPACTION_LIMITS.protectedRounds} newest complete
   * rounds at or after `protectFrom` keep their output whole; so does every
   * result that is not a recoverable read, and results not yet in the history
   * are not here to prune. Messages are never removed, so each call keeps its
   * result.
   */
  prune(charsToFree: number, protectFrom = 0): Pruned {
    const pruned: Pruned = { removedChars: 0, outputs: 0 };
    if (charsToFree <= 0) return pruned;
    const nameById = new Map<string, string>();
    const rounds: number[] = [];
    for (const [i, m] of this.messages.entries()) {
      if (m.role !== 'assistant' || !m.tool_calls?.length) continue;
      for (const call of m.tool_calls) if (call.id && call.function?.name) nameById.set(call.id, call.function.name);
      // A round whose results are still on their way is not complete: the two
      // kept whole are the newest the model has read in full.
      if (i >= protectFrom && i < this.messages.length - 1) rounds.push(i);
    }
    const protectedIds = new Set(rounds.slice(-COMPACTION_LIMITS.protectedRounds)
      .flatMap((i) => (this.messages[i].tool_calls ?? []).flatMap((c) => (c.id ? [c.id] : []))));
    for (const [i, m] of this.messages.entries()) {
      if (pruned.removedChars >= charsToFree) break;
      if (m.role !== 'tool' || typeof m.content !== 'string' || !m.tool_call_id) continue;
      if (m.content.length <= COMPACTION_LIMITS.minPrunableChars || protectedIds.has(m.tool_call_id)) continue;
      const name = nameById.get(m.tool_call_id);
      if (!name || !RECOVERABLE_READ_TOOLS.has(name)) continue;
      const stub = m.content.slice(0, COMPACTION_LIMITS.keepHeadChars)
        + `\n[... ${name} output pruned (${m.content.length} chars) to free context: read it again if you need it]`;
      const next = { ...m, content: stub };
      const size = this.sizeOf(next);
      pruned.removedChars += this.sizes[i] - size;
      pruned.outputs++;
      this.changes++;
      this.total += size - this.sizes[i];
      this.sizes[i] = size;
      this.messages[i] = next;
    }
    return pruned;
  }
}

interface ResultsBlock {
  tool: string | null;
  lines: string[];
}

const PRESERVED_BLOCKS = new Set([SPAWN_RESEARCH_AGENT, 'llm_response']);

/**
 * Bound the accumulated research-findings text embedded in the one-shot
 * fallback plan prompt. Blocks are pruned oldest-first: raw tool transcripts
 * before subagent digests and the model's own closing synthesis, which only
 * shrink if the budget still cannot be met without them.
 */
export function compactResearchResults(
  resultsText: string,
  maxChars = COMPACTION_LIMITS.researchResultsMaxChars,
): string {
  if (resultsText.length <= maxChars) return resultsText;

  // Blocks are delimited by the headers executeToolCalls writes:
  // "[toolName({...args})]" or "[LLM response]", always at line start.
  const knownNames = new Set(RESEARCH_TOOLS.map((t) => t.name)).add(SPAWN_RESEARCH_AGENT);
  const headerRe = /^\[([a-z_]+)\(/;
  const blocks: ResultsBlock[] = [{ tool: null, lines: [] }];
  for (const line of resultsText.split('\n')) {
    const m = headerRe.exec(line);
    const tool = m && knownNames.has(m[1]) ? m[1] : line === '[LLM response]' ? 'llm_response' : null;
    if (tool) blocks.push({ tool, lines: [line] });
    else blocks[blocks.length - 1].lines.push(line);
  }

  // Splitting the line list into blocks and re-joining is the identity, so
  // untouched blocks survive byte-for-byte.
  const texts = blocks.map((b) => b.lines.join('\n'));
  let total = texts.reduce((n, t) => n + t.length, 0);
  const prunePasses: Array<(b: ResultsBlock) => boolean> = [
    (b) => b.tool !== null && !PRESERVED_BLOCKS.has(b.tool),
    (b) => b.tool !== null && PRESERVED_BLOCKS.has(b.tool),
  ];
  for (const shouldPrune of prunePasses) {
    for (const [i, b] of blocks.entries()) {
      if (total <= maxChars) break;
      if (!shouldPrune(b) || texts[i].length <= COMPACTION_LIMITS.minPrunableChars) continue;
      const stub = texts[i].slice(0, COMPACTION_LIMITS.keepHeadChars)
        + `\n[... pruned ${texts[i].length} chars to fit the research budget]`;
      total -= texts[i].length - stub.length;
      texts[i] = stub;
    }
  }

  // Blocks partition the split lines, so joining block texts with '\n' undoes
  // the split exactly — except the synthetic empty first block, which must not
  // inject a leading newline when the text opened with a header line.
  return (blocks[0].lines.length === 0 ? texts.slice(1) : texts).join('\n');
}
