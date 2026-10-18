import { v4 as uuidv4 } from 'uuid';
import type { ResearchProgress } from '../../models/Task';
import type { TurnRun } from '../AiService';
import { opensWithJsonObject } from '../JsonExtractor';
import { sameMessage } from '../../utils/sameMessage';
import { joinRuns } from '../settleReply';

/**
 * One run of a planner turn's reply text (see `AgentEvent`). Its `text` is its
 * complete copy, or what streamed of it when none came; `startedAt`, when its
 * first text arrived.
 */
interface Run extends TurnRun {
  runId: string;
  /** Its deltas reached the surfaces, so its complete copy is not streamed again. */
  streamed: boolean;
  /** How many of the planner's own tool calls came before it began. */
  calls: number;
}

/**
 * The failure a turn ends on, in front of which the final run's own text is
 * kept. Claude Code says a usage limit twice — as an assistant message and as
 * the `result` of the failed turn — and a run that only repeats the failure
 * is dropped so the user reads it once. Text that came before it is a real
 * reply, and a JSON envelope the planner never finished is not one.
 */
function failureAfterReply(tail: readonly Run[], error: string): string {
  const repeated = sameMessage(tail.at(-1)?.text ?? '', error);
  const before = joinRuns(repeated ? tail.slice(0, -1) : tail).trim();
  return before && opensWithJsonObject(before) !== true ? `${before}\n\n${error}` : error;
}

/**
 * The reply one planner turn streams: its runs of text in the order they
 * began, joined by a paragraph break. A run's complete copy replaces what
 * streamed of it where it began, so text that began before a tool call stays
 * ahead of the call even when its copy arrives after it. Each run streams
 * under a segment of its own, so an envelope opening a run is classified on
 * its own opening, not on whatever text came before it.
 */
export class TurnReply {
  private readonly started: Run[] = [];
  private calls = 0;

  constructor(private readonly onProgress: (progress: ResearchProgress) => void, private readonly now: () => Date = () => new Date()) {}

  delta(runId: string, text: string): void {
    const run = this.run(runId);
    run.text += text;
    run.streamed = true;
    this.onProgress({ type: 'text_delta', text, segmentId: run.segmentId });
  }

  complete(runId: string, text: string): void {
    const run = this.run(runId);
    if (!run.streamed) this.onProgress({ type: 'text_delta', text, segmentId: run.segmentId });
    run.text = text;
  }

  /** One of the planner's own tool calls; a subagent's happen inside the planner's pending call. */
  toolCall(): void {
    this.calls++;
  }

  get text(): string {
    return joinRuns(this.started);
  }

  /** The reply's runs in the order they began; one a planner tool call followed is narration. */
  runs(): TurnRun[] {
    return this.started
      .filter((run) => run.text)
      .map(({ segmentId, text, startedAt, calls }) => ({ segmentId, text, startedAt, ...(calls < this.calls ? { narration: true as const } : {}) }));
  }

  /**
   * The turn failed with `error`: what it said after the planner's last tool
   * call is taken back from the surfaces and from the reply, and the failure
   * carries it instead.
   */
  fail(error: string): string {
    const tail = this.started.filter((run) => run.calls === this.calls);
    for (const run of tail) this.onProgress({ type: 'text_retracted', segmentId: run.segmentId });
    this.started.splice(this.started.length - tail.length);
    return failureAfterReply(tail, error);
  }

  private run(runId: string): Run {
    const known = this.started.find((run) => run.runId === runId);
    if (known) return known;
    const run: Run = { runId, segmentId: uuidv4(), text: '', startedAt: this.now().toISOString(), streamed: false, calls: this.calls };
    this.started.push(run);
    return run;
  }
}
