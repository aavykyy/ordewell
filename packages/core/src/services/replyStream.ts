import { opensWithJsonObject } from './JsonExtractor';
import type { PlannerCompaction, ResearchProgress } from '../models/Task';

/** Where one segment of a planner reply streams: the chat, or the "building plan" display. */
export type SegmentRoute = 'text' | 'plan';

export interface RoutedDelta {
  route: SegmentRoute;
  text: string;
}

/**
 * Routes a planner reply's streamed text, segment by segment, to the chat or to
 * the plan display, so a JSON envelope (plan, taskOps, taskQuery) never reads
 * as prose. A segment is judged by how it opens, on the same terms
 * `classifyPlannerReply` parses by ({@link opensWithJsonObject}), and is
 * held back until its opening can tell. The whole segment follows its opening:
 * an envelope behind a prose preamble streams as prose, and the settled
 * `planner_message` is what replaces it.
 */
export class ReplySplitter {
  private readonly segments = new Map<string, SegmentRoute | { held: string }>();

  push(segmentId: string, text: string): RoutedDelta | null {
    const state = this.segments.get(segmentId);
    if (state === 'text' || state === 'plan') return { route: state, text };
    const held = (state?.held ?? '') + text;
    const opensWithObject = opensWithJsonObject(held);
    if (opensWithObject === undefined) {
      this.segments.set(segmentId, { held });
      return null;
    }
    const route: SegmentRoute = opensWithObject ? 'plan' : 'text';
    this.segments.set(segmentId, route);
    return { route, text: held };
  }
}

/**
 * One planner turn's progress on its way to the session: every event stamped
 * with the turn, and reply text routed per segment by a {@link ReplySplitter}.
 * The turn's owner mints one per user turn and hands a {@link sink} to every
 * backend call the turn makes, so no backend needs to know about either.
 */
export class TurnStream {
  private readonly splitter = new ReplySplitter();
  /**
   * Segments streamed and not taken back, to the chat or to the plan display,
   * each with the sink it came through. A botched envelope streams to the plan
   * display, and its retry must not build on top of it.
   */
  private readonly shown = new Map<string, object>();
  private muted = false;
  /** A compaction whose start went out and whose end has not: its end must follow, whatever becomes of the turn. */
  private compacting: Extract<PlannerCompaction, { phase: 'started' }> | undefined;

  constructor(readonly turnId: string, private readonly sendOn: (progress: ResearchProgress) => void) {}

  /**
   * Send nothing more: the turn was abandoned, and its end is announced next.
   * A call that does not end when stopped streams on whenever it settles, and
   * what it says would draw in, or cut, the turn that has the conversation now.
   * A compaction it started ends now, as stopped — its own end would come
   * muted, and the session would go on telling every surface it runs.
   */
  mute(): void {
    const running = this.compacting;
    if (running) {
      const { id, origin, trigger } = running;
      this.emit({ type: 'compaction', compaction: { phase: 'ended', id, origin, trigger, outcome: 'stopped', at: new Date().toISOString() }, turnId: this.turnId });
    }
    this.muted = true;
  }

  private emit(progress: ResearchProgress): void {
    if (this.muted) return;
    const compaction = progress.type === 'compaction' ? progress.compaction : undefined;
    if (compaction?.phase === 'started') this.compacting = compaction;
    else if (compaction && compaction.id === this.compacting?.id) this.compacting = undefined;
    this.sendOn(progress);
  }

  /**
   * Progress for one backend call. A backend that takes back its attempt
   * without naming a segment means the text of that call only — not what an
   * earlier call of the same turn streamed, such as a read it answered.
   */
  sink(): (progress: ResearchProgress) => void {
    const call = {};
    return (progress) => {
      if (progress.type === 'text_delta' && progress.segmentId && progress.text) {
        const routed = this.splitter.push(progress.segmentId, progress.text);
        if (!routed) return;
        this.shown.set(progress.segmentId, call);
        if (routed.route === 'plan') {
          this.emit({ type: 'plan_token', planToken: routed.text, segmentId: progress.segmentId, turnId: this.turnId });
          return;
        }
        this.emit({ ...progress, text: routed.text, turnId: this.turnId });
        return;
      }
      if (progress.type === 'text_retracted') {
        const { segmentId } = progress;
        this.retractWhere((id, owner) => (segmentId ? id === segmentId : owner === call));
        return;
      }
      this.emit({ ...progress, turnId: this.turnId });
    };
  }

  /**
   * Take back every segment the turn still shows but `keep`: the owner is
   * discarding the whole attempt, which spans every call since the last one
   * it discarded, all but the narration it keeps (ADR-0017 A1).
   */
  retract(keep: ReadonlySet<string> = new Set()): void {
    this.retractWhere((segmentId) => !keep.has(segmentId));
  }

  private retractWhere(matches: (segmentId: string, owner: object) => boolean): void {
    for (const [segmentId, owner] of this.shown) {
      if (!matches(segmentId, owner)) continue;
      this.shown.delete(segmentId);
      this.emit({ type: 'text_retracted', segmentId, turnId: this.turnId });
    }
  }
}
