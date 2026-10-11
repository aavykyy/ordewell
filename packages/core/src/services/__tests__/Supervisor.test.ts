import { describe, expect, it, vi } from 'vitest';
import { Supervisor, wakeUpDigest, type RunEventInput, type SupervisedRun, type SupervisorHost } from '../Supervisor';
import type { RunEvent } from '../WakePolicy';

const describeTask = (taskId: string) => `#${taskId.slice(1)} "Task ${taskId}"`;

describe('wakeUpDigest', () => {
  it('names each event with its task and a short detail, never a log, then the passes since the last update', () => {
    const attention: RunEvent[] = [
      { kind: 'task_failed', taskId: 't1', at: 0, detail: 'The runner reported failure:\n  the tests fail' },
      { kind: 'waiting_input', taskId: 't2', at: 0, detail: 'Which database?' },
      { kind: 'waiting_approval', taskId: 't3', at: 0, detail: 'Bash(npm publish)' },
      { kind: 'task_idle', taskId: 't4', at: 0, detail: 'no output since 2026-10-11T18:05:00.000Z' },
      { kind: 'landing_conflict', taskId: 't5', at: 0 },
      { kind: 'auto_merge_stopped', taskId: 't6', at: 0, detail: 'it conflicts in .: a.ts' },
      { kind: 'usage_limit', taskId: 't7', taskIds: ['t7', 't8'], at: 0, runner: 'codex', resumeAt: null },
      { kind: 'run_finished', at: 0, detail: '5 of 8 tasks completed, 1 failed' },
    ];

    expect(wakeUpDigest({ attention, sinceLast: [{ kind: 'task_passed', taskId: 't9', at: 0 }] }, describeTask)).toBe([
      'Run update:',
      '- task #1 "Task t1" failed: The runner reported failure: the tests fail',
      '- task #2 "Task t2" is waiting for input: Which database?',
      '- task #3 "Task t3" is waiting for approval: Bash(npm publish)',
      '- task #4 "Task t4" has gone quiet (no output since 2026-10-11T18:05:00.000Z)',
      '- task #5 "Task t5" finished, but its work conflicts and could not land',
      '- automatic Merge all at the merge gate of task #6 "Task t6" stopped: it conflicts in .: a.ts; the gate waits for the user',
      '- tasks #7 "Task t7" and #8 "Task t8" paused on codex\'s usage limit; they wait for a retry, as the reset time could not be read',
      '- the run finished: 5 of 8 tasks completed, 1 failed',
      'Since the last update: task #9 "Task t9" passed.',
    ].join('\n'));
  });

  it('cuts a long detail to one short line', () => {
    const digest = wakeUpDigest({ attention: [{ kind: 'task_failed', taskId: 't1', at: 0, detail: 'x'.repeat(1000) }], sinceLast: [] }, describeTask);

    expect(digest.split('\n')[1].length).toBeLessThan(300);
    expect(digest).toMatch(/…$/);
  });

  it('names each passed task once', () => {
    const pass = (taskId: string): RunEvent => ({ kind: 'task_passed', taskId, at: 0 });
    const digest = wakeUpDigest({ attention: [{ kind: 'run_finished', at: 0 }], sinceLast: [pass('t1'), pass('t2'), pass('t1'), pass('t3')] }, describeTask);

    expect(digest).toContain('Since the last update: tasks #1 "Task t1", #2 "Task t2" and #3 "Task t3" passed.');
  });
});

describe('Supervisor', () => {
  function host(run: SupervisedRun | null): SupervisorHost & { deliver: ReturnType<typeof vi.fn>; dropToWatch: ReturnType<typeof vi.fn> } {
    return {
      run: () => run, deliver: vi.fn(async () => undefined), pump: vi.fn(), describeTask, readBudget: () => 12, retryLimit: () => 2,
      plannerRunner: () => null, restartPlanner: vi.fn(), abandonTurn: vi.fn(), goUnsupervised: vi.fn(), dropToWatch: vi.fn(), notice: vi.fn(),
    };
  }

  it.each<[string, SupervisedRun | null]>([
    ['no run has started', null],
    ['the run is Off', { level: 'off' }],
    ['the supervisor failed in this run', { level: 'watch', unsupervised: 'it failed twice' }],
  ])('gathers nothing while %s', async (_case, run) => {
    vi.useFakeTimers();
    const h = host(run);
    const supervisor = new Supervisor(h, { debounceMs: 10 });

    supervisor.observe({ kind: 'task_failed', taskId: 't1' });
    await vi.advanceTimersByTimeAsync(100);

    expect(h.deliver).not.toHaveBeenCalled();
    expect(supervisor.mayWake()).toBe(false);
    vi.useRealTimers();
  });

  it('tells a wake-up turn at Watch its read budget, and refuses every change to the plan', () => {
    const turn = new Supervisor(host({ level: 'watch' })).wakeUpTurn();

    expect(turn.readBudget).toBe(12);
    expect(turn.refused('edit')).toMatch(/^Plan edits are refused in a wake-up turn: you are the supervisor at Watch/);
    expect(turn.refused('plan')).toMatch(/^Plan edits are refused in a wake-up turn/);
    expect(turn.brief).toMatch(/up to 12 reads this turn/);
    expect(turn.brief).toMatch(/At Watch you only suggest/);
  });

  it('lets a wake-up turn at Act edit the plan, but not replace it, and tells it its guards', () => {
    const turn = new Supervisor({ ...host({ level: 'act' }), retryLimit: () => 3 }).wakeUpTurn();

    expect(turn.refused('edit')).toBeUndefined();
    expect(turn.refused('plan')).toMatch(/^A whole new plan is refused in a wake-up turn: .*edit_plan/);
    expect(turn.brief).toMatch(/At Act you may act/);
    expect(turn.brief).toMatch(/up to 3 times/);
  });

  it('applies a level lowered during the turn at once', () => {
    let run: SupervisedRun = { level: 'act' };
    const turn = new Supervisor({ ...host(null), run: () => run }).wakeUpTurn();
    expect(turn.refused('edit')).toBeUndefined();

    run = { level: 'watch' };
    expect(turn.refused('edit')).toMatch(/you are the supervisor at Watch/);
    run = { level: 'off' };
    expect(turn.refused('edit')).toMatch(/^Plan edits are refused: the supervisor was turned off for this run/);
    run = { level: 'act', unsupervised: 'it failed twice' };
    expect(turn.refused('edit')).toMatch(/turned off for this run/);
  });

  describe('the wake-up rate guard', () => {
    const rate = { max: 2, windowMs: 60_000 };

    async function wakes(supervisor: Supervisor, events: RunEventInput[]): Promise<void> {
      for (const event of events) {
        supervisor.observe(event);
        await vi.advanceTimersByTimeAsync(20);
      }
    }
    const input = (taskId: string): RunEventInput => ({ kind: 'waiting_input', taskId });

    it('drops an Act supervisor to Watch on the wake-up past the rate, before it is delivered', async () => {
      vi.useFakeTimers();
      const h = host({ level: 'act' });
      const order: string[] = [];
      h.deliver.mockImplementation(async () => { order.push('deliver'); });
      h.dropToWatch.mockImplementation(() => { order.push('drop'); });
      const supervisor = new Supervisor(h, { debounceMs: 10, wakeUpRate: rate });

      await wakes(supervisor, [input('t1'), input('t2'), input('t3')]);

      expect(order).toEqual(['deliver', 'deliver', 'drop', 'deliver']);
      expect(h.dropToWatch).toHaveBeenCalledWith('woke 3 times in 1 minute with no task passing in between');
      vi.useRealTimers();
    });

    it('starts counting again after a pass, and ignores wake-ups outside the window', async () => {
      vi.useFakeTimers();
      const h = host({ level: 'act' });
      const supervisor = new Supervisor(h, { debounceMs: 10, wakeUpRate: rate });

      await wakes(supervisor, [input('t1'), input('t2'), { kind: 'task_passed', taskId: 't9' }, input('t3')]);
      await vi.advanceTimersByTimeAsync(rate.windowMs);
      await wakes(supervisor, [input('t4'), input('t5')]);

      expect(h.deliver).toHaveBeenCalledTimes(5);
      expect(h.dropToWatch).not.toHaveBeenCalled();
      vi.useRealTimers();
    });

    it('leaves a Watch supervisor be: it has nothing to lower', async () => {
      vi.useFakeTimers();
      const h = host({ level: 'watch' });
      const supervisor = new Supervisor(h, { debounceMs: 10, wakeUpRate: rate });

      await wakes(supervisor, [input('t1'), input('t2'), input('t3'), input('t4')]);

      expect(h.dropToWatch).not.toHaveBeenCalled();
      vi.useRealTimers();
    });
  });
});
