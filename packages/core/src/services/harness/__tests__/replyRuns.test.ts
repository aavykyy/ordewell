import { describe, it, expect } from 'vitest';
import type { AgentAdapter, AgentEvent, AgentProcessDeps } from '../AgentAdapter';
import { ClaudeCodeAdapter } from '../ClaudeCodeAdapter';
import { CodexAdapter } from '../CodexAdapter';
import { OpenCodeAdapter } from '../OpenCodeAdapter';
import { ReplyRuns } from '../replyRuns';
import type { StructuredEvent } from '../../../interfaces/IRunner';
import { coalesceTaskLog, toTaskLogEvent, type TaskLogEvent } from '../../../models/TaskLog';
import { replayTaskLog } from '../../../conversation/taskLog';
import { fakeSpawn, fixture, openCodeFixture, sseResponse, type ScriptedReply } from '../../__tests__/harnessTestKit';

/**
 * Every adapter names each run of reply text it reports: the deltas and the
 * complete copy of one run share its id, and no run carries the paragraph
 * break that joins it to the one before — its consumers join runs
 * themselves. Driven from the recorded transcripts.
 */

interface Run { runId: string; deltas: string; text: string }

/** The turn's runs in the order they began, each with what streamed for it and its complete copy. */
function runsOf(events: AgentEvent[]): Run[] {
  const runs = new Map<string, Run>();
  for (const event of events) {
    if (event.type !== 'assistant_text' && event.type !== 'assistant_text_delta') continue;
    const run = runs.get(event.runId) ?? { runId: event.runId, deltas: '', text: '' };
    runs.set(event.runId, run);
    if (event.type === 'assistant_text_delta') run.deltas += event.text;
    else run.text += event.text;
  }
  return [...runs.values()];
}

function processDeps(replies: ScriptedReply[], fetch?: typeof globalThis.fetch): { deps: AgentProcessDeps; spawned: ReturnType<typeof fakeSpawn> } {
  const spawned = fakeSpawn(replies);
  return {
    spawned,
    deps: {
      spawn: spawned.spawn,
      fetch: fetch ?? (async () => { throw new Error('no HTTP in this test'); }) as unknown as typeof globalThis.fetch,
      resolvePath: async () => '/usr/bin',
      platform: 'linux',
      isDirectory: () => true,
      exists: () => true,
      workspaceEnv: async () => ({}),
    },
  };
}

async function turnOf(adapter: AgentAdapter, started: (start: Promise<void>) => Promise<void> = (start) => start): Promise<AgentEvent[]> {
  await started(adapter.start({ kind: 'planner', cwd: '/repo', systemPrompt: 'Plan read-only.' }));
  const events: AgentEvent[] = [];
  await adapter.send('the goal', (event) => events.push(event));
  adapter.dispose();
  return events;
}

function claudeTurn(name: string): Promise<AgentEvent[]> {
  return turnOf(new ClaudeCodeAdapter(processDeps([fixture('claude-code', name)]).deps));
}

function codexTurn(name: string): Promise<AgentEvent[]> {
  const { deps } = processDeps([fixture('codex', 'handshake'), fixture('codex', 'new-conversation'), fixture('codex', name)]);
  return turnOf(new CodexAdapter(deps));
}

/** A recorded `opencode serve` 1.18.32 turn: every frame is delivered before the message POST settles, as the live server sent them. */
function openCodeTurn(name: string): Promise<AgentEvent[]> {
  const { sessionId, frames, response } = openCodeFixture(name);
  let delivered: () => void = () => {};
  const allDelivered = new Promise<void>((resolve) => { delivered = resolve; });
  const fetch = (async (input: string | URL, init?: RequestInit) => {
    const path = String(input).replace('http://127.0.0.1:4096', '');
    const method = init?.method ?? 'GET';
    if (path === '/event') {
      const { response: events, stream } = sseResponse(init, frames);
      void stream.drained.then(delivered);
      return events;
    }
    const json = method === 'POST' && path === '/session'
      ? { id: sessionId }
      : method === 'POST' && path === `/session/${sessionId}/message` ? await allDelivered.then(() => response) : true;
    return { ok: true, status: 200, statusText: 'OK', json: async () => json } as unknown as Response;
  }) as unknown as typeof globalThis.fetch;
  const { deps, spawned } = processDeps([], fetch);
  return turnOf(new OpenCodeAdapter(deps), async (start) => {
    for (let i = 0; i < 50 && spawned.processes.length === 0; i++) await Promise.resolve();
    spawned.processes[0].emitStdout('opencode server listening on http://127.0.0.1:4096\n');
    await start;
  });
}

const TURNS: Record<string, (name: string) => Promise<AgentEvent[]>> = { 'claude-code': claudeTurn, codex: codexTurn, opencode: openCodeTurn };

describe('the runs of reply text each adapter reports', () => {
  it.each([
    // Claude Code names a run by its message and the content block's place in it.
    ['claude-code', 'prose', [{ runId: 'msg_01:0', deltas: '', text: 'Before I plan this: should the cache be in-process or Redis?' }]],
    ['claude-code', 'stream-reasoning', [
      { runId: 'msg_011CfSugy7H8TSxigEFZviSD:1', deltas: 'No, 391 is not prime, because 17 × 23 = 391.', text: 'No, 391 is not prime, because 17 × 23 = 391.' },
    ]],
    ['claude-code', 'stream-tool-rounds', [
      { runId: 'msg_011CfSuvECkMCBWjXTWo83H6:0', deltas: "I'll read README.md now.", text: "I'll read README.md now." },
      { runId: 'msg_011CfSuvM9DevV5u4fHWhtxy:0', deltas: 'The first line of README.md is "hello".', text: 'The first line of README.md is "hello".' },
    ]],
    // Codex by its `agentMessage` item.
    ['codex', 'deltas', [{ runId: 'item_m1', deltas: 'Which store?', text: 'Which store?' }]],
    ['codex', 'two-messages', [
      { runId: 'item_m5', deltas: '', text: 'I am reading the pricing module.' },
      { runId: 'item_m6', deltas: '', text: 'applyDiscount has no tests. Shall I plan them?' },
    ]],
    // OpenCode by its text part.
    ['opencode', 'prose', [
      { runId: 'prt_0e0156b8a001O26Nh2U7lsZljn', deltas: 'math.ts exports a single `add` function (`(a, b) => a + b`).', text: 'math.ts exports a single `add` function (`(a, b) => a + b`).' },
    ]],
    // The part of nothing but newlines the planner opened its first message with is no run at all.
    ['opencode', 'subagent', [
      { runId: 'prt_0e01637a1001wI0NZlpst89S2z', deltas: '`math.ts` exports a single function `add(a: number, b: number): number`.', text: '`math.ts` exports a single function `add(a: number, b: number): number`.' },
    ]],
  ] as const)('%s %s', async (runner, name, expected) => {
    expect(runsOf(await TURNS[runner](name))).toEqual(expected);
  });
});

/** What a task's log keeps of an adapter's turn: the structured session forwards every event but the four it acts on itself. */
function logOf(events: AgentEvent[]): TaskLogEvent[] {
  const forwarded = events.filter((e): e is Extract<AgentEvent, StructuredEvent> =>
    e.type !== 'turn_end' && e.type !== 'permission_cancelled' && e.type !== 'message_delivered' && e.type !== 'message_dropped');
  return forwarded.flatMap((e) => toTaskLogEvent(e) ?? []);
}

/** The task-log view's text and steps, as `role:text` for a message and the block's type otherwise. */
function shown(log: TaskLogEvent[]): string[] {
  return replayTaskLog(log).blocks.flatMap((b) => (b.type === 'usage' ? [] : [b.type === 'message' ? `${b.role}:${b.text}` : b.type]));
}

describe('the task-log view of each recorded turn', () => {
  it.each([
    ['claude-code', 'stream-tool-rounds', ['agent:I\'ll read README.md now.', 'tool', 'agent:The first line of README.md is "hello".']],
    ['codex', 'deltas', ['thinking', 'agent:Which store?']],
    ['codex', 'two-messages', ['agent:I am reading the pricing module.', 'agent:applyDiscount has no tests. Shall I plan them?']],
    ['opencode', 'prose', ['thinking', 'tool', 'tool', 'agent:math.ts exports a single `add` function (`(a, b) => a + b`).']],
    ['opencode', 'subagent', ['thinking', 'subagent', 'agent:`math.ts` exports a single function `add(a: number, b: number): number`.']],
  ] as const)('%s %s: one block per run, live and as saved', async (runner, name, expected) => {
    const log = logOf(await TURNS[runner](name));
    expect(shown(log)).toEqual(expected);
    // What reaches the disk: merged deltas, through JSON.
    expect(shown(JSON.parse(JSON.stringify(coalesceTaskLog(log))) as TaskLogEvent[])).toEqual(expected);
  });
});

describe('ReplyRuns', () => {
  function collect() {
    const events: AgentEvent[] = [];
    return { events, onEvent: (e: AgentEvent) => events.push(e) };
  }

  it('emits each run once, under its own id and with no break before it', () => {
    const runs = new ReplyRuns();
    const { events, onEvent } = collect();
    runs.complete('a', 'First.', onEvent);
    runs.complete('a', 'First.', onEvent);
    runs.complete('b', 'Second.', onEvent);

    expect(events).toEqual([{ type: 'assistant_text', runId: 'a', text: 'First.' }, { type: 'assistant_text', runId: 'b', text: 'Second.' }]);
  });

  it('drops a run of nothing but whitespace', () => {
    const runs = new ReplyRuns();
    const { events, onEvent } = collect();
    runs.complete('a', '\n\n', onEvent);
    runs.complete('b', 'Reply.', onEvent);

    expect(events).toEqual([{ type: 'assistant_text', runId: 'b', text: 'Reply.' }]);
  });

  it('streams deltas that add up to the completed run, holding back leading whitespace', () => {
    const runs = new ReplyRuns();
    const { events, onEvent } = collect();
    runs.complete('a', 'First.', onEvent);
    runs.delta('b', '\n', onEvent);
    runs.delta('b', 'Sec', onEvent);
    runs.delta('b', 'ond.', onEvent);
    runs.complete('b', '\nSecond.', onEvent);
    runs.delta('b', 'late', onEvent);

    expect(events.slice(1)).toEqual([
      { type: 'assistant_text_delta', runId: 'b', text: '\nSec' },
      { type: 'assistant_text_delta', runId: 'b', text: 'ond.' },
      { type: 'assistant_text', runId: 'b', text: '\nSecond.' },
    ]);
  });
});
