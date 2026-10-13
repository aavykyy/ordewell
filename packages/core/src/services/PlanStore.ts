import {
  Task, TaskSnapshot, TaskStatus, RunnerId, AwaitingReason, DEFAULT_RUNNERS, flattenTasks,
  addTaskToPlan, removeTaskFromPlan, updateTaskInPlan,
  opsFlag, waitsForReset,
} from '../models/Task';
import { startAttemptUsage, addAttemptUsage, endAttemptUsage, type UsageRecord } from '../models/Usage';

/** Deep copy of a task tree, down to the arrays the store rewrites. */
function cloneTasks(tasks: ReadonlyArray<Readonly<Task>>): Task[] {
  return tasks.map((t) => ({ ...t, dependencies: [...t.dependencies], ...(t.attemptUsage ? { attemptUsage: structuredClone(t.attemptUsage) } : {}), subtasks: cloneTasks(t.subtasks ?? []) }));
}

/**
 * The deep module owning all plan-shaped state. Holds `planTasks` (the ordered
 * tree the user edits), the flattened `allTasks` view and the `taskMap` index.
 * The orchestrator calls `markCompleted`/`markFailed`/`markInProgress`/`retry`
 * to update task status — it never mutates task state directly.
 *
 * Completion and failure are read from `task.status` and nothing else, so
 * `isCompleted`, `completedCount`, `isAllComplete` and the scheduler's
 * dependency checks cannot disagree. The store owns its task objects: `load`
 * copies what it is given, the getters hand out readonly views, and
 * `snapshot` is the copy a caller may keep or write to disk.
 *
 * `rebuild` is the internal seam that keeps the flat views in sync with the
 * tree.
 *
 * `planRunners` lives here because it's part of the plan's identity (the runner
 * set, carried on the plan). `validateAssignedRunners` is pure store logic.
 */
export class PlanStore {
  private _planTasks: readonly Task[] = [];
  private _allTasks: readonly Task[] = [];
  private _taskMap = new Map<string, Task>();
  /** Task id → the top-level task it hangs under, itself for a top-level task. */
  private _rootMap = new Map<string, Task>();
  private _planRunners: RunnerId[] = [...DEFAULT_RUNNERS];
  private _onMutate: (() => void) | null = null;
  private _executionLog: TaskSnapshot[] = [];

  /** Hook called after every structural mutation (add/remove/update/resetForRun). */
  set onMutate(cb: (() => void) | null) { this._onMutate = cb; }

  get planTasks(): ReadonlyArray<Readonly<Task>> { return this._planTasks; }
  get allTasks(): ReadonlyArray<Readonly<Task>> { return this._allTasks; }
  get planRunners(): RunnerId[] { return this._planRunners; }
  get completedCount(): number { return this.countStatus('completed'); }
  get failedCount(): number { return this.countStatus('failed'); }

  isAllComplete(): boolean { return this._allTasks.every((t) => t.status === 'completed'); }
  isAnyFailed(): boolean { return this._allTasks.some((t) => t.status === 'failed'); }
  isCompleted(id: string): boolean { return this._taskMap.get(id)?.status === 'completed'; }
  isFailed(id: string): boolean { return this._taskMap.get(id)?.status === 'failed'; }

  get(taskId: string): Readonly<Task> | undefined { return this._taskMap.get(taskId); }

  /**
   * Whether a task runs as an ops task (ADR-0020). Only a top-level AI task
   * can be one; a subtask runs with the top-level task it hangs under.
   */
  isOps(taskId: string): boolean {
    const root = this._rootMap.get(taskId);
    return opsFlag(root?.ops, root?.type) === true;
  }

  /** A copy of the task tree, detached from the store: later status changes do not reach it. */
  snapshot(): Task[] { return cloneTasks(this._planTasks); }

  getExecutionLog(): ReadonlyArray<TaskSnapshot> { return this._executionLog; }

  appendToLog(snapshot: TaskSnapshot): void {
    const idx = this._executionLog.findIndex((s) => s.id === snapshot.id);
    this._executionLog = idx >= 0
      ? this._executionLog.map((s, i) => (i === idx ? snapshot : s))
      : [...this._executionLog, snapshot];
  }

  /**
   * Drop a task's archived snapshot. Un-marking a completion has to erase the
   * "finished" record too — dependent tasks are prompted from the log, so a
   * left-behind snapshot would keep feeding them a result that no longer exists.
   */
  removeFromLog(taskId: string): void {
    this._executionLog = this._executionLog.filter((s) => s.id !== taskId);
  }

  clearLog(): void {
    this._executionLog = [];
  }

  private notifyMutate(): void { this._onMutate?.(); }

  private countStatus(status: TaskStatus): number {
    return this._allTasks.filter((t) => t.status === status).length;
  }

  load(tasks: ReadonlyArray<Readonly<Task>>, runners: readonly RunnerId[]): void {
    this._planTasks = cloneTasks(tasks);
    this._planRunners = [...runners];
    this.rebuild();
    // Completed tasks survive a reload so a half-finished plan resumes the
    // remainder (their output summaries still feed dependents). Failed tasks
    // get a fresh chance. In-progress is left alone — load() also runs while
    // a task's runner session is live (forceStartTask); orphaned in_progress
    // from a saved session is normalized at the disk-load boundary instead.
    for (const task of this._allTasks) {
      if (task.status === 'failed') task.status = 'pending';
    }
    this.validateAssignedRunners();
  }

  add(partial: Partial<Task>): Task {
    const oldIds = new Set(this._taskMap.keys());
    this._planTasks = addTaskToPlan(this._planTasks, partial);
    this.rebuild();
    this.notifyMutate();
    return this._allTasks.find(t => !oldIds.has(t.id))!;
  }

  remove(taskId: string): void {
    if (!this._taskMap.has(taskId)) return;
    // `removeTaskFromPlan` detaches the dependency, but a dependent parked at
    // 'blocked' would keep that status with nothing left to release it —
    // `isBlocked` reads the status on its own, so the scheduler would skip the
    // task forever.
    this.unblockDependents(taskId);
    this._planTasks = removeTaskFromPlan(this._planTasks, taskId);
    this.rebuild();
    this.notifyMutate();
  }

  update(taskId: string, changes: Partial<Task>): Task | undefined {
    if (!this._taskMap.has(taskId)) return undefined;
    const safe: Partial<Task> = { ...changes };
    delete safe.id;
    delete safe.order;
    this._planTasks = updateTaskInPlan(this._planTasks, taskId, safe);
    this.rebuild();
    this.notifyMutate();
    return this._taskMap.get(taskId);
  }

  /**
   * Run preparation as one named op: flip every AI task to 'approved'. By
   * default completed tasks keep their status so a reloaded half-finished plan
   * resumes the remainder instead of re-running work that already succeeded;
   * `preserveCompleted: false` is for a freshly committed plan, where
   * everything starts over. `keepScheduledResumes` leaves a task waiting on
   * its runner's usage-limit reset waiting: an edit adopted between runs is
   * not the user starting over.
   */
  resetForRun(opts: { preserveCompleted?: boolean; keepScheduledResumes?: boolean } = {}): void {
    const preserveCompleted = opts.preserveCompleted ?? true;
    for (const t of this._allTasks) {
      if (t.type !== 'ai') continue;
      if (preserveCompleted && t.status === 'completed') continue;
      if (opts.keepScheduledResumes && waitsForReset(t)) continue;
      t.status = 'approved';
      delete t.awaitingReason;
      delete t.resumeAt;
    }
    this.notifyMutate();
  }

  markCompleted(id: string): void {
    this.setStatus(id, 'completed');
  }

  markFailed(id: string): void {
    this.setStatus(id, 'failed');
  }

  markInProgress(id: string): void {
    this.setStatus(id, 'in_progress');
  }

  markAwaitingUser(id: string, reason?: AwaitingReason): void {
    const task = this._taskMap.get(id);
    if (!task) return;
    task.status = 'awaiting_user';
    if (reason) task.awaitingReason = reason;
    else delete task.awaitingReason;
    delete task.resumeAt;
  }

  /** When a task paused on a usage limit resumes on its own; undefined leaves it to a manual retry. */
  setTaskResumeAt(id: string, resumeAt: string | undefined): void {
    const task = this._taskMap.get(id);
    if (!task || task.awaitingReason !== 'usage-limit') return;
    if (resumeAt) task.resumeAt = resumeAt;
    else delete task.resumeAt;
  }

  markPending(id: string): void {
    this.setStatus(id, 'pending');
  }

  retry(id: string): void {
    const task = this._taskMap.get(id);
    if (task) {
      this.setStatus(id, 'pending');
      task.verdict = undefined;
      task.outputSummary = undefined;
      delete task.forcedPastGate;
    }
  }

  /** Kept on the task: it was force-started past its merge gate, before these dependencies' work was merged (ADR-0020). */
  setForcedPastGate(id: string, dependencies: string[]): void {
    const task = this._taskMap.get(id);
    if (task) task.forcedPastGate = dependencies;
  }

  /** A reason outlives nothing: any status but `awaiting_user` drops it, and the resume time with it. */
  private setStatus(id: string, status: Exclude<TaskStatus, 'awaiting_user'>): void {
    const task = this._taskMap.get(id);
    if (!task) return;
    task.status = status;
    delete task.awaitingReason;
    delete task.resumeAt;
  }

  blockDependents(id: string): void {
    for (const t of this._allTasks) {
      if (t.dependencies.includes(id) && t.status !== 'completed') {
        t.status = 'blocked';
      }
    }
  }

  unblockDependents(id: string): void {
    for (const t of this._allTasks) {
      if (t.status === 'blocked' && t.dependencies.includes(id)) {
        t.status = 'pending';
      }
    }
  }

  setTaskVerdict(id: string, verdict: Task['verdict']): void {
    const task = this._taskMap.get(id);
    if (task) task.verdict = verdict;
  }

  setTaskOutputSummary(id: string, summary: Task['outputSummary']): void {
    const task = this._taskMap.get(id);
    if (task) task.outputSummary = summary;
  }

  setTaskRunnerSessionId(id: string, runnerSessionId: string | undefined): void {
    const task = this._taskMap.get(id);
    if (task) task.runnerSessionId = runnerSessionId;
  }

  startAttemptUsage(id: string, attempt: number, runner: string, startedAt: string): void {
    const task = this._taskMap.get(id);
    if (task) task.attemptUsage = [...task.attemptUsage ?? [], startAttemptUsage(attempt, runner, startedAt)];
  }

  recordAttemptUsage(id: string, attempt: number, record: UsageRecord, now: string): void {
    const task = this._taskMap.get(id);
    if (task?.attemptUsage) task.attemptUsage = task.attemptUsage.map((usage) => usage.attempt === attempt ? addAttemptUsage(usage, record, now) : usage);
  }

  endAttemptUsage(id: string, attempt: number, now: string): void {
    const task = this._taskMap.get(id);
    if (task?.attemptUsage) task.attemptUsage = task.attemptUsage.map((usage) => usage.attempt === attempt ? endAttemptUsage(usage, now) : usage);
  }

  setTaskAttemptSkills(id: string, skills: Task['attemptSkills']): void {
    const task = this._taskMap.get(id);
    if (task) task.attemptSkills = skills && skills.length > 0 ? skills : undefined;
  }

  /**
   * Widen the plan's runner set. Retargeting a task onto a runner the plan has
   * not used before has to land here as well as on the plan state, or
   * {@link resolveTaskRunner} reads the new runner as foreign and spawns the
   * plan's first one instead.
   */
  admitRunner(runner: RunnerId): void {
    if (!this._planRunners.includes(runner)) this._planRunners = [...this._planRunners, runner];
  }

  resolveTaskRunner(task: Readonly<Task>): RunnerId {
    if (task.assignedRunner && this._planRunners.includes(task.assignedRunner)) return task.assignedRunner;
    const fallback = this._planRunners[0] ?? DEFAULT_RUNNERS[0];
    if (task.assignedRunner) {
      console.warn(
        `[PlanStore] Task "${task.title}" is assigned to "${task.assignedRunner}", which is not in this plan's ` +
        `runner set [${this._planRunners.join(', ')}] — spawning "${fallback}" instead.`,
      );
    }
    return fallback;
  }

  private rebuild(): void {
    // Frozen because the getters return these arrays as they are; a caller
    // that casts the readonly type away still cannot reshape the plan.
    Object.freeze(this._planTasks);
    this._allTasks = Object.freeze(flattenTasks(this._planTasks));
    this._taskMap.clear();
    for (const task of this._allTasks) {
      this._taskMap.set(task.id, task);
    }
    this._rootMap.clear();
    for (const root of this._planTasks) {
      for (const task of flattenTasks([root])) this._rootMap.set(task.id, root);
    }
  }

  private validateAssignedRunners(): void {
    for (const task of this._allTasks) {
      if (task.type !== 'ai') continue;
      if (!this._planRunners.includes(task.assignedRunner)) {
        throw new Error(
          `Task "${task.title}" has assignedRunner "${task.assignedRunner}" ` +
          `which is not in the plan's runner set: [${this._planRunners.join(', ')}]`
        );
      }
    }
  }
}
