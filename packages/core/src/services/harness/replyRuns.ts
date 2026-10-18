import type { AgentEvent } from './AgentAdapter';

/**
 * The runs of one turn's reply text as an adapter reports them, each under
 * the id its runner gives it (see {@link AgentEvent}). A run is completed
 * once: a runner that restates a part, or a read-back of what the stream
 * already delivered, adds nothing.
 *
 * Some models open a message with text of nothing but newlines before calling
 * a tool. It says nothing, and as a paragraph of its own it would push the
 * real reply down by a blank one, so a run's deltas are held while they are
 * only whitespace, and a complete copy of only whitespace is dropped.
 */
export class ReplyRuns {
  /** Runs whose deltas so far are only whitespace, with what they held. */
  private readonly held = new Map<string, string>();
  private readonly streaming = new Set<string>();
  private readonly completed = new Set<string>();

  delta(runId: string, text: string, onEvent: (event: AgentEvent) => void): void {
    if (this.completed.has(runId)) return;
    if (this.streaming.has(runId)) {
      onEvent({ type: 'assistant_text_delta', runId, text });
      return;
    }
    const held = (this.held.get(runId) ?? '') + text;
    if (!held.trim()) {
      this.held.set(runId, held);
      return;
    }
    this.held.delete(runId);
    this.streaming.add(runId);
    onEvent({ type: 'assistant_text_delta', runId, text: held });
  }

  complete(runId: string, text: string, onEvent: (event: AgentEvent) => void): void {
    if (this.completed.has(runId)) return;
    this.completed.add(runId);
    this.held.delete(runId);
    this.streaming.delete(runId);
    if (text.trim()) onEvent({ type: 'assistant_text', runId, text });
  }
}
