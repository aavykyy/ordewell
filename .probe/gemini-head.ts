import { GeminiService } from '../packages/core/src/services/GeminiService';
import { fakeConfig, fakeFileSystem } from '../packages/core/src/testing';

interface Part { text?: string; thought?: boolean; thoughtSignature?: string; functionCall?: { name: string; args: Record<string, unknown> }; functionResponse?: { name: string; response: { output: string } } }
interface Content { role: string; parts: Part[] }
function pairingProblem(contents: Content[]): string | null {
  if (contents[0]?.role !== 'user') return 'the first turn is not the user\'s';
  for (const [i, c] of contents.entries()) {
    if (c.parts.length === 0) return `turn ${i} has no parts`;
    if (i > 0 && c.role === contents[i - 1].role) return `turn ${i} has the role of turn ${i - 1}`;
    const calls = c.role === 'model' ? c.parts.filter((p) => p.functionCall).map((p) => p.functionCall!.name) : [];
    const next = contents[i + 1];
    if (calls.length > 0 && next) {
      const answers = next.role === 'function' ? next.parts.map((p) => p.functionResponse?.name) : [];
      if (JSON.stringify(answers) !== JSON.stringify(calls)) return `turn ${i + 1} does not answer the calls of turn ${i}`;
    }
    if (c.role === 'function') {
      const before = contents[i - 1];
      if (before?.role !== 'model' || !before.parts.some((p) => p.functionCall)) return `turn ${i} answers no function call`;
    }
  }
  return null;
}

const chinese = 'seed goal';
const requests: Array<{ roles: string[]; problem: string | null }> = [];
(globalThis as unknown as { fetch: typeof fetch }).fetch = (async (_url: string | URL, init?: RequestInit) => {
  const body = JSON.parse(String(init?.body ?? '{}')) as { contents: Content[] };
  const problem = pairingProblem(body.contents);
  requests.push({ roles: body.contents.map((c) => c.role), problem });
  if (problem) {
    return new Response(JSON.stringify({ error: { code: 400, message: `Please ensure that function response turn comes immediately after a function call turn (${problem}).` } }), { status: 400, statusText: 'Bad Request' });
  }
  const sse = `data: ${JSON.stringify({ candidates: [{ content: { role: 'model', parts: [{ text: 'Done.' }] }, finishReason: 'STOP' }] })}\r\n\r\ndata: ${JSON.stringify({ usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 2 } })}\r\n\r\n`;
  return new Response(sse, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
}) as typeof fetch;

const svc = new GeminiService(fakeConfig({ aiProvider: 'google', apiKey: 'gem-key', orchestratorModel: 'gemini:big-model', researchMaxSteps: 10 }));
(async () => {
  try {
    await svc.startConversation({ goal: 'map the cache', runners: ['claude-code'], modelsByRunner: {}, fs: fakeFileSystem({}), onProgress: () => {} });
  } catch (err) {
    console.log('start rejected:', err instanceof Error ? err.message : String(err));
  }
  console.log(JSON.stringify(requests, null, 2));
})();
