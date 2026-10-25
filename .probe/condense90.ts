import { BudgetedChat, type CallInput, type ChatCompaction, type ConversationCompactionHost } from '../packages/core/src/services/budgetedChat';
import type { CompactableMessage } from '../packages/core/src/services/contextCompaction';
import type { ResearchTurn } from '../packages/core/src/services/BaseAiService';
import type { ChatBudget, ModelLimits } from '../packages/core/src/services/plannerContextBudget';
import { TokenGauge } from '../packages/core/src/services/plannerContextBudget';
import type { SummaryCall } from '../packages/core/src/services/contextSummary';

type M = CompactableMessage & { role: 'user' | 'assistant' | 'tool'; content?: string };

class Chat extends BudgetedChat<M> {
  readonly calls: Array<{ chars: number; historyChars: number; inputChars: number; maxTokens: number }> = [];
  constructor(seed: M[], toolsChars: number, wantedReply: number, options: ConstructorParameters<typeof BudgetedChat<M>>[3]) {
    super(seed, toolsChars, wantedReply, options);
  }
  protected userMessage(text: string): M { return { role: 'user', content: text }; }
  protected resultMessages(results: Array<{ name: string; output: string; truncated: boolean; totalChars: number; id?: string }>): M[] {
    return results.map((r) => ({ role: 'tool', content: r.output, tool_call_id: r.id }));
  }
  protected notExecuted(_id: string, _name: string, text: string): M { return { role: 'tool', content: text }; }
  protected replayed(messages: ReadonlyArray<Pick<M, 'role' | 'content'>>): M[] { return messages.map((m) => ({ role: m.role as M['role'], content: String(m.content ?? '') })); }
  protected isContextOverflow(): boolean { return false; }
  protected statedLimits(): ModelLimits | undefined { return undefined; }
  protected async callApi(input: CallInput<M>, _model: string, maxTokens: number): Promise<ResearchTurn> {
    this.calls.push({ chars: this.history.chars + this.history.charsOf(input.messages) + this.toolsChars, historyChars: this.history.chars, inputChars: this.history.charsOf(input.messages), maxTokens });
    return { text: 'ok', toolCalls: [], hasToolCalls: false };
  }
}

const LIVE = 125_000;
const MESSAGE = 190_000;
const head: M = { role: 'user', content: 'S'.repeat(1_000) };
const landed: M = { role: 'assistant', content: 'L'.repeat(LIVE) };
const host: ConversationCompactionHost = {
  turnId: () => 't1',
  landed: () => ({ heldFrom: 2, exchanges: [{ from: 1, messages: [{ role: 'assistant', content: 'L'.repeat(LIVE) }] }] }),
  checkpoint: () => {},
  planLines: () => null,
};
const summarize: SummaryCall = async () => ({ text: `<conversation_summary>${'summary word '.repeat(60)}</conversation_summary>`, finishReason: 'stop' });
const compaction: ChatCompaction = { host, summarize, onCompaction: () => {} };
const gauge = new TokenGauge();
gauge.record('m', 1_000, 1_000);
const budget: ChatBudget = {
  limits: () => ({ contextWindow: 200_000, maxOutputTokens: 2_000 }),
  autoCompaction: () => true,
  gauge,
  onCompacted: () => {},
};
const chat = new Chat([head, landed], 0, 2_000, { model: () => 'm', source: () => 'test', budget, compaction });

(async () => {
  await chat.sendMessage('u'.repeat(MESSAGE));
  const call = chat.calls[0];
  console.log(JSON.stringify({
    calls: chat.calls.length,
    historyChars: call?.historyChars,
    inputChars: call?.inputChars,
    sentChars: call?.chars,
    plain: gauge.plainCharsPerToken('m'),
    perToken: gauge.charsPerToken('m'),
    shareOfWindow: call ? call.chars / 200_000 : undefined,
    promptLimit: 198_000,
    ceiling: 180_000,
    overCeiling: call ? call.chars > 180_000 : undefined,
    overPromptLimit: call ? call.chars > 198_000 : undefined,
  }, null, 2));
})().catch((err) => { console.error(err); process.exit(1); });
