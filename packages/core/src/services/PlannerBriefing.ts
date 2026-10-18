import { flattenTasksWithParents, type Task } from '../models/Task';
import type { AssignmentScope } from './AssignmentScope';
import { AUTORUN_OFF, AUTORUN_ON } from './PlanPrompts';
import { flaggedTasks, runnersChangedBlock, scopeChange } from './RunnerChange';

/** What the briefing reads as it stands now. */
export interface BriefingSource {
  /** Whether autorun is on (ADR-0030). */
  autorun(): boolean;
  /** The enabled runners and allowlist. */
  scope(): AssignmentScope;
  tasks(): readonly Task[];
  /** Whether the planner reads its catalog through Ordewell's tools (ADR-0022). */
  plannerTools(): boolean;
}

/** One turn's briefing: the blocks it carries, and what makes them told. */
export interface TurnBriefing {
  readonly blocks: readonly string[];
  /** The turn landed an answer the planner gave having read them: the next turn is told only what changes after. */
  heard(): void;
}

/**
 * What the planner is told once rather than in every turn: that autorun was
 * switched (ADR-0030), that the user changed the runners or allowlist it may
 * assign, and run updates no turn has carried yet (ADR-0029) — each in the
 * next turn, whoever opens it.
 *
 * A turn's briefing is told only when the turn lands an answer the planner
 * gave: one that fails or is stopped may not have read it, so the next one
 * says it again. An opening — the first turn, or a replay from the transcript —
 * states autorun and the runners in its own prompt, so that is what the
 * planner was told by it; its briefing is built after the opening, and says
 * neither again. All of it belongs to the plan scope, and goes with it.
 */
export class PlannerBriefing {
  private toldAutorun = false;
  /** Null until a conversation opens in this scope. */
  private toldScope: AssignmentScope | null = null;
  private untold: string[] = [];

  constructor(private readonly source: BriefingSource) {}

  /** Tell the planner's next turn, whoever opens it. */
  runUpdate(text: string): void {
    this.untold.push(text);
  }

  /** A conversation opened under a prompt stating autorun as given and the runners as they are now. */
  opened(autorun: boolean): void {
    this.toldAutorun = autorun;
    this.toldScope = this.source.scope();
  }

  /** The next turn's briefing. Build it after the turn has opened, or chosen not to. */
  brief(): TurnBriefing {
    const autorun = this.source.autorun();
    const scope = this.source.scope();
    const updates = [...this.untold];
    const blocks = [
      autorun === this.toldAutorun ? null : autorun ? AUTORUN_ON : AUTORUN_OFF,
      this.runnersChanged(scope),
      updates.length > 0 ? ['Run update:', ...updates.map((update) => `- ${update}`)].join('\n') : null,
    ].filter((block): block is string => block !== null);
    return {
      blocks,
      heard: () => {
        this.toldAutorun = autorun;
        this.toldScope = scope;
        // Updates only ever join at the end, and one turn lands at a time.
        this.untold = this.untold.slice(updates.length);
      },
    };
  }

  /** The plan scope is gone: nothing told in it carries to the next. */
  clear(): void {
    this.toldAutorun = false;
    this.toldScope = null;
    this.untold = [];
  }

  /**
   * The same once-per-change rule as autorun, for API and harness planners
   * alike. Tasks the change leaves outside the scope are named, not touched.
   */
  private runnersChanged(now: AssignmentScope): string | null {
    const change = this.toldScope && scopeChange(this.toldScope, now);
    if (!change) return null;
    const flagged = flaggedTasks(flattenTasksWithParents(this.source.tasks()), now);
    return runnersChangedBlock(change, flagged, this.source.plannerTools());
  }
}
