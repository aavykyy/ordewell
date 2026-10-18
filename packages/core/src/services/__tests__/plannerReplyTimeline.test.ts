import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { IConfig } from '../../interfaces/IConfig';
import type { ResearchProgress, ResearchStep, RunnerId } from '../../models/Task';
import type { ConversationTurn, TurnRun } from '../AiService';
import { fakeConfig } from '../../testing';
import { CliAgentAiService } from '../harness/CliAgentAiService';
import type { SessionMessage } from '../SessionMessage';
import { EMPTY_CONVERSATION, reduceConversation, type ConversationView } from '../../conversation/reduce';
import { fromTranscript } from '../../conversation/transcript';
import { fakeMcpServer, fakeSpawn, fixture, openCodeFixture, sseResponse, type ScriptedReply } from './harnessTestKit';
import { makeSession } from './sessionTestKit';

/**
 * The user-reported timeline bug (ADR-0017 A1): a coding-agent planner's words
 * must stay where it said them — "I'll read README.md now" above the Read row
 * it announced, not joined with the rest of the turn below it — live and after
 * a reload. Driven from recorded runner output through a real Session.
 */

function timeline(view: ConversationView): string[] {
  return view.blocks.flatMap((b) => {
    if (b.type === 'message') return [`${b.role}: ${b.text}`];
    if (b.type === 'tool') return [`tool: ${b.headline.name}`];
    if (b.type === 'subagent') return ['subagent'];
    if (b.type === 'plan') return [`plan: ${b.status}`];
    return [];
  });
}

const deps = { resolvePath: async () => '/usr/bin', workspaceRoot: () => '/repo', isDirectory: () => true, exists: () => true, mcpServer: fakeMcpServer() };

function harness(provider: IConfig['aiProvider'], replies: ScriptedReply[]): CliAgentAiService {
  return new CliAgentAiService(fakeConfig({ aiProvider: provider }), {
    ...deps,
    spawn: fakeSpawn(replies).spawn,
    fetch: (async () => { throw new Error('no HTTP in this test'); }) as unknown as typeof fetch,
    platform: 'linux',
  });
}

/** An OpenCode server replaying a recorded turn, its settled response held back until every frame has arrived. */
function openCode(frames: string[], sessionId: string, response: unknown): CliAgentAiService {
  const spawned = fakeSpawn([]);
  const spawn: typeof spawned.spawn = (cmd, argv, opts) => {
    const proc = spawned.spawn(cmd, argv, opts);
    queueMicrotask(() => spawned.processes.at(-1)!.emitStdout('opencode server listening on http://127.0.0.1:44100\n'));
    return proc;
  };
  const fetchImpl = (async (input: string | URL, init?: RequestInit) => {
    const url = String(input);
    const json = (body: unknown) => ({ ok: true, status: 200, statusText: 'OK', json: async () => body }) as unknown as Response;
    if (url.endsWith('/api/info')) return json({});
    if (url.endsWith('/mcp')) return json({ ordewell: { status: 'connected' } });
    if (url.endsWith('/event')) return sseResponse(init, frames).response;
    if (url.endsWith('/session')) return json({ id: sessionId });
    return new Promise((resolve) => setTimeout(() => resolve(json(response)), 0));
  }) as unknown as typeof fetch;
  return new CliAgentAiService(fakeConfig({ aiProvider: 'opencode', enabledRunners: ['opencode'] }), { ...deps, spawn, fetch: fetchImpl });
}

/** Plan with `planner` in a real Session: the view every surface draws live, and the one a reload opens with. */
async function planWith(planner: CliAgentAiService, goal: string, runner: RunnerId) {
  const sent: SessionMessage[] = [];
  const session = makeSession({
    // Each broadcast moves the clock on, so what the planner said, and the
    // calls it made, are stamped apart as they are in a real turn.
    broadcast: (msg) => { sent.push(msg); vi.advanceTimersByTime(1000); },
    aiService: planner,
    config: fakeConfig({ enabledRunners: [runner] }),
  });
  const plan = await session.startPlanning(goal, [runner]);
  return {
    live: timeline(sent.reduce(reduceConversation, EMPTY_CONVERSATION)),
    reloaded: timeline(fromTranscript(plan.conversationHistory, plan.researchLog)),
  };
}

describe('a coding-agent planner\'s reply timeline', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.parse('2026-10-18T10:00:00.000Z'));
  });
  afterEach(() => vi.useRealTimers());

  it('keeps Claude Code\'s words around the Read it announced, live and after a reload', async () => {
    const { live, reloaded } = await planWith(harness('claude-code', [fixture('claude-code', 'stream-tool-rounds')]), 'What does README.md start with?', 'claude-code');

    expect(live).toEqual([
      'user: What does README.md start with?',
      'planner: I\'ll read README.md now.',
      'tool: Read',
      'planner: The first line of README.md is "hello".',
    ]);
    expect(reloaded).toEqual(live);
  });

  it('keeps Codex\'s words around the command it ran, live and after a reload', async () => {
    const { live, reloaded } = await planWith(harness('codex', [fixture('codex', 'handshake'), fixture('codex', 'new-conversation'), fixture('codex', 'usage')]), 'What is the answer?', 'codex');

    expect(live).toEqual([
      'user: What is the answer?',
      'planner: I will read the file.',
      expect.stringMatching(/^tool: /),
      'planner: The answer is 42.',
    ]);
    expect(reloaded).toEqual(live);
  });

  // The recorded early text part is nothing but newlines; given words, it is
  // what the planner said before handing the read to a subagent.
  it('keeps OpenCode\'s words around the subagent it started, live and after a reload', async () => {
    const said = 'I will have a subagent read it.';
    const early = 'prt_0e0161564001KdeNCS3UUcJpRp';
    const { sessionId, frames, response } = openCodeFixture('subagent');
    const worded = frames.map((frame) => {
      const event = JSON.parse(frame.slice('data: '.length)) as { properties: { partID?: string; delta?: string; part?: { id?: string; text?: string } } };
      if (event.properties.partID === early) event.properties.delta = said;
      else if (event.properties.part?.id === early && event.properties.part.text) event.properties.part.text = said;
      else return frame;
      return `data: ${JSON.stringify(event)}\n\n`;
    });

    const { live, reloaded } = await planWith(openCode(worded, sessionId, response), 'What does math.ts export?', 'opencode');

    expect(live).toEqual([
      'user: What does math.ts export?',
      `planner: ${said}`,
      'subagent',
      'planner: `math.ts` exports a single function `add(a: number, b: number): number`.',
    ]);
    expect(reloaded).toEqual(live);
  });
});

/**
 * A planner that says what it will read, reads it and is still at it when it
 * is stopped, settling on what it had; then answers whatever comes next.
 */
function lookingPlanner() {
  let call = 0;
  const said = (onProgress: (p: ResearchProgress) => void, text: string, narration = false): TurnRun => {
    const run: TurnRun = { segmentId: `s${++call}`, text, startedAt: new Date().toISOString(), ...(narration ? { narration: true as const } : {}) };
    onProgress({ type: 'text_delta', segmentId: run.segmentId, text });
    return run;
  };
  const look = (onProgress: (p: ResearchProgress) => void, signal?: AbortSignal) => new Promise<ConversationTurn>((resolve) => {
    const run = said(onProgress, 'Let me look at the parser.', true);
    onProgress({ type: 'tool_call', tool: 'read_file', toolArgs: '{"path":"parser.ts"}', toolCallId: 'c1' });
    const read: ResearchStep = { id: 'rs-1', tool: 'read_file', args: '{"path":"parser.ts"}', result: 'export {}', success: true, outcome: 'success', toolCallId: 'c1', timestamp: new Date().toISOString() };
    onProgress({ type: 'tool_result', toolResult: read.result, step: read, toolCallId: 'c1' });
    signal?.addEventListener('abort', () => resolve({ kind: 'message', text: run.text, researchLog: [read], aborted: true, runs: [run] }), { once: true });
  });
  const answer = (onProgress: (p: ResearchProgress) => void, text: string): ConversationTurn => ({ kind: 'message', text, researchLog: [], runs: [said(onProgress, text)] });
  let looking = false;
  return {
    startConversation: vi.fn(async (req: { onProgress: (p: ResearchProgress) => void }) => answer(req.onProgress, 'Which parser?')),
    continueConversation: vi.fn((message: string, onProgress: (p: ResearchProgress) => void, signal?: AbortSignal) => {
      if (looking) return Promise.resolve(answer(onProgress, 'Switching to the YAML parser.'));
      looking = true;
      return look(onProgress, signal);
    }),
    hasActiveConversation: () => true,
    reset: vi.fn(),
  };
}

describe('a stopped or force-sent planner turn\'s timeline', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.parse('2026-10-18T10:00:00.000Z'));
  });
  afterEach(() => vi.useRealTimers());

  async function lookingSession() {
    const sent: SessionMessage[] = [];
    const session = makeSession({
      broadcast: (msg) => { sent.push(msg); vi.advanceTimersByTime(1000); },
      aiService: lookingPlanner(),
    });
    await session.startPlanning('parse the config', ['claude-code']);
    const turn = session.continueConversation('why is parsing slow?');
    await vi.waitFor(() => expect(sent.some((m) => m.type === 'research_step_done')).toBe(true));
    const views = () => {
      const plan = session.planState!;
      return { live: timeline(sent.reduce(reduceConversation, EMPTY_CONVERSATION)), reloaded: timeline(fromTranscript(plan.conversationHistory, plan.researchLog)) };
    };
    return { session, turn, views };
  }

  it('keeps what a stopped turn said where it said it, live and after a reload', async () => {
    const { session, turn, views } = await lookingSession();

    session.abortPlannerTurn();
    await turn;

    const { live, reloaded } = views();
    expect(live.slice(-3)).toEqual(['user: why is parsing slow?', 'planner: Let me look at the parser.', 'tool: Read']);
    expect(reloaded).toEqual(live);
  });

  it('keeps what a force-sent turn said where it said it, ahead of the forced message, live and after a reload', async () => {
    const { session, turn, views } = await lookingSession();

    await session.forceSendPrompt('use the YAML parser');
    await turn;

    const { live, reloaded } = views();
    expect(live.slice(-5)).toEqual([
      'user: why is parsing slow?', 'planner: Let me look at the parser.', 'tool: Read', 'user: use the YAML parser', 'planner: Switching to the YAML parser.',
    ]);
    expect(reloaded).toEqual(live);
  });
});
