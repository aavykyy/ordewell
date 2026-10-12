import * as vscode from 'vscode';
import { ACT_RISK, AUTORUN_RISK, SUPERVISOR_LEVEL_LABEL, type GlobalRunSettings, type SupervisorLevel } from '@ordewell/core';

export interface SettingsWizardDeps {
  autonomous: boolean;
  run: GlobalRunSettings;
  maxParallel: number;
  saveAutonomy(enabled: boolean): void;
  changeRunSettings(changes: Partial<GlobalRunSettings>): void;
  setMaxParallel(n: number): Promise<void>;
}

interface Draft {
  autonomous: boolean;
  run: GlobalRunSettings;
  maxParallel: number;
}

interface Choice<T> extends vscode.QuickPickItem {
  value: T;
}

type StepId = 'autonomy' | 'supervisor' | 'retries' | 'reads' | 'automerge' | 'autorun' | 'parallel';

interface Step {
  placeholder: string;
  choices(draft: Draft): Choice<unknown>[];
  current(draft: Draft): unknown;
  set(draft: Draft, value: unknown): void;
}

/** Whole numbers the picker proposes; core accepts any number above the floor, so the current value is added when it falls between. */
function counts(base: number[], current: number): Choice<number>[] {
  const values = [...new Set([...base, current])].sort((a, b) => a - b);
  return values.map((n) => ({ label: String(n), value: n }));
}

const RETRY_COUNTS = [0, 1, 2, 3, 5];
const READ_COUNTS = [4, 8, 12, 16, 24];
const PARALLEL_COUNTS = [1, 2, 3, 4, 5, 6, 8];

const STEPS: Record<StepId, Step> = {
  autonomy: {
    placeholder: 'Autonomy: how much the coding agents may do without asking',
    choices: () => [
      { label: 'Full', description: '', detail: 'Agents run in their autonomous mode, with no permission prompts.', value: true },
      { label: 'Guarded', description: '', detail: 'Agents run in their safe mode and ask before risky actions.', value: false },
    ],
    current: (d) => d.autonomous,
    set: (d, v) => { d.autonomous = v as boolean; },
  },
  supervisor: {
    placeholder: 'Supervisor: whether the planner watches or acts on your runs',
    choices: () => (['off', 'watch', 'act'] as const).map((value): Choice<SupervisorLevel> => ({
      label: SUPERVISOR_LEVEL_LABEL[value],
      detail: {
        off: 'The planner does nothing while a run is going.',
        watch: 'The planner reads the run and leaves you notes; it changes nothing.',
        act: 'The planner runs, stops and retries tasks and edits the plan for you.',
      }[value],
      value,
    })),
    current: (d) => d.run.supervisorLevel,
    set: (d, v) => { d.run.supervisorLevel = v as SupervisorLevel; },
  },
  retries: {
    placeholder: 'Supervisor retries: how often it may retry one task',
    choices: (d) => counts(RETRY_COUNTS, d.run.supervisorRetryLimit).map((c) => ({ ...c, detail: c.value === 0 ? 'Never retry a task.' : `Retry one task up to ${c.value} time${c.value === 1 ? '' : 's'}.` })),
    current: (d) => d.run.supervisorRetryLimit,
    set: (d, v) => { d.run.supervisorRetryLimit = v as number; },
  },
  reads: {
    placeholder: 'Supervisor reads: how much it may look at per wake-up',
    choices: (d) => counts(READ_COUNTS, d.run.wakeUpReadBudget).map((c) => ({ ...c, detail: `Up to ${c.value} reads each time it wakes.` })),
    current: (d) => d.run.wakeUpReadBudget,
    set: (d, v) => { d.run.wakeUpReadBudget = v as number; },
  },
  automerge: {
    placeholder: 'Automerge: merge into your branch by itself',
    choices: () => [
      { label: 'On', detail: 'Merge at merge gates and at the end of a run without asking.', value: true },
      { label: 'Off', detail: 'Wait for you at every merge.', value: false },
    ],
    current: (d) => d.run.mergeAtGatesAutomatically,
    set: (d, v) => { d.run.mergeAtGatesAutomatically = v as boolean; },
  },
  autorun: {
    placeholder: 'Autorun: start each submitted plan without review',
    choices: () => [
      { label: 'On', detail: 'A plan the planner submits starts at once.', value: true },
      { label: 'Off', detail: 'Each plan waits for you to press Execute.', value: false },
    ],
    current: (d) => d.run.autorun,
    set: (d, v) => { d.run.autorun = v as boolean; },
  },
  parallel: {
    placeholder: 'Parallel tasks: how many AI tasks run at once',
    choices: (d) => counts(PARALLEL_COUNTS, d.maxParallel).map((c) => ({ ...c, detail: `Up to ${c.value} AI task${c.value === 1 ? '' : 's'} at a time.` })),
    current: (d) => d.maxParallel,
    set: (d, v) => { d.maxParallel = v as number; },
  },
};

const stepOrder = (draft: Draft): StepId[] => [
  'autonomy', 'supervisor',
  ...(draft.run.supervisorLevel === 'off' ? [] : ['retries', 'reads'] as const),
  'automerge', 'autorun', 'parallel',
];

type Answer = { value: unknown } | 'back' | undefined;

function ask(step: Step, draft: Draft, number: number, total: number): Promise<Answer> {
  return new Promise((resolve) => {
    const pick = vscode.window.createQuickPick<Choice<unknown>>();
    const current = step.current(draft);
    const choices = step.choices(draft);
    pick.title = 'Settings';
    pick.step = number;
    pick.totalSteps = total;
    pick.placeholder = step.placeholder;
    pick.items = choices.map((c) => (c.value === current ? { ...c, description: 'current' } : c));
    pick.activeItems = pick.items.filter((c) => c.value === current);
    if (number > 1) pick.buttons = [vscode.QuickInputButtons.Back];

    let settled = false;
    const finish = (answer: Answer): void => {
      if (settled) return;
      settled = true;
      resolve(answer);
      pick.dispose();
    };
    pick.onDidAccept(() => {
      const chosen = pick.selectedItems[0] ?? pick.activeItems[0];
      if (chosen) finish({ value: chosen.value });
    });
    pick.onDidTriggerButton((button) => { if (button === vscode.QuickInputButtons.Back) finish('back'); });
    pick.onDidHide(() => finish(undefined));
    pick.show();
  });
}

async function confirmed(title: string, detail: string, confirm: string): Promise<boolean> {
  return (await vscode.window.showWarningMessage(title, { modal: true, detail }, confirm)) === confirm;
}

/** The same questions `/supervisor act` and `/autorun on` ask, once, when the walk ends. */
export async function confirmRisks(changes: Partial<GlobalRunSettings>): Promise<boolean> {
  if (changes.supervisorLevel === 'act' && !(await confirmed('Let the supervisor act?', `At Act the supervisor runs, stops and retries tasks, edits the plan and merges, without asking you. ${ACT_RISK}`, 'Let it act'))) return false;
  if (changes.autorun === true && !(await confirmed('Start plans without review?', `Each plan the planner submits starts at once, as if you had pressed Execute. ${AUTORUN_RISK}`, 'Turn autorun on'))) return false;
  return true;
}

/** The run settings of /auto, /supervisor, /automerge, /autorun and /parallel as one multi-step quick pick (ADR-0030). */
export async function runSettingsWizard(deps: SettingsWizardDeps): Promise<void> {
  const draft: Draft = { autonomous: deps.autonomous, run: { ...deps.run }, maxParallel: deps.maxParallel };

  // The supervisor answer decides whether the limit steps exist, so the order is re-read at each step.
  let index = 0;
  while (index < stepOrder(draft).length) {
    const order = stepOrder(draft);
    const answer = await ask(STEPS[order[index]], draft, index + 1, order.length);
    if (answer === undefined) return;
    if (answer === 'back') {
      index -= 1;
      continue;
    }
    STEPS[order[index]].set(draft, answer.value);
    index += 1;
  }

  const runChanges: Partial<GlobalRunSettings> = {};
  const lines: string[] = [];
  for (const key of Object.keys(deps.run) as (keyof GlobalRunSettings)[]) {
    if (draft.run[key] === deps.run[key]) continue;
    (runChanges as Record<string, unknown>)[key] = draft.run[key];
  }
  if (draft.autonomous !== deps.autonomous) lines.push(`Autonomy ${draft.autonomous ? 'Full' : 'Guarded'}`);
  if (runChanges.supervisorLevel !== undefined) lines.push(`Supervisor ${SUPERVISOR_LEVEL_LABEL[runChanges.supervisorLevel]}`);
  if (runChanges.supervisorRetryLimit !== undefined) lines.push(`retries ${runChanges.supervisorRetryLimit}`);
  if (runChanges.wakeUpReadBudget !== undefined) lines.push(`reads ${runChanges.wakeUpReadBudget}`);
  if (runChanges.mergeAtGatesAutomatically !== undefined) lines.push(`automerge ${runChanges.mergeAtGatesAutomatically ? 'on' : 'off'}`);
  if (runChanges.autorun !== undefined) lines.push(`autorun ${runChanges.autorun ? 'on' : 'off'}`);
  if (draft.maxParallel !== deps.maxParallel) lines.push(`parallel ${draft.maxParallel}`);

  if (lines.length === 0) {
    vscode.window.showInformationMessage('No changes.');
    return;
  }
  if (!(await confirmRisks(runChanges))) return;

  if (draft.autonomous !== deps.autonomous) deps.saveAutonomy(draft.autonomous);
  if (Object.keys(runChanges).length > 0) deps.changeRunSettings(runChanges);
  if (draft.maxParallel !== deps.maxParallel) await deps.setMaxParallel(draft.maxParallel);
  vscode.window.showInformationMessage(`Settings changed: ${lines.join(' · ')}.`);
}
