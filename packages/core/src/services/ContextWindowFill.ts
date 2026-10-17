import type { UsageRecord } from '../models/Usage';
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
 * The window each record of one usage stream (a planner's, or one task
 * attempt's) is measured against. A window the reporter states wins. A record
 * that states none keeps the window already known for its model, so a window
 * reported once is not replaced by the catalog's on a later call, after the
 * stream ran on another model too; a model with none known reads its window
 * from the catalog. Neither known: the record stays without one, and the
 * context stays unknown.
 *
 * Looked up per record, not once per stream, because the model can change
 * mid-stream — a planner switched within its provider keeps its conversation.
 */
export class ContextWindowFill {
  /** The window known for each model of the stream, by reporter and model. */
  private readonly known = new Map<string, number>();

  constructor(private readonly catalog: CatalogWindow, last: StreamModel = {}) {
    if (last.contextWindow !== undefined) this.known.set(modelKey(last.source, last.model), last.contextWindow);
  }

  fill(record: UsageRecord): UsageRecord {
    // A subagent runs its own model, and a breakdown names no current one:
    // neither says anything about the stream's own context.
    if (record.subagentId || record.aggregate) return record;
    const key = modelKey(record.source, record.model);
    const reported = record.contextWindow !== undefined && record.contextWindow > 0 ? record.contextWindow : undefined;
    const window = reported
      ?? this.known.get(key)
      ?? (record.model ? positive(this.catalog(record.source, record.model)) : undefined);
    if (window !== undefined) this.known.set(key, window);
    return window === undefined || window === record.contextWindow ? record : { ...record, contextWindow: window };
  }
}

function modelKey(source: string | undefined, model: string | undefined): string {
  return JSON.stringify([source ?? null, model ?? null]);
}

/**
 * A runner whose attempts' usage records carry their model's window, each
 * attempt its own stream; a continue carries on from the window its session
 * was last measured against. It sits innermost, so the attempt's usage and the
 * task log a surface folds into the task's meter read the same window.
 */
export function withContextWindows(runner: IRunner, catalog: CatalogWindow): IRunner {
  return {
    spawn: async (opts) => windowedSession(await runner.spawn(opts), new ContextWindowFill(catalog, opts.resumeWindow)),
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
