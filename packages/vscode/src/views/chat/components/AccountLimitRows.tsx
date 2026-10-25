import React from 'react';
import { accountLimitsText, accountLimitsTitle, resumeTime } from '@ordewell/core/plan-utils';
import type { AccountLimitSnapshot } from '@ordewell/core';

/*
 * One compact row per runner account with limits to show — the planner footer
 * draws every installed one, a task log only its own runner's. Core words the
 * row and its hover; an account with nothing known draws no row, so an unread
 * or signed-out account never reads as one with room left.
 */

export default function AccountLimitRows({ limits }: { limits: readonly AccountLimitSnapshot[] }) {
  const rows = limits.flatMap((snapshot) => {
    const text = accountLimitsText(snapshot);
    return text ? [{ snapshot, text }] : [];
  });
  if (rows.length === 0) return null;
  const now = new Date();

  return (
    <div className="usage-line account-limits" role="status" aria-label="Account limits">
      {rows.map(({ snapshot, text }) => (
        <span key={snapshot.harness} className={`account-limit${snapshot.status === 'stale' ? ' stale' : ''}`}
          title={accountLimitsTitle(snapshot, (at) => resumeTime(at, now))}>
          {text}
        </span>
      ))}
    </div>
  );
}
