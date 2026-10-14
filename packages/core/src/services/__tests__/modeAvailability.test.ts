import { describe, it, expect } from 'vitest';
import { RunnerRegistry } from '../../plugins/RunnerRegistry';
import { plannedMode, readOnlyRunners, runnerModesFrom } from '../ModeResolver';
import { validateTaskEdit } from '../TaskEditValidator';
import { retargetTaskRunner } from '../TaskRetarget';
import { CODEX_SANDBOX_MODE_REASON } from '../harness/codexSandbox';
import type { Task } from '../../models/Task';

/** A host where Codex's sandbox cannot start (ADR-0033): its sandboxed modes carry a reason. */
function catalog() {
  const registry = new RunnerRegistry();
  registry.setUnavailableModes('codex', { agent: CODEX_SANDBOX_MODE_REASON, plan: CODEX_SANDBOX_MODE_REASON });
  return runnerModesFrom(registry, ['claude-code', 'codex', 'opencode']);
}

const task = (over: Partial<Task>): Task => ({
  id: 't1', title: 'Audit', description: 'd', prompt: 'p', type: 'ai', status: 'pending', order: 1,
  assignedRunner: 'claude-code', dependencies: [], ...over,
} as Task);

describe('a runner mode that is unavailable on this host', () => {
  it('is never assigned to a read-only task, and the refusal names the runners that can take it', () => {
    const result = plannedMode('codex', catalog(), { readOnly: true });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('claude-code, opencode');
      expect(result.error).toContain(CODEX_SANDBOX_MODE_REASON);
    }
    expect(readOnlyRunners(catalog())).toEqual(['claude-code', 'opencode']);
  });

  it('is refused with its reason under Guarded, not swapped for Full access', () => {
    const guarded = plannedMode('codex', catalog(), {}, false);

    expect(guarded.ok).toBe(false);
    if (!guarded.ok) expect(guarded.error).toContain(CODEX_SANDBOX_MODE_REASON);
    expect(plannedMode('codex', catalog(), {}, true)).toEqual({ ok: true, mode: 'fullAccess' });
  });

  it('is refused when a task already holds it, rather than kept', () => {
    const result = plannedMode('codex', catalog(), { current: 'agent' }, true);

    expect(result.ok).toBe(false);
  });

  it('is refused for a hand-picked task mode, with the reason', () => {
    const check = validateTaskEdit('direct', [task({ assignedRunner: 'codex' })], 't1', { taskMode: 'plan' }, {
      modelsByRunner: {}, runnerModes: catalog(),
    });

    expect(check.ok).toBe(false);
    expect(check.error).toContain(CODEX_SANDBOX_MODE_REASON);
  });

  it('is not what a read-only task lands on when it is moved: the move is left to be refused, not made writable', () => {
    const modes = catalog();
    const readOnlyTask = task({ assignedRunner: 'claude-code', taskMode: 'plan' });

    const patch = retargetTaskRunner(readOnlyTask, 'codex', { models: [], modes: modes.codex, defaultMode: 'fullAccess' }, modes['claude-code']);

    expect(patch.taskMode).toBe('plan');
  });
});
