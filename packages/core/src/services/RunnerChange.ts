import type { DiscoveredModel, RunnerId } from '../models/Task';
import { effectiveAllowlist } from './ModelAllowlistResolver';
import { assignmentIssue, assignmentIssueText, type AssignedTask, type AssignmentScope } from './AssignmentScope';

/** What moved in the user's scope between two readings of it. */
export interface ScopeChange {
  switchedOn: string[];
  switchedOff: string[];
  /** One entry per runner whose allowlist reads differently; undefined is "no restriction". */
  allowlists: { runner: string; before: string[] | undefined; after: string[] | undefined }[];
}

/** A plan task the new scope no longer covers, as the planner is shown it. */
export interface FlaggedTask {
  ref: string;
  title: string;
  task: AssignedTask;
}

const sameSet = (a: readonly string[] | undefined, b: readonly string[] | undefined): boolean =>
  a === undefined || b === undefined ? a === b : a.length === b.length && a.every((id) => b.includes(id));

/** Null when the planner's picture of what it may assign is still right. */
export function scopeChange(told: AssignmentScope, now: AssignmentScope): ScopeChange | null {
  const switchedOn = now.enabledRunners.filter((r) => !told.enabledRunners.includes(r));
  const switchedOff = told.enabledRunners.filter((r) => !now.enabledRunners.includes(r));
  // Both readings use what is known now: a model discovered in between must not
  // read as the user having changed the list.
  const models = now.models as Partial<Record<RunnerId, DiscoveredModel[]>> | undefined;
  const allowlists = [...new Set([...Object.keys(told.allowlist), ...Object.keys(now.allowlist)])]
    .map((runner) => ({
      runner,
      before: effectiveAllowlist(told.allowlist[runner] as string[] | undefined, runner, models),
      after: effectiveAllowlist(now.allowlist[runner] as string[] | undefined, runner, models),
    }))
    .filter((c) => !sameSet(c.before, c.after));
  return switchedOn.length || switchedOff.length || allowlists.length ? { switchedOn, switchedOff, allowlists } : null;
}

/** The plan tasks the scope no longer covers. */
export function flaggedTasks(rows: readonly { ref: string; task: AssignedTask & { title: string } }[], scope: AssignmentScope): (FlaggedTask & { text: string; status: string })[] {
  return rows.flatMap(({ ref, task }) => {
    const issue = assignmentIssue(task, scope);
    return issue ? [{ ref, title: task.title, task, text: assignmentIssueText(issue), status: task.status }] : [];
  });
}

/** What happens to a flagged task as assigned, which depends on where it stands: a failed one only runs again if retried. */
function consequence(status: string | undefined): string {
  if (status === 'failed') return 'failed; a retry would run it there unless moved';
  if (status === 'in_progress' || status === 'awaiting_user') return 'already running as assigned';
  return 'runs as assigned unless moved';
}

function allowlistLine({ runner, before, after }: ScopeChange['allowlists'][number]): string {
  if (!after) return `${runner} is no longer limited: any of its models may be assigned.`;
  if (!before) return `${runner} is now limited to: ${after.join(', ')}.`;
  const added = after.filter((id) => !before.includes(id));
  const removed = before.filter((id) => !after.includes(id));
  return `${runner} models: ${[added.length ? `now allowed ${added.join(', ')}` : '', removed.length ? `no longer allowed ${removed.join(', ')}` : ''].filter(Boolean).join('; ')}.`;
}

/**
 * What the planner is told on the turn after the user changed the runners or
 * the allowlist. The tasks it names still run as assigned; moving them is the
 * planner's or the user's call, so this suggests rather than instructs.
 */
export function runnersChangedBlock(change: ScopeChange, flagged: readonly { ref: string; title: string; text: string; status?: string }[], tools: boolean): string {
  return [
    '<runners_changed>',
    'The user changed which runners and models you may assign since your last turn.',
    change.switchedOn.length ? `Runners switched on: ${change.switchedOn.join(', ')}.` : '',
    change.switchedOff.length ? `Runners switched off: ${change.switchedOff.join(', ')}.` : '',
    ...change.allowlists.map(allowlistLine),
    flagged.length
      ? ['These tasks are now outside that:', ...flagged.map((f) => `- ${f.ref} "${f.title}" (${f.text}) — ${consequence(f.status)}`)].join('\n')
      : '',
    `${tools ? 'list_runners and list_models give' : '<available_models> shows'} what you may assign now.${flagged.length ? ' Consider moving the tasks above to an enabled runner and an allowed model, or tell the user why you left them.' : ''}`,
    '</runners_changed>',
  ].filter(Boolean).join('\n');
}
