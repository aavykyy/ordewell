import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { IConfig } from '../../interfaces/IConfig';
import type { ResearchProgress } from '../../models/Task';
import { fakeConfig } from '../../testing';
import { CliAgentAiService } from '../harness/CliAgentAiService';
import { plannerTranscript } from '../skillInvocation';
import type { ConversationMessage } from '../../models/Task';
import type { SessionMessage } from '../SessionMessage';
import { EMPTY_CONVERSATION, reduceConversation, type ConversationView } from '../../conversation/reduce';
import { fromTranscript } from '../../conversation/transcript';
import { fakeMcpServer, fakeSpawn, fixture, openCodeFixture, sseResponse, type ScriptedReply } from './harnessTestKit';
import { fakeFs, makeSession } from './sessionTestKit';

function claudeSays(text: string): string {
  return [
    { type: 'system', subtype: 'init', session_id: 'sess-open', cwd: '/repo', permissionMode: 'plan' },
    { type: 'assistant', session_id: 'sess-open', message: { id: 'msg_open', role: 'assistant', content: text ? [{ type: 'text', text }] : [] } },
    { type: 'result', subtype: 'success', session_id: 'sess-open', is_error: false, result: text },
  ].map((line) => `${JSON.stringify(line)}\n`).join('');
}

/**
 * Adversarial checks on the planner reply timeline (ADR-0017 A1) driven
 * through the real service and Session: a force send landing while a recorded
 * turn is still streaming, and what the planner is told on a replay — each
 * reply whole, once, runs or no runs.
 */

function timeline(view: ConversationView): string[] {
  return view.blocks.flatMap((b) => {
    if (b.type === 'message') return [`${b.role}: ${b.text}`];
    if (b.type === 'tool') return [`tool: ${b.headline.name}`];
    if (b.type === 'subagent') return ['subagent'];
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

describe('a force send landing while a recorded turn is still streaming', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.parse('2026-10-18T10:00:00.000Z'));
  });
  afterEach(() => vi.useRealTimers());

  it('keeps the stopped turn\'s words where they streamed, then answers the forced message, live and after a reload', async () => {
    // The recorded turn: narration, a Read, then the answer mid-stream. Cut
    // after the answer's first delta, so the stop lands while it streams.
    const lines = fixture('claude-code', 'stream-tool-rounds').split('\n').filter(Boolean);
    const midAnswer = lines.findIndex((line) => line.includes('"The first line of README.md is"')) + 1;
    const opening = `${lines.slice(0, midAnswer).join('\n')}\n`;
    const resumeReply = [
      { type: 'system', subtype: 'init', session_id: 'sess-claude-stream-2', cwd: '/repo', permissionMode: 'plan' },
      { type: 'assistant', session_id: 'sess-claude-stream-2', message: { id: 'msg_resume', role: 'assistant', content: [{ type: 'text', text: 'Switching to the YAML parser.' }] } },
      { type: 'result', subtype: 'success', session_id: 'sess-claude-stream-2', is_error: false, result: 'Switching to the YAML parser.' },
    ].map((line) => `${JSON.stringify(line)}\n`).join('');

    const sent: SessionMessage[] = [];
    const session = makeSession({
      broadcast: (msg) => { sent.push(msg); vi.advanceTimersByTime(1000); },
      aiService: harness('claude-code', [claudeSays('Replying.'), opening, resumeReply]),
      config: fakeConfig({ enabledRunners: ['claude-code'] }),
    });
    await session.startPlanning('What does README.md start with?', ['claude-code']);
    const turn = session.continueConversation('and the LICENSE?');
    await vi.waitFor(() => expect(sent.some((m) => m.type === 'planner_text_delta' && m.text.includes('The first line'))).toBe(true));

    await session.forceSendPrompt('use the YAML parser');
    await turn;

    const plan = session.planState!;
    const live = timeline(sent.reduce(reduceConversation, EMPTY_CONVERSATION));
    const reloaded = timeline(fromTranscript(plan.conversationHistory, plan.researchLog));
    expect(live.slice(-6)).toEqual([
      'user: and the LICENSE?',
      'planner: I\'ll read README.md now.',
      'tool: Read',
      'planner: The first line of README.md is',
      'user: use the YAML parser',
      'planner: Switching to the YAML parser.',
    ]);
    expect(reloaded).toEqual(live);
  });
});

describe('what a replay tells the planner of replies that kept runs', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.parse('2026-10-18T10:00:00.000Z'));
  });
  afterEach(() => vi.useRealTimers());

  // The transcript entries keep their runs beside `content`; the replay sends
  // `content` alone. The runs must not surface a second time.
  const history: ConversationMessage[] = [
    { role: 'user', content: 'Plan the parser.', timestamp: '2026-10-18T10:00:00.000Z' },
    {
      role: 'assistant', content: 'I will read it.\n\nIt says hello.', timestamp: '2026-10-18T10:00:01.000Z',
      runs: [
        { segmentId: 'seg-a', text: 'I will read it.', startedAt: '2026-10-18T10:00:00.500Z' },
        { segmentId: 'seg-b', text: 'It says hello.', startedAt: '2026-10-18T10:00:01.000Z' },
      ],
    },
    { role: 'user', content: 'go on', timestamp: '2026-10-18T10:00:02.000Z' },
  ];

  it('replays each reply\'s content once into the resumed conversation', async () => {
    const fake = fakeSpawn([JSON.stringify({ type: 'system', subtype: 'init', session_id: 'sess-replay', cwd: '/repo', permissionMode: 'plan' }) + '\n' + JSON.stringify({ type: 'assistant', session_id: 'sess-replay', message: { id: 'msg_r', role: 'assistant', content: [{ type: 'text', text: 'Answering.' }] } }) + '\n' + JSON.stringify({ type: 'result', subtype: 'success', session_id: 'sess-replay', is_error: false, result: 'Answering.' }) + '\n']);
    const svc = new CliAgentAiService(fakeConfig({ aiProvider: 'claude-code' }), {
      ...deps,
      spawn: fake.spawn,
      fetch: (async () => { throw new Error('no HTTP in this test'); }) as unknown as typeof fetch,
      platform: 'linux',
    });
    const progress = (_p: ResearchProgress) => {};
    await svc.startConversation({
      goal: 'Plan the parser.', runners: ['claude-code'], modelsByRunner: {}, fs: fakeFs(),
      onProgress: progress, priorHistory: history, initialMessage: 'go on again', plannerTools: { sessionId: 's', handler: {} },
    });
    const written = fake.processes[0]?.written.join('\n') ?? '';
    expect(written.split('It says hello.')).toHaveLength(2);
    expect(written.split('I will read it.')).toHaveLength(2);
  });

  it('leaves entries with runs exactly as they were for the replay', () => {
    const replayed = plannerTranscript(history);
    expect(replayed.map((m) => m.content)).toEqual(['Plan the parser.', 'I will read it.\n\nIt says hello.', 'go on']);
  });

  it('carries a backgrounded agent\'s earlier words once, above the report, live and after a reload', async () => {
    const sent: SessionMessage[] = [];
    const session = makeSession({
      broadcast: (msg) => { sent.push(msg); vi.advanceTimersByTime(1000); },
      aiService: harness('claude-code', [
        claudeSays('Ready.'),
        fixture('claude-code', 'stream-async-agent'),
        fixture('claude-code', 'async-agent-report'),
      ]),
      config: fakeConfig({ enabledRunners: ['claude-code'] }),
    });
    await session.startPlanning('Read the repo.', ['claude-code']);
    await session.continueConversation('read README and summarize');

    const plan = session.planState!;
    const live = timeline(sent.reduce(reduceConversation, EMPTY_CONVERSATION));
    const reloaded = timeline(fromTranscript(plan.conversationHistory, plan.researchLog));
    // The agent was launched by the call (its row stands above), the words
    // said when it was backgrounded follow, and the answer the wait turn
    // brought comes last — carried across the wait, once, never duplicated.
    expect(live.slice(-4)).toEqual([
      'user: read README and summarize',
      'subagent',
      'planner: Launched the Explore agent in the background to read README.md and report its first line.',
      'planner: The exploration agent landed: the KPI helpers live in lib/kpis.py, and nothing there segments lost RFQs by item.',
    ]);
    expect(reloaded).toEqual(live);
  });

  it('settles an OpenCode turn stopped mid-stream with the part it streamed, live and after a reload', async () => {
    const { sessionId, frames, response } = openCodeFixture('prose');
    // Feed only up to the first text part's last delta; the stop lands before
    // the tool part's frames would.
    const cut = frames.findIndex((frame) => frame.includes('"tool"')) + 1;
    const streamed = frames.slice(0, cut);
    const spawned = fakeSpawn([]);
    const spawn: typeof spawned.spawn = (cmd, argv, opts) => {
      const proc = spawned.spawn(cmd, argv, opts);
      queueMicrotask(() => spawned.processes.at(-1)!.emitStdout('opencode server listening on http://127.0.0.1:44100\n'));
      return proc;
    };
    const json = (body: unknown) => ({ ok: true, status: 200, statusText: 'OK', json: async () => body }) as unknown as Response;
    const fetchImpl = (async (input: string | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/api/info')) return json({});
      if (url.endsWith('/mcp')) return json({ ordewell: { status: 'connected' } });
      if (url.endsWith('/event')) return sseResponse(init, streamed).response;
      if (url.endsWith('/session')) return json({ id: sessionId });
      return new Promise((resolve) => setTimeout(() => resolve(json(response)), 0));
    }) as unknown as typeof fetch;
    const sent: SessionMessage[] = [];
    const session = makeSession({
      broadcast: (msg) => { sent.push(msg); vi.advanceTimersByTime(1000); },
      aiService: new CliAgentAiService(fakeConfig({ aiProvider: 'opencode', enabledRunners: ['opencode'] }), { ...deps, spawn, fetch: fetchImpl }),
      config: fakeConfig({ enabledRunners: ['opencode'] }),
    });
    const planPromise = session.startPlanning('What does math.ts export?', ['opencode']);
    await vi.waitFor(() => expect(sent.some((m) => m.type === 'planner_text_delta')).toBe(true));

    session.abortPlannerTurn();
    await planPromise;

    const plan = session.planState!;
    const live = timeline(sent.reduce(reduceConversation, EMPTY_CONVERSATION));
    const reloaded = timeline(fromTranscript(plan.conversationHistory, plan.researchLog));
    // The stop landed after the settled response was in hand, so the turn
    // settles on the whole reply — streamed where it streamed, and once.
    expect(live.slice(-2)).toEqual([
      'user: What does math.ts export?',
      'planner: math.ts exports a single `add` function (`(a, b) => a + b`).',
    ]);
    expect(reloaded).toEqual(live);
  });
});
