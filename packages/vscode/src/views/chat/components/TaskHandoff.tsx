import React from 'react';
import type { HandoffDigest, StoredHandoff } from '@ordewell/core';
import { handoffFindingsText, handoffReferenceText, savedPatchViews, severityLabel, worstSeverity } from '@ordewell/core/plan-utils';
import { useOpenPatch } from '../openPatch';
import ReportBody from './ReportBody';

/** The same handoff in expanded task details and an attempt log (ADR-0047); only the log carries the report. */
export default function TaskHandoff({ handoff, taskName, onReadFull }: {
  handoff: HandoffDigest | StoredHandoff;
  taskName?: (id: string) => string | undefined;
  onReadFull?: () => void;
}) {
  const severity = worstSeverity(handoff.findings);
  const report = 'report' in handoff ? handoff.report : undefined;
  const more = handoff.findingCount - handoff.findings.length;
  // A patch gets its own block below (ADR-0050); the artifacts list keeps the
  // author's references, which stay one line each.
  const artifacts = handoff.artifacts?.filter((a) => a.kind !== 'patch') ?? [];
  const patches = savedPatchViews(handoff);
  const openPatch = useOpenPatch();
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
      {artifacts.length ? (
        <div className="task-handoff-artifacts">
          <div className="task-handoff-heading">Artifacts</div>
          {artifacts.map((ref, i) => <div key={i}>{handoffReferenceText(ref, taskName)}</div>)}
        </div>
      ) : null}
      {patches.map((patch) => (
        <div key={patch.path} className="task-handoff-patch">
          <div className="task-handoff-heading">Patch · {patch.changes}</div>
          <div className="task-handoff-patch-saved">{patch.saved}</div>
          <div className="task-handoff-patch-base">{patch.base}</div>
          {patch.flags.map((flag) => <div key={flag} className="task-handoff-patch-flag">{flag}</div>)}
          {openPatch && <button type="button" className="task-log-open-btn" onClick={() => openPatch(patch.path)}>Open patch</button>}
        </div>
      ))}
      {report && (
        <div className="chat-report">
          <div className="chat-report-head">Report</div>
          <ReportBody lines={report.replace(/\n+$/, '').split('\n')} className="chat-report-body task-handoff-report" />
        </div>
      )}
      {onReadFull && <button type="button" className="task-log-open-btn" onClick={onReadFull}>Read full handoff</button>}
    </section>
  );
}
