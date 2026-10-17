/**
 * What one model call consumed, as its provider or runner reported it. Shared
 * by the planner's usage line (#49) and per-attempt task usage (#26): a record
 * says nothing about who asked for the call, so either can hold a list of them.
 *
 * Every measure is optional because backends report different subsets. An
 * absent field means "not reported" — never zero — so a total can tell the two
 * apart.
 */
export interface UsageRecord {
  /** The provider or runner id that reported the call — `openai`, `claude-code`, … */
  source: string;
  model?: string;
  /** A session breakdown can name a model without identifying the current context. */
  aggregate?: true;
  inputTokens?: number;
  outputTokens?: number;
  /** The share of `inputTokens` served from the provider's prompt cache. */
  cachedInputTokens?: number;
  /**
   * Filled only from a provider's or runner's own report, never from a price
   * table or an estimate: prices go stale, and a subscription runner has no
   * per-token price at all. No report means no cost, not a guessed one.
   */
  reportedCost?: { amount: number; currency: string };
  /**
   * The model's context window: as the runner or provider reported it, or,
   * when it reported none, from that runner's or provider's own model listing
   * (`ContextWindowFill`). Never from a table kept in Ordewell.
   */
  contextWindow?: number;
  /** Set when a subagent made the call; its usage still counts toward the total. */
  subagentId?: string;
}

/**
 * A running sum of {@link UsageRecord}s. A measure stays absent until some
 * record reports it. Cost is kept per currency: two runners may bill in
 * different ones, and there is no honest exchange rate to fold them together.
 */
export interface UsageTotals {
  inputTokens?: number;
  outputTokens?: number;
  cachedInputTokens?: number;
  reportedCost?: Record<string, number>;
}

/**
 * The input side of a call whose provider reports its prompt in parts — the
 * uncached tail, with cache reads and cache writes beside it rather than inside
 * it (Anthropic, and OpenCode after it). The prompt the model saw is all three;
 * only the reads were served from cache, since a write is billed as fresh
 * input. A part left unreported adds nothing, and with no part reported there
 * is no measure at all.
 */
export function partedPromptUsage(parts: { uncached?: number; cacheRead?: number; cacheWrite?: number }): Pick<UsageRecord, 'inputTokens' | 'cachedInputTokens'> {
  const reported = [parts.uncached, parts.cacheRead, parts.cacheWrite].filter((n): n is number => n !== undefined);
  return {
    ...(reported.length > 0 ? { inputTokens: reported.reduce((a, b) => a + b, 0) } : {}),
    ...(parts.cacheRead !== undefined ? { cachedInputTokens: parts.cacheRead } : {}),
  };
}

const TOKEN_FIELDS = ['inputTokens', 'outputTokens', 'cachedInputTokens'] as const;

export function addUsage(totals: UsageTotals, record: UsageRecord): UsageTotals {
  const next: UsageTotals = { ...totals };
  for (const field of TOKEN_FIELDS) {
    const reported = record[field];
    if (reported !== undefined) next[field] = (totals[field] ?? 0) + reported;
  }
  if (record.reportedCost) {
    const { amount, currency } = record.reportedCost;
    next.reportedCost = { ...totals.reportedCost, [currency]: (totals.reportedCost?.[currency] ?? 0) + amount };
  }
  return next;
}

/**
 * What the planner has consumed over a session (#49). `totals` includes every
 * `bySubagent` entry. `lastPromptTokens` and `contextWindow` track the
 * planner's own calls only — a subagent runs its own model, whose window says
 * nothing about the planner's.
 */
export interface PlannerUsage {
  totals: UsageTotals;
  bySubagent?: Record<string, UsageTotals>;
  byModel?: ModelUsage[];
  source?: string;
  model?: string;
  lastPromptTokens?: number;
  contextWindow?: number;
}

export function addPlannerUsage(usage: PlannerUsage, record: UsageRecord): PlannerUsage {
  const next: PlannerUsage = { ...usage, totals: addUsage(usage.totals, record), byModel: addModelUsage(usage.byModel ?? [], record) };
  if (record.subagentId) {
    next.bySubagent = { ...usage.bySubagent, [record.subagentId]: addUsage(usage.bySubagent?.[record.subagentId] ?? {}, record) };
    return next;
  }
  if (!record.aggregate) {
    if (record.source !== usage.source || record.model !== usage.model) {
      delete next.lastPromptTokens;
      delete next.contextWindow;
    }
    next.source = record.source;
    next.model = record.model;
  }
  if (record.inputTokens !== undefined) next.lastPromptTokens = record.inputTokens;
  // A reported window of 0 means "not known", not "no room": keep it out so the
  // fill is omitted rather than shown against a guessed zero.
  if (record.contextWindow !== undefined) next.contextWindow = record.contextWindow > 0 ? record.contextWindow : undefined;
  return next;
}

/** Whether any measure was reported: a token line of nothing but blanks says nothing. */
export function isMeasured(totals: UsageTotals): boolean {
  return totals.inputTokens !== undefined || totals.outputTokens !== undefined || totals.cachedInputTokens !== undefined
    || Object.keys(totals.reportedCost ?? {}).length > 0;
}

/** What the token line shows of a ledger — live from its broadcast, or reloaded from the saved one. */
export interface UsageLine {
  byModel?: ModelUsage[];
  model?: string;
  totals: UsageTotals;
  bySubagent?: Record<string, UsageTotals>;
  contextFill?: { usedTokens: number; windowTokens: number };
}

export function usageLine(usage: PlannerUsage): UsageLine {
  const contextFill = plannerContextFill(usage);
  return {
    totals: usage.totals,
    ...(usage.byModel ? { byModel: usage.byModel } : {}),
    ...(usage.model ? { model: usage.model } : {}),
    ...(usage.bySubagent ? { bySubagent: usage.bySubagent } : {}),
    ...(contextFill ? { contextFill } : {}),
  };
}

/**
 * The last planner prompt against its window, or undefined while either is
 * unknown. `usedTokens` is the prompt total as reported, cached tokens
 * included: a cached token still occupies the window, so subtracting the
 * cached share would understate how full the context is. A window of 0 is
 * treated as unknown — never guessed.
 */
export function plannerContextFill(usage: PlannerUsage): { usedTokens: number; windowTokens: number } | undefined {
  if (usage.lastPromptTokens === undefined || usage.contextWindow === undefined || usage.contextWindow <= 0) return undefined;
  return { usedTokens: usage.lastPromptTokens, windowTokens: usage.contextWindow };
}

export interface ModelUsage {
  source: string;
  model?: string;
  totals: UsageTotals;
}

export function addModelUsage(models: readonly ModelUsage[], record: UsageRecord): ModelUsage[] {
  const index = models.findIndex((m) => m.source === record.source && m.model === record.model);
  if (index < 0) return [...models, { source: record.source, ...(record.model ? { model: record.model } : {}), totals: addUsage({}, record) }];
  return models.map((m, i) => i === index ? { ...m, totals: addUsage(m.totals, record) } : m);
}

/**
 * What Ordewell has counted of a runner's own session that reports its cost
 * as a running total: that total and each model's share, in USD, as of its
 * last report. A resume of that session counts its first report's growth
 * over this; with no count kept for it, that report only sets the baseline.
 */
export interface RunnerSessionCost {
  sessionId: string;
  usd: number;
  modelUsd: Record<string, number>;
}

export interface AttemptUsage extends PlannerUsage {
  attempt: number;
  runner: string;
  /** The runner session this attempt ran in, as its runner reported it: what a later Continue of it resumes. */
  sessionId?: string;
  startedAt: string;
  endedAt?: string;
  wallTimeMs: number;
  /** What was counted of its runner session's running cost as it ended: a continue of that session counts on from it. */
  runnerSessionCost?: RunnerSessionCost;
}

export function startAttemptUsage(attempt: number, runner: string, startedAt: string): AttemptUsage {
  return { attempt, runner, startedAt, wallTimeMs: 0, totals: {}, byModel: [] };
}

export function addAttemptUsage(usage: AttemptUsage, record: UsageRecord, now: string): AttemptUsage {
  const folded = addPlannerUsage(usage, record);
  return { ...usage, ...folded, lastPromptTokens: folded.lastPromptTokens, contextWindow: folded.contextWindow, wallTimeMs: Math.max(0, Date.parse(now) - Date.parse(usage.startedAt)) };
}

export function endAttemptUsage(usage: AttemptUsage, now: string, runnerSessionCost?: RunnerSessionCost, sessionId?: string): AttemptUsage {
  return {
    ...usage,
    endedAt: now,
    wallTimeMs: Math.max(0, Date.parse(now) - Date.parse(usage.startedAt)),
    ...(sessionId ? { sessionId } : {}),
    ...(runnerSessionCost ? { runnerSessionCost } : {}),
  };
}

/** The count a continue of `sessionId` starts from: the one its latest attempt in that session ended with. */
export function countedSessionCost(attempts: readonly AttemptUsage[] | undefined, sessionId: string): RunnerSessionCost | undefined {
  return [...attempts ?? []].reverse().find((usage) => usage.runnerSessionCost?.sessionId === sessionId)?.runnerSessionCost;
}

/**
 * The model a continue's session last ran on and the window it was measured
 * against: the latest earlier attempt of that same runner session that
 * reported one. An attempt that measured nothing is skipped — a continuation
 * does not undo what its session was last measured against — and a window is
 * never borrowed from another session: a fresh attempt starts one.
 */
export function resumedSessionWindow(attempts: readonly AttemptUsage[] | undefined, runner: string, attempt: number, sessionId: string): Pick<PlannerUsage, 'source' | 'model' | 'contextWindow'> | undefined {
  const last = [...attempts ?? []].reverse().find((usage) => usage.attempt !== attempt && usage.runner === runner && usage.sessionId === sessionId && usage.contextWindow !== undefined);
  return last ? { source: last.source, model: last.model, contextWindow: last.contextWindow } : undefined;
}

export interface PlanUsage {
  totals: UsageTotals;
  byModel: ModelUsage[];
  wallTimeMs: number;
  attempts: number;
}

export function addUsageTotals(totals: UsageTotals, addition: UsageTotals): UsageTotals {
  let next = addUsage(totals, { source: '', inputTokens: addition.inputTokens, outputTokens: addition.outputTokens, cachedInputTokens: addition.cachedInputTokens });
  for (const [currency, amount] of Object.entries(addition.reportedCost ?? {})) next = addUsage(next, { source: '', reportedCost: { currency, amount } });
  return next;
}

interface UsageTask { attemptUsage?: readonly AttemptUsage[]; subtasks?: readonly UsageTask[] }

export function planUsage(tasks: readonly UsageTask[]): PlanUsage {
  const result: PlanUsage = { totals: {}, byModel: [], wallTimeMs: 0, attempts: 0 };
  for (const task of tasks) {
    const child = planUsage(task.subtasks ?? []);
    result.totals = addUsageTotals(result.totals, child.totals);
    result.wallTimeMs += child.wallTimeMs;
    result.attempts += child.attempts;
    const models = [...child.byModel];
    for (const usage of task.attemptUsage ?? []) {
      result.totals = addUsageTotals(result.totals, usage.totals);
      result.wallTimeMs += usage.wallTimeMs;
      result.attempts++;
      models.push(...usage.byModel ?? []);
    }
    for (const model of models) {
      const existing = result.byModel.find((m) => m.source === model.source && m.model === model.model);
      if (existing) existing.totals = addUsageTotals(existing.totals, model.totals);
      else result.byModel.push({ ...model, totals: addUsageTotals({}, model.totals) });
    }
  }
  return result;
}

/**
 * What one task spent across every attempt and every model it ran on, so a
 * stop, a model change and a continue never makes the earlier spend vanish. The
 * context meter is the exception: it reads the latest attempt, because only the
 * current model's window says how full the next prompt is.
 */
export interface TaskUsageSummary {
  totals: UsageTotals;
  attempts: number;
  contextFill?: { usedTokens: number; windowTokens: number };
}

export function taskUsageSummary(task: Pick<UsageTask, 'attemptUsage'>): TaskUsageSummary {
  const attempts = task.attemptUsage ?? [];
  const latest = attempts.at(-1);
  const contextFill = latest ? plannerContextFill(latest) : undefined;
  return {
    totals: attempts.reduce((sum, attempt) => addUsageTotals(sum, attempt.totals), {} as UsageTotals),
    attempts: attempts.length,
    ...(contextFill ? { contextFill } : {}),
  };
}
