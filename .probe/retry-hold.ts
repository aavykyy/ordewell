import { BudgetedChat, type CallInput, type ChatCompaction, type ConversationCompactionHost } from '../packages/core/src/services/budgetedChat';
import type { CompactableMessage } from '../packages/core/src/services/contextCompaction';
import type { ResearchTurn } from '../packages/core/src/services/BaseAiService';
import type { ChatBudget, ModelLimits } from '../packages/core/src/services/plannerContextBudget';
import { TokenGauge, PlannerContextExhaustedError } from '../packages/core/src/services/plannerContextBudget';
import type { SummaryCall } from '../packages/core/src/services/contextSummary';

type M = CompactableMessage & { role: 'user' | 'assistant' | 'tool'; content?: string };

class Chat extends BudgetedChat<M> {
  readonly calls: Array<{ chars: number; maxTokens: number }> = [];
  constructor(seed: M[], options: ConstructorParameters<typeof BudgetedChat<M>>[3]) { super(seed, 0, 2_000, options); }
  protected userMessage(text: string): M { return { role: 'user', content: text }; }
  protected resultMessages(results: Array<{ name: string; output: string; truncated: boolean; totalChars: number; id?: string }>): M[] { return results.map((r) => ({ role: 'tool', content: r.output, tool_call_id: r.id })); }
  protected notExecuted(_id: string, _name: string, text: string): M { return { role: 'tool', content: text }; }
  protected replayed(messages: ReadonlyArray<Pick<M, 'role' | 'content'>>): M[] { return messages.map((m) => ({ role: m.role as M['role'], content: String(m.content ?? '') })); }
  protected isContextOverflow(): boolean { return false; }
  protected statedLimits(): ModelLimits | undefined { return undefined; }
  protected async callApi(input: CallInput<M>, _model: string, maxTokens: number): Promise<ResearchTurn> {
    this.calls.push({ chars: this.history.chars + this.history.charsOf(input.messages), maxTokens });
    return { text: 'ok', toolCalls: [], hasToolCalls: false };
  }
}

const LIVE = 125_000;
const MESSAGE = 400_000;
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
gauge.record('m', 1_000, 1_000); // measured: plain = 1 char/token
const budget: ChatBudget = { limits: () => ({ contextWindow: 200_000, maxOutputTokens: 2_000 }), autoCompaction: () => true, gauge, onCompacted: () => {} };
const chat = new Chat([head, landed], { model: () => 'm', source: () => 'test', budget, compaction });

(async () => {
  let first: string | undefined;
  try { await chat.sendMessage('u'.repeat(MESSAGE)); } catch (err) { first = err instanceof PlannerContextExhaustedError ? `held:${err.summary}:${err.tooLong ?? 'none'}` : String(err); }
  const callsAfterSend = chat.calls.length;
  let retried: string | undefined;
  try { await chat.retry(); } catch (err) { retried = err instanceof PlannerContextExhaustedError ? `held:${err.summary}:${err.tooLong ?? 'none'}` : String(err); }
  console.log(JSON.stringify({ first, callsAfterSend, retryResult: retried, callsAfterRetry: chat.calls.length, retryable: chat.retryable(), plain: gauge.plainCharsPerToken('m') }, null, 2));
})().catch((err) => { console.error(err); process.exit(1); });
