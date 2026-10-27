import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { liveDaemon, toolContext, type LiveDaemon } from '../../tui/__tests__/liveDaemon';
import { handlePlan } from '../plan';

vi.mock('../../utils', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../utils')>()),
  saveLastSession: () => {},
}));

/** What `ordewell plan` printed, with the process left standing. */
async function printed(run: () => Promise<void>): Promise<string> {
  const lines: string[] = [];
  const log = vi.spyOn(console, 'log').mockImplementation((line: string) => { lines.push(line); });
  const error = vi.spyOn(console, 'error').mockImplementation(() => {});
  const write = vi.spyOn(process.stderr, 'write').mockImplementation((() => true) as never);
  try {
    await run();
  } finally {
    log.mockRestore();
    error.mockRestore();
    write.mockRestore();
  }
  return lines.join('\n');
}

/**
 * Headless planning ends by saying what happens to the plan next. With
 * autorun on the plan is already running by then (ADR-0030); only a plan
 * nobody has started is the user's to run.
 */
describe('ordewell plan, once the planner has submitted the plan', () => {
  let daemon: LiveDaemon;

  beforeEach(async () => { daemon = await liveDaemon(); });
  afterEach(async () => { await daemon.close(); });

  async function plannedHeadless(midTurn?: () => Promise<void>): Promise<string> {
    return printed(async () => {
      const planning = handlePlan(['--goal', 'Rate limiting', '--workspace', daemon.workspace], { api: daemon.client() });
      await vi.waitFor(() => expect(daemon.turns).toHaveLength(1));
      const submitted = await daemon.turns[0].tools.submitPlan!({ tasks: [
        { title: 'Add the limiter', description: 'a token bucket', prompt: 'add the limiter', assignedRunner: 'claude-code', sliceType: 'AFK', autonomy: 'AFK' },
      ] }, toolContext);
      expect(submitted.isError, submitted.text).toBeFalsy();
      await midTurn?.();
      daemon.turns[0].finish('Here is the plan.');
      await planning;
    });
  }

  it('says autorun started it, and points at following it rather than running it', async () => {
    await daemon.client().updateRunSettings({ autorun: true });

    const out = await plannedHeadless();

    expect(out).toContain('Add the limiter');
    expect(out).toMatch(/Autorun started the plan/);
    expect(out).toMatch(/ordewell status/);
    expect(out).not.toMatch(/Run 'ordewell run' to execute/);
  });

  it('asks the user to run a plan nobody started', async () => {
    await daemon.client().updateRunSettings({ autorun: false });

    const out = await plannedHeadless();

    expect(out).toMatch(/Run 'ordewell run' to execute/);
    expect(out).not.toMatch(/Autorun/);
  });

  it("says autorun started it from this session's copy, though another surface turned the file off mid-turn", async () => {
    await daemon.client().updateRunSettings({ autorun: true });

    const out = await plannedHeadless(async () => { await daemon.client().updateRunSettings({ autorun: false }); });

    expect(out).toMatch(/Autorun started the plan/);
  });
});
