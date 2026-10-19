import type { ReportedWindow, UsageRecord } from '../models/Usage';
import type { IRunner, IRunnerSession, StructuredEvent } from '../interfaces/IRunner';

/**
 * A model's context window from a catalog Ordewell already holds — a runner's
 * own model listing or a provider's own models endpoint, never a table kept in
 * Ordewell. `source` is the record's reporter: a runner id or a vendor id.
 */
export type CatalogWindow = (source: string, model: string) => number | undefined;

/** The model a stream's own calls last ran on, and the window known for it. */
export interface StreamModel {
  source?: string;
  model?: string;
  contextWindow?: number;
}

/**
 * The windows runners and providers reported over one Ordewell session, by
 * reporter and exact model id, shared by every stream of it: the planner's,
 * each task attempt's and each continue's. Claude Code states a window only on
 * a turn's last line, and a task is often one long turn, so without the
 * planner's or an earlier attempt's report on the same model the task would
 * have none for its whole run. Saved with the plan, so a reload knows them too.
 *
 * Holds only what a reporter stated — never a catalog's window, which the
 * catalog serves again, and never a table kept in Ordewell (ADR-0017 U1).
 */
export class SessionWindows {
  private readonly reported = new Map<string, ReportedWindow>();

  constructor(readonly catalog: CatalogWindow = () => undefined) {}

  report(source: string, model: string, contextWindow: number): void {
    // 0 is a reporter saying it does not know, not a window.
    if (contextWindow > 0) this.reported.set(modelKey(source, model), { source, model, contextWindow });
  }

  get(source: string, model: string): number | undefined {
    return this.reported.get(modelKey(source, model))?.contextWindow;
  }

  snapshot(): ReportedWindow[] {
    return [...this.reported.values()];
  }

  restore(saved: readonly ReportedWindow[] | undefined): void {
    this.reported.clear();
    for (const { source, model, contextWindow } of saved ?? []) this.report(source, model, contextWindow);
  }

  clear(): void {
    this.reported.clear();
  }
}

/**
 * The window each record of one usage stream (a planner's, or one task
 * attempt's) is measured against. A window the reporter states wins, and the
 * session keeps it for that model. A record that states none takes the window
 * already known for its model — one the session was told by any stream, else
 * one this stream already used — so a window reported once is not replaced by
 * the catalog's; a model with none known reads its window from the catalog.
 * Neither known: the record stays without one, and the context stays unknown.
 *
 * Looked up per record, not once per stream, because the model can change
 * mid-stream — a planner switched within its provider keeps its conversation.
 */
export class ContextWindowFill {
  /** The window this stream used for each of its models, by reporter and model. */
  private readonly known = new Map<string, number>();

  constructor(private readonly windows: SessionWindows, last: StreamModel = {}) {
    if (last.contextWindow !== undefined) this.known.set(modelKey(last.source, last.model), last.contextWindow);
  }

  fill(record: UsageRecord): UsageRecord {
    // A subagent runs its own model, and a breakdown names no current one:
    // neither says anything about the stream's own context. A compaction
    // measures no call, so it has no window to fill.
    if (record.subagentId || record.aggregate || record.compacted) return record;
    const key = modelKey(record.source, record.model);
    const reported = record.contextWindow !== undefined && record.contextWindow > 0 ? record.contextWindow : undefined;
    if (reported !== undefined && record.model) this.windows.report(record.source, record.model, reported);
    const window = reported
      ?? (record.model ? this.windows.get(record.source, record.model) : undefined)
      ?? this.known.get(key)
      ?? (record.model ? positive(this.windows.catalog(record.source, record.model)) : undefined);
    if (window !== undefined) this.known.set(key, window);
    return window === undefined || window === record.contextWindow ? record : { ...record, contextWindow: window };
  }
}

function modelKey(source: string | undefined, model: string | undefined): string {
  return JSON.stringify([source ?? null, model ?? null]);
}

/**
 * A runner whose attempts' usage records carry their model's window, each
 * attempt its own stream over the session's windows; a continue carries on
 * from the window its session was last measured against. It sits innermost, so the attempt's usage and the
 * task log a surface folds into the task's meter read the same window.
 */
export function withContextWindows(runner: IRunner, windows: SessionWindows): IRunner {
  return {
    spawn: async (opts) => windowedSession(await runner.spawn(opts), new ContextWindowFill(windows, opts.resumeWindow)),
    stop: (sessionId) => runner.stop(sessionId),
    stopAll: () => runner.stopAll(),
    get activeCount() { return runner.activeCount; },
  };
}

/** `session`, with each usage event filled once, before any of its listeners sees it. */
function windowedSession(session: IRunnerSession, windows: ContextWindowFill): IRunnerSession {
  const listeners: Array<(event: StructuredEvent) => void> = [];
  session.onEvent((event) => {
    const filled = event.type === 'usage' ? { ...event, record: windows.fill(event.record) } : event;
    for (const listener of listeners) listener(filled);
  });
  const onEvent: IRunnerSession['onEvent'] = (listener) => { listeners.push(listener); };
  return new Proxy(session, {
    get: (target, prop) => {
      if (prop === 'onEvent') return onEvent;
      const value: unknown = Reflect.get(target, prop, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

function positive(n: number | undefined): number | undefined {
  return n !== undefined && n > 0 ? n : undefined;
}
