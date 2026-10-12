import type { GlobalRunSettings } from '@ordewell/core';
import { ACT_RISK, AUTORUN_RISK, automergeSummary, autorunSummary, parseCount, parseSwitch, supervisorSummary } from '@ordewell/core';
import type { TuiState } from '../state';
import { say } from '../transcript';
import { fail, step, type Effect, type Step } from './shared';

/**
 * The run settings commands (ADR-0030). Each change is saved for every later
 * run and applied at once to this session's run; the daemon answers the
 * settings as they then stand.
 */

export function runSettingsEffect(state: TuiState, changes: Partial<GlobalRunSettings>): Effect {
  return { type: 'setRunSettings', changes, ...(state.sessionId ? { sessionId: state.sessionId } : {}) };
}

export function supervisorCommand(state: TuiState, args: string[]): Step {
  const [arg, value] = args;
  if (arg === undefined) {
    return step(say(state, 'system', `${supervisorSummary(state.runSettings)} — /supervisor off|watch|act, /supervisor retries <n>, /supervisor reads <n>.`));
  }
  if (arg === 'retries') {
    const n = parseCount(value, 0);
    return n === null ? fail(state, 'Usage: /supervisor retries <whole number, 0 or more>') : step(state, [runSettingsEffect(state, { supervisorRetryLimit: n })]);
  }
  if (arg === 'reads') {
    const n = parseCount(value, 1);
    return n === null ? fail(state, 'Usage: /supervisor reads <whole number, 1 or more>') : step(state, [runSettingsEffect(state, { wakeUpReadBudget: n })]);
  }
  if (arg === 'act') return confirmSupervisorAct(state);
  if (arg === 'off' || arg === 'watch') return step(state, [runSettingsEffect(state, { supervisorLevel: arg })]);
  return fail(state, 'Usage: /supervisor [off|watch|act] · /supervisor retries <n> · /supervisor reads <n>');
}

export function automergeCommand(state: TuiState, arg: string | undefined): Step {
  if (arg === undefined) {
    return step(say(state, 'system', `${automergeSummary(state.runSettings)} — /automerge on|off.`));
  }
  const enabled = parseSwitch(arg);
  if (enabled === null) return fail(state, 'Usage: /automerge [on|off]');
  return step(state, [runSettingsEffect(state, { mergeAtGatesAutomatically: enabled })]);
}

export function autorunCommand(state: TuiState, arg: string | undefined): Step {
  if (arg === undefined) {
    return step(say(state, 'system', `${autorunSummary(state.runSettings)} — /autorun on starts each plan the planner submits, without review.`));
  }
  const enabled = parseSwitch(arg);
  if (enabled === null) return fail(state, 'Usage: /autorun [on|off]');
  if (enabled) return confirmAutorun(state);
  return step(state, [runSettingsEffect(state, { autorun: false })]);
}

function confirmSupervisorAct(state: TuiState): Step {
  return step({
    ...state,
    overlay: {
      kind: 'confirm',
      title: 'Let the supervisor act?',
      message: 'At Act the supervisor runs, stops and retries tasks, answers their requests (never allowing), edits the plan and merges, without asking you.',
      note: `${ACT_RISK}\nIt applies to this session's run now, and to every later run.`,
      action: { kind: 'supervisor-act' },
    },
  });
}

function confirmAutorun(state: TuiState): Step {
  return step({
    ...state,
    overlay: {
      kind: 'confirm',
      title: 'Start plans without review?',
      message: 'With autorun on, each plan the planner submits starts at once, as if you had pressed Execute. The planner still asks when something is unclear.',
      note: AUTORUN_RISK,
      action: { kind: 'autorun-on' },
    },
  });
}
