import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTask, type LegacyPlanState } from '../../models/Task';
import type { ConversationTurn, IAiService, TurnRun } from '../AiService';
import { AUTORUN_OFF } from '../PlanPrompts';
import { RUN_SETTINGS_DEFAULTS, type GlobalRunSettings } from '../SettingsService';
import { PlannerConversation, type PlannerConversationHost } from '../PlannerConversation';
import { fakePlanChanges, passed } from './planChangesTestKit';
import type { IConfig } from '../../interfaces/IConfig';
import type { SessionMessage } from '../SessionMessage';
import { HUNG_TURN_GRACE_MS, WAKE_UP_TURN_TIMEOUT_MS } from '../Supervisor';
import { fakeConfig, makeSession, testWorkspace } from './sessionTestKit';
import { ctx, heldPlanner, plan, prose, settled, task, until, wokenUp } from './supervisorTestKit';

beforeEach(() => {
  vi.useFakeTimers({ now: new Date('2026-10-11T18:00:00Z'), toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
});

afterEach(() => {
  vi.useRealTimers();
});

/**
 * Adversarial checks on planner turns after the held-writes, briefing and
 * backend changes (tasks 14-15): a turn writes nothing until it lands, a
 * settings change never discards one, and everything a hung turn left behind
 * belongs to that turn alone.
 */

// ---------------------------------------------------------------------------
// Backend: a service the test answers by hand, made per configured provider.
// ---------------------------------------------------------------------------

interface HeldProviderService {
  provider: string;
  service: IAiService & { reset: ReturnType<typeof vi.fn> };
  calls: { finish: (turn: ConversationTurn) => void; fail: (err: Error) => void }[];
}

const created: HeldProviderService[] = [];

vi.mock('../AiService', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../AiService')>();
  return {
    ...actual,
    createAiService: vi.fn((config: IConfig) => {
      const calls: HeldProviderService['calls'] = [];
      const service = {
        reset: vi.fn(),
        hasActiveConversation: () => false,
        startConversation: vi.fn(() => new Promise<ConversationTurn>((resolve, reject) => { calls.push({ finish: resolve, fail: reject }); })),
        continueConversation: vi.fn(() => new Promise<ConversationTurn>((resolve, reject) => { calls.push({ finish: resolve, fail: reject }); })),
      } as unknown as HeldProviderService['service'];
      created.push({ provider: config.aiProvider, service, calls });
      return service;
    }),
  };
});

// ---------------------------------------------------------------------------
// PlannerConversation direct: a host whose mutation ritual is just a persist.
// ---------------------------------------------------------------------------

function dialoguePlan(): LegacyPlanState {
  return {
    tasks: [],
    generatedAt: '2026-10-18T00:00:00Z',
    status: 'draft',
    runners: ['claude-code'],
    lastUpdated: '2026-10-18T00:00:00Z',
    conversationHistory: [
      { role: 'user', content: 'build me a parser', timestamp: '2026-10-18T00:00:00Z' },
      { role: 'assistant', content: 'Which file formats?', timestamp: '2026-10-18T00:00:01Z' },
    ],
    researchLog: [],
  };
}

function fakeAi(turn: ConversationTurn): IAiService {
  return {
    startConversation: vi.fn().mockResolvedValue(turn),
    continueConversation: vi.fn().mockResolvedValue(turn),
    hasActiveConversation: () => true,
    reset: vi.fn(),
    plannerToolsAttached: () => false,
  } as unknown as IAiService;
}

function conversationHost(ai: IAiService, planState: LegacyPlanState | null = dialoguePlan()) {
  const state = { plan: planState, persists: 0 };
  const checks = fakePlanChanges({ tasks: () => state.plan?.tasks ?? [], runners: () => ['claude-code'], catalog: () => ({ modelsByRunner: {} }) });
  // An edit passes as it stands; a plan meets the real rules.
  checks.rules.mockImplementation((change, phase) => (change.kind === 'ops' ? passed({ tasks: [...state.plan?.tasks ?? []], summary: ['updated'] }) : checks.real(change, phase)));
  const host: PlannerConversationHost = {
    plan: () => state.plan,
    goal: () => 'build me a parser',
    aiService: () => ai,
    onProgress: vi.fn(),
    opening: vi.fn().mockResolvedValue({ runners: ['claude-code'], modelsByRunner: {}, fs: {} }),
    catalog: () => ({ runners: ['claude-code'], models: {}, modes: {}, autonomousDefault: true }),
    assignmentScope: () => ({ enabledRunners: ['claude-code'], allowlist: {} }),
    autorun: () => false,
    tasks: () => state.plan?.tasks ?? [],
    startWaits: () => [],
    liveOutput: () => null,
    isExecuting: () => false,
    mutate: (op, notify) => {
      if (!state.plan || !op()) return null;
      state.persists++;
      notify?.();
      return state.plan;
    },
    broadcast: vi.fn(),
    broadcastPlan: vi.fn(),
    planChanges: checks.planChanges,
    notice: vi.fn(),
    usageLimit: vi.fn((said) => ({ text: said.message, resendAt: null })),
    contextPaused: vi.fn((details) => ({ ...details, at: new Date().toISOString(), inputs: [] })),
    adoptTasks: vi.fn((tasks) => tasks.length),
    capturePrd: vi.fn(),
    turnAborted: vi.fn(),
  };
  return { conversation: new PlannerConversation(host), host, state };
}

const runs: TurnRun[] = [{ segmentId: 'seg-1', text: 'Here it is.', startedAt: '2026-10-18T00:00:03Z', narration: true }];

describe('runs on a reply that lands as a plan or an edit', () => {
  it('saves a plan turn\'s runs on the message the plan came with', async () => {
    const { conversation, state } = conversationHost(fakeAi({
      kind: 'plan', tasks: [createTask({ id: 't1', order: 1, title: 'A', prompt: 'a' })], text: 'Here it is.', runs, researchLog: [],
    }));

    await conversation.reply('plan it');

    expect(state.plan!.conversationHistory!.find((m) => m.content === 'Here it is.')?.runs?.map((r) => r.segmentId)).toEqual(['seg-1']);
    expect(state.plan!.conversationHistory!.at(-1)).toMatchObject({ kind: 'plan_generated' });
  });

  it('saves an edit turn\'s runs on the message the edit came with', async () => {
    const { conversation, state } = conversationHost(
      fakeAi({ kind: 'task_ops', ops: [{ op: 'add', task: { title: 'Docs', prompt: 'write docs' } }], text: '{"taskOps":[]}', runs, researchLog: [] }),
      { ...dialoguePlan(), tasks: [createTask({ id: 't1', order: 1, title: 'A', prompt: 'a', assignedRunner: 'claude-code' })] },
    );

    await conversation.reply('add docs');

    expect(state.plan!.conversationHistory!.find((m) => m.content === 'Here it is.')?.runs?.map((r) => r.segmentId)).toEqual(['seg-1']);
    expect(state.plan!.conversationHistory!.at(-1)?.content).toMatch(/^Tasks updated:/);
  });
});

describe('a save that lands while a planner turn runs', () => {
  it('lands the turn\'s message where it was held, ahead of the save, and the plan last', async () => {
    let during: (() => void) | null = null;
    const turn: ConversationTurn = {
      kind: 'plan', tasks: [createTask({ id: 't1', order: 1, title: 'A', prompt: 'a' })], text: 'Here it is.', runs, researchLog: [],
    };
    const ai = fakeAi(turn);
    const made = conversationHost(ai);
    const { conversation, host, state } = made;
    (ai.continueConversation as ReturnType<typeof vi.fn>).mockImplementation(async () => {
      during?.();
      return turn;
    });
    // A call at the seam saved while the turn runs: written at once, never held.
    during = () => {
      host.mutate(() => {
        conversation.recordExecution({ command: 'run_task', actor: 'user', outcome: 'done', at: '2026-10-18T00:00:02Z' }, 'Started task 1.');
        return true;
      });
    };

    await conversation.reply('plan it');

    expect(state.plan!.conversationHistory!.map((m) => m.kind ?? m.content)).toEqual([
      'build me a parser', 'Which file formats?', 'plan it', 'execution', 'Here it is.', 'plan_generated',
    ]);
    expect(state.plan!.researchLog!.map((e) => ('content' in e ? e.content : e.id))).toEqual(['plan it']);
  });
});

// ---------------------------------------------------------------------------
// A settings change during a wake-up turn.
// ---------------------------------------------------------------------------

describe('a settings change during a wake-up turn', () => {
  it('keeps the wake-up digest and its pending input, landing the turn once', async () => {
    const env = await wokenUp();

    env.session.plannerSettingsChanged();
    env.planner.calls[0].finish(prose('Task 1 needs an answer.'));
    await settled();

    const history = env.session.planState!.conversationHistory!;
    expect(history.filter((e) => e.kind === 'wake_up')).toHaveLength(1);
    expect(env.session.planState!.pendingTurns).toEqual([]);
    expect(history.at(-1)).toMatchObject({ kind: 'supervisor', content: 'Task 1 needs an answer.' });
  });

  it('tells a stopped turn\'s autorun change again on the next turn', async () => {
    const settings: GlobalRunSettings = { ...RUN_SETTINGS_DEFAULTS, supervisorLevel: 'off', autorun: true };
    const planner = heldPlanner();
    const session = makeSession({ aiService: planner.aiService, settings: () => ({ run: { ...settings } }) });
    session.loadPlan(plan([task('t1', 1)]), 'build it', testWorkspace, { persist: false });

    const first = session.continueConversation('do it');
    await until(() => planner.calls.length === 1);
    // The user turns autorun off while the turn runs, then stops the turn: it
    // never answered, so the next turn must say so again.
    settings.autorun = false;
    session.applyRunSettings({ autorun: false });
    session.abortPlannerTurn();
    await first;

    void session.continueConversation('go on');
    await until(() => planner.calls.length === 2);

    expect(planner.calls[0].message).not.toContain(AUTORUN_OFF);
    expect(planner.calls[1].message).toContain(AUTORUN_OFF);
  });
});

// ---------------------------------------------------------------------------
// A provider switch during a turn that then fails.
// ---------------------------------------------------------------------------

describe('a provider switch while a planner turn runs', () => {
  beforeEach(() => { created.length = 0; });

  it('serves the next turn on the new provider when the running turn fails', async () => {
    const config = fakeConfig({ aiProvider: 'claude-code' });
    const session = makeSession({ config });
    session.loadPlan(dialoguePlan(), 'build me a parser', testWorkspace, { persist: false });

    const failed = session.continueConversation('JSON and YAML');
    await until(() => created[0]?.calls.length === 1);
    // The daemon's settings route switches the provider under the turn.
    (config as { aiProvider: IConfig['aiProvider'] }).aiProvider = 'opencode';
    created[0].calls[0].fail(new Error('backend down'));
    await expect(failed).rejects.toThrow('backend down');

    void session.continueConversation('JSON, then');
    await until(() => created.at(-1)?.calls.length === 1);

    expect(created.at(-1)?.provider).toBe('opencode');
    expect(created[0].service.reset).toHaveBeenCalled();
    created.at(-1)!.calls[0].finish(prose('Both, then.'));
    await settled();
    expect(session.planState!.conversationHistory!.at(-1)).toMatchObject({ content: 'Both, then.' });
  });
});

// ---------------------------------------------------------------------------
// A hung wake-up turn and the retry that follows it.
// ---------------------------------------------------------------------------

const turnStarts = (messages: ReadonlyArray<SessionMessage>) =>
  messages.flatMap((m) => (m.type === 'planner_turn_started' ? [m] : []));

describe('a hung wake-up turn whose retry follows it', () => {
  it('is not retried once it committed an edit, and takes back nothing of it when it settles late', async () => {
    // One task, waiting: a second, running silent past the timeout, would go quiet and wake it again.
    const env = await wokenUp({ settings: { supervisorLevel: 'act' }, config: { autonomousMode: true } }, [task('t1', 1)]);
    env.planner.state.ignoresStop = true;
    const tools = env.planner.tools();

    // The turn commits an edit through its tool as the call answers (ADR-0022 P2), and its wake-up goes with it.
    const first = await tools.editPlan!({ ops: [{ op: 'add', task: { title: 'A', prompt: 'a' } }] }, ctx);
    expect(first.isError).toBeFalsy();
    expect(env.session.planState!.pendingTurns ?? []).toEqual([]);

    await vi.advanceTimersByTimeAsync(WAKE_UP_TURN_TIMEOUT_MS);
    await settled();
    await vi.advanceTimersByTimeAsync(HUNG_TURN_GRACE_MS);
    await settled();

    // A retry on the same wake-up could make the change again.
    expect(env.planner.calls).toHaveLength(1);
    env.planner.calls[0].finish(prose('Still looking at task 1.'));
    await settled();

    expect(env.session.planTasks.map((t) => t.title)).toContain('A');
    expect(env.session.planState!.conversationHistory!.map((e) => e.content)).not.toContain('Still looking at task 1.');
  });
});

// ---------------------------------------------------------------------------
// The grace timer of a hung turn when the plan scope ends first.
// ---------------------------------------------------------------------------

describe('a hung wake-up turn whose grace fires after the plan scope has moved on', () => {
  it('does not abandon the next plan\'s opening turn', async () => {
    const env = await wokenUp();
    env.planner.state.ignoresStop = true;

    // The wake-up passes its time and is stopped; it ignores the stop, so the
    // supervisor is still waiting out its grace.
    await vi.advanceTimersByTimeAsync(WAKE_UP_TURN_TIMEOUT_MS);
    await settled();
    expect(env.planner.calls).toHaveLength(1);

    // Meanwhile the user starts a new goal, as a host's "new session" does.
    const started = env.session.startPlanning('a different goal', ['claude-code']);
    await until(() => env.planner.calls.length === 2);
    const openingTurn = turnStarts(env.messages).at(-1)!.turnId as string;

    // The old turn's grace expires now, while the new opening holds the conversation.
    await vi.advanceTimersByTimeAsync(HUNG_TURN_GRACE_MS);
    await settled();

    expect(env.messages.filter((m) => m.type === 'planner_turn_ended' && m.turnId === openingTurn)).toEqual([]);
    expect(env.session.isPlannerBusy).toBe(true);

    env.planner.calls[1].finish(prose('Here is the new plan.'));
    await expect(started).resolves.toBeDefined();
    expect(env.session.planState!.conversationHistory!.at(-1)).toMatchObject({ content: 'Here is the new plan.' });
  });

  it('does not abandon the turn of an adopted session', async () => {
    const env = await wokenUp();
    env.planner.state.ignoresStop = true;
    await vi.advanceTimersByTimeAsync(WAKE_UP_TURN_TIMEOUT_MS);
    await settled();

    // Another session is adopted while the old turn is still out there.
    env.session.loadPlan(plan([task('t9', 9)]), 'another session', testWorkspace, { persist: false });
    const next = env.session.continueConversation('hello there');
    await until(() => env.planner.calls.length === 2);
    const turnId = turnStarts(env.messages).at(-1)!.turnId as string;

    // The old turn's grace expires now, while the adopted session's turn waits.
    await vi.advanceTimersByTimeAsync(HUNG_TURN_GRACE_MS);
    await settled();

    expect(env.messages.filter((m) => m.type === 'planner_turn_ended' && m.turnId === turnId)).toEqual([]);
    env.planner.calls[1].finish(prose('hello back'));
    await expect(next).resolves.toBeDefined();
  });
});
