import { describe, it, expect, vi } from 'vitest';
import { TurnEffects, type TurnEffectsHost } from '../TurnEffects';
import type { ExecutionCommand } from '../ExecutionCommands';
import { flushMicrotasks } from '../../testing';

describe('the starts a turn deferred behind its edit', () => {
  it('stop at the plan scope\'s end even once they are under way: those not started yet are not done', async () => {
    let release: () => void = () => {};
    const replay = vi.fn((_command: ExecutionCommand) => new Promise<void>((resolve) => {
      release = () => resolve();
    }));
    const notice = vi.fn();
    const host: TurnEffectsHost = { replay, supervisorLevel: () => 'act', notice };
    const effects = new TurnEffects(host);
    effects.defer({ command: 'retry_task', task: '1', from: 'fresh' }, { kind: 'planner-turn' }, 'retry task #1');
    effects.defer({ command: 'retry_task', task: '2', from: 'fresh' }, { kind: 'planner-turn' }, 'retry task #2');
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
});
