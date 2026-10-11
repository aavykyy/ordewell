import { describe, it, expect } from 'vitest';
import { createWakePolicy, type RunEvent } from '../WakePolicy';

const DEBOUNCE = 1000;

function event(kind: RunEvent['kind'], at: number, taskId?: string): RunEvent {
  return { kind, at, taskId };
}

describe('createWakePolicy', () => {
  it('never wakes for passes alone, however long it waits', () => {
    const policy = createWakePolicy({ debounceMs: DEBOUNCE });
    policy.push(event('task_passed', 0, 't1'));
    policy.push(event('task_passed', 10, 't2'));

    expect(policy.poll(1_000_000)).toBeNull();
  });

  it.each(['task_failed', 'waiting_input', 'waiting_approval', 'task_idle', 'landing_conflict', 'auto_merge_stopped'] as const)(
    'wakes for %s',
    (kind) => {
      const policy = createWakePolicy({ debounceMs: DEBOUNCE });
      policy.push(event(kind, 0, 't1'));

      expect(policy.poll(DEBOUNCE)?.attention).toEqual([event(kind, 0, 't1')]);
    },
  );

  describe('debounce window', () => {
    it('merges attention events inside the window into one wake-up', () => {
      const policy = createWakePolicy({ debounceMs: DEBOUNCE });
      policy.push(event('task_failed', 0, 't1'));
      policy.push(event('waiting_input', 300, 't2'));
      policy.push(event('landing_conflict', 900, 't3'));

      expect(policy.poll(DEBOUNCE)?.attention).toEqual([
        event('task_failed', 0, 't1'),
        event('waiting_input', 300, 't2'),
        event('landing_conflict', 900, 't3'),
      ]);
    });

    it('wakes once the window has fully elapsed, and a pass does not open it', () => {
      const policy = createWakePolicy({ debounceMs: DEBOUNCE });
      policy.push(event('task_passed', 0, 't1'));
      policy.push(event('task_failed', 400, 't2'));

      expect(policy.poll(400 + DEBOUNCE - 1)).toBeNull();
      expect(policy.poll(400 + DEBOUNCE)).not.toBeNull();
    });

    it('runs the window from the first attention event, so a steady stream cannot hold the wake-up off', () => {
      const policy = createWakePolicy({ debounceMs: DEBOUNCE });
      policy.push(event('task_failed', 0, 't1'));
      policy.push(event('task_failed', 600, 't2'));

      expect(policy.poll(DEBOUNCE)?.attention).toHaveLength(2);
    });
  });

  describe('run_finished', () => {
    it('flushes without waiting for the window', () => {
      const policy = createWakePolicy({ debounceMs: DEBOUNCE });
      policy.push(event('task_failed', 0, 't1'));
      policy.push(event('task_passed', 10, 't2'));
      policy.push(event('run_finished', 20));

      expect(policy.poll(20)).toEqual({
        attention: [event('task_failed', 0, 't1'), event('run_finished', 20)],
        sinceLast: [event('task_passed', 10, 't2')],
      });
    });

    it('reports the run\'s end once however often it is announced', () => {
      const policy = createWakePolicy({ debounceMs: DEBOUNCE });
      policy.push(event('run_finished', 20));
      policy.push(event('run_finished', 21));

      expect(policy.poll(21)?.attention).toEqual([event('run_finished', 20)]);
    });

    it('wakes on its own with the passes, and leaves the policy open for a retry', () => {
      const policy = createWakePolicy({ debounceMs: DEBOUNCE });
      policy.push(event('task_passed', 0, 't1'));
      policy.push(event('run_finished', 20));

      expect(policy.poll(20)).toEqual({
        attention: [event('run_finished', 20)],
        sinceLast: [event('task_passed', 0, 't1')],
      });

      policy.push(event('waiting_input', 5000, 't1'));
      expect(policy.poll(5000 + DEBOUNCE)?.attention).toEqual([event('waiting_input', 5000, 't1')]);
    });
  });

  describe('idle de-duplication', () => {
    it('reports a task that goes idle twice in one window once, at its first place and stamp', () => {
      const policy = createWakePolicy({ debounceMs: DEBOUNCE });
      policy.push(event('task_idle', 0, 't1'));
      policy.push(event('task_failed', 100, 't2'));
      policy.push(event('task_idle', 200, 't1'));
      policy.push(event('task_idle', 300, 't3'));

      expect(policy.poll(DEBOUNCE)?.attention).toEqual([
        event('task_idle', 0, 't1'),
        event('task_failed', 100, 't2'),
        event('task_idle', 300, 't3'),
      ]);
    });

    it('reports the same task idle again after a wake-up', () => {
      const policy = createWakePolicy({ debounceMs: DEBOUNCE });
      policy.push(event('task_idle', 0, 't1'));
      policy.poll(DEBOUNCE);

      policy.push(event('task_idle', 2000, 't1'));
      expect(policy.poll(2000 + DEBOUNCE)?.attention).toEqual([event('task_idle', 2000, 't1')]);
    });

    it('collapses only silence: two waiting_input events from one task both reach the supervisor', () => {
      const policy = createWakePolicy({ debounceMs: DEBOUNCE });
      policy.push({ kind: 'waiting_input', taskId: 't1', at: 0, detail: 'Which database?' });
      policy.push({ kind: 'waiting_input', taskId: 't1', at: 300, detail: 'Overwrite the migration?' });

      expect(policy.poll(DEBOUNCE)?.attention.map((e) => e.detail)).toEqual([
        'Which database?',
        'Overwrite the migration?',
      ]);
    });

    it('keeps an idle report even when the task passes before the wake-up', () => {
      const policy = createWakePolicy({ debounceMs: DEBOUNCE });
      policy.push(event('task_idle', 0, 't1'));
      policy.push(event('task_passed', 500, 't1'));

      expect(policy.poll(DEBOUNCE)).toEqual({
        attention: [event('task_idle', 0, 't1')],
        sinceLast: [event('task_passed', 500, 't1')],
      });
    });
  });

  it('clears the batch on a wake-up, so each pass is reported once', () => {
    const policy = createWakePolicy({ debounceMs: DEBOUNCE });
    policy.push(event('task_passed', 0, 't1'));
    policy.push(event('task_failed', 10, 't2'));
    expect(policy.poll(10 + DEBOUNCE)?.sinceLast).toEqual([event('task_passed', 0, 't1')]);
    expect(policy.poll(10 + DEBOUNCE)).toBeNull();

    policy.push(event('task_failed', 2000, 't3'));
    expect(policy.poll(2000 + DEBOUNCE)?.sinceLast).toEqual([]);
  });

  describe('usage limits', () => {
    const limit = (at: number, taskId: string, runner: string, resumeAt: string | null): RunEvent =>
      ({ kind: 'usage_limit', taskId, at, runner, resumeAt });

    it('wakes for a task paused on its runner\'s limit, with the runner and the resume time', () => {
      const policy = createWakePolicy({ debounceMs: DEBOUNCE });
      policy.push(limit(0, 't1', 'claude-code', '2026-10-11T20:10:00.000Z'));

      expect(policy.poll(DEBOUNCE)?.attention).toEqual([
        { kind: 'usage_limit', taskId: 't1', taskIds: ['t1'], at: 0, runner: 'claude-code', resumeAt: '2026-10-11T20:10:00.000Z' },
      ]);
    });

    it('coalesces every task one runner\'s limit pauses into one entry, at the first one\'s place', () => {
      const policy = createWakePolicy({ debounceMs: DEBOUNCE });
      policy.push(limit(0, 't1', 'claude-code', '2026-10-11T20:10:00.000Z'));
      policy.push(event('task_failed', 100, 't9'));
      policy.push(limit(200, 't2', 'claude-code', '2026-10-11T20:10:00.000Z'));
      policy.push(limit(300, 't3', 'codex', null));
      policy.push(limit(400, 't1', 'claude-code', '2026-10-11T20:10:00.000Z'));

      expect(policy.poll(DEBOUNCE)?.attention).toEqual([
        { kind: 'usage_limit', taskId: 't1', taskIds: ['t1', 't2'], at: 0, runner: 'claude-code', resumeAt: '2026-10-11T20:10:00.000Z' },
        event('task_failed', 100, 't9'),
        { kind: 'usage_limit', taskId: 't3', taskIds: ['t3'], at: 300, runner: 'codex', resumeAt: null },
      ]);
    });

    it('keeps a known resume time when a later pause on the same limit could not read one', () => {
      const policy = createWakePolicy({ debounceMs: DEBOUNCE });
      policy.push(limit(0, 't1', 'claude-code', '2026-10-11T20:10:00.000Z'));
      policy.push(limit(10, 't2', 'claude-code', null));

      expect(policy.poll(DEBOUNCE)?.attention[0]).toMatchObject({ taskIds: ['t1', 't2'], resumeAt: '2026-10-11T20:10:00.000Z' });
    });
  });

  describe('dueAt', () => {
    it('is null while only passes wait, the window\'s end once attention waits, and at once after run_finished', () => {
      const policy = createWakePolicy({ debounceMs: DEBOUNCE });
      policy.push(event('task_passed', 0, 't1'));
      expect(policy.dueAt()).toBeNull();

      policy.push(event('task_failed', 50, 't2'));
      policy.push(event('waiting_input', 70, 't3'));
      expect(policy.dueAt()).toBe(50 + DEBOUNCE);

      policy.push(event('run_finished', 90));
      expect(policy.dueAt()).toBe(50);
      policy.poll(90);
      expect(policy.dueAt()).toBeNull();
    });
  });

  describe('a snapshot across a restart', () => {
    it('keeps the events inside the window and the passes, so the batch is delivered after a reload', () => {
      const policy = createWakePolicy({ debounceMs: DEBOUNCE });
      policy.push(event('task_passed', 0, 't1'));
      policy.push(event('waiting_input', 400, 't2'));
      policy.push(event('task_failed', 500, 't3'));

      const restarted = createWakePolicy({ debounceMs: DEBOUNCE });
      restarted.restore(policy.snapshot());

      expect(restarted.dueAt()).toBe(400 + DEBOUNCE);
      expect(restarted.poll(400 + DEBOUNCE)).toEqual({
        attention: [event('waiting_input', 400, 't2'), event('task_failed', 500, 't3')],
        sinceLast: [event('task_passed', 0, 't1')],
      });
    });

    it('restores nothing from a plan saved before the snapshot existed', () => {
      const policy = createWakePolicy({ debounceMs: DEBOUNCE });
      policy.push(event('task_failed', 0, 't1'));

      policy.restore(undefined);

      expect(policy.dueAt()).toBeNull();
      expect(policy.poll(DEBOUNCE)).toBeNull();
    });
  });

  it.each([-1, Number.NaN, Number.POSITIVE_INFINITY])('rejects a debounce of %s', (debounceMs) => {
    expect(() => createWakePolicy({ debounceMs })).toThrow(RangeError);
  });
});
