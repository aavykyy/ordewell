import { afterEach, describe, expect, it, vi } from 'vitest';
import { StructuredRunner } from '../StructuredRunner';
import { RunnerRegistry } from '../../plugins/RunnerRegistry';
import type { AgentEvent, AgentStartOptions, TaskModeAgentAdapter } from '../harness/AgentAdapter';
import type { IRunnerSession } from '../../interfaces/IRunner';

/**
 * Adversarial checks on the plain-text channel (ADR-0018, O1a): what the
 * live read and the fallback summary see when runs complete out of order, as
 * a runner's late read-back or a lost frame makes them.
 */

class OpenAdapter implements TaskModeAgentAdapter {
  async mcpAttached(): Promise<boolean> { return true; }
  readonly agentId: string = 'codex';
  readonly sent: string[] = [];
  private turn: { onEvent: (event: AgentEvent) => void; resolve: () => void } | null = null;
  private outOfTurn: ((event: AgentEvent) => void) | null = null;

  async start(_opts: AgentStartOptions): Promise<void> {}
  send(message: string, onEvent: (event: AgentEvent) => void): Promise<void> {
    this.sent.push(message);
    return new Promise<void>((resolve) => { this.turn = { onEvent, resolve }; });
  }
  emit(...events: AgentEvent[]): void { for (const event of events) this.turn?.onEvent(event); }
  async interrupt(): Promise<boolean> { return false; }
  onOutOfTurn(listener: (event: AgentEvent) => void): void { this.outOfTurn = listener; }
  onProcessExit(_listener: (code: number) => void): void {}
  answerPermission(_id: string, _decision: never): boolean { return false; }
  nativeSessionId(): string | null { return 'native-1'; }
  dispose(): void {}
}

const registry = new RunnerRegistry();
const runners: StructuredRunner[] = [];
afterEach(() => { for (const runner of runners.splice(0)) runner.stopAll(); });

async function session(): Promise<{ session: IRunnerSession; adapter: OpenAdapter; output: () => string }> {
  const adapters: OpenAdapter[] = [];
  const runner = new StructuredRunner({
    createAdapter: () => {
      const adapter = new OpenAdapter();
      adapters.push(adapter);
      return adapter;
    },
  });
  runners.push(runner);
  const session = await runner.spawn({
    taskId: 'task-0042-plain', runner: 'codex', prompt: 'Do the task', modelId: 'gpt-5.6-luna', mode: 'fullAccess', cwd: '/repo', registry,
  });
  const adapter = adapters[0];
  await vi.waitFor(() => expect(adapter.sent).toEqual(['Do the task']));
  return { session, adapter, output: () => session.getOutput() };
}

describe('the plain-text channel when runs settle out of order', () => {
  // ADVERSARIAL FINDING (plain-text channel): PlainTextChannel.block writes a run's authoritative tail after later text without a line break, so a run whose complete copy lands after a later run's (a runner's read-back completes runs in file order; a lost frame makes a copy longer than its deltas) glues onto it: output was 'One\ntw\n\nTwo lines.o'. Expected: the residual tail starts on a line of its own ('Two lines.\no') — the same line break the disagree path writes when not at line start.
  it.skip('starts the tail of an earlier run’s late copy on its own line, after a later run spoke', async () => {
    const { adapter, output } = await session();

    adapter.emit(
      { type: 'assistant_text_delta', runId: 'r1', text: 'One\n' },
      { type: 'assistant_text_delta', runId: 'r1', text: 'tw' },
      // The second run starts, which flushes the first run's held tail.
      { type: 'assistant_text_delta', runId: 'r2', text: 'Two lines.' },
      { type: 'assistant_text', runId: 'r2', text: 'Two lines.' },
      // The first run's authoritative copy lands last, longer than its deltas.
      { type: 'assistant_text', runId: 'r1', text: 'One\ntwo' },
    );

    const out = output();
    expect(out).toContain('One\ntw');
    expect(out).toContain('Two lines.');
    // The channel writes whole lines: the late tail must not glue onto the
    // run that spoke last ("Two lines.o").
    expect(out).not.toContain('Two lines.o');
  });

  it('writes a copy that disagrees with its deltas whole, on a line of its own', async () => {
    const { adapter, output } = await session();

    adapter.emit(
      { type: 'assistant_text_delta', runId: 'r1', text: 'Checking\n' },
      { type: 'tool_call', id: 'c1', name: 'shell', args: { command: 'ls' } },
      // A frame was lost: the copy says more than what streamed.
      { type: 'assistant_text', runId: 'r1', text: 'Checking the tree.' },
    );

    expect(output()).toContain('Checking the tree.');
  });
});
