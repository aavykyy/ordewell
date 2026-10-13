import { describe, it, expect, vi } from 'vitest';
import { TurnEffects, type TurnEffectsHost } from '../TurnEffects';
import type { CommandOutcome, ExecutionCommand } from '../ExecutionCommands';
import { flushMicrotasks } from '../../testing';

describe('the starts a turn deferred behind its edit', () => {
  it('stop at the plan scope\'s end even once they are under way: those not started yet are not done', async () => {
    let release: () => void = () => {};
    const execute = vi.fn((_command: ExecutionCommand) => new Promise<CommandOutcome>((resolve) => {
      release = () => resolve({ ok: true, message: 'started' });
    }));
    const notice = vi.fn();
    const host: TurnEffectsHost = { execute, supervisorLevel: () => 'act', notice };
    const effects = new TurnEffects(host);
    effects.defer({ command: 'retry_task', task: '1', from: 'fresh' }, { kind: 'planner-turn' }, 'retry task #1');
    effects.defer({ command: 'retry_task', task: '2', from: 'fresh' }, { kind: 'planner-turn' }, 'retry task #2');
    effects.landed('edit');
    effects.settle();
    await flushMicrotasks();
    expect(execute).toHaveBeenCalledTimes(1);

    effects.abandon();
    release();
    await flushMicrotasks();

    expect(execute).toHaveBeenCalledTimes(1);
    expect(notice).toHaveBeenCalledWith('warn', expect.stringMatching(/^Not done: retry task #2/));
    expect(notice).not.toHaveBeenCalledWith('warn', expect.stringMatching(/^Not done: retry task #1/));
  });
});
