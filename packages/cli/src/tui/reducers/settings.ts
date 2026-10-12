import type { GlobalRunSettings, SupervisorLevel } from '@ordewell/core';
import { ACT_RISK, AUTORUN_RISK, SUPERVISOR_LEVEL_LABEL, autonomyLevelLabel } from '@ordewell/core';
import type { PickerItem, TuiState } from '../state';
import { say } from '../transcript';
import { openStepper, type StepChoices, type StepperDefinition } from './stepper';
import { step, type Effect, type Step } from './shared';

/**
 * `/settings`: the run settings `/auto`, `/supervisor`, `/automerge`,
 * `/autorun` and `/parallel` set one at a time, as one stepped panel. Only
 * what changed is saved, through the same paths those commands use.
 */

export type SaveSettingsEffect = Extract<Effect, { type: 'saveSettings' }>;

// Every count is valid with no ceiling (core's parseCount, parseMaxParallel);
// these are the likely picks, and the current value joins them if it is not one.
const RETRY_COUNTS = [0, 1, 2, 3, 5];
const READ_COUNTS = [1, 6, 12, 24, 48];
const PARALLEL_COUNTS = [1, 2, 3, 4, 5, 8, 10];

const SUPERVISOR_DETAIL: Record<SupervisorLevel, string> = {
  off: 'The planner speaks only when you write',
  watch: 'The planner follows your runs and suggests what to do',
  act: 'The planner also runs, stops and retries tasks, edits the plan and merges, without asking',
};

const onOff = (on: boolean): string => (on ? 'on' : 'off');

const switchItems = (current: boolean, onDetail: string, offDetail: string): PickerItem[] => [
  { id: 'on', label: 'On', detail: onDetail, selected: current },
  { id: 'off', label: 'Off', detail: offDetail, selected: !current },
];

function countItems(counts: number[], current: number): PickerItem[] {
  const all = counts.includes(current) ? counts : [...counts, current].sort((a, b) => a - b);
  return all.map((n) => ({ id: String(n), label: String(n), selected: n === current }));
}

const supervisorOff = (_state: TuiState, choices: StepChoices): boolean => choices.supervisor === 'off';

export const SETTINGS: StepperDefinition = {
  title: 'Settings',
  hint: 'Saved for this run and every later one. Nothing is saved until the last step.',
  steps: [
    {
      id: 'autonomy',
      label: 'Autonomy',
      items: (state) => [
        { id: 'full', label: 'Full', detail: "New plans run tasks in each runner's autonomous mode", selected: state.autonomous },
        { id: 'guarded', label: 'Guarded', detail: "New plans run tasks in each runner's safer mode", selected: !state.autonomous },
      ],
    },
    {
      id: 'supervisor',
      label: 'Supervisor',
      items: (state) => (['off', 'watch', 'act'] as const).map((level) => ({
        id: level, label: SUPERVISOR_LEVEL_LABEL[level], detail: SUPERVISOR_DETAIL[level], selected: state.runSettings.supervisorLevel === level,
      })),
    },
    {
      id: 'retries',
      label: 'Supervisor retries',
      hint: 'How many times the supervisor may retry one task in a run',
      skip: supervisorOff,
      items: (state) => countItems(RETRY_COUNTS, state.runSettings.supervisorRetryLimit),
    },
    {
      id: 'reads',
      label: 'Supervisor reads',
      hint: 'How many reads the supervisor may make each time it wakes up',
      skip: supervisorOff,
      items: (state) => countItems(READ_COUNTS, state.runSettings.wakeUpReadBudget),
    },
    {
      id: 'automerge',
      label: 'Automerge',
      items: (state) => switchItems(
        state.runSettings.mergeAtGatesAutomatically,
        'Merge into your branch by itself at merge gates and at the end of a run',
        'Wait for you to merge',
      ),
    },
    {
      id: 'autorun',
      label: 'Autorun',
      items: (state) => switchItems(
        state.runSettings.autorun,
        'Start each plan the planner submits, without review',
        'Wait for you to review and start each plan',
      ),
    },
    {
      id: 'parallel',
      label: 'Parallel',
      hint: 'How many AI tasks run at once, a live run included',
      items: (state) => countItems(PARALLEL_COUNTS, state.maxParallel),
    },
  ],
  complete: completeSettings,
};

export const openSettings = (state: TuiState): Step => openStepper(state, SETTINGS);

function completeSettings(state: TuiState, choices: StepChoices): Step {
  const run: Partial<GlobalRunSettings> = {};
  const changed: string[] = [];
  const save: Omit<SaveSettingsEffect, 'message'> = { type: 'saveSettings', run, ...(state.sessionId ? { sessionId: state.sessionId } : {}) };

  const autonomous = choices.autonomy === 'full';
  if (autonomous !== state.autonomous) {
    save.autonomous = autonomous;
    changed.push(`Autonomy ${autonomyLevelLabel(autonomous)}`);
  }
  const level = choices.supervisor as SupervisorLevel;
  if (level !== state.runSettings.supervisorLevel) {
    run.supervisorLevel = level;
    changed.push(`Supervisor ${SUPERVISOR_LEVEL_LABEL[level]}`);
  }
  // A skipped step has no choice, which leaves its setting as it is.
  if (choices.retries !== undefined && Number(choices.retries) !== state.runSettings.supervisorRetryLimit) {
    run.supervisorRetryLimit = Number(choices.retries);
    changed.push(`Supervisor retries ${choices.retries}`);
  }
  if (choices.reads !== undefined && Number(choices.reads) !== state.runSettings.wakeUpReadBudget) {
    run.wakeUpReadBudget = Number(choices.reads);
    changed.push(`Supervisor reads ${choices.reads}`);
  }
  const automerge = choices.automerge === 'on';
  if (automerge !== state.runSettings.mergeAtGatesAutomatically) {
    run.mergeAtGatesAutomatically = automerge;
    changed.push(`Automerge ${onOff(automerge)}`);
  }
  const autorun = choices.autorun === 'on';
  if (autorun !== state.runSettings.autorun) {
    run.autorun = autorun;
    changed.push(`Autorun ${onOff(autorun)}`);
  }
  const parallel = Number(choices.parallel);
  if (parallel !== state.maxParallel) {
    save.maxParallel = parallel;
    changed.push(`Parallel ${parallel}`);
  }

  if (changed.length === 0) return step(say(state, 'system', 'No changes.'));
  const effect: SaveSettingsEffect = { ...save, message: `Settings: ${changed.join(' · ')}` };
  const risks = [...(run.supervisorLevel === 'act' ? [ACT_RISK] : []), ...(run.autorun ? [AUTORUN_RISK] : [])];
  if (risks.length === 0) return saveSettings(state, effect);
  // The same warning `/supervisor act` and `/autorun on` ask behind; picking
  // the row in a list is no more considered than typing the command.
  return step({
    ...state,
    overlay: {
      kind: 'confirm',
      title: 'Save these settings?',
      message: effect.message,
      note: `${risks.join('\n')}\nThey apply to this session's run now, and to every later run.`,
      action: { kind: 'save-settings', effect },
    },
  });
}

/**
 * The flags `/auto` and `/parallel` set are updated here, not when the save
 * lands, as those commands do: the daemon never answers them back.
 */
export function saveSettings(state: TuiState, effect: SaveSettingsEffect): Step {
  return step({
    ...state,
    ...(effect.autonomous !== undefined ? { autonomous: effect.autonomous } : {}),
    ...(effect.maxParallel !== undefined ? { maxParallel: effect.maxParallel } : {}),
  }, [effect]);
}
