import type { ScriptResult } from '../models/Execution';
import type { Task } from '../models/Task';
import { fitTail } from './TaskQuery';

/** How much of a task's output a report carries: enough to read what happened by, never the log, which `task_output` pages. */
export const REPORT_TAIL_LINES = 30;
const REPORT_TAIL_CHARS = 2_000;

/**
 * Whether a task's attempt is over in a way a report can tell: it passed, it
 * failed, or it passed but waits on the user for what it left in their
 * checkout. A pause on a usage limit or a question is not its end.
 */
export function reportEnded(task: Pick<Task, 'status' | 'awaitingReason'>): boolean {
  return task.status === 'completed' || task.status === 'failed'
    || (task.status === 'awaiting_user' && (task.awaitingReason === 'files-changed' || task.awaitingReason === 'conflict'));
}

/** Where a script task stood once its attempt was over, as a `run_script` record keeps it (ADR-0035). */
export function scriptResultOf(task: Pick<Task, 'status' | 'awaitingReason'>): ScriptResult {
  if (task.status === 'completed') return 'passed';
  if (task.status === 'failed') return 'failed';
  return task.status === 'awaiting_user' ? 'changed-files' : 'stopped';
}

/**
 * What a planner turn is told of a task whose result it asked for (ADR-0035,
 * ADR-0037, R2): how it ended, and the end of what it printed — the same
 * whether the call that started it is still waiting or a later turn hears it.
 * `tail` is the output's end, read where the output is kept.
 */
export function taskReport(task: Pick<Task, 'status' | 'awaitingReason' | 'verdict'>, tail: string | undefined): string {
  const reason = task.verdict?.reason?.trim() ?? '';
  const ended = (() => {
    switch (scriptResultOf(task)) {
      case 'passed': return 'It passed.';
      case 'failed': return `It failed: ${reason || 'no reason was given.'}`;
      case 'changed-files': return task.awaitingReason === 'conflict'
        ? 'It passed, but its work conflicts and could not land: it waits for the user.'
        : 'It passed, but changed tracked files in the user\'s checkout: nothing was committed, and it waits for the user to look at the changes, then mark it complete or retry it.';
      default: return 'It was stopped before it ended, so it has no verdict.';
    }
  })();
  const output = fitTail((tail ?? '').trim(), REPORT_TAIL_CHARS).text;
  // A failure's reason already ends with its error output; the same lines twice tell the planner nothing more.
  if (task.status === 'failed' && (!output || reason.includes(output))) return ended;
  return output ? `${ended}\nThe end of its output:\n${output}` : `${ended}\nIt printed nothing.`;
}
