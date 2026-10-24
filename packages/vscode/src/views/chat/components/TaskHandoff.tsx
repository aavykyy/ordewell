import React from 'react';
import type { HandoffDigest, StoredHandoff, TaskRowHandoff } from '@ordewell/core';
import { handoffFindingsText, handoffPeekParts, handoffReferenceText, REPORT_PREVIEW_LINES, severityLabel, worstSeverity } from '@ordewell/core/plan-utils';

export function HandoffPeek({ handoff }: { handoff: TaskRowHandoff | null }) {
  if (!handoff) return null;
  return (
    <div className="task-handoff-peek" title={handoff.commit ? `${handoff.commit.subject}\n\n${handoff.summary}` : handoff.summary}>
      Handed over · {handoffPeekParts(handoff).join(' · ')}
    </div>
  );
}

/** The same handoff in a plan card and an attempt log (ADR-0047); only the log carries the report. */
export default function TaskHandoff({ handoff, expanded = false, taskName, onReadFull }: {
  handoff: HandoffDigest | StoredHandoff;
  expanded?: boolean;
  taskName?: (id: string) => string | undefined;
  onReadFull?: () => void;
}) {
  const severity = worstSeverity(handoff.findings);
  const report = 'report' in handoff ? handoff.report : undefined;
  const lines = report ? report.replace(/\n+$/, '').split('\n') : [];
  const shown = expanded ? lines : lines.slice(0, REPORT_PREVIEW_LINES);
  const hidden = lines.length - shown.length;
  const more = handoff.findingCount - handoff.findings.length;
  return (
    <section className="task-handoff" aria-label="Handoff">
      <div className="task-handoff-heading">Handoff · {handoffFindingsText(handoff.findingCount)}{severity ? ` · ${severityLabel(severity)}` : ''}</div>
      {handoff.commit && (
        <div className="task-handoff-commit">
          <div className="task-handoff-commit-subject">Commit: {handoff.commit.subject}</div>
          {handoff.commit.body && <div className="task-handoff-commit-body">{handoff.commit.body}</div>}
        </div>
      )}
      {handoff.summary && <div className="task-handoff-summary">{handoff.summary}</div>}
      {handoff.findings.map((finding) => (
        <div key={finding.id} className="task-handoff-finding" data-severity={finding.severity}>
          <div className="task-handoff-finding-heading">{finding.id} · {severityLabel(finding.severity)} · {finding.title}</div>
          {finding.detail && <div className="task-handoff-detail">{finding.detail}</div>}
          {finding.evidence?.length ? (
            <div className="task-handoff-evidence">Evidence: {finding.evidence.map((ref) => handoffReferenceText(ref, taskName)).join('; ')}</div>
          ) : null}
        </div>
      ))}
      {more > 0 && <div className="task-handoff-more">+{more} more finding{more === 1 ? '' : 's'}, in the attempt's log</div>}
      {handoff.artifacts?.length ? (
        <div className="task-handoff-artifacts">
          <div className="task-handoff-heading">Artifacts</div>
          {handoff.artifacts.map((ref, i) => <div key={i}>{handoffReferenceText(ref, taskName)}</div>)}
        </div>
      ) : null}
      {report && (
        <div className="chat-report">
          <div className="chat-report-head">Report</div>
          <pre className="chat-report-body task-handoff-report">{shown.join('\n')}</pre>
          {hidden > 0 && <span className="cmd-row-more">+{hidden} line{hidden === 1 ? '' : 's'} of the report</span>}
        </div>
      )}
      {onReadFull && <button type="button" className="task-log-open-btn" onClick={onReadFull}>Read full handoff</button>}
    </section>
  );
}
