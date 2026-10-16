import { afterEach, describe, expect, it, vi } from 'vitest';
import { createTask, type LegacyPlanState } from '../../models/Task';
import type { ConversationTurn } from '../AiService';
import type { IConfig } from '../../interfaces/IConfig';
import { detectInstalledPlanner, recordInstalledPlanner, recordedInstalledPlanner, resetInstalledPlanner } from '../InstalledPlanner';
import { PlannerTurnStoppedError } from '../PlannerConversation';
import { PlannerNotReadyError } from '../plannerReadiness';
import { fakeConfig, makeSession, testWorkspace } from './sessionTestKit';

/**
 * The one gate every planner turn passes before it opens (ADR-0009): it waits
 * for the installed-planner probe, then judges the planner in use at that
 * moment, and a refusal never costs the user the message it held up.
 */

/** No AI_PROVIDER and no vendor key: the planner is whatever the probe records, openrouter until it answers. */
function keylessConfig(): IConfig {
  const config = fakeConfig({ getProviderApiKey: () => '', orchestratorModel: '', planningModel: '' });
  Object.defineProperty(config, 'aiProvider', { get: () => recordedInstalledPlanner() ?? 'openrouter' });
  return config;
}

/** A probe whose answer the test gives: Claude Code is usable or not, every other agent never is. */
function heldProbe() {
  let answer!: (usable: boolean) => void;
  const claude = new Promise<{ usable: boolean }>((resolve) => { answer = (usable) => resolve({ usable }); });
  void detectInstalledPlanner({ plannerUsability: async (runner) => (runner === 'claude-code' ? claude : { usable: false }) });
  return { answer };
}

const prose = (text: string): ConversationTurn => ({ kind: 'message', text, researchLog: [] });

/**
 * A planner that records which provider each turn was taken on. Like the real
 * openrouter transport, it throws when asked to plan with no key.
 */
function recordingPlanner(config: IConfig) {
  const providers: string[] = [];
  const aiService = {
    startConversation: vi.fn(),
    hasActiveConversation: () => true,
    continueConversation: vi.fn(async (message: string) => {
      if (config.aiProvider === 'openrouter' && !config.getProviderApiKey('openrouter')) throw new Error('OpenRouter API key not configured');
      providers.push(config.aiProvider);
      return prose(message.includes('<conversation_summary>') ? '<conversation_summary>Built it.</conversation_summary>' : 'Done.');
    }),
    reset: vi.fn(),
  };
  return { aiService, providers };
}

function savedPlan(pending: string[] = []): LegacyPlanState {
  const now = new Date().toISOString();
  return {
    tasks: [
      createTask({ id: 't1', order: 1, title: 'First', prompt: 'do first', assignedRunner: 'claude-code' }),
      createTask({ id: 't2', order: 2, title: 'Second', prompt: 'do second', assignedRunner: 'claude-code' }),
    ],
    generatedAt: now,
    status: 'approved',
    runners: ['claude-code'],
    lastUpdated: now,
    conversationHistory: [
      { role: 'user', content: 'build it', timestamp: '2026-10-11T00:00:00Z' },
      { role: 'assistant', content: 'Plan generated with 2 tasks.', timestamp: '2026-10-11T00:00:01Z', kind: 'plan_generated' },
      { role: 'user', content: 'keep it small', timestamp: '2026-10-11T00:00:02Z' },
      { role: 'assistant', content: 'Noted.', timestamp: '2026-10-11T00:00:03Z' },
      { role: 'user', content: 'and typed', timestamp: '2026-10-11T00:00:04Z' },
      { role: 'assistant', content: 'Noted.', timestamp: '2026-10-11T00:00:05Z' },
    ],
    pendingTurns: pending.map((text, i) => ({ id: `turn-${i + 1}`, source: 'user', text, timestamp: '2026-10-11T00:00:02Z' })),
  };
}

const pendingTexts = (plan: LegacyPlanState | null) => (plan?.pendingTurns ?? []).map((t) => t.text);
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

afterEach(() => resetInstalledPlanner());

describe('a restored message', () => {
  it('waits for the probe, then is answered by the coding agent it finds, kept on the plan until then', async () => {
    const config = keylessConfig();
    const { aiService, providers } = recordingPlanner(config);
    const probe = heldProbe();
    const session = makeSession({ config, aiService });

    session.loadPlan(savedPlan(['rename task 1']), 'build it', testWorkspace);
    await settle();
    expect(aiService.continueConversation).not.toHaveBeenCalled();
    expect(pendingTexts(session.planState)).toEqual(['rename task 1']);

    probe.answer(true);
    await vi.waitFor(() => expect(providers).toEqual(['claude-code']));
    await vi.waitFor(() => expect(pendingTexts(session.planState)).toEqual([]));
  });
});

describe('a restored message', () => {
  it('stays queued, with the /planner notice, when no coding agent is installed and no key is set, and goes with the next message', async () => {
    const config = keylessConfig();
    const { aiService } = recordingPlanner(config);
    const probe = heldProbe();
    const notices: string[] = [];
    const session = makeSession({ config, aiService, onNotice: (n) => notices.push(n.message) });

    session.loadPlan(savedPlan(['rename task 1']), 'build it', testWorkspace);
    probe.answer(false);
    await vi.waitFor(() => expect(notices.some((n) => n.includes('/planner'))).toBe(true));

    expect(aiService.continueConversation).not.toHaveBeenCalled();
    expect(pendingTexts(session.planState)).toEqual(['rename task 1']);
    expect(notices.join('\n')).toContain('rename task 1');

    recordInstalledPlanner('claude-code');
    await session.continueConversation('and add tests');
    expect(aiService.continueConversation).toHaveBeenCalledTimes(1);
    expect(aiService.continueConversation.mock.calls[0][0]).toMatch(/rename task 1[\s\S]*and add tests/);
    expect(pendingTexts(session.planState)).toEqual([]);
  });

  it('is never answered by a session closed while the probe was out', async () => {
    const config = keylessConfig();
    const { aiService } = recordingPlanner(config);
    const probe = heldProbe();
    const session = makeSession({ config, aiService });

    session.loadPlan(savedPlan(['rename task 1']), 'build it', testWorkspace);
    session.destroy();
    probe.answer(true);
    await settle();
    await settle();

    expect(aiService.continueConversation).not.toHaveBeenCalled();
  });
});

describe('a message sent while the probe is out', () => {
  const sends: [string, (session: ReturnType<typeof makeSession>) => Promise<LegacyPlanState>][] = [
    ['a reply', (s) => s.continueConversation('rename task 1')],
    ['a force send', (s) => s.forceSendPrompt('rename task 1')],
    ['a merge', (s) => s.requestMerge(['t1', 't2'])],
    ['a split', (s) => s.requestSplit('t1')],
  ];
  for (const [kind, send] of sends) {
    it(`waits for it, then is answered by the agent it finds: ${kind}`, async () => {
      const config = keylessConfig();
      const { aiService, providers } = recordingPlanner(config);
      const probe = heldProbe();
      const session = makeSession({ config, aiService });
      session.loadPlan(savedPlan(), 'build it', testWorkspace);

      const answered = send(session);
      await settle();
      expect(aiService.continueConversation).not.toHaveBeenCalled();
      expect(session.planState!.pendingTurns).toHaveLength(1);

      probe.answer(true);
      await answered;
      expect(providers).toEqual(['claude-code']);
    });
  }

  it('is dropped, unanswered, when its caller stops it before the probe answers', async () => {
    const config = keylessConfig();
    const { aiService } = recordingPlanner(config);
    const probe = heldProbe();
    const session = makeSession({ config, aiService });
    session.loadPlan(savedPlan(), 'build it', testWorkspace);
    const stop = new AbortController();

    const answered = session.continueConversation('rename task 1', { signal: stop.signal });
    stop.abort();
    probe.answer(true);

    await expect(answered).rejects.toBeInstanceOf(PlannerTurnStoppedError);
    expect(aiService.continueConversation).not.toHaveBeenCalled();
    expect(pendingTexts(session.planState)).toEqual([]);
  });

  it('a compaction waits for it, then summarises on the agent it finds', async () => {
    const config = keylessConfig();
    const { aiService, providers } = recordingPlanner(config);
    const probe = heldProbe();
    const session = makeSession({ config, aiService });
    session.loadPlan(savedPlan(), 'build it', testWorkspace);

    const compaction = session.compactConversation();
    await settle();
    expect(aiService.continueConversation).not.toHaveBeenCalled();

    probe.answer(true);
    await compaction;
    expect(providers).toEqual(['claude-code']);
  });
});

describe('after the selected vendor\'s key is taken away', () => {
  function keyedSession() {
    let key = 'sk-or';
    const config = fakeConfig({ aiProvider: 'openrouter', getProviderApiKey: () => key });
    const { aiService } = recordingPlanner(config);
    const notices: string[] = [];
    const session = makeSession({ config, aiService, onNotice: (n) => notices.push(n.message) });
    session.loadPlan(savedPlan(), 'build it', testWorkspace);
    key = '';
    return { session, aiService, notices };
  }

  const sends: [string, (session: ReturnType<typeof makeSession>) => Promise<unknown>][] = [
    ['a reply', (s) => s.continueConversation('rename task 1')],
    ['a force send', (s) => s.forceSendPrompt('rename task 1')],
    ['a merge', (s) => s.requestMerge(['t1', 't2'])],
    ['a split', (s) => s.requestSplit('t1')],
    ['a compaction', (s) => s.compactConversation()],
  ];
  for (const [kind, send] of sends) {
    it(`refuses ${kind} with the /planner reason before the vendor is called`, async () => {
      const { session, aiService } = keyedSession();

      const refusal = send(session);
      await expect(refusal).rejects.toBeInstanceOf(PlannerNotReadyError);
      await expect(refusal).rejects.toThrow(/\/planner/);

      expect(aiService.continueConversation).not.toHaveBeenCalled();
      // The caller holds its message; nothing of it is left to replay unasked.
      expect(pendingTexts(session.planState)).toEqual([]);
      expect(session.isPlannerBusy).toBe(false);
    });
  }
});
