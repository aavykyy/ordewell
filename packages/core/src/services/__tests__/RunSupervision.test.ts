import { afterEach, describe, expect, it, vi } from 'vitest';
import { createTask, type RunSettings, type Task } from '../../models/Task';
import type { ExecutionRecord } from '../../models/Execution';
import { RunSupervision, type RunSupervisionHost } from '../RunSupervision';
import { RUN_SETTINGS_DEFAULTS, type GlobalRunSettings } from '../SettingsService';
import type { SupervisorOptions } from '../Supervisor';

/** The ADR-0029 and ADR-0030 rules of one run's supervision, with no Session around it. */

const task = (id: string, order: number, over: Partial<Task> = {}): Task =>
  createTask({ id, order, title: `Task ${id}`, prompt: `do ${id}`, assignedRunner: 'claude-code', ...over });

const SUPERVISOR_RETRY: ExecutionRecord = { command: 'retry_task', actor: 'supervisor', level: 'act', outcome: 'done', task: { id: 't1', ref: '#1', title: 'Task t1' }, at: '2026-10-13T00:00:00Z' };

function harness(user: Partial<GlobalRunSettings> = {}, options: SupervisorOptions = {}) {
  const tasks = [task('t1', 1)];
  const plan: { runSettings?: RunSettings } = {};
  const settings: GlobalRunSettings = { ...RUN_SETTINGS_DEFAULTS, ...user };
  const transcript: { text: string; voice: 'system' | 'supervisor' }[] = [];
  const host = {
    plan: () => plan,
    userSettings: () => ({ ...settings }),
    tasks: () => tasks,
    checkpointQuestion: () => undefined,
    recentOutput: () => undefined,
    reportTail: () => undefined,
    reported: vi.fn(),
    systemNote: vi.fn((text: string) => { transcript.push({ text, voice: 'system' }); }),
    supervisorNote: vi.fn((text: string) => { transcript.push({ text, voice: 'supervisor' }); }),
    changed: vi.fn(),
    save: vi.fn(),
    notice: vi.fn(),
    resendHandoff: vi.fn(),
    deliver: vi.fn(async () => undefined),
    pump: vi.fn(),
    restartPlanner: vi.fn(),
    abandonTurn: vi.fn(),
  } satisfies RunSupervisionHost;
  const supervision = new RunSupervision(host, { debounceMs: 10, ...options });
  return { supervision, plan, settings, tasks, transcript, host };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('a run starting', () => {
  it('copies the user\'s settings when the user starts it', () => {
    const { supervision, plan } = harness({ supervisorLevel: 'act', mergeAtGatesAutomatically: true, supervisorRetryLimit: 4, wakeUpReadBudget: 7 });

    supervision.runStarted('user');

    expect(plan.runSettings).toEqual({ supervisorLevel: 'act', mergeAtGatesAutomatically: true, supervisorRetryLimit: 4, wakeUpReadBudget: 7 });
    expect(supervision.level).toBe('act');
  });

  it.each(['supervisor', 'limit-reset'] as const)('continues the last run when the %s opens it: its settings, and what the guards remember', (origin) => {
    const { supervision, plan, settings } = harness({ supervisorLevel: 'act' });
    supervision.runStarted('user');
    supervision.executed(SUPERVISOR_RETRY);
    Object.assign(settings, { supervisorLevel: 'watch', mergeAtGatesAutomatically: true });

    supervision.runStarted(origin);

    expect(plan.runSettings).toMatchObject({ supervisorLevel: 'act', mergeAtGatesAutomatically: false });
    expect(supervision.snapshot().guards?.retries).toEqual({ t1: 1 });
  });

  it('starts afresh when the user opens a run after the supervisor\'s, forgetting what the guards remember', () => {
    const { supervision, plan, settings } = harness({ supervisorLevel: 'act' });
    supervision.runStarted('user');
    supervision.executed(SUPERVISOR_RETRY);
    supervision.runStarted('supervisor');
    settings.supervisorRetryLimit = 5;

    supervision.runStarted('user');

    expect(plan.runSettings).toMatchObject({ supervisorLevel: 'act', supervisorRetryLimit: 5 });
    expect(supervision.snapshot().guards?.retries).toEqual({});
  });

  it('copies the user\'s settings for the first run, whoever opens it', () => {
    const { supervision, plan } = harness({ supervisorLevel: 'watch', wakeUpReadBudget: 3 });

    supervision.runStarted('limit-reset');

    expect(plan.runSettings).toMatchObject({ supervisorLevel: 'watch', wakeUpReadBudget: 3 });
  });
});

describe('the user\'s change', () => {
  it('applies to the run under way at once, saved, and to nothing once no run has started', () => {
    const idle = harness();
    idle.supervision.apply({ supervisorLevel: 'act', mergeAtGatesAutomatically: true });
    expect(idle.plan.runSettings).toBeUndefined();

    const { supervision, plan, host, transcript } = harness({ supervisorLevel: 'act' });
    supervision.runStarted('user');
    supervision.apply({ supervisorLevel: 'watch', mergeAtGatesAutomatically: true, supervisorRetryLimit: 0, wakeUpReadBudget: 30 });

    expect(plan.runSettings).toEqual({ supervisorLevel: 'watch', mergeAtGatesAutomatically: true, supervisorRetryLimit: 0, wakeUpReadBudget: 30 });
    expect(supervision.level).toBe('watch');
    expect(transcript).toEqual([{ text: 'You set the supervisor to Watch.', voice: 'system' }]);
    expect(host.save).toHaveBeenCalled();
  });

  it('holds the supervisor\'s next retry to the run\'s new retry limit, and never the user\'s', () => {
    const { supervision, tasks } = harness({ supervisorLevel: 'act' });
    supervision.runStarted('user');
    supervision.executed(SUPERVISOR_RETRY);
    const retry = { command: 'retry_task', task: 't1', from: 'fresh' } as const;
    const target = { task: tasks[0], ref: '#1' };
    expect(supervision.guard({ kind: 'supervisor', level: 'act' }, retry, target)).toBeNull();

    supervision.apply({ supervisorRetryLimit: 1 });

    expect(supervision.guard({ kind: 'supervisor', level: 'act' }, retry, target)?.refusal).toMatch(/^Refused by the retry limit/);
    expect(supervision.guard({ kind: 'user' }, retry, target)).toBeNull();
  });
});

describe('an automatic lowering', () => {
  it('drops a spinning Act supervisor to Watch, tells the user in its voice, and the user\'s command raises it again with the guards\' memory kept', async () => {
    vi.useFakeTimers();
    const { supervision, plan, host, transcript } = harness({ supervisorLevel: 'act' }, { wakeUpRate: { max: 1, windowMs: 60_000 } });
    supervision.runStarted('user');
    supervision.executed(SUPERVISOR_RETRY);

    for (let i = 0; i < 2; i++) {
      supervision.observe({ kind: 'waiting_input', taskId: 't1' });
      await vi.advanceTimersByTimeAsync(10);
    }

    expect(plan.runSettings!.supervisorLevel).toBe('watch');
    expect(transcript.at(-1)).toEqual({ voice: 'supervisor', text: expect.stringMatching(/^Loop guard, wake-up rate: I woke 2 times/) });
    expect(host.notice).toHaveBeenCalledWith('warn', expect.stringMatching(/^Loop guard, wake-up rate/));

    supervision.apply({ supervisorLevel: 'act' });

    expect(supervision.level).toBe('act');
    expect(supervision.snapshot().guards?.retries).toEqual({ t1: 1 });
  });

  it('leaves the run unsupervised when the supervisor fails twice, and the user\'s command brings it back', async () => {
    const { supervision, plan, host, transcript } = harness({ supervisorLevel: 'watch' });
    supervision.runStarted('user');
    const fail = () => supervision.wakeUp(async () => { throw new Error('planner exited'); });

    await expect(fail()).rejects.toThrow('planner exited');
    await expect(fail()).rejects.toThrow('planner exited');

    expect(plan.runSettings!.unsupervised).toMatch(/failed twice/);
    expect(supervision.level).toBe('off');
    expect(transcript.at(-1)).toEqual({ voice: 'system', text: expect.stringMatching(/^The supervisor stopped: its wake-up turn failed twice/) });
    expect(host.restartPlanner).toHaveBeenCalledTimes(2);

    supervision.apply({ supervisorLevel: 'watch' });

    expect(plan.runSettings!.unsupervised).toBeUndefined();
    expect(supervision.level).toBe('watch');
    expect(supervision.mayWake()).toBe(true);
  });
});

describe('the end-of-run handoff', () => {
  const handoff = { repos: [], landed: [] };

  it('goes to an Act supervisor first, and to the user again once the user lowers it', () => {
    const { supervision, host } = harness({ supervisorLevel: 'act' });
    supervision.runStarted('user');

    expect(supervision.handoff(handoff)).toEqual({ ...handoff, deferredTo: 'supervisor' });
    supervision.apply({ supervisorLevel: 'watch' });

    expect(host.resendHandoff).toHaveBeenCalledTimes(1);
  });

  it('goes straight to the user below Act, and is not sent twice', () => {
    const { supervision, host } = harness({ supervisorLevel: 'watch' });
    supervision.runStarted('user');

    expect(supervision.handoff(handoff)).toEqual(handoff);
    supervision.apply({ supervisorLevel: 'off' });

    expect(host.resendHandoff).not.toHaveBeenCalled();
  });
});
