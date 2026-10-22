import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { IConfig } from '../../interfaces/IConfig';
import type { IFileSystem } from '../../interfaces/IFileSystem';
import type { ResearchProgress } from '../../models/Task';
import { fakeConfig, fakeFileSystem } from '../../testing';
import type { SkillInfo } from '../SkillsService';
import { TurnBudgets } from '../PlannerBudgets';

/** The chat instance every getGenerativeModel().startChat() hands back. */
const startChat = vi.hoisted(() => vi.fn());
/** The model each getGenerativeModel() call was asked for, in order. */
const modelsAsked = vi.hoisted((): string[] => []);

vi.mock('@google/generative-ai', () => ({
  GoogleGenerativeAI: class {
    getGenerativeModel = ({ model }: { model: string }) => {
      modelsAsked.push(model);
      // As the SDK does: the instance names the model by its resource path.
      return { model: `models/${model}`, startChat: startChat, generateContentStream: vi.fn() };
    };
  },
  SchemaType: { STRING: 'STRING', NUMBER: 'NUMBER', ARRAY: 'ARRAY', BOOLEAN: 'BOOLEAN', OBJECT: 'OBJECT' },
}));

import { GeminiService } from '../GeminiService';

interface ChunkSpec {
  candidates?: Array<{ content?: { parts?: Array<Record<string, unknown>> }; finishReason?: string }>;
  finishReason?: string;
  usageMetadata?: Record<string, unknown>;
}

type SendMessageStreamRequest = unknown;

function streamResult(chunks: ChunkSpec[]): { stream: AsyncIterable<ChunkSpec> } {
  return {
    stream: (async function* () {
      for (const chunk of chunks) yield chunk;
    })(),
  };
}

/** Wire the mocked chat so each call pops one canned stream and records the request. */
function scriptStreams(specs: { stream: AsyncIterable<ChunkSpec> }[]): { requests: SendMessageStreamRequest[] } {
  const requests: SendMessageStreamRequest[] = [];
  startChat.mockReturnValue({
    sendMessageStream: async (request: SendMessageStreamRequest) => {
      requests.push(request);
      const spec = specs[requests.length - 1];
      if (!spec) throw new Error('scripted streams exhausted');
      return spec;
    },
  });
  return { requests };
}

function geminiConfig(): IConfig {
  return fakeConfig({ aiProvider: 'google', apiKey: 'key', planningModel: 'test-model' });
}

describe('Gemini research chat streaming', () => {
  beforeEach(() => { startChat.mockReset(); });

  it('streams a text reply as deltas under one segment per call, with one usage record from the final chunk', async () => {
    scriptStreams([
      streamResult([
        { candidates: [{ content: { parts: [{ thought: true, text: 'Considering the layout.' }] } }] },
        { candidates: [{ content: { parts: [{ text: 'Which ' }] } }] },
        { candidates: [{ content: { parts: [{ text: 'store?' }] }, finishReason: 'STOP' }] },
        { usageMetadata: { promptTokenCount: 120, candidatesTokenCount: 8, cachedContentTokenCount: 100, totalTokenCount: 142 } },
      ]),
    ]);
    const service = new GeminiService(geminiConfig());
    const progress: ResearchProgress[] = [];
    const turn = await service.startConversation({
      goal: 'find a place',
      runners: ['claude-code'],
      modelsByRunner: {},
      fs: fakeFileSystem() as IFileSystem,
      onProgress: (p) => progress.push(p),
    });

    const textDeltas = progress.filter((p) => p.type === 'text_delta');
    expect(textDeltas.map((p) => p.text)).toEqual(['Which ', 'store?']);
    // One call, one segment: both deltas key to the same fresh segmentId.
    expect(new Set(textDeltas.map((p) => p.segmentId))).toHaveLength(1);
    expect(textDeltas[0].segmentId).toBeTruthy();

    expect(progress.filter((p) => p.type === 'thinking').map((p) => p.text)).toEqual(['Considering the layout.']);

    // Exactly one usage record, assembled from the final chunk's counters.
    const usage = progress.filter((p) => p.type === 'usage');
    expect(usage).toHaveLength(1);
    expect(usage[0].record).toEqual({ source: 'google', model: 'test-model', inputTokens: 120, outputTokens: 8, cachedInputTokens: 100, contextTokens: 128 });

    // The final text still lands on the turn the loop classifies.
    expect(turn.kind).toBe('message');
    if (turn.kind === 'message') expect(turn.text).toBe('Which store?');
  });

  it('calls the picked planner model and names it on each usage record', async () => {
    modelsAsked.length = 0;
    scriptStreams([streamResult([
      { candidates: [{ content: { parts: [{ text: 'Ok.' }] }, finishReason: 'STOP' }] },
      { usageMetadata: { promptTokenCount: 50, candidatesTokenCount: 2 } },
    ])]);
    const service = new GeminiService(fakeConfig({ aiProvider: 'google', apiKey: 'key', planningModel: 'gemini-1.5-flash', orchestratorModel: 'gemini:gemini-2.5-pro' }));
    const progress: ResearchProgress[] = [];
    await service.startConversation({ goal: 'go', runners: ['claude-code'], modelsByRunner: {}, fs: fakeFileSystem() as IFileSystem, onProgress: (p) => progress.push(p) });

    expect(modelsAsked).toEqual(['gemini-2.5-pro']);
    expect(progress.filter((p) => p.type === 'usage').map((p) => p.record)).toEqual([{ source: 'google', model: 'gemini-2.5-pro', inputTokens: 50, outputTokens: 2, contextTokens: 52 }]);
  });

  it('follows a model switched within Gemini on the next turn, over the same history', async () => {
    modelsAsked.length = 0;
    const said = (n: number) => ({ role: 'model', parts: [{ text: `reply ${n}` }] });
    const chats: Array<{ history: unknown[]; sent: unknown[] }> = [];
    let replies = 0;
    startChat.mockImplementation(({ history }: { history: unknown[] }) => {
      const chat = { history: [...history], sent: [] as unknown[] };
      chats.push(chat);
      return {
        getHistory: async () => chat.history,
        sendMessageStream: async (request: unknown) => {
          chat.sent.push(request);
          chat.history.push({ role: 'user', parts: [{ text: request }] }, said(++replies));
          return streamResult([
            { candidates: [{ content: { parts: [{ text: `reply ${replies}` }] }, finishReason: 'STOP' }] },
            { usageMetadata: { promptTokenCount: 100 * replies, candidatesTokenCount: 2 } },
          ]);
        },
      };
    });
    const config = fakeConfig({ aiProvider: 'google', apiKey: 'key', orchestratorModel: 'gemini:gemini-2.5-pro' });
    const service = new GeminiService(config);
    const progress: ResearchProgress[] = [];
    await service.startConversation({ goal: 'go', runners: ['claude-code'], modelsByRunner: {}, fs: fakeFileSystem() as IFileSystem, onProgress: (p) => progress.push(p) });

    config.orchestratorModel = 'gemini:gemini-2.5-flash';
    await service.continueConversation('and then?', (p) => progress.push(p));

    expect(modelsAsked).toEqual(['gemini-2.5-pro', 'gemini-2.5-flash']);
    expect(chats).toHaveLength(2);
    expect(chats[1].history.slice(0, -2)).toEqual(chats[0].history);
    expect(chats[1].sent).toEqual(['and then?']);
    expect(progress.filter((p) => p.type === 'usage').map((p) => p.record?.model)).toEqual(['gemini-2.5-pro', 'gemini-2.5-flash']);
  });

  it('assembles tool calls from function-call chunks, streams a tool round as a fresh segment, and still bills each call', async () => {
    const { requests } = scriptStreams([
      streamResult([
        { candidates: [{ content: { parts: [{ text: 'Let me read the file.' }] } }] },
        { candidates: [{ content: { parts: [{ functionCall: { name: 'read_file', args: { path: 'src/x.ts' } } }] }, finishReason: 'STOP' }] },
        { usageMetadata: { promptTokenCount: 40, candidatesTokenCount: 9 } },
      ]),
      streamResult([
        { candidates: [{ content: { parts: [{ text: 'The read came up ' }] } }] },
        { candidates: [{ content: { parts: [{ text: 'empty. Question: the exact path?' }] }, finishReason: 'STOP' }] },        { usageMetadata: { promptTokenCount: 55, candidatesTokenCount: 14, cachedContentTokenCount: 50 } },
      ]),
    ]);
    const service = new GeminiService(geminiConfig());
    const progress: ResearchProgress[] = [];
    const turn = await service.startConversation({
      goal: 'read a file',
      runners: ['claude-code'],
      modelsByRunner: {},
      fs: fakeFileSystem() as IFileSystem,
      onProgress: (p) => progress.push(p),
    });

    // The tool round happened against the real loop, not inside this test.
    expect(progress.filter((p) => p.type === 'tool_call').map((p) => p.tool)).toEqual(['read_file']);
    const funcResponses = (requests[1] as Array<{ functionResponse: { name: string } }>)[0];
    expect(funcResponses.functionResponse.name).toBe('read_file');

    // Preamble text streamed from the first call under one segment...
    const deltaSegments = progress.filter((p) => p.type === 'text_delta');
    expect(deltaSegments[0].text).toBe('Let me read the file.');
    const firstSegment = deltaSegments[0].segmentId;
    // ...and the post-tool-reply streamed under a NEW segment minted for the second call.
    const secondCallDeltas = deltaSegments.slice(1);
    expect(secondCallDeltas.map((p) => p.text)).toEqual(['The read came up ', 'empty. Question: the exact path?']);
    expect(secondCallDeltas[0].segmentId).toBeTruthy();
    expect(secondCallDeltas[0].segmentId).not.toBe(firstSegment);

    // Concatenation of a call's deltas IS the final text the loop classifies.
    expect(turn.kind).toBe('message');
    if (turn.kind === 'message') expect(turn.text).toBe(secondCallDeltas.map((p) => p.text).join(''));
    // Each call's text is a run of the reply, under the segment it streamed: the preamble as narration.
    expect(turn.runs?.map((run) => [run.segmentId, run.text, run.narration])).toEqual([
      [firstSegment, 'Let me read the file.', true],
      [secondCallDeltas[0].segmentId, 'The read came up empty. Question: the exact path?', undefined],
    ]);

    // One bill per call: unspecified counters stay absent rather than zeroing.
    const usage = progress.filter((p) => p.type === 'usage');
    expect(usage).toHaveLength(2);
    expect(usage[0].record).toEqual({ source: 'google', model: 'test-model', inputTokens: 40, outputTokens: 9, contextTokens: 49 });
    expect(usage[1].record).toEqual({ source: 'google', model: 'test-model', inputTokens: 55, outputTokens: 14, cachedInputTokens: 50, contextTokens: 69 });
  });

  it('reports no usage when the chunks carry no usageMetadata', async () => {
    scriptStreams([
      streamResult([
        { candidates: [{ content: { parts: [{ text: 'Nothing priced here. Question: proceed?' }] }, finishReason: 'STOP' }] },
      ]),
    ]);
    const service = new GeminiService(geminiConfig());
    const progress: ResearchProgress[] = [];
    const turn = await service.startConversation({
      goal: 'go',
      runners: ['claude-code'],
      modelsByRunner: {},
      fs: fakeFileSystem() as IFileSystem,
      onProgress: (p) => progress.push(p),
    });

    expect(progress.filter((p) => p.type === 'usage')).toEqual([]);
    expect(turn.kind).toBe('message');
    if (turn.kind === 'message') expect(turn.text).toBe('Nothing priced here. Question: proceed?');
  });

  it('a chat without streaming hooks (one-shot loop, a future subagent chat) streams no text, only its bill', async () => {
    const planReply = JSON.stringify({
      tasks: [{
        id: 't1', order: 1, title: 'Add widget', description: 'Adds the widget module',
        type: 'ai', dependencies: [], prompt: 'Create src/widget.ts',
        assignedModel: { modelId: 'm', modelLabel: 'M' }, assignedRunner: 'claude-code',
        taskMode: 'acceptEdits', autonomy: 'AFK', sliceType: 'AFK', userStoriesCovered: [], subtasks: [],
      }],
    });
    scriptStreams([
      streamResult([
        { candidates: [{ content: { parts: [{ thought: true, text: 'quietly considering' }] } }] },
        { candidates: [{ content: { parts: [{ text: planReply }] }, finishReason: 'STOP' }] },
        { usageMetadata: { promptTokenCount: 70, candidatesTokenCount: 60, thoughtsTokenCount: 12, totalTokenCount: 142 } },
      ]),
    ]);
    const service = new GeminiService(geminiConfig());
    const progress: ResearchProgress[] = [];
    const { tasks } = await service.researchAndPlan(
      'add a widget',
      ['claude-code'],
      {},
      fakeFileSystem() as IFileSystem,
      (p) => progress.push(p),
    );

    // Nothing streamed — the one-shot loop's thinking and reply are its own
    // business; only the per-call bill flows into the ledger.
    expect(progress.filter((p) => p.type === 'text_delta' || p.type === 'thinking')).toEqual([]);
    const usage = progress.filter((p) => p.type === 'usage');
    expect(usage).toHaveLength(1);
    // Thought tokens bill as output alongside the answer tokens.
    expect(usage[0].record).toEqual({ source: 'google', model: 'test-model', inputTokens: 70, outputTokens: 72, contextTokens: 130 });
    expect(tasks).toHaveLength(1);
  });
});

describe('Gemini planner skill catalog', () => {
  beforeEach(() => { startChat.mockReset(); });

  it('shows the task skills the planner may attach, and no planner skills, which load only through tools', async () => {
    scriptStreams([streamResult([{ candidates: [{ content: { parts: [{ text: 'Which cache?' }] }, finishReason: 'STOP' }] }])]);
    const skill = (name: string, appliesTo: SkillInfo['appliesTo']): SkillInfo => ({
      name, description: `${name} description`, metadata: { name, description: '' }, content: 'BODY',
      source: 'global', path: `/skills/${name}/SKILL.md`, appliesTo, modelInvocable: true, userInvocable: true,
    });

    await new GeminiService(geminiConfig()).startConversation({
      goal: 'add a cache', runners: ['claude-code'], modelsByRunner: {}, fs: fakeFileSystem() as IFileSystem, onProgress: () => {},
      skills: [skill('pr-style', 'task'), skill('review-plan', 'planner')],
    });

    const [{ history }] = startChat.mock.calls[0] as [{ history: { parts: { text: string }[] }[] }];
    const system = history[0].parts[0].text;
    expect(system).toContain('Task skills you may attach:\n- pr-style: pr-style description');
    expect(system).not.toMatch(/review-plan|load_skill/);
  });
});

describe('Gemini turn budgets', () => {
  beforeEach(() => { startChat.mockReset(); });

  it('appends the budget block to the turn\'s message and keeps it out of the system prompt', async () => {
    const reply = () => streamResult([{ candidates: [{ content: { parts: [{ text: 'Which cache?' }] }, finishReason: 'STOP' }] }]);
    const { requests } = scriptStreams([reply(), reply()]);
    let left = 40;
    const service = new GeminiService(geminiConfig(), new TurnBudgets([() => `Web reads left this turn: ${left}.`]));

    await service.startConversation({ goal: 'add a cache', runners: ['claude-code'], modelsByRunner: {}, fs: fakeFileSystem() as IFileSystem, onProgress: () => {} });
    left = 39;
    await service.continueConversation('in-process', () => {});

    expect(requests).toEqual([
      'add a cache\n\nCONTEXT AND BUDGETS (this turn):\n- Web reads left this turn: 40.',
      'in-process\n\nCONTEXT AND BUDGETS (this turn):\n- Web reads left this turn: 39.',
    ]);
    const [{ history }] = startChat.mock.calls[0] as [{ history: { parts: { text: string }[] }[] }];
    expect(history[0].parts[0].text).not.toContain('CONTEXT AND BUDGETS');
  });
});
