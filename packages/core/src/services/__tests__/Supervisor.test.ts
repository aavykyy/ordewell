import { describe, expect, it, vi } from 'vitest';
import { Supervisor, wakeUpDigest, type SupervisedRun, type SupervisorHost } from '../Supervisor';
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
  function host(run: SupervisedRun | null): SupervisorHost & { deliver: ReturnType<typeof vi.fn> } {
    return {
      run: () => run, deliver: vi.fn(async () => undefined), pump: vi.fn(), describeTask, readBudget: () => 12,
      plannerRunner: () => null, restartPlanner: vi.fn(), abandonTurn: vi.fn(), goUnsupervised: vi.fn(), notice: vi.fn(),
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

  it('tells a wake-up turn its read budget, and refuses its edits until Act has its own rules', () => {
    for (const level of ['watch', 'act'] as const) {
      const turn = new Supervisor(host({ level })).wakeUpTurn();
      expect(turn).toMatchObject({ readBudget: 12, editsRefused: expect.stringMatching(/^Plan edits are refused in a wake-up turn/) });
      expect(turn.brief).toMatch(/up to 12 reads this turn/);
    }
  });
});
