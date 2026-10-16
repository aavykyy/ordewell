import type { Task } from '../models/Task';
import type { PlanStore } from './PlanStore';
import type { IsolationRunController } from './IsolationRunController';
import { classifyAttempt, mergeExcludes } from './attemptKind';
import { blockingFailures } from './blocking';

/** What the scheduler may read to decide what runs: read-only plan state, the holds, and the open isolated run. */
export interface ReadinessInput {
  store: Pick<PlanStore, 'allTasks' | 'get' | 'isCompleted' | 'isSkipped' | 'isOps'>;
  /** Task ids pulled out of auto-scheduling (cancelled, or a spawn that failed). */
  onHold: ReadonlySet<string>;
  /** The user's approval record (ADR-0035): a task outside it waits for them, however ready it is. */
  approved: (taskId: string) => boolean;
  /**
   * The open isolated run's records — `openRecord` answers undefined for a
   * shared-root run — and which landed work still waits to be merged into
   * the user's branch.
   */
  runs: Pick<IsolationRunController, 'openRecord' | 'awaitsMerge'>;
  /** Attempts already holding a slot. */
  active: number;
  maxParallel: number;
  /** A Merge all is under way, so no work it excludes may start (ADR-0020). */
  merging?: boolean;
}

/** One AI task the gates held back, with why, for the scheduler's log. */
export interface ReadyTaskExclusion {
  task: Readonly<Task>;
  reasons: string[];
}

export interface Readiness {
  /** The tasks to start, lowest order first, capped at the free slots. */
  ready: Task[];
  /** How many tasks passed every gate, before the slot cap. */
  candidateCount: number;
  /** AI tasks with a prompt the gates held back, with why. Empty when the slots are full. */
  excluded: ReadyTaskExclusion[];
  /** Ops tasks held back by nothing but their merge gate. */
  gated: Task[];
}

/**
 * The scheduler's readiness rule as one pure function over the plan and the
 * holds: an AI task with a prompt is ready while it is pending or approved,
 * approved by the user (ADR-0035), off hold, not blocked (ADR-0034), and every
 * dependency's work is on the integration branch. An ops task also waits at its merge gate, and while a Merge all is
 * under way (ADR-0020). `active` is the slots already taken, so no more than
 * `maxParallel` run at once.
 */
export function selectReadyTasks(input: ReadinessInput): Readiness {
  const { store, onHold, runs, active, maxParallel } = input;
  if (active >= maxParallel) return { ready: [], candidateCount: 0, excluded: [], gated: [] };
  const availableSlots = maxParallel - active;

  const blocked = blockingFailures(store.allTasks);
  const gated: Task[] = [];
  const candidates = store.allTasks.filter((t) => {
    if (t.status !== 'pending' && t.status !== 'approved') return false;
    if (t.type === 'user') return false;
    if (!t.prompt) return false;
    if (onHold.has(t.id)) return false;
    if (!input.approved(t.id)) return false;
    if (blockedIn(t, blocked)) return false;
    if (unmetDependencies(t, store, runs).length > 0) return false;
    if (heldByMerge(t, input)) return false;
    if (mergeGate(t, store, runs).length > 0) {
      gated.push(t);
      return false;
    }
    return true;
  });

  const excluded = store.allTasks
    .filter((t) => t.type === 'ai' && t.prompt && !candidates.includes(t))
    .map((task) => ({ task, reasons: exclusionReasons(task, input, blocked) }));

  return {
    ready: candidates.sort((a, b) => a.order - b.order).slice(0, availableSlots),
    candidateCount: candidates.length,
    excluded,
    gated,
  };
}

/** A task is blocked when it was parked as blocked, or a dependency of it failed or is blocked (ADR-0034). */
export function isBlocked(task: Readonly<Task>, store: Pick<PlanStore, 'allTasks'>): boolean {
  return blockedIn(task, blockingFailures(store.allTasks));
}

const blockedIn = (task: Readonly<Task>, blocked: ReadonlyMap<string, string[]>): boolean =>
  task.status === 'blocked' || blocked.has(task.id);

/** What the dependency rule reads of the plan. */
type DependencyStore = Pick<PlanStore, 'allTasks' | 'get' | 'isCompleted' | 'isSkipped'>;

/**
 * In an isolated run a dependency is met once its work is on the integration
 * branch, not merely once it passed: the dependent's worktree is cut from that
 * branch, so starting earlier would hand it a tree without the work it depends
 * on. A skipped dependency lands nothing of its own, but the work it waited
 * on is still what the dependent builds on: it is met once the tasks behind
 * it are, by the same rule (see {@link unmetDependencies}).
 */
export function dependencyMet(
  depId: string,
  store: DependencyStore,
  runs: Pick<IsolationRunController, 'openRecord'>,
): boolean {
  return waitingBehind([depId], store, runs).length === 0;
}

/**
 * The tasks a task's dependencies still hold it back for, nearest first and
 * each named once: a dependency not met yet, or, through a skipped one, the
 * nearest unmet tasks behind it. Behind a skip, a failed or blocked task holds nothing
 * back: skipping is how the user releases the dependents of work that
 * cannot finish (ADR-0034), so only work still under way or yet to run is
 * waited for.
 */
export function unmetDependencies(
  task: Readonly<Pick<Task, 'dependencies'>>,
  store: DependencyStore,
  runs: Pick<IsolationRunController, 'openRecord'>,
): string[] {
  return waitingBehind(task.dependencies, store, runs);
}

function waitingBehind(
  depIds: readonly string[],
  store: DependencyStore,
  runs: Pick<IsolationRunController, 'openRecord'>,
): string[] {
  const seen = new Set<string>();
  const waiting: string[] = [];
  // Only a walk through a skip needs it, and most never take one.
  let blocked: ReadonlyMap<string, string[]> | undefined;
  const deadEnd = (id: string): boolean => {
    const task = store.get(id);
    if (task?.status === 'failed' || task?.status === 'blocked') return true;
    blocked ??= blockingFailures(store.allTasks);
    return blocked.has(id);
  };
  // Breadth first, so a task that is also a direct dependency is judged as one.
  const queue = depIds.map((id) => ({ id, behindSkip: false }));
  for (let next = queue.shift(); next !== undefined; next = queue.shift()) {
    const { id, behindSkip } = next;
    if (seen.has(id)) continue;
    seen.add(id);
    if (store.isSkipped(id)) queue.push(...(store.get(id)?.dependencies ?? []).map((dep) => ({ id: dep, behindSkip: true })));
    else if (!landed(id, store, runs) && !(behindSkip && deadEnd(id))) waiting.push(id);
  }
  return waiting;
}

/** Completed, and in an isolated run merged into the integration branch. */
function landed(id: string, store: Pick<PlanStore, 'isCompleted'>, runs: Pick<IsolationRunController, 'openRecord'>): boolean {
  if (!store.isCompleted(id)) return false;
  const record = runs.openRecord(id);
  return !record || record.status === 'merged';
}

/**
 * The merge gate (ADR-0020): the completed ancestors of a task that runs
 * outside a worktree — an ops task or a user task — whose landed work is not
 * in the user's branch yet. What it acts on, or what the user checks by hand,
 * is their checkout, which does not hold that work until it is merged. Every
 * ancestor counts, not only the direct dependencies: a dependency on a
 * verification that landed nothing still means the work it verified. Empty
 * for a change task, and for any task of a run that never isolated.
 */
export function mergeGate(
  task: Readonly<Task>,
  store: Pick<PlanStore, 'get' | 'isCompleted' | 'isOps'>,
  runs: Pick<IsolationRunController, 'awaitsMerge'>,
): string[] {
  if (task.type !== 'user' && !store.isOps(task.id)) return [];
  return ancestors(task, store).filter((id) => store.isCompleted(id) && runs.awaitsMerge(id));
}

/** Every task a task depends on, directly or through others, nearest first; a cycle is walked once. */
function ancestors(task: Readonly<Task>, store: Pick<PlanStore, 'get'>): string[] {
  const seen = new Set<string>([task.id]);
  const queue = [...task.dependencies];
  const found: string[] = [];
  for (let id = queue.shift(); id !== undefined; id = queue.shift()) {
    if (seen.has(id)) continue;
    seen.add(id);
    found.push(id);
    queue.push(...(store.get(id)?.dependencies ?? []));
  }
  return found;
}

function exclusionReasons(task: Readonly<Task>, input: ReadinessInput, blocked: ReadonlyMap<string, string[]>): string[] {
  const { store, onHold, runs } = input;
  const reasons: string[] = [];
  if (task.status !== 'pending' && task.status !== 'approved') reasons.push(`status=${task.status}`);
  if (onHold.has(task.id)) reasons.push('on-hold');
  if (!input.approved(task.id)) reasons.push('unapproved');
  if (blockedIn(task, blocked)) reasons.push('blocked');
  const unmet = unmetDependencies(task, store, runs);
  if (unmet.length > 0) reasons.push(`deps=${unmet.join(',')}`);
  if (mergeGate(task, store, runs).length > 0) reasons.push('merge-gate');
  if (heldByMerge(task, input)) reasons.push('merging');
  return reasons;
}

/** A Merge all under way holds back the work it excludes (ADR-0020). */
function heldByMerge(task: Readonly<Task>, input: ReadinessInput): boolean {
  return input.merging === true && mergeExcludes(classifyAttempt(input.store.isOps(task.id)));
}
