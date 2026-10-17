import React from 'react';
import { capConflictFiles } from '@ordewell/core/plan-utils';
import type { IsolationMergeBlock, IsolationMergeResult } from '@ordewell/core';

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
  /** The branch the run started on; absent when it started on a detached HEAD. */
  baseBranch?: string;
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

/** Where a repo's run forked: the branch and the commit, or that it started on neither. */
function baseOf({ baseBranch, baseRef }: HandoffRepo): string {
  const commit = baseRef.slice(0, 12);
  return baseBranch ? `${baseBranch} @ ${commit}` : `detached at ${commit}`;
}

function sortLanded(tasks: HandoffLandedTask[]): HandoffLandedTask[] {
  return [...tasks].sort((a, b) => a.order - b.order);
}

/** Why one repo kept Merge all from touching anything, as one line. */
function blockReason({ reason, files, expected, actual }: IsolationMergeBlock): string {
  switch (reason) {
    case 'merge-in-progress': return 'has a merge in progress';
    case 'conflict': return `would conflict${files.length > 0 ? ` in ${files.join(', ')}` : ''}`;
    case 'uncommitted-changes': return `has uncommitted changes${files.length > 0 ? ` to ${files.join(', ')}` : ''}`;
    case 'partial-landing': return 'holds part of a task whose landing could not be rolled back';
    case 'wrong-branch': return `is ${actual ? `on ${actual}` : 'on a detached HEAD'}; this run started on ${expected}. Check out ${expected} and merge again`;
    case 'git-error': return 'could not be checked by git';
  }
}

/**
 * What Merge all did after it ran. `blocked` is all-or-nothing across the group;
 * a group old enough to lack `merge-tree --write-tree` merges in turn and names
 * the repos it already landed instead.
 */
function MergeOutcome({ result, branch }: { result: IsolationMergeResult; branch: string }) {
  if (result.outcome === 'merged') {
    return <div className="isolation-merge-result merged">Merged every repository&rsquo;s integration branch.</div>;
  }
  if (result.outcome === 'blocked') {
    return (
      <div className="isolation-merge-result blocked">
        <div className="isolation-merge-blocked-title">Merged nothing, so every tree is as it was:</div>
        <ul className="isolation-merge-blocks">
          {result.blocked.map((block) => (
            <li key={block.repo} className="isolation-merge-block">
              <code>{block.repo}</code> {blockReason(block)}
            </li>
          ))}
        </ul>
        <div className="isolation-merge-hint">
          Each repository&rsquo;s <code>{branch}</code> branch can be merged by hand.
        </div>
      </div>
    );
  }
  return (
    <div className={`isolation-merge-result ${result.outcome}`}>
      <div className="isolation-merge-stopped">
        Merging stopped in <code>{result.repo}</code>
        {result.files && result.files.length > 0 ? ` (${result.files.join(', ')})` : ''}.
      </div>
      {result.landed && result.landed.length > 0 && (
        <div className="isolation-merge-landed">{result.landed.join(', ')} were merged already and stay merged.</div>
      )}
    </div>
  );
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
      {mergeResult && isGroup && <MergeOutcome result={mergeResult} branch={repos[0]?.integrationBranch ?? ''} />}
      <div className="isolation-handoff-actions">
        <button className="task-action-btn" onClick={() => onAction('reviewDiff')}>Review diff</button>
        <button className="task-action-btn run" onClick={() => onAction('merge')}>{isGroup ? 'Merge all' : 'Merge'}</button>
        {!midRun && <button className="task-action-btn skip" onClick={() => onAction('cleanup')}>Clean up</button>}
        {!midRun && <button className="task-action-btn cancel" onClick={() => onAction('discard')}>Discard</button>}
      </div>
    </div>
  );
}
