import React, { useId } from 'react';
import { accountLimitsText, accountLimitsTitle, resumeTime } from '@ordewell/core/plan-utils';
import type { AccountLimitSnapshot } from '@ordewell/core';

/*
 * One compact row per runner account with limits to show — the planner footer
 * draws every installed one, a task log only its own runner's. Core words the
 * row and its details; an account with nothing known draws no row, so an
 * unread or signed-out account never reads as one with room left.
 *
 * The details — resets, plan, how current the read is — are the hover for a
 * mouse, and for everyone else the row's description and the text a focused
 * (or tapped) row opens on a line of its own. The rows are not a live region:
 * a poll moving a percentage is no reason to interrupt a screen reader.
 */

export default function AccountLimitRows({ limits }: { limits: readonly AccountLimitSnapshot[] }) {
  const id = useId();
  const rows = limits.flatMap((snapshot) => {
    const text = accountLimitsText(snapshot);
    return text ? [{ snapshot, text }] : [];
  });
  if (rows.length === 0) return null;
  const now = new Date();

  return (
    <div className="usage-line account-limits" role="group" aria-label="Account limits">
      {rows.map(({ snapshot, text }) => {
        const details = accountLimitsTitle(snapshot, (at) => resumeTime(at, now));
        const detailsId = `${id}-${snapshot.harness}`;
        return (
          <React.Fragment key={snapshot.harness}>
            <span className={`account-limit${snapshot.status === 'stale' ? ' stale' : ''}`}
              tabIndex={0} title={details} aria-describedby={detailsId}>
              {text}
            </span>
            <span id={detailsId} className="account-limit-details">
              {details.split('\n').map((line, index) => <span key={index}>{line}</span>)}
            </span>
          </React.Fragment>
        );
      })}
    </div>
  );
}
