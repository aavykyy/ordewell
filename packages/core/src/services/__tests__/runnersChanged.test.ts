import { describe, it, expect, vi } from 'vitest';
import type { DiscoveredModel, LegacyPlanState, RunnerId, Task } from '../../models/Task';
import { RUN_SETTINGS_DEFAULTS } from '../SettingsService';
import { runnersChangedBlock } from '../RunnerChange';
import { makeSession, testWorkspace } from './sessionTestKit';

function models(...ids: string[]): DiscoveredModel[] {
  return ids.map((modelId) => ({ modelId, modelLabel: modelId, variants: [] }));
}

function aiTask(over: Partial<Task>): Task {
  return {
    id: 't1', order: 1, title: 'Write the thing', description: 'd', prompt: 'p', type: 'ai', status: 'pending',
    dependencies: [], assignedRunner: 'claude-code', ...over,
  } as Task;
}

function planWith(tasks: Task[], runners: RunnerId[] = ['claude-code']): LegacyPlanState {
  const now = new Date().toISOString();
  return { tasks, generatedAt: now, status: 'draft', runners, lastUpdated: now };
}

/** A session whose enabled runners and allowlist the test moves between turns, as the user's settings do. */
function harness(options: { tools?: boolean } = {}) {
  const settings: { enabledRunners: RunnerId[]; modelAllowlist: Record<string, string[]> } = {
    enabledRunners: ['claude-code', 'codex'],
    modelAllowlist: {},
  };
  const continueConversation = vi.fn().mockResolvedValue({ kind: 'message', text: 'ok', researchLog: [] });
  const session = makeSession({
    aiService: {
      continueConversation,
      hasActiveConversation: () => true,
      startConversation: vi.fn().mockResolvedValue({ kind: 'message', text: 'hi', researchLog: [] }),
      ...(options.tools ? { plannerToolsAttached: () => true } : {}),
    },
    modelResolver: {
      modelsForRunners: vi.fn().mockResolvedValue({
        'claude-code': models('claude-opus-4', 'claude-sonnet-4'),
        codex: models('gpt-5', 'gpt-5-mini'),
      }),
    },
    settings: () => ({ ...settings, run: { ...RUN_SETTINGS_DEFAULTS, supervisorLevel: 'off' } }),
  });
  const outgoing = (call: number) => String(continueConversation.mock.calls[call][0]);
  return { session, settings, outgoing, continueConversation };
}

/**
 * The plan adopted, and one turn landed on it: what the planner is told of the
 * runners belongs to the session it was told in, so a change is measured from there.
 */
async function adopted(session: ReturnType<typeof makeSession>, plan: LegacyPlanState): Promise<void> {
  session.loadPlan(plan, 'goal', testWorkspace, { persist: false });
  await session.continueConversation('first');
}

describe('runners changed — the planner is told on its next turn', () => {
  it('names a runner switched off and the plan tasks still assigned to it', async () => {
    const { session, settings, outgoing } = harness();
    await adopted(session, planWith([aiTask({ assignedRunner: 'codex', assignedModel: { modelId: 'gpt-5', modelLabel: 'gpt-5' } })], ['claude-code', 'codex']));

    settings.enabledRunners = ['claude-code'];
    await session.continueConversation('go on');

    expect(outgoing(1)).toContain('<runners_changed>');
    expect(outgoing(1)).toMatch(/switched off: codex/i);
    expect(outgoing(1)).toContain('#1 "Write the thing" (codex is switched off)');
  });

  it('sends nothing on a turn where nothing changed, and nothing again after it has told', async () => {
    const { session, settings, outgoing } = harness();
    await session.startPlanning('goal', ['claude-code', 'codex']);

    await session.continueConversation('first');
    settings.enabledRunners = ['claude-code'];
    await session.continueConversation('second');
    await session.continueConversation('third');

    expect(outgoing(0)).not.toContain('<runners_changed>');
    expect(outgoing(1)).toContain('<runners_changed>');
    expect(outgoing(2)).not.toContain('<runners_changed>');
  });

  it('tells again on the next turn when the turn it first went with failed', async () => {
    const { session, settings, outgoing, continueConversation } = harness();
    await session.startPlanning('goal', ['claude-code', 'codex']);

    settings.enabledRunners = ['claude-code'];
    continueConversation.mockRejectedValueOnce(new Error('backend down'));
    await expect(session.continueConversation('first')).rejects.toThrow('backend down');
    await session.continueConversation('second');

    expect(outgoing(0)).toContain('<runners_changed>');
    expect(outgoing(1)).toContain('<runners_changed>');
    expect(outgoing(1)).toMatch(/switched off: codex/i);
  });

  it('tells again on the next turn when the turn it first went with came back failed', async () => {
    const { session, settings, outgoing, continueConversation } = harness();
    await session.startPlanning('goal', ['claude-code', 'codex']);

    settings.enabledRunners = ['claude-code'];
    continueConversation.mockResolvedValueOnce({ kind: 'message', failed: true, text: 'backend failed before processing the input', researchLog: [] });
    await session.continueConversation('first');
    await session.continueConversation('second');

    expect(outgoing(0)).toContain('<runners_changed>');
    expect(outgoing(1)).toContain('<runners_changed>');
    expect(outgoing(1)).toMatch(/switched off: codex/i);
  });

  it('tells the first turn after another session is adopted nothing of the session before', async () => {
    const settings: { enabledRunners: RunnerId[]; modelAllowlist: Record<string, string[]> } = { enabledRunners: ['claude-code', 'codex'], modelAllowlist: {} };
    // A backend whose reset drops its live context, as every real one does.
    let live = false;
    const startConversation = vi.fn(async (_request: { initialMessage?: string }) => {
      live = true;
      return { kind: 'message' as const, text: 'hi', researchLog: [] };
    });
    const session = makeSession({
      aiService: {
        startConversation,
        continueConversation: vi.fn().mockResolvedValue({ kind: 'message', text: 'ok', researchLog: [] }),
        hasActiveConversation: () => live,
        reset: vi.fn(() => { live = false; }),
      },
      settings: () => ({ ...settings, run: { ...RUN_SETTINGS_DEFAULTS, supervisorLevel: 'off' } }),
    });
    await session.startPlanning('goal', ['claude-code', 'codex']);

    settings.enabledRunners = ['claude-code'];
    session.loadPlan(planWith([aiTask({})]), 'another goal', testWorkspace, { persist: false });
    await session.continueConversation('go on');

    // Replayed from its own transcript, under an opening that states the runners as they are now.
    expect(startConversation.mock.calls.at(-1)?.[0].initialMessage).not.toContain('<runners_changed>');
  });

  it('says what each flagged task will do by where it stands, not that a failed one still runs', () => {
    const change = { switchedOn: [], switchedOff: ['codex'], allowlists: [] };
    const text = 'codex is switched off';
    const block = runnersChangedBlock(change, [
      { ref: '#1', title: 'Waiting', text, status: 'pending' },
      { ref: '#2', title: 'Broke', text, status: 'failed' },
      { ref: '#3', title: 'Going', text, status: 'in_progress' },
    ], false);
    const lines = block.split('\n');

    expect(lines.find((l) => l.includes('"Waiting"'))).toContain('runs as assigned unless moved');
    expect(lines.find((l) => l.includes('"Broke"'))).toContain('failed; a retry would run it there unless moved');
    expect(lines.find((l) => l.includes('"Going"'))).toContain('already running as assigned');
    expect(block).not.toMatch(/still run/);
  });

  it('does not call a task running whose attempt has ended, as one paused on a usage limit', async () => {
    const { session, settings, outgoing } = harness();
    await adopted(session, planWith([
      aiTask({ id: 't1', title: 'Resumes', assignedRunner: 'codex', status: 'awaiting_user', awaitingReason: 'usage-limit', resumeAt: '2099-01-01T00:00:00.000Z' }),
      aiTask({ id: 't2', title: 'Waits', assignedRunner: 'codex', status: 'awaiting_user', awaitingReason: 'usage-limit' }),
      aiTask({ id: 't3', title: 'Asks', assignedRunner: 'codex', status: 'awaiting_user', awaitingReason: 'checkpoint' }),
      aiTask({ id: 't4', title: 'Clashed', assignedRunner: 'codex', status: 'awaiting_user', awaitingReason: 'conflict' }),
    ], ['claude-code', 'codex']));

    settings.enabledRunners = ['claude-code'];
    await session.continueConversation('go on');
    const lines = outgoing(1).split('\n').filter((l) => l.startsWith('- '));

    expect(lines.find((l) => l.includes('"Resumes"'))).toContain('paused on a usage limit; a retry would run it there unless moved');
    expect(lines.find((l) => l.includes('"Waits"'))).toContain('paused on a usage limit; a retry would run it there unless moved');
    expect(lines.find((l) => l.includes('"Asks"'))).toContain('already running as assigned');
    expect(lines.find((l) => l.includes('"Clashed"'))).toContain('waiting for the user; what runs next runs there unless moved');
  });

  it('reads an allowlist as the catalog does: ids only another runner offers limit nothing', async () => {
    const { session, settings, outgoing } = harness();
    // The opening discovers the catalog the allowlist is read against.
    await session.startPlanning('goal', ['claude-code', 'codex']);
    await adopted(session, planWith([aiTask({ assignedModel: { modelId: 'claude-opus-4', modelLabel: 'Opus 4' } })], ['claude-code', 'codex']));

    settings.modelAllowlist = { 'claude-code': ['gpt-5'] };
    await session.continueConversation('go on');

    expect(outgoing(1)).not.toContain('<runners_changed>');
    expect(outgoing(0)).toMatch(/^claude-code: .*claude-opus-4/m);
    // A catalog block goes again only when it changed (ADR-0012 T10): the allowlist took nothing out.
    expect(outgoing(1)).not.toContain('<available_models>');
  });

  it('names a runner switched on', async () => {
    const { session, settings, outgoing } = harness();
    settings.enabledRunners = ['claude-code'];
    await session.startPlanning('goal', ['claude-code']);

    settings.enabledRunners = ['claude-code', 'codex'];
    await session.continueConversation('go on');

    expect(outgoing(0)).toMatch(/switched on: codex/i);
    expect(outgoing(0)).not.toContain('These tasks are now outside');
  });

  it('names an allowlist narrowed, and the task left on a model off it', async () => {
    const { session, settings, outgoing } = harness();
    await adopted(session, planWith([aiTask({ assignedModel: { modelId: 'claude-opus-4', modelLabel: 'Opus 4' } })]));

    settings.modelAllowlist = { 'claude-code': ['claude-sonnet-4'] };
    await session.continueConversation('go on');

    expect(outgoing(1)).toContain('claude-code is now limited to: claude-sonnet-4');
    expect(outgoing(1)).toContain('#1 "Write the thing" (Opus 4 is not in the allowlist)');
  });

  it('says what an edit of the allowlist added and removed', async () => {
    const { session, settings, outgoing } = harness();
    settings.modelAllowlist = { 'claude-code': ['claude-sonnet-4', 'claude-opus-4'] };
    await session.startPlanning('goal', ['claude-code']);

    settings.modelAllowlist = { 'claude-code': ['claude-sonnet-4', 'claude-haiku-4'] };
    await session.continueConversation('go on');

    expect(outgoing(0)).toContain('claude-code models: now allowed claude-haiku-4; no longer allowed claude-opus-4.');
  });

  it('does not list a finished task, only those that could still be moved', async () => {
    const { session, settings, outgoing } = harness();
    await adopted(session, planWith([aiTask({ status: 'completed', assignedRunner: 'codex' })], ['claude-code', 'codex']));

    settings.enabledRunners = ['claude-code'];
    await session.continueConversation('go on');

    expect(outgoing(1)).toContain('<runners_changed>');
    expect(outgoing(1)).not.toContain('Write the thing" (codex');
  });

  it('tells a planner that reads its catalog through tools too, pointing it at the tools', async () => {
    const { session, settings, outgoing } = harness({ tools: true });
    await session.startPlanning('goal', ['claude-code', 'codex']);

    settings.enabledRunners = ['claude-code'];
    await session.continueConversation('go on');

    expect(outgoing(0)).toContain('<runners_changed>');
    expect(outgoing(0)).toContain('list_runners');
  });
});

describe('the API planner\'s <available_models>', () => {
  const block = (text: string) => text.slice(text.indexOf('<available_models>'), text.indexOf('</available_models>'));

  it('lists every enabled runner, not just the plan\'s, and none switched off', async () => {
    const { session, settings, outgoing } = harness();
    settings.enabledRunners = ['claude-code', 'codex'];
    await session.startPlanning('goal', ['claude-code']);
    session.loadPlan(planWith([]), 'goal', testWorkspace, { persist: false });

    await session.continueConversation('go on');
    expect(block(outgoing(0))).toMatch(/^codex: gpt-5, gpt-5-mini$/m);

    settings.enabledRunners = ['claude-code'];
    await session.continueConversation('again');
    expect(block(outgoing(1))).not.toMatch(/^codex:/m);
    expect(block(outgoing(1))).toMatch(/^claude-code:/m);
  });
});
