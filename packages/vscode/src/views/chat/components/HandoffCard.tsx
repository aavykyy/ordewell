import React from 'react';
import { capConflictFiles, describeMergeResult } from '@ordewell/core/plan-utils';
import type { IsolationMergeResult } from '@ordewell/core';

export interface HandoffLandedTask {
  taskId: string;
  order: number;
  title: string;
  /** Set when the task landed only after a conflict repair (ADR-0015): the files it was started for. */
  repairedFiles?: string[];
}

/** So the reviewer knows where to look (ADR-0015). */
function RepairedNote({ files }: { files: string[] }) {
  return <span className="isolation-handoff-repaired">: repaired ({capConflictFiles(files)})</span>;
}

export interface HandoffRepo {
  path: string;
  integrationBranch: string;
  baseRef: string;
  /** The branch the run started on; absent when it started on a detached HEAD or the record never noted one. */
  baseBranch?: string;
  /** Set when the run started on a detached HEAD. */
  startedDetached?: true;
  /** Tasks whose work landed in this repo, in plan order. */
  landed?: HandoffLandedTask[];
}

interface HandoffCardProps {
  repos: HandoffRepo[];
  landed: HandoffLandedTask[];
  /** An Act supervisor looks at this run when it wakes and may merge it; the actions stay the user's too. */
  deferredTo?: 'supervisor';
  /** The result of the last Merge all, so a blocked or part-landed group is visible. */
  mergeResult?: IsolationMergeResult | null;
  /**
   * Set while the run is still going and tasks wait at a merge gate
   * (ADR-0020): only reviewing and Merge all are offered, and `paused` says
   * nothing else is running.
   */
  midRun?: { paused: boolean };
  /** Every action here is available once the run is settled; mid-run, only review and merge. */
  onAction: (action: 'reviewDiff' | 'merge' | 'discard' | 'cleanup') => void;
}

/** Where a repo's run forked: the branch and the commit, or that it started detached, or just the commit when the record never noted a branch. */
function baseOf({ baseBranch, startedDetached, baseRef }: HandoffRepo): string {
  const commit = baseRef.slice(0, 12);
  return baseBranch ? `${baseBranch} @ ${commit}` : `${startedDetached ? 'detached at' : 'base'} ${commit}`;
}

function sortLanded(tasks: HandoffLandedTask[]): HandoffLandedTask[] {
  return [...tasks].sort((a, b) => a.order - b.order);
}

/**
 * What Merge all did, in core's words so the card and the TUI cannot disagree
 * about a blocked, part-landed or failed merge — for a lone repo as well as a
 * group. `group` only changes core's wording of a clean merge.
 */
function MergeOutcome({ result, branch, group, repaired }: { result: IsolationMergeResult; branch: string; group: boolean; repaired: HandoffLandedTask[] }) {
  const { message } = describeMergeResult(result, branch, group, repaired);
  return <div className={`isolation-merge-result ${result.outcome}`}>{message}</div>;
}

/**
 * The end of an isolated run (ADR-0013). Unless the user opted in to automatic
 * merging or a supervisor at Act merges, Ordewell does not merge into the
 * checked-out branch, so this is where that irreversible step is offered — next to the one artifact to review it with, the integration branch.
 * A repo group (ADR-0014) reports per repo and merges all-or-nothing; a group
 * of one reads exactly as it did before.
 */
export default function HandoffCard({ repos, landed, deferredTo, mergeResult, midRun, onAction }: HandoffCardProps) {
  const sorted = sortLanded(landed);
  const isGroup = repos.length > 1;
  // Every repo's integration branch has the same name.
  const branch = [...new Set(repos.map((r) => r.integrationBranch))].join(', ');
  const base = repos.map(baseOf).join(', ');
  return (
    <div className="isolation-handoff">
      <div className="isolation-handoff-header">
        <span className="isolation-handoff-title">
          {midRun
            ? midRun.paused ? 'Paused for Merge all: tasks wait for this work in your branch' : 'Tasks wait for Merge all: merge what has landed so far'
            : <>Run complete: review the integration branch</>}
        </span>
        <code className="isolation-handoff-branch">{branch}</code>
      </div>
      {deferredTo === 'supervisor' && (
        <div className="isolation-handoff-deferred">The supervisor may merge this when it wakes. You can review or merge it yourself meanwhile.</div>
      )}
      {isGroup ? (
        <>
          <div className="isolation-handoff-base">
            {sorted.length} task{sorted.length === 1 ? '' : 's'} landed across {repos.length} repositories
          </div>
          <div className="isolation-handoff-repos">
            {repos.map((repo) => (
              <div key={repo.path} className="isolation-handoff-repo">
                <code className="isolation-handoff-repo-path">{repo.path}</code>
                <span className="isolation-handoff-repo-base">on <code>{baseOf(repo)}</code></span>
                {repo.landed && repo.landed.length > 0 && (
                  <ul className="isolation-handoff-landed">
                    {sortLanded(repo.landed).map((t) => (
                      <li key={t.taskId}>
                        <span className="isolation-handoff-order">{t.order}</span>
                        {t.title}
                        {t.repairedFiles && t.repairedFiles.length > 0 && <RepairedNote files={t.repairedFiles} />}
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            ))}
          </div>
        </>
      ) : (
        <>
          <div className="isolation-handoff-base">
            {sorted.length} task{sorted.length === 1 ? '' : 's'} landed on top of <code>{base}</code>
          </div>
          {sorted.length > 0 && (
            <ul className="isolation-handoff-landed">
              {sorted.map((t) => (
                <li key={t.taskId}>
                  <span className="isolation-handoff-order">{t.order}</span>
                  {t.title}
                  {t.repairedFiles && t.repairedFiles.length > 0 && <RepairedNote files={t.repairedFiles} />}
                </li>
              ))}
            </ul>
          )}
        </>
      )}
      {mergeResult && (
        <MergeOutcome
          result={mergeResult}
          branch={repos[0]?.integrationBranch ?? ''}
          group={isGroup}
          repaired={sorted.filter((t) => t.repairedFiles && t.repairedFiles.length > 0)}
        />
      )}
      <div className="isolation-handoff-actions">
        <button className="task-action-btn" onClick={() => onAction('reviewDiff')}>Review diff</button>
        <button className="task-action-btn run" onClick={() => onAction('merge')}>{isGroup ? 'Merge all' : 'Merge'}</button>
        {!midRun && <button className="task-action-btn skip" onClick={() => onAction('cleanup')}>Clean up</button>}
        {!midRun && <button className="task-action-btn cancel" onClick={() => onAction('discard')}>Discard</button>}
      </div>
    </div>
  );
}
