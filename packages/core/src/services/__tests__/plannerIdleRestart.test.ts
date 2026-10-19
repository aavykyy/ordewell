import { describe, it, expect } from 'vitest';
import type { ChildProcess } from 'child_process';
import { CliAgentAiService } from '../harness/CliAgentAiService';
import type { SpawnFn } from '../harness/AgentAdapter';
import { fakeConfig, flushMicrotasks } from '../../testing';
import { makeSession } from './sessionTestKit';
import { fakeMcpServer, respondingSpawn } from './harnessTestKit';

/**
 * A Claude Code planner whose process ended while nobody was talking to it,
 * at the process boundary and through the session: the next message restarts
 * it from its own session, and when that session cannot be resumed the
 * conversation goes on from Ordewell's transcript (ADR-0009, T4).
 */

const line = (value: unknown) => `${JSON.stringify(value)}\n`;

/**
 * A fake `claude` that answers each user turn with `answer(text)`. A spawn
 * asked to `--resume` a session the CLI does not have is refused as
 * `claude` 2.1.296 does: on stderr, exiting 1 before the attach check.
 */
function fakeClaude(answer: (text: string) => string, options: { resumable: boolean }) {
  const turns: string[] = [];
  const spawned = respondingSpawn((written, proc) => {
    const msg = JSON.parse(written) as { type: string; request_id?: string; request?: { subtype?: string }; message?: { content: { text: string }[] } };
    if (msg.type === 'control_request') {
      const response = msg.request?.subtype === 'mcp_status' ? { mcpServers: [{ name: 'ordewell', status: 'connected' }] } : {};
      proc.emitStdout(line({ type: 'control_response', response: { subtype: 'success', request_id: msg.request_id, response } }));
      return;
    }
    if (msg.type !== 'user') return;
    const text = msg.message?.content.map((c) => c.text).join('\n') ?? '';
    turns.push(text);
    const said = answer(text);
    proc.emitStdout(line({ type: 'system', subtype: 'init', session_id: `sess-${turns.length}`, permissionMode: 'default' }));
    proc.emitStdout(line({ type: 'assistant', session_id: `sess-${turns.length}`, message: { id: `m-${turns.length}`, content: [{ type: 'text', text: said }] } }));
    proc.emitStdout(line({ type: 'result', subtype: 'success', session_id: `sess-${turns.length}`, is_error: false, result: said }));
  });
  const spawn: SpawnFn = (command, args, spawnOptions): ChildProcess => {
    const child = spawned.spawn(command, args, spawnOptions);
    const resumed = args.indexOf('--resume');
    if (resumed >= 0 && !options.resumable) {
      const proc = spawned.processes.at(-1)!;
      queueMicrotask(() => {
        proc.emitStderr(`No conversation found with session ID: ${args[resumed + 1]}\n`);
        proc.exit(1);
      });
    }
    return child;
  };
  return { spawned, spawn, turns };
}

function plannerSession(claude: ReturnType<typeof fakeClaude>) {
  const mcp = fakeMcpServer();
  const ai = new CliAgentAiService(fakeConfig({ aiProvider: 'claude-code' }), {
    spawn: claude.spawn,
    resolvePath: async () => '/usr/bin',
    workspaceRoot: () => '/repo',
    platform: 'linux',
    isDirectory: () => true,
    exists: () => true,
    mcpServer: mcp,
  });
  return makeSession({
    config: fakeConfig({ aiProvider: 'claude-code' }),
    aiService: ai,
    mcpServer: mcp,
    settings: () => ({ enabledRunners: ['claude-code'] }),
  });
}

const reply = (text: string) => (text.includes('Use Postgres') ? 'Postgres it is.' : 'Which database?');
const transcript = (session: ReturnType<typeof plannerSession>) => (session.planState?.conversationHistory ?? []).map((m) => m.content);

describe('a planner whose idle process ended', () => {
  it('answers the next message from a restart on its own session', async () => {
    const claude = fakeClaude(reply, { resumable: true });
    const session = plannerSession(claude);
    await session.startPlanning('Build inventory', ['claude-code']);
    claude.spawned.processes[0].exit(143);
    await flushMicrotasks();

    await session.continueConversation('Use Postgres');

    expect(transcript(session).at(-1)).toBe('Postgres it is.');
    expect(transcript(session).join('\n')).not.toContain('143');
    const args = claude.spawned.lastArgs();
    expect(args[args.indexOf('--resume') + 1]).toBe('sess-1');
  });

  it('goes on from the transcript when its session cannot be resumed, rather than refusing every message', async () => {
    const claude = fakeClaude(reply, { resumable: false });
    const session = plannerSession(claude);
    await session.startPlanning('Build inventory', ['claude-code']);
    claude.spawned.processes[0].exit(143);
    await flushMicrotasks();

    await expect(session.continueConversation('Use Postgres')).rejects.toThrow('could not be resumed');
    await session.continueConversation('Use Postgres');

    expect(transcript(session).at(-1)).toBe('Postgres it is.');
    expect(transcript(session).filter((said) => said === 'Use Postgres')).toHaveLength(1);
    expect(claude.spawned.lastArgs()).not.toContain('--resume');
    const replayed = claude.turns.at(-1)!;
    expect(replayed).toContain('<previous_conversation>');
    expect(replayed).toContain('Which database?');
  });
});
