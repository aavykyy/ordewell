import { describe, expect, it } from 'vitest';
import { ClaudeCodeAdapter } from '../harness/ClaudeCodeAdapter';
import type { AgentEvent, AgentProcessDeps, TaskStartOptions } from '../harness/AgentAdapter';
import { addAttemptUsage, startAttemptUsage, type AttemptUsage } from '../../models/Usage';
import { fakeSpawn, fixture } from './harnessTestKit';

/**
 * Adversarial: what every recorded Claude Code stream reports in its `result`
 * lines is what the attempt counts, once. A turn whose calls streamed reports
 * each call itself; one recorded without partial messages reports only the
 * turn's sum, which is taken once and never as a per-call context.
 */

interface Line {
  type?: string;
  subtype?: string;
  permissionMode?: string;
  session_id?: string;
  total_cost_usd?: number;
  parent_tool_use_id?: string | null;
  usage?: Usage;
  message?: { id?: string; model?: string; usage?: Usage };
  tool_use_result?: { usage?: Usage };
  event?: { type?: string; usage?: Usage };
}

interface Usage {
  input_tokens?: number;
  output_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
}

function processDeps(text: string): AgentProcessDeps {
  const spawned = fakeSpawn([text]);
  return {
    spawn: spawned.spawn,
    fetch: (async () => { throw new Error('no HTTP in this test'); }) as unknown as typeof fetch,
    resolvePath: async () => '/usr/bin',
    platform: 'linux',
    isDirectory: () => true,
    exists: () => true,
    workspaceEnv: async () => ({}),
  };
}

function linesOf(text: string): Line[] {
  return text.split('\n').filter(Boolean).flatMap((line) => {
    try { return [JSON.parse(line) as Line]; } catch { return []; }
  });
}

/** A call's prompt as the runner splits it: uncached input, cache write, cache read. */
function promptOf(usage: Usage | undefined): number {
  return (usage?.input_tokens ?? 0) + (usage?.cache_creation_input_tokens ?? 0) + (usage?.cache_read_input_tokens ?? 0);
}

function expectedUsage(lines: Line[]): { input: number; cached: number; output: number } {
  // A result states its turn's own sum, whether or not the turn's calls
  // streamed. The attempt must equal it: streamed calls are counted once and a
  // call whose stream is missing (or absent, in an older recording) is added
  // from that remainder.
  const main = lines.flatMap((l) => (l.type === 'result' && l.usage ? [l.usage] : []));
  let input = main.reduce((sum, u) => sum + promptOf(u), 0);
  let cached = main.reduce((sum, u) => sum + (u.cache_read_input_tokens ?? 0), 0);
  let output = main.reduce((sum, u) => sum + (u.output_tokens ?? 0), 0);
  // A subagent's assistant lines are prompt snapshots (no output yet); its last
  // call arrives whole on the Agent result.
  const counted = new Set<string>();
  for (const l of lines) {
    if (l.type !== 'assistant' || !l.parent_tool_use_id) continue;
    const id = l.message?.id;
    if (id && counted.has(id)) continue;
    if (id) counted.add(id);
    input += promptOf(l.message?.usage);
    cached += l.message?.usage?.cache_read_input_tokens ?? 0;
  }
  for (const l of lines) {
    const usage = l.type === 'user' ? l.tool_use_result?.usage : undefined;
    if (!usage) continue;
    input += promptOf(usage);
    cached += usage.cache_read_input_tokens ?? 0;
    output += usage.output_tokens ?? 0;
  }
  return { input, cached, output };
}

function tokensOf(ledger: AttemptUsage): { input: number; cached: number; output: number } {
  const { inputTokens = 0, cachedInputTokens = 0, outputTokens = 0 } = ledger.totals;
  return { input: inputTokens, cached: cachedInputTokens, output: outputTokens };
}

function costOf(ledger: AttemptUsage): number {
  return ledger.totals.reportedCost?.USD ?? 0;
}

const REPLAYED = [
  'task-checkpoint', 'task-background', 'task-no-marker', 'task-marker', 'task-compact',
  'task-interrupt-followup', 'task-command-skill', 'task-model-switched', 'task-effort-command',
  'stream-tool-rounds', 'stream-subagent', 'stream-reasoning', 'stream-async-agent-report',
  'permission-task-allowed-for-task', 'permission-task-cancelled',
];

describe('adversarial: every recorded attempt counts what its result lines report', () => {
  it.each(REPLAYED)('%s', async (name) => {
    const text = fixture('claude-code', name);
    const lines = linesOf(text);
    const mode = lines.find((l) => l.type === 'system' && l.subtype === 'init')?.permissionMode ?? 'default';
    const start: TaskStartOptions = { kind: 'task', cwd: '/repo', mode, flags: { permissionMode: mode, modeSettings: {} } };
    const adapter = new ClaudeCodeAdapter(processDeps(text));
    await adapter.start(start);
    const events: AgentEvent[] = [];
    adapter.onOutOfTurn?.((event) => events.push(event));
    await adapter.send('do it', (event) => events.push(event));
    let ledger = startAttemptUsage(1, 'claude-code', '2026-10-19T00:00:00Z');
    for (const event of events) {
      if (event.type === 'usage') ledger = addAttemptUsage(ledger, event.record, '2026-10-19T00:01:00Z');
    }

    const results = lines.flatMap((l) => (l.type === 'result' && typeof l.total_cost_usd === 'number' ? [l.total_cost_usd] : []));
    expect(costOf(ledger)).toBeCloseTo(results.at(-1) ?? 0, 9);
    expect(tokensOf(ledger)).toEqual(expectedUsage(lines));
    adapter.dispose();
  }, 30_000);
});
