/**
 * How much of its model's window an API planner's next call may fill. The
 * check runs before every call, against the model configured at that moment,
 * so a model switched mid-turn is budgeted on its own window from its next
 * call. A harness planner's agent and every task runner keep their own
 * context; nothing here reaches them.
 *
 * Nothing here is an exact count: no provider counts a prompt offline. What
 * a call costs is estimated from what the provider measured the last call of
 * the same model at, with a margin, and the provider's refusal of a prompt
 * too long stays the backstop. An estimate never leaves this module as usage.
 */

/** What a provider's own catalog states about a model; either may be unknown. */
export interface ModelLimits {
  /** The whole window: the prompt and the reply together, as an OpenAI-compatible catalog states it. */
  contextWindow?: number;
  /**
   * The longest prompt alone, the reply having a limit of its own, as Gemini
   * states its `inputTokenLimit`. Budgeted on in place of `contextWindow`.
   */
  inputTokenLimit?: number;
  /** The longest reply the provider serves for the model. */
  maxOutputTokens?: number;
}

/** What an API planner reads, before each call, to budget it. */
export interface PlannerContextDeps {
  /** The model's limits from catalogs already held: never awaits a fetch. Undefined or no window: unknown. */
  modelLimits?: (source: string, model: string) => ModelLimits | undefined;
  /** The config file's `plannerAutoCompaction`, read at each call; absent means on. */
  autoCompaction?: () => boolean;
}

export const CONTEXT_BUDGET = {
  /** The share of a known window a prompt may fill before older output is pruned. */
  fillShare: 0.9,
  /**
   * Pruning goes on to this share of the ceiling, not just under it, so the
   * next calls do not each prune a little — every pruning changes the prompt's
   * head and voids the provider's prompt cache.
   */
  lowWaterShare: 0.75,
  /** The reply asked for when nothing smaller is known: a whole plan must fit in it. */
  defaultMaxOutputTokens: 32_000,
  /** At most this share of a known window is set aside for the reply, so a small window keeps room for its prompt. */
  maxOutputShare: 0.25,
  /** Before any call was measured: few enough characters to a token that the estimate errs high. */
  defaultCharsPerToken: 3,
  /** A measured ratio is taken as at most this; a provider reporting nonsense must not shrink every estimate. */
  maxCharsPerToken: 6,
  /** Over a measurement of the same model: what was added since may tokenize denser than what was measured. */
  measuredMargin: 1.1,
  /** Over another model's measurement, until this one reports: a different tokenizer. */
  borrowedMargin: 1.25,
};

/** One call's budget on a model whose window is known. */
export interface CallBudget {
  /** The window budgeted on: the whole window, or the prompt's alone where the provider states that. */
  contextWindow: number;
  /** The reply the call asks for. */
  maxOutputTokens: number;
  /** Prompt tokens a call may carry: 90% of the window, and never into the reply's share. */
  ceiling: number;
  /** The most the prompt can hold at all: past it, a call is refused rather than sent. */
  promptLimit: number;
  /** Where pruning stops once it has started. */
  lowWater: number;
}

/**
 * The reply a call asks for: `wanted`, or the provider's cap when it states a
 * lower one, and on a known whole window no more than its share of it. An
 * OpenAI-compatible window holds prompt and reply together, so asking for more
 * than is left fails the call or, on some servers, cuts the prompt. A limit on
 * the prompt alone leaves the reply its own.
 */
export function replyTokens(limits: ModelLimits | undefined, wanted = CONTEXT_BUDGET.defaultMaxOutputTokens): number {
  const cap = positive(limits?.maxOutputTokens);
  const window = positive(limits?.contextWindow);
  return Math.min(
    wanted,
    cap ?? Infinity,
    window !== undefined && positive(limits?.inputTokenLimit) === undefined ? Math.floor(window * CONTEXT_BUDGET.maxOutputShare) : Infinity,
  );
}

/** Undefined when the window is unknown: then nothing is budgeted, and nothing pruned ahead of a call. */
export function callBudget(limits: ModelLimits | undefined, wanted?: number): CallBudget | undefined {
  const maxOutputTokens = replyTokens(limits, wanted);
  const inputLimit = positive(limits?.inputTokenLimit);
  const contextWindow = inputLimit ?? positive(limits?.contextWindow);
  if (contextWindow === undefined) return undefined;
  const promptLimit = inputLimit ?? contextWindow - maxOutputTokens;
  const ceiling = Math.floor(Math.min(contextWindow * CONTEXT_BUDGET.fillShare, promptLimit));
  return { contextWindow, maxOutputTokens, ceiling, promptLimit, lowWater: Math.floor(ceiling * CONTEXT_BUDGET.lowWaterShare) };
}

/** How a planner's chat budgets each call. A subagent's chat has none. */
export interface ChatBudget {
  limits(model: string): ModelLimits | undefined;
  autoCompaction(): boolean;
  gauge: TokenGauge;
  /** The model's context changed under what earlier turns were sent (ADR-0012 T10). */
  onCompacted(): void;
}

/** What automatic compaction does for the planner's model now, for a surface to state. */
export type PlannerContextStatus =
  | { auto: 'off' }
  | { auto: 'unknown_window'; model: string }
  | { auto: 'on'; model: string; contextWindow: number; maxOutputTokens: number };

/**
 * Characters to a token, per model, from what each model's provider reported
 * for a call whose characters were counted here. Kept per model so a switch
 * never reads the previous model's measurement as the new one's: until the
 * new model reports, the last measurement stands in with a wider margin.
 */
export class TokenGauge {
  private readonly measured = new Map<string, number>();
  private last: number | undefined;

  record(model: string, chars: number, promptTokens: number | undefined): void {
    if (!promptTokens || promptTokens <= 0 || chars <= 0) return;
    const ratio = Math.min(chars / promptTokens, CONTEXT_BUDGET.maxCharsPerToken);
    this.measured.set(model, ratio);
    this.last = ratio;
  }

  /** Characters taken as one token for `model`: an estimate that errs high on tokens. */
  charsPerToken(model: string): number {
    const own = this.measured.get(model);
    if (own !== undefined) return own / CONTEXT_BUDGET.measuredMargin;
    if (this.last !== undefined) return this.last / CONTEXT_BUDGET.borrowedMargin;
    return CONTEXT_BUDGET.defaultCharsPerToken;
  }

  /**
   * The same, without the margin: what refusing a call outright is judged on.
   * Undefined until some call was measured — a guess alone never refuses one.
   */
  plainCharsPerToken(model: string): number | undefined {
    return this.measured.get(model) ?? this.last;
  }
}

/**
 * How condensing by summary fared before a call was found not to fit:
 * `not_tried` — nothing could be condensed, or this chat condenses nothing;
 * `condensed` — a summary stands in, and still the call does not fit;
 * `failed` — no summary could be had, and what it would have replaced stays.
 */
export type ContextSummaryAttempt = 'not_tried' | 'condensed' | 'failed';

/**
 * The planner's next call cannot fit its model's window: pruning what may be
 * pruned and condensing what may be condensed left too much, or the provider
 * refused the call as too long after one more pass. What the call was to send
 * is held by the chat, so sending it again (`ResearchChat.resend`) runs no
 * tool a second time — the decision a recovery reads, by `summary`, before
 * pausing the planner or trying again.
 */
export class PlannerContextExhaustedError extends Error {
  readonly summary: ContextSummaryAttempt;

  constructor(readonly model: string, readonly refusedByProvider: boolean, options?: { cause?: unknown; summary?: ContextSummaryAttempt }) {
    const summary = options?.summary ?? 'not_tried';
    super(`The planner's context no longer fits ${model}'s window, even after ${summary === 'condensed' ? 'pruning older file reads and condensing the conversation' : 'pruning older file reads'}. `
      + (summary === 'condensed'
        ? 'Switch the planner to a model with a larger window, or narrow the request.'
        : 'Use /compact to condense the conversation, or switch the planner to a model with a larger window.'), options);
    this.name = 'PlannerContextExhaustedError';
    this.summary = summary;
  }
}

function positive(n: number | undefined): number | undefined {
  return n !== undefined && Number.isFinite(n) && n > 0 ? n : undefined;
}
