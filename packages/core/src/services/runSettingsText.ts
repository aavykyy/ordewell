import type { SupervisorLevel } from '../models/Execution';
import type { GlobalRunSettings } from './SettingsService';

/** How every surface words the run settings (ADR-0030), so they all say the same thing. */

export const SUPERVISOR_LEVEL_LABEL: Record<SupervisorLevel, string> = { off: 'Off', watch: 'Watch', act: 'Act' };

const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;
const onOff = (value: boolean): string => (value ? 'on' : 'off');

export const supervisorSummary = (run: GlobalRunSettings): string =>
  `Supervisor: ${SUPERVISOR_LEVEL_LABEL[run.supervisorLevel]}, ${plural(run.supervisorRetryLimit, 'retry', 'retries')} per task, ${plural(run.wakeUpReadBudget, 'read', 'reads')} per wake-up`;
export const automergeSummary = (run: GlobalRunSettings): string => `Merge automatically (gates, end of run): ${onOff(run.mergeAtGatesAutomatically)}`;
export const autorunSummary = (run: GlobalRunSettings): string => `Autorun: ${onOff(run.autorun)}`;
export const researchSummary = (run: GlobalRunSettings): string => `Research: ${run.researchMaxParallel} at once, ${run.researchMaxPerMessage} tasks and report turns per message`;
export const RESEARCH_USAGE = 'Usage: /research [parallel <n>|per-message <n>]';

export function researchSettingsChange(args: readonly string[]): Partial<GlobalRunSettings> | null {
  const [arg, value] = args;
  const n = parseCount(value, 1);
  if (n === null || !Number.isSafeInteger(n)) return null;
  return arg === 'parallel' ? { researchMaxParallel: n } : arg === 'per-message' ? { researchMaxPerMessage: n } : null;
}

export const ACT_RISK = 'Tasks it adds run too, ops tasks included, which can act on real systems unattended.';
export const AUTORUN_RISK = 'Plans start without review, ops tasks included, which can act on real systems unattended. In Full, the planner may also start tasks it adds later.';

/** `on`/`off` as a switch's value; null for anything else. */
export function parseSwitch(arg: string): boolean | null {
  return arg === 'on' ? true : arg === 'off' ? false : null;
}

/** A whole number at least `min`, as typed; null for anything else. */
export function parseCount(arg: string | undefined, min: number): number | null {
  if (arg === undefined || !/^\d+$/.test(arg)) return null;
  const n = Number(arg);
  return n >= min ? n : null;
}
