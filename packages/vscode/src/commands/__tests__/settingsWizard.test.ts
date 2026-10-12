import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';
import { window, __quickPicks, __quickPickScript, __resetQuickPicks, type FakeQuickPick } from '../../test/vscode.mock';
import { RUN_SETTINGS_DEFAULTS, type GlobalRunSettings } from '@ordewell/core';
import { runSettingsWizard, type SettingsWizardDeps } from '../settingsWizard';

type Pick = FakeQuickPick & { __accept(): void; __back(): void; __escape(): void };
const choose = (label: string) => (pick: Pick) => {
  pick.activeItems = pick.items.filter((i) => i.label === label);
  pick.__accept();
};
const keep = (pick: Pick) => pick.__accept();
const back = (pick: Pick) => pick.__back();
const escape = (pick: Pick) => pick.__escape();

const info = (): Mock => window.showInformationMessage as unknown as Mock;
const warning = (): Mock => window.showWarningMessage as unknown as Mock;

function makeDeps(overrides: Partial<SettingsWizardDeps> = {}) {
  return {
    autonomous: true,
    run: { ...RUN_SETTINGS_DEFAULTS } as GlobalRunSettings,
    maxParallel: 5,
    saveAutonomy: vi.fn<(enabled: boolean) => void>(),
    changeRunSettings: vi.fn<(changes: Partial<GlobalRunSettings>) => void>(),
    setMaxParallel: vi.fn<(n: number) => Promise<void>>(async () => {}),
    ...overrides,
  } as SettingsWizardDeps & { saveAutonomy: Mock; changeRunSettings: Mock; setMaxParallel: Mock };
}

beforeEach(() => {
  __resetQuickPicks();
  info().mockClear();
  warning().mockReset();
});

describe('settings wizard', () => {
  it('walks every step in order, titled Settings, and says No changes when nothing moved', async () => {
    __quickPickScript.push(...Array(7).fill(keep));
    const deps = makeDeps();

    await runSettingsWizard(deps);

    expect(__quickPicks.map((p) => p.step)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(__quickPicks.every((p) => p.title === 'Settings' && p.totalSteps === 7)).toBe(true);
    expect(deps.changeRunSettings).not.toHaveBeenCalled();
    expect(deps.saveAutonomy).not.toHaveBeenCalled();
    expect(deps.setMaxParallel).not.toHaveBeenCalled();
    expect(info()).toHaveBeenCalledWith('No changes.');
  });

  it('marks the current value and pre-selects it', async () => {
    __quickPickScript.push(escape);
    await runSettingsWizard(makeDeps({ autonomous: false }));

    const [first] = __quickPicks;
    expect(first.items.map((i) => [i.label, i.description === 'current'])).toEqual([
      ['Full', false],
      ['Guarded', true],
    ]);
    expect(first.activeItems.map((i) => i.label)).toEqual(['Guarded']);
  });

  it('skips the retry and read steps when the supervisor is Off', async () => {
    __quickPickScript.push(keep, choose('Off'), ...Array(3).fill(keep));
    const deps = makeDeps();

    await runSettingsWizard(deps);

    expect(__quickPicks).toHaveLength(5);
    expect(__quickPicks.at(-1)?.totalSteps).toBe(5);
    expect(deps.changeRunSettings).toHaveBeenCalledWith({ supervisorLevel: 'off' });
  });

  it('applies only what changed, run settings in one call', async () => {
    __quickPickScript.push(
      choose('Guarded'), keep, choose('1'), keep, choose('On'), choose('On'), choose('8'),
    );
    warning().mockResolvedValue('Turn autorun on');
    const deps = makeDeps();

    await runSettingsWizard(deps);

    expect(deps.saveAutonomy.mock.calls).toEqual([[false]]);
    expect(deps.changeRunSettings.mock.calls).toEqual([[
      { supervisorRetryLimit: 1, mergeAtGatesAutomatically: true, autorun: true },
    ]]);
    expect(deps.setMaxParallel.mock.calls).toEqual([[8]]);
    const message = info().mock.calls.at(-1)?.[0] as string;
    expect(message).toMatch(/Guarded/);
    expect(message).toMatch(/autorun/i);
  });

  it('Back returns to the previous step, keeping its earlier answer', async () => {
    __quickPickScript.push(choose('Guarded'), back, keep, ...Array(6).fill(keep));
    const deps = makeDeps();

    await runSettingsWizard(deps);

    expect(__quickPicks.map((p) => p.step)).toEqual([1, 2, 1, 2, 3, 4, 5, 6, 7]);
    expect(__quickPicks[2].activeItems.map((i) => i.label)).toEqual(['Guarded']);
    expect(deps.saveAutonomy).toHaveBeenCalledWith(false);
  });

  it('shows no Back button on the first step', async () => {
    __quickPickScript.push(escape);
    await runSettingsWizard(makeDeps());
    expect(__quickPicks[0].buttons).toEqual([]);
  });

  it('Escape part-way applies nothing', async () => {
    __quickPickScript.push(choose('Guarded'), choose('Act'), escape);
    const deps = makeDeps();

    await runSettingsWizard(deps);

    expect(deps.saveAutonomy).not.toHaveBeenCalled();
    expect(deps.changeRunSettings).not.toHaveBeenCalled();
    expect(deps.setMaxParallel).not.toHaveBeenCalled();
    expect(info()).not.toHaveBeenCalled();
  });

  it('applies nothing when the user declines the Act confirmation', async () => {
    __quickPickScript.push(keep, choose('Act'), ...Array(5).fill(keep));
    warning().mockResolvedValue(undefined);
    const deps = makeDeps();

    await runSettingsWizard(deps);

    expect(deps.changeRunSettings).not.toHaveBeenCalled();
  });

  it("offers counts at or above core's floor and always includes the current value", async () => {
    __quickPickScript.push(keep, keep, escape);
    await runSettingsWizard(makeDeps({ run: { ...RUN_SETTINGS_DEFAULTS, supervisorRetryLimit: 7 } }));

    const retries = __quickPicks[2].items.map((i) => i.label);
    expect(retries).toContain('7');
    expect(retries.every((l) => Number(l) >= 0)).toBe(true);
  });
});
