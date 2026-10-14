import React, { useState } from 'react';
import { taskCommand, useRunnerCommands, useTaskCommands } from './RunnerCommands';
import SubTaskCard from './SubTaskCard';
import ModelSelector from './ModelSelector';
import DependencyPicker from './DependencyPicker';
import SkillChips from './SkillChips';
import { QUEUE_TITLE, SendKeyHint, isSendNowKey } from './PendingMessages';
import { lastLine } from '../taskOutput';
import { checkLabel } from '../checkLabel';
import { useFollowOutput } from '../followOutput';
import { blockedByLabel, dependencyCandidates, capConflictFiles, pausedOnLimit, skippedLabel, taskRowView } from '@ordewell/core/plan-utils';
import type { Task, DiscoveredModel, TaskModelAssignment, RunTask, TaskRowAction, TaskRowView, TaskStatusKind } from '@ordewell/core';

export interface RunnerMode {
  id: string;
  label: string;
  description: string;
  /** Tagged `autonomous: true` on the manifest — runs without permission prompts. */
  autonomous?: boolean;
  /** Why this host cannot run the mode; the option is listed, not selectable. */
  unavailable?: string;
}

export interface RunnerOption {
  id: string;
  displayName: string;
}

interface TaskCardProps {
  task: Task;
  models: DiscoveredModel[];
  modes?: RunnerMode[];
  /** Every runner's catalog, keyed by runner id — used to re-scope a subtask's
   *  own pickers to ITS `assignedRunner` rather than the parent's (a subtask
   *  can run on a different runner than its parent). */
  modelsByRunner?: Partial<Record<string, DiscoveredModel[]>>;
  modesByRunner?: Record<string, RunnerMode[]>;
  runners?: RunnerOption[];
  effectiveRunner?: string;
  configuredProviders?: ('openrouter' | 'google' | 'openai_compatible')[];
  modelApiMapping?: Record<string, ('openrouter' | 'google' | 'openai_compatible')[]>;
  isExecuting?: boolean;
  /** Tail of this task's live runner output, if any has arrived. */
  output?: string;
  /**
   * This task's own status as the run view holds it (#S8c): its stall mark,
   * runner approvals, isolation and merge gate. Absent before the host has
   * folded the run, in which case the plan's own fields are all there is.
   */
  run?: Pick<RunTask, 'idleSince' | 'awaitingApproval' | 'isolation' | 'mergeGate' | 'continuable'>;
  /** Opt in to resolving this task's merge conflict as an AI task. */
  onResolveConflict?: (taskId: string) => void;
  dependentCount?: number;
  /** The task list this task belongs to — the dependency editor's candidates and the tree its dependency references are labelled against. */
  siblings?: Task[];
  onDependenciesChange?: (taskId: string, dependencies: string[]) => void;
  onRunnerChange?: (taskId: string, runner: string) => void;
  onModelChange?: (taskId: string, assignment: TaskModelAssignment) => void;
  /** Called when this task's model dropdown opens, so a stale/degraded catalog self-heals. */
  onModelsRefreshNeeded?: () => void;
  onModeChange?: (taskId: string, mode: string) => void;
  /** Change versus ops (ADR-0020); offered until the task starts. */
  onOpsChange?: (taskId: string, ops: boolean) => void;
  taskSkills?: { name: string; description: string }[];
  onSkillsChange?: (taskId: string, skills: string[]) => void;
  onRemoveTask?: (taskId: string) => void;
  onPromptChange?: (taskId: string, prompt: string) => void;
  onRetry?: (taskId: string) => void;
  onSkip?: (taskId: string) => void;
  onCancel?: (taskId: string) => void;
  /** Keep a task paused on a usage limit from resuming on its own (#84). */
  onCancelResume?: (taskId: string) => void;
  /** Resume a task paused on a usage limit now, in its saved session, once the user says the limit has reset. */
  onResumeNow?: (taskId: string) => void;
  onForceStart?: (taskId: string) => void;
  onMarkComplete?: (taskId: string) => void;
  onMarkIncomplete?: (taskId: string) => void;
  onRunTask?: (taskId: string) => void;
  /** Message the running or waiting task from its card (ADR-0018, M1); a plain message goes through the command seam. */
  onSendMessage?: (taskId: string, text: string) => void;
  /** Force send to the running task from its card (ADR-0023, F1): interrupt its turn and deliver this next. */
  onSendMessageNow?: (taskId: string, text: string) => void;
  /** Open (or focus) this task's log tab (ADR-0018, V1). */
  onOpenLog?: (taskId: string) => void;
  /** Controlled expansion. When both are supplied the parent owns which card is
   *  open (an accordion); omitted, the card keeps its own state. */
  expanded?: boolean;
  onExpandedChange?: (expanded: boolean) => void;
}

const STATUS_BADGE: Record<TaskStatusKind, { label: string; cls: string }> = {
  done: { label: 'Done', cls: 'status-completed' },
  failed: { label: 'Failed', cls: 'status-failed' },
  running: { label: 'Running', cls: 'status-running' },
  quiet: { label: 'Stalled', cls: 'status-stalled' },
  blocked: { label: 'Blocked', cls: 'status-blocked' },
  skipped: { label: 'Skipped', cls: 'status-skipped' },
  todo: { label: 'To do', cls: 'status-pending' },
  awaiting: { label: 'Awaiting User', cls: 'status-blocked' },
};

/** The status badge: what an awaiting task waits on, the failure a blocked one waits on, or why one was skipped, outranks the generic word. */
export function statusBadge(row: Pick<TaskRowView, 'status' | 'awaiting' | 'blockedBy' | 'skipReason'>): { label: string; cls: string } {
  const badge = STATUS_BADGE[row.status];
  if (row.status === 'skipped') return { ...badge, label: skippedLabel(row.skipReason) };
  return { ...badge, label: row.awaiting ?? (row.blockedBy ? blockedByLabel(row.blockedBy) : badge.label) };
}

const CHECK_STATE: Record<TaskStatusKind, 'done' | 'running' | 'stalled' | 'skipped' | 'todo'> = {
  done: 'done', running: 'running', quiet: 'stalled', todo: 'todo', awaiting: 'todo', blocked: 'todo', failed: 'todo', skipped: 'skipped',
};

/** Minimal to-do / done indicator: empty ring → pulsing ring → filled check.
 *  The ring is a toggle: clicking an unfinished task marks it executed, clicking
 *  a done one takes it back to not-executed. */
export function TaskCheck({ row, taskId, onMarkComplete, onMarkIncomplete }: { row: Pick<TaskRowView, 'status' | 'mark'>; taskId?: string; onMarkComplete?: (taskId: string) => void; onMarkIncomplete?: (taskId: string) => void }) {
  const state = CHECK_STATE[row.status];
  const toggle = row.mark === 'uncomplete' ? onMarkIncomplete : onMarkComplete;
  const clickable = !!toggle && !!taskId;
  const title = state === 'done'
    ? (clickable ? 'Executed — click to mark not done' : 'Executed')
    : state === 'running'
      ? 'Running'
      : state === 'stalled'
        ? 'Stalled — no output recently'
        : state === 'skipped'
          ? (clickable ? 'Skipped — click to mark complete, which lands its kept work' : 'Skipped — nothing of it landed')
          : (clickable ? 'Click to mark executed' : 'To do');
  return (
    <span
      className={`task-check ${state} ${clickable ? 'clickable' : ''}`}
      title={title}
      onClick={(e) => {
        if (!clickable) return;
        e.stopPropagation();
        toggle!(taskId!);
      }}
    >
      {state === 'done' && (
        <svg viewBox="0 0 16 16" aria-hidden="true">
          <path d="M4.2 8.6l2.4 2.4 5.2-5.6" fill="none" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      )}
    </span>
  );
}

const ACTION_CLASS: Record<TaskRowAction, string> = {
  cancel: 'cancel', 'resume-now': 'start', 'cancel-resume': 'cancel', skip: 'skip', 'force-start': 'start', complete: 'start', uncomplete: 'skip',
};

const ACTION_LABELS: Record<TaskRowAction, string> = {
  cancel: 'Cancel', 'resume-now': 'Resume Now', 'cancel-resume': 'Don\'t Resume', skip: 'Skip', 'force-start': 'Start', complete: 'Mark Complete', uncomplete: 'Mark Not Done',
};

/**
 * The header's controls for a task paused on a usage limit (#84), shown
 * whether or not the plan reads as executing: the pause holds the run, so a
 * held run's card would otherwise hide them.
 */
export function UsageLimitControls({ taskId, row, onResumeNow, onCancelResume }: {
  taskId: string;
  row: Pick<TaskRowView, 'resumes' | 'actions'>;
  onResumeNow?: (taskId: string) => void;
  onCancelResume?: (taskId: string) => void;
}) {
  return (
    <>
      {row.resumes && (
        <span className="task-isolation-badge gate" title="Its runner hit its usage limit. The task resumes on its own once the limit resets.">
          {row.resumes}
        </span>
      )}
      {row.actions.includes('resume-now') && onResumeNow && (
        <button type="button" className="task-log-open-btn"
          onClick={(e) => { e.stopPropagation(); onResumeNow(taskId); }}
          title="The limit has reset: resume it in its saved session now">
          Resume now
        </button>
      )}
      {row.resumes && onCancelResume && (
        <button type="button" className="task-log-open-btn"
          onClick={(e) => { e.stopPropagation(); onCancelResume(taskId); }}
          title="Keep it from resuming on its own: resume or retry it yourself once the limit resets">
          Don't resume
        </button>
      )}
    </>
  );
}

/** The buttons a running plan offers on a card, in the order core lays them out. */
export function TaskActions({ taskId, actions, labels, handlers }: {
  taskId: string;
  actions: TaskRowAction[];
  labels: Record<TaskRowAction, string>;
  handlers: Partial<Record<TaskRowAction, (taskId: string) => void>>;
}) {
  return (
    <div className="task-actions">
      {actions.map((action) => {
        const handler = handlers[action];
        return handler && (
          <button key={action} className={`task-action-btn ${ACTION_CLASS[action]}`} onClick={(e) => { e.stopPropagation(); handler(taskId); }}>
            {labels[action]}
          </button>
        );
      })}
    </div>
  );
}

/**
 * A compact composer on a running or waiting task's card (ADR-0018, M1;
 * ADR-0023, F1). Send is the plain task message the log sends; Ctrl+Enter
 * interrupts the running turn and delivers this one next, as `ctrl-s` does in
 * the TUI and in the log. A task paused on a usage limit has no turn to
 * interrupt: its message resumes it, after the reset notice.
 */
export function TaskMessageBox({ taskId, onSend, onSendNow, working = false, resumes = false }: {
  taskId: string;
  onSend: (taskId: string, text: string) => void;
  onSendNow: (taskId: string, text: string) => void;
  /** A turn is live, so Enter queues and Ctrl+Enter sends now. */
  working?: boolean;
  resumes?: boolean;
}) {
  const [text, setText] = useState('');
  const [error, setError] = useState('');
  const { commands, invoke } = useTaskCommands(taskId);
  const completion = useRunnerCommands(text, setText, commands);
  const canSend = text.trim().length > 0;
  const send = () => {
    if (!canSend) return;
    try {
      const command = taskCommand(text.trim(), commands);
      if (command && !resumes) invoke(command.name, command.args);
      else onSend(taskId, text.trim());
      setError('');
      setText('');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };
  const nativeSlash = text.trim().startsWith('/') && commands.length > 0;
  const queues = working && canSend && !resumes && !nativeSlash;
  const sendNow = () => { if (nativeSlash) { send(); return; } if (canSend) { onSendNow(taskId, text.trim()); setText(''); } };
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.nativeEvent.isComposing || completion.keyDown(e)) return;
    if (e.key !== 'Enter' || e.shiftKey) return;
    e.preventDefault();
    if (isSendNowKey(e) && !resumes) sendNow(); else send();
  };
  return (
    <div className="task-message-box" onClick={(e) => e.stopPropagation()}>
      {completion.palette}
      {error && <span className="task-command-error" role="alert">{error}</span>}
      <textarea className="task-message-input" value={text} rows={1}
        placeholder={resumes ? 'The limit has reset? A message to resume it with… (Enter to resume)' : 'Message the task… (Enter to send)'}
        onChange={(e) => completion.change(e.target.value)} onKeyDown={onKeyDown} />
      <button type="button" className="task-message-send" disabled={!canSend} onClick={send}
        title={queues ? QUEUE_TITLE : `${resumes ? 'Resume' : 'Send'} (Enter)`}>
        {resumes ? 'Resume' : 'Send'}
      </button>
      {queues && <SendKeyHint />}
    </div>
  );
}

const DEFAULT_MODES: RunnerMode[] = [
  { id: 'build', label: 'Build', description: 'Edit files and run commands' },
  { id: 'plan', label: 'Plan', description: 'Read-only analysis' },
];

/**
 * The runner list a task's picker offers. The task's own runner is always in it,
 * even when missing from the installed set (uninstalled since planning, or a
 * model discovery didn't see): a select that dropped it would fall back to
 * displaying some other runner and misreport what the task will be spawned on.
 */
export function runnerOptionsFor(runners: RunnerOption[] | undefined, assignedRunner: string): RunnerOption[] {
  if (!runners || runners.length === 0) return [];
  if (runners.some((r) => r.id === assignedRunner)) return runners;
  return [...runners, { id: assignedRunner, displayName: assignedRunner }];
}

export default function TaskCard({ task, run, models, modes, modelsByRunner, modesByRunner, runners, configuredProviders, modelApiMapping, isExecuting, output, onResolveConflict, dependentCount, siblings, onDependenciesChange, onRunnerChange, onModelChange, onModelsRefreshNeeded, onModeChange, onOpsChange, taskSkills, onSkillsChange, onRemoveTask, onPromptChange, onRetry, onSkip, onCancel, onCancelResume, onResumeNow, onForceStart, onMarkComplete, onMarkIncomplete, onRunTask, onSendMessage, onSendMessageNow, onOpenLog, expanded: expandedProp, onExpandedChange }: TaskCardProps) {
  const [internalExpanded, setInternalExpanded] = useState(false);
  const isControlled = expandedProp !== undefined;
  const expanded = isControlled ? expandedProp : internalExpanded;
  const setExpanded = (next: boolean) => {
    if (isControlled) onExpandedChange?.(next);
    else setInternalExpanded(next);
  };
  const [editingPrompt, setEditingPrompt] = useState<string | null>(null);
  const [editingDeps, setEditingDeps] = useState(false);
  const [completedSteps, setCompletedSteps] = useState<Set<number>>(new Set());
  const [offeringResolve, setOfferingResolve] = useState(false);
  const sortedSubtasks = [...task.subtasks].sort((a, b) => a.order - b.order);

  // The run's word on this task: absent until the host has folded a run, and
  // then authoritative over the plan for everything status-only.
  const idleSince = run?.idleSince ?? null;
  const awaitingApproval = run?.awaitingApproval ?? 0;
  const isolation = run?.isolation ?? null;
  const mergeGate = run?.mergeGate;

  const isolatedWork = isolation && isolation.state !== 'none' ? isolation : null;
  const activeModes = modes && modes.length > 0 ? modes : DEFAULT_MODES;
  const row = taskRowView({ ...task, idleSince, awaitingApproval, isolation, mergeGate, continuable: run?.continuable === true }, { tasks: siblings, modes: activeModes });
  const conflictFiles = isolatedWork?.conflictFiles ?? [];
  const repair = isolatedWork?.repair ?? null;

  const outputRef = useFollowOutput<HTMLPreElement>(output);

  const status = statusBadge(row);
  const isUserTask = task.type === 'user';

  const handlePromptSave = () => {
    if (editingPrompt !== null && editingPrompt !== task.prompt) {
      onPromptChange?.(task.id, editingPrompt);
    }
    setEditingPrompt(null);
  };

  const handlePromptKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) handlePromptSave();
    if (e.key === 'Escape') {
      e.preventDefault();
      setEditingPrompt(null);
    }
  };

  const toggleStep = (order: number) => {
    setCompletedSteps((prev) => {
      const next = new Set(prev);
      if (next.has(order)) next.delete(order); else next.add(order);
      return next;
    });
  };

  const allStepsComplete = task.userSteps?.every((s) => completedSteps.has(s.order)) ?? false;



  const runnerOptions = runnerOptionsFor(runners, task.assignedRunner);
  const canEditDeps = !isExecuting && !!onDependenciesChange;
  // Only a running or waiting AI task has a runner turn to reach; a manual task
  // or one not yet started has none. One paused on a usage limit is reached
  // by resuming it, which needs its saved session.
  const paused = pausedOnLimit(task);
  const resumable = row.actions.includes('resume-now');
  const canMessage = task.type === 'ai'
    && (row.status === 'running' || row.status === 'quiet' || (row.status === 'awaiting' && (!paused || resumable)))
    && !!onSendMessage && !!onSendMessageNow;

  return (
    <div className={`task-card task-${task.type} ${expanded ? 'expanded' : ''}`}>
      <div className="task-card-header" onClick={() => setExpanded(!expanded)}>
        <TaskCheck row={row} taskId={task.id} onMarkComplete={onMarkComplete} onMarkIncomplete={onMarkIncomplete} />
        <span className="task-order">{row.orderLabel}</span>
        <span className={`task-type-badge ${task.type}`}>
          {isUserTask ? 'Manual' : 'AI'}
        </span>
        {row.kind === 'ops' && (
          <span className="task-type-badge ops" title="An ops task: it changes no repository files and runs in your checkout, once the work it depends on is merged">Ops</span>
        )}
        <span className="task-title-text">{task.title}</span>
        {task.addedBy === 'supervisor' && (
          <span className="task-type-badge supervisor" title="The supervisor added this task during the run, at Act: it is approved to run without asking you">Added by supervisor</span>
        )}

        {/* As plain as a task that waits on the user (ADR-0020). */}
        <UsageLimitControls taskId={task.id} row={row} onResumeNow={onResumeNow} onCancelResume={onCancelResume} />

        {row.mergeGate && (
          <span className="task-isolation-badge gate"
            title={`The work of ${row.mergeGate.join(', ')} is not merged into your branch yet. Merge all lets this task go on.`}>
            Waits for Merge all
          </span>
        )}

        {/* A stopped integration is not a hidden failure (US33) — visible on the
            collapsed card, since it is the one isolation state that needs a
            decision, not just inspection. */}
        {row.conflict && (
          <span className="task-isolation-badge conflict" title={`Integrating this task conflicted${row.conflict.repo ? ` in ${row.conflict.repo}` : ''}${row.conflict.files ? `: ${row.conflict.files}` : ''}. Its worktree and branch are kept.`}>
            Conflict{row.conflict.repo ? ` in ${row.conflict.repo}` : ''}
          </span>
        )}

        {/* Still running, so it reads as progress, not a blocker like a conflict (ADR-0015). */}
        {row.repairing && (
          <span className="task-isolation-badge repairing" title={`Repairing the conflict in its own worktree${row.repairing.files ? `: ${row.repairing.files}` : ''}.`}>
            Repairing{row.repairing.attempt ? ` (${row.repairing.attempt.attempt} of ${row.repairing.attempt.limit})` : ''}
          </span>
        )}

        {/* Approvals arrive mid-turn and leave the status alone (ADR-0018,
            A1), so waiting on one is a badge beside it, which opens the log
            where the request is answered. */}
        {row.approvals && (
          <button type="button" className="task-approval-badge"
            onClick={(e) => { e.stopPropagation(); onOpenLog?.(task.id); }}
            title="The runner is waiting for you to allow or deny a tool call — open the log to answer">
            {row.approvals}
          </button>
        )}

        {onOpenLog && (
          <button type="button" className="task-log-open-btn"
            onClick={(e) => { e.stopPropagation(); onOpenLog(task.id); }}
            title="Open this task's log in an editor tab">
            Open log
          </button>
        )}

        {/* The awaiting reason is a badge in its own right (ADR-0018, W1): a
            task held for the user must read as such whether or not a run is
            still being drawn as active — and so must one a failure blocks. */}
        {(isExecuting || row.status === 'failed' || row.status === 'awaiting' || row.status === 'blocked' || row.status === 'skipped') && (
          <>
            <span className={`task-status-dot ${status.cls}`} title={status.label} />
            <span className={`task-status-badge ${status.cls}`}>{status.label}</span>
          </>
        )}

        {canEditDeps ? (
          <button className="task-dep-badge dep-in task-dep-badge-btn"
            title={task.dependencies.length > 0
              ? `Depends on: ${row.dependencies.join(', ')} — click to edit`
              : 'Click to set dependencies'}
            onClick={(e) => { e.stopPropagation(); setExpanded(true); setEditingDeps(true); }}>
            &#8593;{task.dependencies.length}
          </button>
        ) : task.dependencies.length > 0 && (
          <span className="task-dep-badge dep-in" title={`Depends on: ${row.dependencies.join(', ')}`}>
            &#8593;{task.dependencies.length}
          </span>
        )}
        {!!dependentCount && (
          <span className="task-dep-badge dep-out" title={`Required by ${dependentCount} task${dependentCount > 1 ? 's' : ''}`}>
            &#8595;{dependentCount}
          </span>
        )}
        {/* The host confirms removal with a real modal. A `confirm()` here would
            never fire — VS Code sandboxes the webview without `allow-modals`. */}
        {!isExecuting && onRemoveTask && (
          <button className="task-remove-btn" onClick={(e) => { e.stopPropagation(); onRemoveTask(task.id); }} title="Remove task">&#10005;</button>
        )}

        <span className={`task-expand-icon ${expanded ? 'open' : ''}`}>&#9654;</span>
      </div>

      {/* Collapsed, the newest line is the whole signal — "which test is it on"
          without having to open the card. */}
      {!expanded && output && (
        <div className="task-output-peek" onClick={() => setExpanded(true)} title="Show the full tail">
          {lastLine(output)}
        </div>
      )}

      {expanded && (
        <div className="task-card-body">
          <p className="task-description">{task.description}</p>

          {/* Worktrees are an implementation detail unless something needs the
              user's attention (US34) — so the branch and path live in the
              details, and only a conflict earns a header badge. */}
          {isolatedWork && (
            <div className="task-isolation">
              <div className="task-isolation-row"><span className="task-isolation-label">Branch</span><code>{isolatedWork.branch}</code></div>
              <div className="task-isolation-row"><span className="task-isolation-label">Worktree</span><code>{isolatedWork.worktree}</code></div>
              {row.repos.length > 0 && (
                <div className="task-isolation-row task-isolation-repos"><span className="task-isolation-label">Repos</span><code>{row.repos.join(', ')}</code></div>
              )}
              {row.conflict?.repo && (
                <div className="task-isolation-row task-isolation-conflict-repo"><span className="task-isolation-label">Conflict</span><code>{row.conflict.repo}</code></div>
              )}
              {conflictFiles.length > 0 && (
                <div className="task-isolation-row task-isolation-conflict-files"><span className="task-isolation-label">Files</span><code>{capConflictFiles(conflictFiles)}</code></div>
              )}
              {repair && (
                <div className="task-isolation-row task-isolation-repair"><span className="task-isolation-label">Repair</span><code>{repair.attempt} of {repair.limit}</code></div>
              )}
              {row.repaired && (
                <div className="task-isolation-row task-isolation-repaired-note">Landed after repairing a conflict in {row.repaired.files}.</div>
              )}
              {row.conflict && onResolveConflict && (
                offeringResolve ? (
                  <div className="task-isolation-resolve">
                    <span>Resolve this conflict as a new AI task?</span>
                    <button className="task-action-btn run" onClick={(e) => { e.stopPropagation(); onResolveConflict(task.id); setOfferingResolve(false); }}>Resolve as a task</button>
                    <button className="task-action-btn" onClick={(e) => { e.stopPropagation(); setOfferingResolve(false); }}>Cancel</button>
                  </div>
                ) : (
                  <button className="task-action-btn run" onClick={(e) => { e.stopPropagation(); setOfferingResolve(true); }}>Resolve</button>
                )
              )}
            </div>
          )}

          {row.opsChangedFiles && (
            <div className="task-ops-note warn">This ops task changed tracked files in your checkout, and nothing was committed. Check the changes, then mark it complete or retry it.</div>
          )}
          {row.forcedPastGate && (
            <div className="task-ops-note">Force-started before the work of {row.forcedPastGate.join(', ')} was merged into your branch.</div>
          )}

          {output && (
            <div className="task-output">
              <div className="task-output-header">Runner output (tail)</div>
              <pre className="task-output-pre" ref={outputRef}>{output}</pre>
            </div>
          )}

          {canEditDeps ? (
            <div className="task-deps">
              <span className="task-deps-label" onClick={(e) => { e.stopPropagation(); setEditingDeps(!editingDeps); }}
                title="Edit dependencies">
                Depends on: {row.dependencies.length > 0 ? row.dependencies.join(', ') : 'nothing'}
                <span className="task-prompt-edit-icon">&#9998;</span>
              </span>
              {editingDeps && (
                <DependencyPicker candidates={dependencyCandidates(siblings ?? [], task.id)}
                  selected={task.dependencies}
                  onChange={(ids) => onDependenciesChange!(task.id, ids)}
                  onDone={() => setEditingDeps(false)} />
              )}
            </div>
          ) : task.dependencies.length > 0 && (
            <div className="task-deps">Depends on: {row.dependencies.join(', ')}</div>
          )}

          {task.verdict && (
            <div className={`task-review ${task.verdict.outcome === 'pass' ? 'review-pass' : 'review-neutral'}`}>
              <div className="task-review-summary">
                {task.verdict.outcome === 'pass' ? 'Verified' : 'Failed verification'} — {task.verdict.reason}
              </div>
              {task.verdict.checks.length > 0 && (
                <div className="task-review-checks">
                  {task.verdict.checks.map((check) => (
                    <div key={check.name} className={`check-item ${check.skipped ? 'check-skipped' : check.passed ? 'check-passed' : 'check-failed'}`}>
                      <span className="check-icon">{check.skipped ? '×' : check.passed ? '✓' : '✗'}</span>
                      <span className="check-name">{checkLabel(check.name)}</span>
                      <span className="check-status">{check.skipped ? 'skipped' : check.passed ? 'passed' : 'failed'}</span>
                      {check.detail && <span className="check-detail">{check.detail}</span>}
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {!isExecuting && isUserTask && task.userSteps && task.userSteps.length > 0 && (
            <div className="user-step-guide">
              <div className="user-step-guide-header">Step-by-Step Guide</div>
              {task.userSteps.map((step) => (
                <div key={step.order} className="user-step-item">
                  <span className="user-step-number">{step.order}</span>
                  <span className="user-step-text">{step.instruction}</span>
                </div>
              ))}
            </div>
          )}

          {isExecuting && isUserTask && task.userSteps && task.userSteps.length > 0 && (
            <div className="steps-section">
              <div className="steps-section-header">Steps</div>
              <ol className="steps-list">
                {task.userSteps.sort((a, b) => a.order - b.order).map((step) => (
                  <li key={step.order} className={`step-item ${completedSteps.has(step.order) ? 'completed' : ''}`}
                    onClick={(e) => { e.stopPropagation(); toggleStep(step.order); }}>
                    <span className="step-checkbox">{completedSteps.has(step.order) ? '✓' : '○'}</span>
                    <span className="step-text">{step.instruction}</span>
                  </li>
                ))}
              </ol>
              {onMarkComplete && (
                <div className="step-actions">
                  <button className="step-complete-btn" disabled={!allStepsComplete && task.userSteps!.length > 0}
                    onClick={(e) => { e.stopPropagation(); onMarkComplete(task.id); }}>
                    Mark Complete
                  </button>
                  {!allStepsComplete && task.userSteps!.length > 0 && (
                    <span className="step-hint">Complete all steps above first</span>
                  )}
                </div>
              )}
            </div>
          )}

          {!isExecuting && task.type === 'ai' && task.prompt && (
            editingPrompt === null ? (
              <div className="task-prompt task-prompt-editable" onClick={(e) => { e.stopPropagation(); setEditingPrompt(task.prompt ?? ''); }} title="Click to edit prompt">
                {task.prompt}
                <span className="task-prompt-edit-icon">&#9998;</span>
              </div>
            ) : (
              <div className="task-prompt-edit-wrapper">
                <textarea className="task-prompt-textarea" value={editingPrompt} onChange={(e) => setEditingPrompt(e.target.value)}
                  onBlur={handlePromptSave} onKeyDown={handlePromptKeyDown} onClick={(e) => e.stopPropagation()}
                  rows={Math.min(editingPrompt.split('\n').length, 20)} autoFocus />
                <div className="task-prompt-edit-actions">
                  <span className="task-prompt-edit-hint">Ctrl+Enter to save &middot; Esc to cancel</span>
                  <button className="task-prompt-save-btn" onMouseDown={(e) => { e.preventDefault(); handlePromptSave(); }}>Save</button>
                </div>
              </div>
            )
          )}

          {isExecuting && task.type === 'ai' && task.prompt && (
            <div className="task-prompt task-prompt-readonly">{task.prompt}</div>
          )}

          {/* Runner first: it decides which models, efforts and modes exist below it. */}
          {!isExecuting && task.type === 'ai' && runnerOptions.length > 0 && onRunnerChange && (
            <div className="model-selector" style={{ marginTop: '8px' }}>
              <label htmlFor={`task-runner-${task.id}`}>Runner</label>
              <select id={`task-runner-${task.id}`} value={task.assignedRunner}
                onChange={(e) => onRunnerChange(task.id, e.target.value)}>
                {runnerOptions.map((r) => (
                  <option key={r.id} value={r.id}>{r.displayName}</option>
                ))}
              </select>
            </div>
          )}

          {!isExecuting && task.type === 'ai' && models.length > 0 && onModelChange && (
            <ModelSelector models={models} currentModel={task.assignedModel}
              configuredProviders={configuredProviders} modelApiMapping={modelApiMapping}
              onChange={(assignment) => onModelChange(task.id, assignment)}
              onOpen={onModelsRefreshNeeded} />
          )}

          {/* The header no longer carries the model, so a card with no catalog to pick from still has to say which model it holds. */}
          {!isExecuting && task.type === 'ai' && task.assignedModel && !(models.length > 0 && onModelChange) && (
            <div className="model-selector" style={{ marginTop: '8px' }}>
              <label>Model</label>
              <span>
                {task.assignedModel.modelLabel}
                {task.assignedModel.thinkingEffort && <> &middot; {task.assignedModel.thinkingEffort}</>}
              </span>
            </div>
          )}

          {!isExecuting && task.type === 'ai' && onModeChange && (
            <div className="model-selector" style={{ marginTop: '8px' }}>
              <label htmlFor={`task-mode-${task.id}`}
                title={row.autonomous ? 'Full: runs without permission prompts — /auto changes the level' : undefined}>
                Mode{row.autonomous && ' ⚡'}
              </label>
              <select id={`task-mode-${task.id}`} value={task.taskMode ?? activeModes[0]?.id ?? 'build'}
                onChange={(e) => onModeChange(task.id, e.target.value)}>
                {activeModes.map((m) => (
                  <option key={m.id} value={m.id} disabled={!!m.unavailable}>{m.label} — {m.unavailable ?? m.description}</option>
                ))}
              </select>
            </div>
          )}

          {task.type === 'ai' && (
            <SkillChips idPrefix="task" taskId={task.id} skills={task.skills} catalog={taskSkills}
              onChange={!isExecuting ? onSkillsChange : undefined} />
          )}

          {!isExecuting && onOpsChange && row.opsEditable && (
            <label className="task-ops-toggle" title="An ops task changes no repository files: it acts on outside systems or on your branch's refs, from your checkout, once the work it depends on is merged.">
              <input type="checkbox" checked={!!task.ops} onChange={(e) => onOpsChange(task.id, e.target.checked)} />
              Ops task — runs in your checkout, not a worktree
            </label>
          )}

          {!isExecuting && task.type === 'ai' && onRunTask && (
            <div className="task-run-btn-wrapper">
              <button className="task-action-btn run" onClick={(e) => { e.stopPropagation(); onRunTask(task.id); }}>
                Run Task
              </button>
            </div>
          )}

          {sortedSubtasks.length > 0 && (
            <div className="subtasks">
              {sortedSubtasks.map((sub) => {
                // A subtask can run on a different runner than its parent, so its
                // pickers must be scoped to ITS OWN assignedRunner, not the
                // parent's — reusing the parent's `models`/`modes` here would
                // show the wrong runner's catalog (or none at all).
                const subRunner = sub.assignedRunner;
                const subRunnerModels = subRunner ? modelsByRunner?.[subRunner] : undefined;
                const subModels = subRunnerModels && subRunnerModels.length > 0 ? subRunnerModels : models;
                const subModes = subRunner ? (modesByRunner?.[subRunner] ?? []) : [];
                return (
                  <SubTaskCard key={sub.id} task={sub} parentTask={task} tasks={siblings} models={subModels}
                    modes={subModes} runners={runners} effectiveRunner={subRunner}
                    configuredProviders={configuredProviders} modelApiMapping={modelApiMapping}
                    isExecuting={isExecuting}
                    onRunnerChange={onRunnerChange}
                    onModelChange={onModelChange} onModelsRefreshNeeded={onModelsRefreshNeeded} onModeChange={onModeChange}
                    taskSkills={taskSkills} onSkillsChange={onSkillsChange}
                    onRemoveTask={onRemoveTask} onPromptChange={onPromptChange}
                    onRetry={onRetry} onSkip={onSkip} onCancel={onCancel} onCancelResume={onCancelResume} onResumeNow={onResumeNow}
                    onForceStart={onForceStart} onMarkComplete={onMarkComplete}
                    onMarkIncomplete={onMarkIncomplete}
                    onRunTask={onRunTask} onOpenLog={onOpenLog} />
                );
              })}
            </div>
          )}

          {canMessage && <TaskMessageBox taskId={task.id} onSend={onSendMessage!} onSendNow={onSendMessageNow!}
            working={row.status === 'running' || row.status === 'quiet'} resumes={paused} />}

          {/* A usage-limit pause holds the run, which then reads as not executing. */}
          {(isExecuting || paused) && (
            <TaskActions taskId={task.id} actions={row.actions} labels={ACTION_LABELS}
              handlers={{ cancel: onCancel, 'resume-now': onResumeNow, 'cancel-resume': onCancelResume, skip: onSkip, 'force-start': onForceStart, complete: onMarkComplete, uncomplete: onMarkIncomplete }} />
          )}
        </div>
      )}
    </div>
  );
}
