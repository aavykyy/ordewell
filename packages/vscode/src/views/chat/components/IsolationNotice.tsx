import React from 'react';
import type { IsolationPreview } from '@ordewell/core';
import { describeIsolationPreview } from '@ordewell/core/plan-utils';

interface IsolationNoticeProps {
  /** `undefined`: the host has not said yet; `null`: it is reading the repositories again. */
  preview: IsolationPreview | null | undefined;
}

/**
 * Which repositories and branches Ordewell found and whether code tasks get
 * isolated worktrees, on both first screens. The text is selectable and wraps,
 * so a long path or branch stays whole in a narrow sidebar.
 */
export default function IsolationNotice({ preview }: IsolationNoticeProps) {
  if (preview === undefined) return null;
  if (preview === null) return <p className="isolation-notice isolation-notice-checking" role="status">Checking repositories…</p>;
  const notice = describeIsolationPreview(preview);
  return (
    <section className="isolation-notice" data-status={preview.status} aria-label="Repositories and branches">
      <p className="isolation-notice-summary">{notice.summary}</p>
      {notice.repos.length > 0 && (
        <ul className="isolation-repos">
          {notice.repos.map((repo, i) => (
            <li key={`${i}:${repo.name}`} className="isolation-repo">
              <span className="isolation-repo-name">{repo.name}</span>
              <span className="isolation-repo-detail">{repo.detail}</span>
            </li>
          ))}
        </ul>
      )}
      {notice.shared && <p className="isolation-notice-note">{notice.shared}</p>}
      {notice.note && <p className="isolation-notice-note">{notice.note}</p>}
    </section>
  );
}
