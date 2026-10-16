import React from 'react';
import type { HeldEdit } from '@ordewell/core';

const MARK_LABEL = { added: 'New', changed: 'Changed', removed: 'Removed' } as const;

/**
 * What the planner turn's held edit would change, below the task cards and
 * apart from them: the edit lands as the reply ends (ADR-0029), and until
 * then these are proposed, not approved. Read-only on purpose: a card here
 * would offer Run or Retry on a task that does not exist yet.
 */
export default function ProposedTasks({ held }: { held: HeldEdit }) {
  const touched = held.tasks.filter((t) => t.mark);
  if (touched.length === 0) return null;
  return (
    <section className="proposed-tasks" aria-labelledby="proposed-tasks-title">
      <div className="proposed-tasks-title" id="proposed-tasks-title">Proposed — lands when this reply ends</div>
      <ul>
        {touched.map(({ label, mark, task }) => (
          <li key={task.id} className="proposed-task" data-mark={mark}>
            <span className="proposed-task-mark">{mark ? MARK_LABEL[mark] : ''}</span>
            <span className="proposed-task-order">{label}</span>
            {mark === 'removed' ? <s className="proposed-task-title">{task.title}</s> : <span className="proposed-task-title">{task.title}</span>}
          </li>
        ))}
      </ul>
    </section>
  );
}
