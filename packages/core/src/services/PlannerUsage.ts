import {
  addPlannerUsage,
  isMeasured,
  usageLine,
  type PlannerUsage,
  type UsageRecord,
} from '../models/Usage';
import type { SessionMessage } from './SessionMessage';
import { ContextWindowFill, SessionWindows } from './ContextWindowFill';
import type { PlannerContextStatus } from './plannerContextBudget';

/** The `planner_usage` member of the session broadcast union. */
export type PlannerUsageMessage = Extract<SessionMessage, { type: 'planner_usage' }>;

/**
 * The planner's session usage ledger (#49), owned by Session. Consumes the
 * `usage` progress events a backend emits per model call, keeps the running
 * session and per-subagent totals, and renders the `planner_usage` message.
 * Session persists {@link snapshot} with the plan and restores it on load, so a
 * reopened session shows its totals again. The accumulation itself lives in
 * `models/Usage` — the one place the sum's currency-per-currency rule is
 * defined — this module just holds the state and the broadcast shape.
 */
export class PlannerUsageLedger {
  private usage: PlannerUsage = { totals: {} };
  private windows: ContextWindowFill;

  /**
   * `sessionWindows` serves the window of a planner model whose backend
   * reports none; `contextStatus`, what an API planner's automatic compaction
   * does for its model now — undefined on a harness planner.
   */
  constructor(
    private readonly sessionWindows: SessionWindows = new SessionWindows(),
    private readonly contextStatus: () => PlannerContextStatus | undefined = () => undefined,
  ) {
    this.windows = new ContextWindowFill(sessionWindows);
  }

  /** Fold one model call's record into the totals; returns the running ledger. */
  record(record: UsageRecord): PlannerUsage {
    this.usage = addPlannerUsage(this.usage, this.windows.fill(record));
    return this.usage;
  }

  /** Adopt a persisted ledger (a reopened session) or start from zero. */
  restore(usage: PlannerUsage | undefined): void {
    this.usage = usage ?? { totals: {} };
    this.windows = new ContextWindowFill(this.sessionWindows, this.usage);
  }

  /** Start a fresh session's ledger from zero. */
  clear(): void {
    this.usage = { totals: {} };
    this.windows = new ContextWindowFill(this.sessionWindows);
  }

  /** Whether the ledger has measures or session billing facts to broadcast. */
  get hasUsage(): boolean {
    return isMeasured(this.usage.totals) || this.usage.sessionBilling !== undefined;
  }

  /** The value persisted onto the plan state. */
  snapshot(): PlannerUsage {
    return { ...this.usage };
  }

  /** The broadcast message for the totals as they stand now. */
  message(turnId?: string): PlannerUsageMessage {
    const line = usageLine(this.usage);
    const status = line.contextFill ? this.contextStatus() : undefined;
    // Said beside the meter, the one place every surface already shows the planner's context: no setting to read, nothing that pops up.
    const off = status?.auto === 'off' ? { off: 'settings' as const }
      : status?.auto === 'unknown_window' ? { off: 'unknown_window' as const, model: status.model } : undefined;
    const contextFill = line.contextFill && off ? { ...line.contextFill, autoCompaction: off } : line.contextFill;
    return { type: 'planner_usage', ...(turnId ? { turnId } : {}), ...line, ...(contextFill ? { contextFill } : {}) };
  }
}
