import { afterEach, describe, expect, it, vi } from 'vitest';
import { StructuredRunner } from '../StructuredRunner';
import { RunnerRegistry } from '../../plugins/RunnerRegistry';
import type { AgentEvent, AgentStartOptions, TaskModeAgentAdapter } from '../harness/AgentAdapter';
import type { ApprovalDecision } from '../../interfaces/IApproval';
import type { IRunnerSession, StructuredEvent, StructuredTurnEnd } from '../../interfaces/IRunner';

/**
 * Adversarial checks on the message-delivery rules (ADR-0023): the orderings
 * of force sends, drops and permission answers the happy path does not drive.
 */

type Turn = { onEvent: (event: AgentEvent) => void; resolve: () => void };

/** A task adapter whose each `send` stays open until the test ends it, and whose steers answer as told. */
class TurnEndAdapter implements TaskModeAgentAdapter {
  async mcpAttached(): Promise<boolean> { return true; }
  readonly agentId: string = 'codex';
  readonly sent: string[] = [];
  answers: ('accept' | 'refuse' | 'hold')[] = [];
  private releaseInterrupt: (() => void) | null = null;
  protected turn: Turn | null = null;
  private outOfTurn: ((event: AgentEvent) => void) | null = null;
  private readonly exitListeners: Array<(code: number) => void> = [];
  private readonly held = new Map<string, (accepted: boolean) => void>();
  readonly steers: Array<{ id: string; text: string }> = [];

  async start(_opts: AgentStartOptions): Promise<void> {}
  send(message: string, onEvent: (event: AgentEvent) => void): Promise<void> {
    this.sent.push(message);
    return new Promise<void>((resolve) => { this.turn = { onEvent, resolve }; });
  }
  emit(...events: AgentEvent[]): void { for (const event of events) this.turn?.onEvent(event); }
  emitOutOfTurn(...events: AgentEvent[]): void { for (const event of events) this.outOfTurn?.(event); }
  endTurn(interrupted = false): void {
    const turn = this.turn;
    this.turn = null;
    turn?.onEvent(interrupted ? { type: 'turn_end', interrupted: true } : { type: 'turn_end' });
    turn?.resolve();
  }
  async interrupt(): Promise<boolean> {
    queueMicrotask(() => this.endTurn(true));
    return true;
  }
  finishInterrupt(): void { this.releaseInterrupt?.(); }
  onOutOfTurn(listener: (event: AgentEvent) => void): void { this.outOfTurn = listener; }
  onProcessExit(listener: (code: number) => void): void { this.exitListeners.push(listener); }
  exit(code: number): void { for (const listener of this.exitListeners.splice(0)) listener(code); }
  answerPermission(_id: string, _decision: ApprovalDecision): boolean { return false; }
  nativeSessionId(): string | null { return 'native-1'; }
  dispose(): void {}

  steer(id: string, text: string): Promise<boolean> {
    this.steers.push({ id, text });
    const answer = this.answers.shift() ?? 'accept';
    if (answer === 'hold') return new Promise<boolean>((resolve) => { this.held.set(id, resolve); });
    return Promise.resolve(answer === 'accept');
  }
  answer(id: string, accepted: boolean): void { this.held.get(id)?.(accepted); this.held.delete(id); }
  deliver(id: string): void { this.emit({ type: 'message_delivered', id }); }
  drop(id: string): void { this.emit({ type: 'message_dropped', id }); }
}

const registry = new RunnerRegistry();
const runners: StructuredRunner[] = [];
afterEach(() => { for (const runner of runners.splice(0)) runner.stopAll(); });

function observe(session: IRunnerSession) {
  const events: StructuredEvent[] = [];
  const turnEnds: StructuredTurnEnd[] = [];
  session.onEvent((event) => events.push(event));
  session.onTurnEnd((reason) => turnEnds.push(reason));
  return { session, events, turnEnds };
}

async function steering(configure: (adapter: TurnEndAdapter) => void = () => {}) {
  const adapters: TurnEndAdapter[] = [];
  const runner = new StructuredRunner({
    createAdapter: () => {
      const adapter = new TurnEndAdapter();
      configure(adapter);
      adapters.push(adapter);
      return adapter;
    },
    interruptGraceMs: 20,
  });
  runners.push(runner);
  const task = observe(await runner.spawn({
    taskId: 'task-0012-steer', runner: 'codex', prompt: 'Do the task', modelId: 'gpt-5.6-luna', mode: 'fullAccess', cwd: '/repo', registry,
  }));
  const adapter = adapters[0];
  await vi.waitFor(() => expect(adapter.sent).toEqual(['Do the task']));
  return { ...task, adapter, adapters };
}

const turnsOf = (events: StructuredEvent[]): string[] =>
  events.flatMap((e) => (e.type === 'turn_start' ? [e.text] : []));

describe('a force send racing a message the runner holds', () => {
  it('delivers the forced message first when the runner lets go of the one it held during the interrupt', async () => {
    const task = await steering((a) => a.answers.push('accept'));
    const held = task.session.sendMessage('use Postgres');
    await vi.waitFor(() => expect(task.adapter.steers).toHaveLength(1));
    // The runner took it (handed over) but has not read it yet.
    await vi.waitFor(() => expect(task.events.some((e) => e.type === 'message_handed_over')).toBe(true));

    task.session.forceSend('stop, use SQLite');
    // The interrupt ends the turn; the runner lets go of the unread message.
    task.adapter.endTurn(true);
    await vi.waitFor(() => expect(task.turnEnds).toEqual(['interrupted']));
    task.adapter.emitOutOfTurn({ type: 'message_dropped', id: held });
    // The forced message opens the next turn; ending it hands the queue to
    // the dropped one.
    await vi.waitFor(() => expect(turnsOf(task.events)).toEqual(['Do the task', 'stop, use SQLite']));
    // The dropped message is then offered into the forced turn, which the
    // runner takes and reads mid-turn.
    task.adapter.deliver(held);
    await vi.waitFor(() => expect(task.events.some((e) => e.type === 'message_delivered' && e.messageId === held)).toBe(true));
    task.adapter.endTurn();
    await vi.waitFor(() => expect(task.turnEnds).toEqual(['interrupted', 'completed']));
  });

  it('keeps nothing delivered while the runner still holds its message, and opens the forced turn only after its own', async () => {
    const task = await steering((a) => a.answers.push('accept'));
    const held = task.session.sendMessage('use Postgres');
    await vi.waitFor(() => expect(task.events.some((e) => e.type === 'message_handed_over')).toBe(true));

    task.session.forceSend('stop, use SQLite');
    // The interrupt ends the turn; the runner keeps the message and reads it
    // in a turn of its own. The forced message waits for that turn to end.
    task.adapter.endTurn(true);
    await vi.waitFor(() => expect(task.turnEnds).toEqual(['interrupted']));
    expect(turnsOf(task.events)).toEqual(['Do the task']);

    task.adapter.emitOutOfTurn({ type: 'message_delivered', id: held });
    await vi.waitFor(() => expect(turnsOf(task.events)).toEqual(['Do the task', 'use Postgres']));
    // The runner's own turn ends out of turn, and the forced message follows.
    task.adapter.emitOutOfTurn({ type: 'turn_end' });
    await vi.waitFor(() => expect(turnsOf(task.events)).toEqual(['Do the task', 'use Postgres', 'stop, use SQLite']));
  });
});

describe('a permission answer that fails to reach the runner', () => {
  it('keeps the request open when the adapter rejects the answer, and takes another', async () => {
    let answers = 0;
    const task = await steering((a) => {
      Object.assign(a, {
        answerPermission: (_id: string, _decision: ApprovalDecision): Promise<boolean> => {
          answers += 1;
          return answers === 1 ? Promise.reject(new Error('write EPIPE')) : Promise.resolve(true);
        },
      });
    });
    task.adapter.emit({ type: 'permission_request', id: 'per_1', name: 'shell', detail: '{}' });
    await vi.waitFor(() => expect(task.events.some((e) => e.type === 'permission_request')).toBe(true));
    const id = task.events.find((e) => e.type === 'permission_request')!.id;

    const accepted = task.session.answerPermission(id, { decision: 'allow' });
    expect(accepted instanceof Promise).toBe(true);
    // The failed answer re-announces the request under the same id, so its
    // card can take another answer.
    await vi.waitFor(() => expect(task.events.filter((e) => e.type === 'permission_request')).toHaveLength(2));
    const second = task.session.answerPermission(id, { decision: 'allow' });
    await vi.waitFor(() => expect(task.events.some((e) => e.type === 'permission_decided')).toBe(true));
    expect(await accepted).toBe(false);
    expect(await second).toBe(true);
  });
});
