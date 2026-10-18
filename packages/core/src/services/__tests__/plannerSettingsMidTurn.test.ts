import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ConversationTurn, IAiService } from '../AiService';
import type { IConfig } from '../../interfaces/IConfig';
import type { LegacyPlanState } from '../../models/Task';
import { makeSession, fakeConfig, testWorkspace } from './sessionTestKit';

/**
 * A backend whose reply the test hands back, and which, like a real one, cuts
 * the call in flight off when it is reset: the call comes back aborted.
 */
function heldService(provider: string) {
  const calls: { finish: (turn: ConversationTurn) => void }[] = [];
  let live = false;
  const cutOff: (() => void)[] = [];
  const take = () => new Promise<ConversationTurn>((resolve) => {
    live = true;
    calls.push({ finish: resolve });
    cutOff.push(() => resolve({ kind: 'message', text: 'Half an ans', researchLog: [], aborted: true }));
  });
  const service = {
    reset: vi.fn(() => {
      live = false;
      for (const cut of cutOff.splice(0)) cut();
    }),
    hasActiveConversation: () => live,
    startConversation: vi.fn(take),
    continueConversation: vi.fn(take),
  };
  return { service: service as unknown as IAiService & { reset: ReturnType<typeof vi.fn> }, calls, provider };
}

const created: ReturnType<typeof heldService>[] = [];

vi.mock('../AiService', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../AiService')>();
  return {
    ...actual,
    createAiService: vi.fn((config: IConfig) => {
      const made = heldService(config.aiProvider);
      created.push(made);
      return made.service;
    }),
  };
});

function dialoguePlan(): LegacyPlanState {
  return {
    tasks: [],
    generatedAt: '2026-01-01T00:00:00Z',
    status: 'draft',
    runners: ['claude-code'],
    lastUpdated: '2026-01-01T00:00:00Z',
    conversationHistory: [
      { role: 'user', content: 'build me a parser', timestamp: '2026-01-01T00:00:00Z' },
      { role: 'assistant', content: 'Which file formats?', timestamp: '2026-01-01T00:00:01Z' },
    ],
    researchLog: [],
  };
}

const contents = (plan: LegacyPlanState | null) => (plan?.conversationHistory ?? []).map((m) => m.content);

describe('a planner switch during a planner turn', () => {
  beforeEach(() => { created.length = 0; });

  it('waits for the turn to end before the old backend is let go, so the turn still lands', async () => {
    const config = fakeConfig({ aiProvider: 'claude-code' });
    const session = makeSession({ config });
    session.loadPlan(dialoguePlan(), 'build me a parser', testWorkspace, { persist: false });

    const reply = session.continueConversation('JSON and YAML');
    await vi.waitFor(() => expect(created[0]?.calls).toHaveLength(1));
    // Loading the plan and replaying it into the call reset the backend; what follows must not.
    created[0].service.reset.mockClear();
    // The TUI's /planner, or the daemon's settings route, switches the provider under the turn; any read of the backend follows.
    (config as { aiProvider: IConfig['aiProvider'] }).aiProvider = 'opencode';
    void session.isConversationActive;

    expect(created[0].service.reset).not.toHaveBeenCalled();
    created[0].calls[0].finish({ kind: 'message', text: 'Both, then.', researchLog: [] });
    await reply;

    expect(contents(session.planState).slice(-2)).toEqual(['JSON and YAML', 'Both, then.']);
    // Once the turn is over the switch is made, and the old backend released.
    void session.isConversationActive;
    expect(created.map((c) => c.provider)).toEqual(['claude-code', 'opencode']);
    expect(created[0].service.reset).toHaveBeenCalled();
  });
});

describe('a planner switch between planner turns', () => {
  beforeEach(() => { created.length = 0; });

  it('serves the next turn on the new backend, though nothing read the backend in between', async () => {
    const config = fakeConfig({ aiProvider: 'claude-code' });
    const session = makeSession({ config });
    session.loadPlan(dialoguePlan(), 'build me a parser', testWorkspace, { persist: false });

    (config as { aiProvider: IConfig['aiProvider'] }).aiProvider = 'opencode';
    const reply = session.continueConversation('JSON and YAML');
    await vi.waitFor(() => expect(created.at(-1)?.calls).toHaveLength(1));
    created.at(-1)!.calls[0].finish({ kind: 'message', text: 'Both, then.', researchLog: [] });
    await reply;

    expect(created.at(-1)?.provider).toBe('opencode');
    expect(created.filter((c) => c.calls.length > 0).map((c) => c.provider)).toEqual(['opencode']);
  });
});

describe('a planner settings change during a planner turn', () => {
  beforeEach(() => { created.length = 0; });

  it('resets the backend built for the provider once the turn has ended, and keeps it', async () => {
    const session = makeSession({ config: fakeConfig({ aiProvider: 'claude-code' }) });
    session.loadPlan(dialoguePlan(), 'build me a parser', testWorkspace, { persist: false });

    const reply = session.continueConversation('JSON and YAML');
    await vi.waitFor(() => expect(created[0]?.calls).toHaveLength(1));
    created[0].service.reset.mockClear();
    session.plannerSettingsChanged();

    expect(created[0].service.reset).not.toHaveBeenCalled();
    created[0].calls[0].finish({ kind: 'message', text: 'Both, then.', researchLog: [] });
    await reply;

    expect(created[0].service.reset).toHaveBeenCalledTimes(1);
    void session.isConversationActive;
    expect(created).toHaveLength(1);
  });

  it('drops the backend only once the turn has ended, so the turn still lands', async () => {
    const { service, calls } = heldService('claude-code');
    const session = makeSession({ aiService: service });
    session.loadPlan(dialoguePlan(), 'build me a parser', testWorkspace, { persist: false });

    const reply = session.continueConversation('JSON and YAML');
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    service.reset.mockClear();
    // VS Code, on any ordewell.* setting: a planner, model or effort picked.
    session.plannerSettingsChanged();

    expect(service.reset).not.toHaveBeenCalled();
    calls[0].finish({ kind: 'message', text: 'Both, then.', researchLog: [] });
    await reply;

    expect(contents(session.planState).slice(-2)).toEqual(['JSON and YAML', 'Both, then.']);
    expect(service.reset).toHaveBeenCalledTimes(1);
  });

  it('drops the backend at once when no turn is running', () => {
    const { service } = heldService('claude-code');
    const session = makeSession({ aiService: service });
    session.loadPlan(dialoguePlan(), 'build me a parser', testWorkspace, { persist: false });
    service.reset.mockClear();

    session.plannerSettingsChanged();

    expect(service.reset).toHaveBeenCalledTimes(1);
  });
});
