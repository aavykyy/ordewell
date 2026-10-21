import { REPORT_LEAD } from '../services/WakePolicy';

/**
 * A run update as a surface draws it: the lines the digest says in a line
 * (ADR-0029), and the reports it carries whole (ADR-0037 R2), which a surface
 * folds when they are long and never cuts without saying so.
 */
export type WakeUpItem =
  | { kind: 'line'; text: string }
  /** `task` names the task that ended, as the digest does (`#3 "Title"`); `lines` are the report, verdict first. */
  | { kind: 'report'; task: string; lines: string[] };

/** What the digest opens with, which every surface leaves to its own label. */
const DIGEST_HEAD = 'Run update:';

/** A report is read rather than skimmed, so a collapsed one shows more than a command's output does. */
export const REPORT_PREVIEW_LINES = 8;

/** Whether a run update carries a report longer than a collapsed view shows. */
export function hasLongReport(text: string): boolean {
  return wakeUpItems(text).some((item) => item.kind === 'report' && item.lines.length > REPORT_PREVIEW_LINES);
}

const REPORTED = /^task (#[\d.]+ ".*")$/;

/** The text of a `wake_up` block, split into its items; a text that is no digest is one line. */
export function wakeUpItems(text: string): WakeUpItem[] {
  const items: WakeUpItem[] = [];
  let report: Extract<WakeUpItem, { kind: 'report' }> | null = null;
  for (const line of text.replace(/\r\n?/g, '\n').split('\n')) {
    // The digest indents a report's lines under its bullet; a blank one is the indent alone.
    if (report && (line.startsWith('  ') || line === '')) {
      report.lines.push(line.slice(2));
      continue;
    }
    report = null;
    if (line === DIGEST_HEAD && items.length === 0) continue;
    const bullet = line.startsWith('- ') ? line.slice(2) : null;
    const at = bullet?.indexOf(REPORT_LEAD) ?? -1;
    const task = bullet === null || at < 0 ? undefined : REPORTED.exec(bullet.slice(0, at))?.[1];
    if (bullet !== null && task !== undefined) {
      report = { kind: 'report', task, lines: [bullet.slice(at + REPORT_LEAD.length).trimStart()] };
      items.push(report);
    } else items.push({ kind: 'line', text: line });
  }
  return items.map((item) => (item.kind === 'report' ? { ...item, lines: trimmed(item.lines) } : item));
}

/** Blank lines at the end are the digest's own separation, not the report's. */
function trimmed(lines: string[]): string[] {
  const kept = [...lines];
  while (kept.length > 1 && kept[kept.length - 1].trim() === '') kept.pop();
  return kept;
}
