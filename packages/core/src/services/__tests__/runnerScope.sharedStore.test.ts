import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RunnerRegistry } from '../../plugins/RunnerRegistry';
import { RUN_SETTINGS_DEFAULTS, SettingsService } from '../SettingsService';
import { sessionRuntimeSettings } from '../createSession';
import { makeSession } from './sessionTestKit';
import { ctx, heldPlanner, NOW, prose, settled, supervised, task, until, waitForInput } from './supervisorTestKit';
import { WAKE_DEBOUNCE_MS } from '../Supervisor';

const ALL = ['claude-code', 'codex', 'opencode'];
const ALLOWED = ['claude-code', 'opencode'];

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ordewell-shared-runners-'));
  vi.useFakeTimers({ now: NOW, toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
});
afterEach(() => {
  vi.useRealTimers();
  rmSync(dir, { recursive: true, force: true });
});

/** The user's settings file with all three runners on, which the Session reads at each call. */
function sharedFile(): SettingsService {
  const file = new SettingsService(join(dir, 'settings.json'));
  file.setEnabledRunners(ALL);
  return file;
}

/** What a surface saves when the user switches Codex off: the one atomic update every surface shares (ADR-0043). */
const switchCodexOff = (file: SettingsService): string[] => file.updateEnabledRunners((saved) => (saved ?? ALL).filter((r) => r !== 'codex'));

const idsOf = (reply: { text: string }): string[] => (JSON.parse(reply.text) as { runners: Array<{ id: string }> }).runners.map((r) => r.id);

describe('the runners a Session offers follow the shared settings file', () => {
  it('offers a supervisor wake-up turn only the runners saved after the run began', async () => {
    const file = sharedFile();
    const env = await supervised([task('t1', 1), task('t2', 2)], {
      settings: { supervisorLevel: 'act' },
      enabledRunners: () => file.getEnabledRunners(),
    });

    switchCodexOff(file);
    waitForInput(env.run.of('t1'));
    await settled();
    await vi.advanceTimersByTimeAsync(WAKE_DEBOUNCE_MS);
    await until(() => env.planner.calls.length === 1);
    const tools = env.planner.tools();

    expect(idsOf(await tools.listRunners!({}, ctx))).toEqual(ALLOWED);
    expect(await tools.listModels!({ runner: 'codex' }, ctx)).toMatchObject({ isError: true });
    env.planner.calls[0].finish(prose('ok'));
  });

  it('plans a session built after the choice on exactly the saved runners', async () => {
    const file = sharedFile();
    switchCodexOff(file);
    const planner = heldPlanner();
    const session = makeSession({
      registry: new RunnerRegistry(),
      aiService: planner.aiService,
      settings: () => ({ ...sessionRuntimeSettings(file.getAll()), run: { ...RUN_SETTINGS_DEFAULTS, supervisorLevel: 'off' } }),
    });

    const planning = session.startPlanning('goal');
    await until(() => planner.calls.length === 1);

    expect(idsOf(await planner.tools().listRunners!({}, ctx))).toEqual(ALLOWED);
    planner.calls[0].finish(prose('ok'));
    expect((await planning).runners).toEqual(ALLOWED);
  });

  it('reaches a second Session of the same workspace through its own reader of the file', async () => {
    const written = sharedFile();
    const planner = heldPlanner();
    const reader = new SettingsService(join(dir, 'settings.json'));
    const session = makeSession({
      registry: new RunnerRegistry(),
      aiService: planner.aiService,
      settings: () => ({ ...sessionRuntimeSettings(reader.getAll()), run: { ...RUN_SETTINGS_DEFAULTS, supervisorLevel: 'off' } }),
    });
    const planning = session.startPlanning('goal', ALL);
    await until(() => planner.calls.length === 1);
    expect(idsOf(await planner.tools().listRunners!({}, ctx))).toEqual(ALL);

    switchCodexOff(written);

    expect(idsOf(await planner.tools().listRunners!({}, ctx))).toEqual(ALLOWED);
    expect(await planner.tools().listModels!({ runner: 'codex' }, ctx)).toMatchObject({ isError: true });
    planner.calls[0].finish(prose('ok'));
    await planning;
  });
});
