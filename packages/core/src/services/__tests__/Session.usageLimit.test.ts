import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { taskOf } from './sessionTestKit';
import { hitLimit, NOW, RESUME_AT, settled, supervised, task, until } from './supervisorTestKit';
import { taskRowView } from '../../taskRow/view';

beforeEach(() => {
  vi.useFakeTimers({ now: NOW, toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
});

afterEach(() => {
  vi.useRealTimers();
});

describe('editing a task waiting on a usage-limit reset', () => {
  it('a runner change makes a usage-limit task ready even if its resume was already cancelled', async () => {
    const env = await supervised([task('t1', 1)], { settings: { supervisorLevel: 'off' } });
    hitLimit(env.run.of('t1'));
    await until(() => taskOf(env.session, 't1')!.resumeAt === RESUME_AT);
    env.session.cancelScheduledResume('t1');

    await env.session.setTaskRunner('t1', 'codex');

    expect(taskOf(env.session, 't1')!.awaitingReason).toBeUndefined();
    await until(() => env.run.spawnedIds().length === 2);
    expect(env.run.runner.spawn.mock.calls[1][0]).toMatchObject({ taskId: 't1', runner: 'codex' });
  });

  it('a moved task waits for a scheduler slot and starts when it becomes free', async () => {
    const env = await supervised([task('t1', 1), task('t2', 2, { assignedRunner: 'codex' })], {
      settings: { supervisorLevel: 'off' }, plan: { runners: ['claude-code', 'codex'] }, config: { maxParallelSessions: 1 },
    });
    hitLimit(env.run.of('t1'));
    await until(() => taskOf(env.session, 't1')!.resumeAt === RESUME_AT);
    await env.session.forceStartTask('t2');

    await env.session.setTaskRunner('t1', 'codex');

    expect(taskOf(env.session, 't1')!.status).toBe('pending');
    expect(taskOf(env.session, 't1')!.resumeAt).toBeUndefined();
    expect(env.run.spawnedIds()).toEqual(['t1', 't2']);
    env.run.of('t2').reportComplete({ status: 'done', summary: '' });
    await until(() => env.run.spawnedIds().length === 3);
    expect(env.run.runner.spawn.mock.calls[2][0]).toMatchObject({ taskId: 't1', runner: 'codex' });
  });

  it('a user model change on the same runner keeps its resume and uses the new model at reset', async () => {
    const env = await supervised([task('t1', 1)], { settings: { supervisorLevel: 'off' } });
    hitLimit(env.run.of('t1'));
    await until(() => taskOf(env.session, 't1')!.resumeAt === RESUME_AT);

    await env.session.updateTask('t1', { assignedModel: { modelId: 'claude-opus-4', modelLabel: 'Opus' } });

    expect(taskOf(env.session, 't1')!.resumeAt).toBe(RESUME_AT);
    expect(env.run.spawnedIds()).toEqual(['t1']);
    expect(taskRowView(taskOf(env.session, 't1')!).resumes).toBeTruthy();
    await vi.advanceTimersByTimeAsync(Date.parse(RESUME_AT) - Date.now() - 1000);
    expect(env.run.spawnedIds()).toEqual(['t1']);
    await vi.advanceTimersByTimeAsync(1000);
    await until(() => env.run.spawnedIds().length === 2);
    expect(env.run.runner.spawn.mock.calls[1][0]).toMatchObject({ runner: 'claude-code', modelId: 'claude-opus-4' });
  });

  it('a runner change leaves the other tasks on the old account waiting until its shared reset', async () => {
    const env = await supervised([task('t1', 1), task('t2', 2), task('t3', 3)], {
      settings: { supervisorLevel: 'off' }, config: { maxParallelSessions: 2 },
    });
    hitLimit(env.run.of('t1'));
    hitLimit(env.run.of('t2'));
    await until(() => taskOf(env.session, 't1')!.resumeAt === RESUME_AT && taskOf(env.session, 't2')!.resumeAt === RESUME_AT);

    await env.session.setTaskRunner('t1', 'codex');
    await settled();

    expect(env.run.spawnedIds()).toEqual(['t1', 't2', 't1']);
    expect(taskOf(env.session, 't2')!.resumeAt).toBe(RESUME_AT);
    env.run.of('t1').reportComplete({ status: 'done', summary: '' });
    await until(() => taskOf(env.session, 't1')!.status === 'completed');
    await settled();
    expect(env.run.spawnedIds()).toEqual(['t1', 't2', 't1']);
    await vi.advanceTimersByTimeAsync(Date.parse(RESUME_AT) - Date.now() + 1000);
    await until(() => env.run.spawnedIds().filter((id) => id === 't2').length === 2);
    env.run.of('t2').reportComplete({ status: 'done', summary: '' });
    await until(() => env.run.spawnedIds().includes('t3'));
    expect(env.run.spawnedIds()).toEqual(['t1', 't2', 't1', 't2', 't3']);
  });

  it('the runner picker starts the task on a newly admitted runner', async () => {
    const env = await supervised([task('t1', 1)], { settings: { supervisorLevel: 'off' } });
    hitLimit(env.run.of('t1'));
    await until(() => taskOf(env.session, 't1')!.resumeAt === RESUME_AT);

    await env.session.setTaskRunner('t1', 'codex');

    expect(taskOf(env.session, 't1')!.resumeAt).toBeUndefined();
    await until(() => env.run.spawnedIds().length === 2);
    expect(env.run.runner.spawn.mock.calls[1][0]).toMatchObject({ taskId: 't1', runner: 'codex' });
  });

  it('a user runner patch releases its resume and starts on the new runner', async () => {
    const env = await supervised([task('t1', 1)], { settings: { supervisorLevel: 'off' }, plan: { runners: ['claude-code', 'codex'] } });
    hitLimit(env.run.of('t1'));
    await until(() => taskOf(env.session, 't1')!.resumeAt === RESUME_AT);

    await env.session.updateTask('t1', { assignedRunner: 'codex' });

    expect(taskOf(env.session, 't1')!.resumeAt).toBeUndefined();
    await until(() => env.run.spawnedIds().length === 2);
    expect(env.run.runner.spawn.mock.calls[1][0]).toMatchObject({ taskId: 't1', runner: 'codex' });
    const status = env.messages.filter((m) => m.type === 'status_update').at(-1)!;
    expect(status.tasks[0].status).toBe('in_progress');
    expect(status.tasks[0].resumeAt).toBeUndefined();
    expect(taskRowView(taskOf(env.session, 't1')!).resumes).toBeNull();
    await vi.advanceTimersByTimeAsync(Date.parse(RESUME_AT) - Date.now() + 1000);
    await settled();
    expect(env.run.spawnedIds()).toEqual(['t1', 't1']);
  });
});
