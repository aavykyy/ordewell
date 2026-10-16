import { describe, it, expect, vi } from 'vitest';
import { TurnEffects, type TurnEffectsHost } from '../TurnEffects';
import type { ExecutionCommand } from '../ExecutionCommands';
import { flushMicrotasks } from '../../testing';

const admission = () => ({ current: () => true, release: vi.fn() });

describe('the starts a turn deferred behind its edit', () => {
  it('stop at the plan scope\'s end even once they are under way: those not started yet are not done', async () => {
    let release: () => void = () => {};
    const replay = vi.fn((_command: ExecutionCommand) => new Promise<void>((resolve) => {
      release = () => resolve();
    }));
    const notice = vi.fn();
    const host: TurnEffectsHost = { replay, supervisorLevel: () => 'act', notice };
    const effects = new TurnEffects(host);
    effects.defer({ command: 'retry_task', task: '1', from: 'fresh' }, { kind: 'planner-turn' }, 'retry task #1', admission());
    effects.defer({ command: 'retry_task', task: '2', from: 'fresh' }, { kind: 'planner-turn' }, 'retry task #2', admission());
    effects.landed('edit');
    effects.settle();
    await flushMicrotasks();
    expect(replay).toHaveBeenCalledTimes(1);

    effects.abandon();
    release();
    await flushMicrotasks();

    expect(replay).toHaveBeenCalledTimes(1);
    expect(notice).toHaveBeenCalledWith('warn', expect.stringMatching(/^Not done: retry task #2/));
    expect(notice).not.toHaveBeenCalledWith('warn', expect.stringMatching(/^Not done: retry task #1/));
  });

  it('let go of each start\'s admission once it ran, so a Stop no longer counts it', async () => {
    const host: TurnEffectsHost = { replay: vi.fn(async () => {}), supervisorLevel: () => 'act', notice: vi.fn() };
    const effects = new TurnEffects(host);
    const queued = admission();
    effects.defer({ command: 'run_plan' }, { kind: 'planner-turn' }, 'run the plan', queued);
    effects.landed('edit');

    effects.settle();
    await flushMicrotasks();

    expect(host.replay).toHaveBeenCalledWith({ command: 'run_plan' }, { kind: 'planner-turn' }, queued);
    expect(queued.release).toHaveBeenCalled();
  });

  it('let go of the admissions of starts that never run: an edit that did not land, or one asked for after the turn', () => {
    const host: TurnEffectsHost = { replay: vi.fn(async () => {}), supervisorLevel: () => 'act', notice: vi.fn() };
    const effects = new TurnEffects(host);
    const dropped = admission();
    const late = admission();
    effects.defer({ command: 'run_plan' }, { kind: 'planner-turn' }, 'run the plan', dropped);

    effects.settle();
    effects.defer({ command: 'run_plan' }, { kind: 'planner-turn' }, 'run the plan', late);

    expect(host.replay).not.toHaveBeenCalled();
    expect(dropped.release).toHaveBeenCalled();
    expect(late.release).toHaveBeenCalled();
  });
});
