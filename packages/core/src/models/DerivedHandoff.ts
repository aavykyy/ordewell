import type { ScriptExit } from '../interfaces/IRunner';
import { HANDOFF_LIMITS, storedHandoff, type StoredHandoff } from './Handoff';
import { secondsText } from './TaskLog';
import type { UserStep } from './Task';

/*
 * The handoff of a task with no model to write one (ADR-0047): Ordewell
 * derives it from the evidence it holds, and does not parse that evidence into
 * findings it cannot vouch for. The one finding a failed script gets says only
 * that it failed, which its exit status already proved.
 */

/** The end of a text within `max` characters, marked when the front was cut: a command says why it failed last. */
function endOf(text: string, max: number): string {
  return text.length <= max ? text : `…${text.slice(-(max - 1))}`;
}

/**
 * What a script task hands over: how it ended and how long it ran as the
 * summary, its output as the report, and for an exit that was not a clean 0 one
 * blocker finding carrying the end of that output. A script that was stopped
 * ended on nobody's account, so it hands over nothing.
 */
export function scriptHandoff(exit: ScriptExit, durationMs: number, output: string): StoredHandoff | undefined {
  const took = secondsText(durationMs);
  const tail = output ? { detail: endOf(output, HANDOFF_LIMITS.detail) } : {};
  const blocker = (title: string) => [{ severity: 'blocker' as const, title, ...tail }];
  let summary: string;
  let findings: ReturnType<typeof blocker> = [];
  switch (exit.outcome) {
    case 'passed':
      summary = `exited 0 in ${took}`;
      break;
    case 'failed': {
      const { code, signal, error } = exit.status;
      if (error !== undefined) {
        summary = `could not start: ${error}`;
        findings = blocker('Script could not start');
      } else if (signal) {
        summary = `ended by ${signal} in ${took}`;
        findings = blocker(`Script ended by ${signal}`);
      } else {
        summary = `exited ${code ?? 'unknown'} in ${took}`;
        findings = blocker(`Script exited ${code ?? 'unknown'}`);
      }
      break;
    }
    case 'timed-out':
      summary = `timed out in ${took}`;
      findings = blocker('Script timed out');
      break;
    case 'stopped':
      return undefined;
  }
  return storedHandoff({ summary, findings, report: endOf(output, HANDOFF_LIMITS.report) });
}

/**
 * What a user task hands over: that the user completed it, and the steps they
 * were given, numbered as the plan has them. The surfaces let a task be marked
 * complete only with every step ticked, and marking it is the user vouching for
 * the rest, so each is listed as done.
 */
export function userTaskHandoff(steps: readonly UserStep[] = []): StoredHandoff | undefined {
  const report = [...steps].sort((a, b) => a.order - b.order).map((s) => `${s.order}. [x] ${s.instruction}`).join('\n');
  return storedHandoff({ summary: 'Completed by the user', ...(report ? { report: endOf(report, HANDOFF_LIMITS.report) } : {}) });
}
