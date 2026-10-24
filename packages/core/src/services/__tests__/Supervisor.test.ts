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

  it('names an automatic Merge all at the run\'s end, which has no task, as the run\'s', () => {
    const digest = wakeUpDigest({ attention: [{ kind: 'auto_merge_stopped', at: 0, detail: 'it conflicts in .: a.ts' }], sinceLast: [] }, describeTask);

    expect(digest.split('\n')[1]).toBe('- automatic Merge all at the end of the run stopped: it conflicts in .: a.ts; the run is handed over to the user to merge');
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
      run: () => run, deliver: vi.fn(async () => undefined), pump: vi.fn(), saveState: vi.fn(), describeTask, blockedBy: () => [], readBudget: () => 12, retryLimit: () => 2,
      restartPlanner: vi.fn(), abandonTurn: vi.fn(), goUnsupervised: vi.fn(), wakeUpEnded: vi.fn(), dropToWatch: vi.fn(), notice: vi.fn(),
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

  describe('a report the planner asked for (ADR-0037)', () => {
    const report = (authority: 'user' | 'supervisor', taskId = 't1'): RunEventInput => ({ kind: 'task_report', taskId, report: { authority, text: 'It passed.\nIt printed nothing.', passed: true } });

    it('is gathered and delivered at Off, with whose authority, its result whole', async () => {
      vi.useFakeTimers();
      const h = host({ level: 'off' });
      const supervisor = new Supervisor(h, { debounceMs: 10 });

      supervisor.observe(report('user'));
      await vi.advanceTimersByTimeAsync(10);

      expect(h.deliver).toHaveBeenCalledWith('Run update:\n- task #1 "Task t1", whose result you asked for, has ended. It passed.\n  It printed nothing.', 'user');
      expect(supervisor.mayWake()).toBe(false);
      expect(supervisor.mayReport()).toBe(true);
      vi.useRealTimers();
    });

    it('goes to a turn of its own when owed to the user\'s turn, apart from the supervisor\'s events in its window', async () => {
      vi.useFakeTimers();
      const h = host({ level: 'act' });
      const supervisor = new Supervisor(h, { debounceMs: 10 });

      supervisor.observe({ kind: 'task_failed', taskId: 't2', detail: 'broke' });
      supervisor.observe(report('user'));
      supervisor.observe(report('supervisor', 't3'));
      await vi.advanceTimersByTimeAsync(10);

      expect(h.deliver.mock.calls).toEqual([
        [expect.stringMatching(/^Run update:\n- task #2 "Task t2" failed: broke\n- task #3 "Task t3", whose result you asked for/), 'supervisor'],
        [expect.stringMatching(/^Run update:\n- task #1 "Task t1", whose result you asked for/), 'user'],
      ]);
      vi.useRealTimers();
    });

    it('outlives a new run the user starts, which drops the supervisor\'s own undelivered events', async () => {
      vi.useFakeTimers();
      const h = host({ level: 'watch' });
      const supervisor = new Supervisor(h, { debounceMs: 10 });

      supervisor.observe({ kind: 'task_failed', taskId: 't2' });
      supervisor.observe(report('user'));
      supervisor.runStarted();
      await vi.advanceTimersByTimeAsync(10);

      expect(h.deliver.mock.calls).toEqual([[expect.not.stringContaining('failed'), 'user']]);
      vi.useRealTimers();
    });

    it('is delivered once due after a restart that restored it inside its debounce window, without the supervisor\'s own events', async () => {
      vi.useFakeTimers();
      const before = new Supervisor(host({ level: 'watch' }), { debounceMs: 10 });
      before.observe({ kind: 'task_failed', taskId: 't2' });
      before.observe(report('user'));
      const saved = before.snapshot();
      before.reset();
      const h = host({ level: 'watch' });
      const supervisor = new Supervisor(h, { debounceMs: 10 });

      supervisor.restore(saved);
      await vi.advanceTimersByTimeAsync(10);

      expect(h.deliver.mock.calls).toEqual([[expect.stringMatching(/^Run update:\n- task #1 "Task t1", whose result you asked for/), 'user']]);
      expect(supervisor.snapshot().policy.attention).toEqual([expect.objectContaining({ kind: 'task_failed', taskId: 't2' })]);

      supervisor.observe({ kind: 'waiting_input', taskId: 't3' });
      await vi.advanceTimersByTimeAsync(10);

      expect(h.deliver).toHaveBeenCalledTimes(2);
      expect(h.deliver.mock.calls[1]).toEqual([expect.stringMatching(/failed\n- task #3 "Task t3" is waiting for input$/), undefined]);
      vi.useRealTimers();
    });

    it('calls a failed report turn of the user\'s a report turn, in the retry and in the give-up', async () => {
      const h = host({ level: 'off' });
      const supervisor = new Supervisor(h);
      const fail = () => supervisor.turn(async () => { throw new Error('planner exited'); }, undefined, 'user');

      await expect(fail()).rejects.toThrow('planner exited');
      expect(h.notice).toHaveBeenCalledWith('warn', 'The planner\'s report turn failed (planner exited). Retrying once with the planner restarted.');
      await expect(fail()).rejects.toThrow('planner exited');
      expect(h.goUnsupervised).toHaveBeenCalledWith('the planner\'s report turn failed twice (planner exited)');
    });

    it('opens no turn once the turns opened without the user have failed for the run', () => {
      expect(new Supervisor(host({ level: 'off', unsupervised: 'its wake-up turn failed twice' })).mayReport()).toBe(false);
    });

    it('acts for the user\'s turn in a report turn of theirs, and refuses it nothing that turn could do', () => {
      const turn = new Supervisor(host({ level: 'watch' })).wakeUpTurn('user');

      expect(turn.actor?.()).toEqual({ kind: 'planner-turn' });
      expect(turn.refused('edit')).toBeUndefined();
      expect(turn.refused('plan')).toBeUndefined();
      expect(turn.brief).toContain('You act as in that turn');
    });

    it('acts at the run\'s level now for the supervisor, read at each call', () => {
      const run: SupervisedRun = { level: 'act' };
      const turn = new Supervisor({ ...host(null), run: () => run }).wakeUpTurn();
      run.level = 'watch';

      expect(turn.actor?.()).toEqual({ kind: 'supervisor', level: 'watch' });
    });
  });

  it('does not wake on the events a restart restored, with no report among them: a session opening is not a run event', async () => {
    vi.useFakeTimers();
    const before = new Supervisor(host({ level: 'watch' }), { debounceMs: 10 });
    before.observe({ kind: 'task_failed', taskId: 't1' });
    const saved = before.snapshot();
    before.reset();
    const h = host({ level: 'watch' });
    const supervisor = new Supervisor(h, { debounceMs: 10 });

    supervisor.restore(saved);
    await vi.advanceTimersByTimeAsync(100);

    expect(h.deliver).not.toHaveBeenCalled();
    expect(supervisor.snapshot().policy.attention).toHaveLength(1);
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

  it('tells a wake-up turn at Act that it answers checkpoints, and leaves the ones that need the user\'s judgement to them', () => {
    const turn = new Supervisor({ ...host({ level: 'act' }), retryLimit: () => 3 }).wakeUpTurn();

    expect(turn.brief).toMatch(/answer_checkpoint/);
    expect(turn.brief).toMatch(/irreversible or outward effect.*escalate it to the user rather than approving it/);
    expect(turn.brief).toMatch(/When you reject, give the reason/);
  });

  it('does not offer the checkpoint tool to a wake-up turn at Watch, which only suggests', () => {
    const turn = new Supervisor({ ...host({ level: 'watch' }), retryLimit: () => 3 }).wakeUpTurn();

    expect(turn.brief).not.toMatch(/answer_checkpoint/);
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
