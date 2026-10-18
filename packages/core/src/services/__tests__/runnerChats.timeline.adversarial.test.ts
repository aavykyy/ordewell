import { afterEach, describe, expect, it } from 'vitest';
import { StructuredRunner } from '../StructuredRunner';
import { RunnerRegistry } from '../../plugins/RunnerRegistry';
import type { AgentEvent, AgentStartOptions, TaskModeAgentAdapter } from '../harness/AgentAdapter';
import type { ApprovalDecision } from '../../interfaces/IApproval';
import type { IRunnerSession, StructuredEvent } from '../../interfaces/IRunner';
import { toTaskLogEvent, type TaskLogEvent } from '../../models/TaskLog';
import { replayTaskLog } from '../../conversation/taskLog';
import { fakeMcpServer } from './harnessTestKit';

/**
 * Adversarial checks on a runner turn's chat (ADR-0018, ADR-0023), second
 * round: force send, steering, subagent-opened turns, a failed permission
 * answer and the messages queued across a turn — each checked in the events
 * the task log records, live and from its saved fold.
 */

type Turn = { onEvent: (event: AgentEvent) => void; resolve: () => void };

class HandAdapter implements TaskModeAgentAdapter {
  async mcpAttached(): Promise<boolean> { return true; }
  readonly agentId = 'codex';
  readonly sent: string[] = [];
  readonly steered: Array<{ id: string; text: string }> = [];
  steerAnswer: (id: string, text: string) => Promise<boolean> = async () => true;
  permissionAnswer: (id: string, decision: ApprovalDecision) => boolean | Promise<boolean> = () => true;
  private turn: Turn | null = null;
  private outOfTurn: ((event: AgentEvent) => void) | null = null;

  async start(_opts: AgentStartOptions): Promise<void> {}
  send(message: string, onEvent: (event: AgentEvent) => void): Promise<void> {
    this.sent.push(message);
    return new Promise<void>((resolve) => { this.turn = { onEvent, resolve }; });
  }
  steer(id: string, text: string): Promise<boolean> {
    this.steered.push({ id, text });
    return this.steerAnswer(id, text);
  }
  emit(...events: AgentEvent[]): void { for (const event of events) this.turn?.onEvent(event); }
  emitOutOfTurn(event: AgentEvent): void { this.outOfTurn?.(event); }
  endTurn(interrupted = false): void {
    const turn = this.turn;
    this.turn = null;
    turn?.onEvent(interrupted ? { type: 'turn_end', interrupted: true } : { type: 'turn_end' });
    turn?.resolve();
  }
  async interrupt(): Promise<boolean> { queueMicrotask(() => this.endTurn(true)); return true; }
  onOutOfTurn(listener: (event: AgentEvent) => void): void { this.outOfTurn = listener; }
  onProcessExit(_listener: (code: number) => void): void {}
  answerPermission(id: string, decision: ApprovalDecision): boolean | Promise<boolean> { return this.permissionAnswer(id, decision); }
  nativeSessionId(): string | null { return 'native-1'; }
  dispose(): void {}
}

const registry = new RunnerRegistry();
const runners: StructuredRunner[] = [];
afterEach(() => { for (const runner of runners.splice(0)) runner.stopAll(); });

interface Harness {
  session: IRunnerSession;
  adapter: HandAdapter;
  events: StructuredEvent[];
  log: () => TaskLogEvent[];
  view: () => ReturnType<typeof replayTaskLog>;
}

async function session(): Promise<Harness> {
  const adapters: HandAdapter[] = [];
  const runner = new StructuredRunner({
    mcp: fakeMcpServer(),
    createAdapter: () => {
      const adapter = new HandAdapter();
      adapters.push(adapter);
      return adapter;
    },
  });
  runners.push(runner);
  const events: StructuredEvent[] = [];
  const spawned = await runner.spawn({
    taskId: 'task-0042-chat', runner: 'codex', prompt: 'Do the task', modelId: 'gpt-5.6-luna',
    mode: 'fullAccess', cwd: '/repo', registry,
  });
  spawned.onEvent((event) => events.push(event));
  const adapter = adapters[0];
  await viWait(() => adapter.sent.length === 1);
  const log = (): TaskLogEvent[] => events.flatMap((event) => toTaskLogEvent(event) ?? []);
  return { session: spawned, adapter, events, log, view: () => replayTaskLog(log()) };
}

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
async function viWait(condition: () => boolean): Promise<void> {
  for (let i = 0; i < 500 && !condition(); i++) await tick();
  if (!condition()) throw new Error('condition never held');
}

function shown(view: ReturnType<typeof replayTaskLog>): string[] {
  return view.blocks.flatMap((b) => {
    if (b.type === 'usage') return [];
    if (b.type === 'message') return [`${b.role}:${b.text}`];
    if (b.type === 'tool') return [`tool:${b.headline.name}`];
    return [b.type];
  });
}

describe('a force send during a turn with a call in flight', () => {
  it('queues it, interrupts, and opens the next turn with it once, live and reloaded', async () => {
    const h = await session();
    h.adapter.emit(
      { type: 'assistant_text_delta', runId: 'r1', text: 'Working on it.' },
      { type: 'tool_call', id: 'c1', name: 'shell', args: { command: 'sleep 5' } },
    );

    h.session.forceSend('use the YAML parser');
    await viWait(() => h.adapter.sent.length === 2);

    h.adapter.emit(
      { type: 'assistant_text_delta', runId: 'r2', text: 'Switching.' },
      { type: 'assistant_text', runId: 'r2', text: 'Switching.' },
    );
    h.adapter.endTurn(false);
    await viWait(() => h.events.some((e) => e.type === 'turn_end' && e.reason === 'completed'));

    expect(shown(h.view())).toEqual([
      'user:Do the task',
      'agent:Working on it.',
      'tool:shell',
      'system:Interrupted.',
      'user:use the YAML parser',
      'agent:Switching.',
    ]);
    // The forced message is one turn, not one queued line plus one message.
    expect(h.view().queued).toEqual([]);
    expect(h.events.filter((e) => e.type === 'turn_start').map((e) => e.type)).toHaveLength(2);
  });
});

describe('steering a message into a running turn', () => {
  it('shows the message where the runner read it, between the runs around it', async () => {
    const h = await session();
    h.adapter.emit({ type: 'assistant_text_delta', runId: 'r1', text: 'Checking' });
    const id = h.session.sendMessage('also the parser');
    await viWait(() => h.adapter.steered.length === 1);
    await viWait(() => h.events.some((e) => e.type === 'message_handed_over'));

    h.adapter.emit({ type: 'message_delivered', id });
    h.adapter.emit(
      { type: 'assistant_text_delta', runId: 'r1', text: ' the parser.' },
      { type: 'assistant_text', runId: 'r1', text: 'Checking the parser.' },
    );
    h.adapter.endTurn(false);
    await viWait(() => h.events.some((e) => e.type === 'turn_end' && e.reason === 'completed'));

    expect(shown(h.view())).toEqual(['user:Do the task', 'agent:Checking the parser.', 'user:also the parser']);
    expect(h.view().queued).toEqual([]);
  });

  it('a refusal leaves it queued for the turn after, marked, not shown as read', async () => {
    const h = await session();
    h.adapter.steerAnswer = async () => false;
    h.adapter.emit({ type: 'assistant_text_delta', runId: 'r1', text: 'Busy.' });
    h.session.sendMessage('later');
    await viWait(() => h.adapter.steered.length === 1);
    await viWait(() => h.events.some((e) => e.type === 'message_queued' && e.text === 'later'));

    h.adapter.endTurn(false);
    await viWait(() => h.adapter.sent.length === 2);
    expect(h.adapter.sent[1]).toBe('later');
    h.adapter.endTurn(false);
    await viWait(() => h.events.filter((e) => e.type === 'turn_end').length === 2);

    expect(shown(h.view())).toEqual(['user:Do the task', 'agent:Busy.', 'user:later']);
  });
});

describe('events between turns', () => {
  it('a subagent report does not open a turn the task cannot end', async () => {
    const h = await session();
    h.adapter.endTurn(false);
    await viWait(() => h.events.some((e) => e.type === 'turn_end' && e.reason === 'completed'));
    const before = h.events.length;

    h.adapter.emitOutOfTurn({ type: 'subagent_finished', subagentId: 'sa1', outcome: 'done', digest: 'found' });
    h.adapter.emitOutOfTurn({ type: 'usage', record: { source: 'codex', model: 'gpt-5', inputTokens: 1, outputTokens: 1 } });
    await tick();
    await tick();

    expect(h.events.slice(before).map((e) => e.type)).toEqual(['subagent_finished', 'usage']);
    expect(h.session.turnState()).toBe('idle');
    expect(h.view().working).toBe(false);
  });

  it('a turn the runner opens itself starts with no user message and ends normally', async () => {
    const h = await session();
    h.adapter.endTurn(false);
    await viWait(() => h.events.some((e) => e.type === 'turn_end' && e.reason === 'completed'));

    h.adapter.emitOutOfTurn({ type: 'assistant_text_delta', runId: 'r-bg', text: 'The agent landed.' });
    h.adapter.emitOutOfTurn({ type: 'assistant_text', runId: 'r-bg', text: 'The agent landed.' });
    h.adapter.emitOutOfTurn({ type: 'turn_end' });
    await viWait(() => h.events.filter((e) => e.type === 'turn_end').length === 2);

    expect(h.events.filter((e) => e.type === 'turn_start').map((e) => e.text)).toEqual(['Do the task', '']);
    expect(shown(h.view())).toEqual(['user:Do the task', 'agent:The agent landed.']);
    expect(h.view().working).toBe(false);
  });
});

describe('a runner permission answer that fails to deliver', () => {
  it('leaves the request open and asks again under the same id', async () => {
    const h = await session();
    h.adapter.emit({ type: 'tool_call', id: 'c1', name: 'shell', args: { command: 'rm -rf build' } });
    h.adapter.emit({
      type: 'permission_request', id: 'req-1', name: 'shell',
      detail: '{"command":"rm -rf build"}', input: { command: 'rm -rf build' },
    });
    await viWait(() => h.events.some((e) => e.type === 'permission_request'));

    let fail = true;
    h.adapter.permissionAnswer = () => {
      if (fail) { fail = false; return Promise.reject(new Error('socket lost')); }
      return true;
    };
    const request = h.events.find((e) => e.type === 'permission_request');
    const id = request && request.type === 'permission_request' ? request.id : '';
    expect(await h.session.answerPermission(id, { decision: 'allow' })).toBe(false);
    await viWait(() => h.events.filter((e) => e.type === 'permission_request').length === 2);
    // The same request is open again, under the same id, and can be answered.
    const again = h.events.filter((e) => e.type === 'permission_request').at(-1);
    expect(again && again.type === 'permission_request' ? again.id : undefined).toBe(id);
    expect(await h.session.answerPermission(id, { decision: 'allow' })).toBe(true);
    await viWait(() => h.events.some((e) => e.type === 'permission_decided'));
    expect(shown(h.view())).toEqual(['user:Do the task', 'tool:shell', 'approval']);
  });
});
