import { runsAsOps, type Task } from '../models/Task';
import type { PlanStore } from './PlanStore';
import type { IsolationRunController } from './IsolationRunController';
import { classifyAttempt, mergeExcludes } from './attemptKind';
import { blockingFailures } from './blocking';
import { scriptBodyOf } from '../models/ScriptTask';

/**
 * Why a task cannot start now: the one start rule (ADR-0034), which the
 * scheduler, the explicit starts, the command seam's refusals, the task row's
 * merge gate and the planner's notes all read. {@link startWaits} lists every
 * one that holds, in this order, so the first is the reason a task waits.
 */
export type StartWait =
  /** Under way, waiting on the user, or ended: only a retry, a continue or a resume starts it again. */
  | { kind: 'started' }
  /** Mark complete is landing its work. */
  | { kind: 'completing' }
  /** An AI task with no prompt yet, or a script task with no body to run: there is nothing to run. */
  | { kind: 'no-prompt' }
  /** Outside the user's approval record (ADR-0035). */
  | { kind: 'unapproved' }
  /** Pulled out of the scheduler: cancelled, marked not done, or a spawn that failed. */
  | { kind: 'on-hold' }
  /** The failed tasks it waits on through its dependencies (ADR-0034). */
  | { kind: 'blocked'; failed: string[] }
  /** What its dependencies still hold it back for (see {@link unmetDependencies}). */
  | { kind: 'dependencies'; waiting: string[] }
  /** A force start queued behind the dependencies still under way or yet to run, which starts once they finish. */
  | { kind: 'queued'; waiting: string[] }
  /** An ops task, a script task among them, and a Merge all is under way (ADR-0020). */
  | { kind: 'merging' }
  /** Its runner hit its usage limit: nothing more starts on that runner until the reset. */
  | { kind: 'usage-limit'; runner: string }
  /** A planner turn holds new starts until its reply ends (ADR-0029). */
  | { kind: 'start-hold' }
  /** Its merge gate (ADR-0020): the ancestors whose landed work is not in the user's branch yet. */
  | { kind: 'merge-gate'; unmerged: string[] }
  /** A user task: the user does it by hand, and nothing starts it. */
  | { kind: 'by-hand' };

export type StartWaitKind = StartWait['kind'];

/**
 * A start the user forced, which goes past what the scheduler waits for: a
 * hold, a failed dependency (ADR-0034), its runner's usage limit, and the
 * merge gate they confirmed (ADR-0020). Made now, it is the user's own act
 * and goes past the whole gate and a planner turn's start hold. Queued behind
 * its dependencies, it starts later with nobody asking, so it waits for a
 * start hold as the scheduler's starts do, and goes past only the gate it was
 * confirmed past: `pastGate`.
 */
export type ForcedStart = { queued: false } | { queued: true; pastGate: readonly string[] };

/** What the start rule reads: the plan, the holds, and the open isolated run. */
export interface StartRuleInput {
  store: Pick<PlanStore, 'allTasks' | 'get' | 'isCompleted' | 'isSkipped' | 'isOps' | 'resolveTaskRunner'>;
  /** Task ids pulled out of the scheduler (cancelled, marked not done, or a spawn that failed). */
  onHold: Pick<ReadonlySet<string>, 'has'>;
  /** The user's approval record (ADR-0035). */
  approved: (taskId: string) => boolean;
  /**
   * The open isolated run's records — `openRecord` answers undefined for a
   * shared-root run — and which landed work still waits to be merged into
   * the user's branch.
   */
  runs: Pick<IsolationRunController, 'openRecord' | 'awaitsMerge'>;
  /** A Merge all is under way, so no work it excludes may start (ADR-0020). */
  merging: boolean;
  /** A planner turn holds new starts (ADR-0029). */
  startsHeld: boolean;
  /** Tasks Mark complete is landing. */
  completing: Pick<ReadonlySet<string>, 'has'>;
  /** Force starts queued behind their dependencies. */
  queued: Pick<ReadonlySet<string>, 'has'>;
}

/** What the scheduler picks from: the start rule's input, and the slots. */
export interface ReadinessInput extends StartRuleInput {
  /** Attempts already holding a slot. */
  active: number;
  maxParallel: number;
}

/** One AI or script task the start rule held back, with why, for the scheduler's log. */
export interface ReadyTaskExclusion {
  task: Readonly<Task>;
  waits: StartWait[];
}

export interface Readiness {
  /** The tasks to start, lowest order first, capped at the free slots. */
  ready: Task[];
  /** How many tasks nothing holds back, before the slot cap. */
  candidateCount: number;
  /** AI tasks with a prompt, and script tasks, the start rule held back, with why. */
  excluded: ReadyTaskExclusion[];
  /** Tasks held back by nothing but their merge gate ({@link onlyAtGate}), in plan order. */
  gated: Task[];
}

/**
 * Every reason `task` cannot start now, in {@link StartWait}'s order; none
 * when it can. `forced` judges a start the user forced rather than the
 * scheduler's own. A slot is not part of it: the claim takes one.
 */
export function startWaits(task: Readonly<Task>, input: StartRuleInput, forced?: ForcedStart): StartWait[] {
  return waitsOf(task, input, forced, judgeOnce(input.store));
}

/**
 * The scheduler's pick: what nothing holds back, lowest order first, no more
 * than the free slots of `maxParallel` with `active` taken.
 */
export function selectReadyTasks(input: ReadinessInput): Readiness {
  const plan = judgeOnce(input.store);
  const judged = input.store.allTasks.map((task) => ({ task, waits: waitsOf(task, input, undefined, plan) }));
  const candidates = judged.filter(({ waits }) => waits.length === 0).map(({ task }) => task).sort((a, b) => a.order - b.order);
  return {
    ready: candidates.slice(0, Math.max(0, input.maxParallel - input.active)),
    candidateCount: candidates.length,
    excluded: judged.filter(({ task, waits }) => (task.type === 'script' || (task.type === 'ai' && task.prompt)) && waits.length > 0),
    gated: judged.filter(({ waits }) => onlyAtGate(waits)).map(({ task }) => task),
  };
}

/**
 * Held back by nothing but its merge gate, besides the user's own hand: what
 * a Merge all lets start, and what merging at gates automatically merges for.
 */
function onlyAtGate(waits: readonly StartWait[]): boolean {
  return waits.some((w) => w.kind === 'merge-gate') && waits.every((w) => w.kind === 'merge-gate' || w.kind === 'by-hand');
}

/** The wait of `kind` among `waits`, if it holds. */
export function waitOf<K extends StartWaitKind>(waits: readonly StartWait[], kind: K): Extract<StartWait, { kind: K }> | undefined {
  return waits.find((w): w is Extract<StartWait, { kind: K }> => w.kind === kind);
}

/** What one judgement of the whole plan reads, worked out once however many tasks it judges. */
interface PlanJudgement {
  blocked(): ReadonlyMap<string, string[]>;
  /** The runners a task waits on the usage limit of. */
  limited(): ReadonlySet<string>;
}

function judgeOnce(store: StartRuleInput['store']): PlanJudgement {
  let blocked: ReadonlyMap<string, string[]> | undefined;
  let limited: ReadonlySet<string> | undefined;
  return {
    blocked: () => (blocked ??= blockingFailures(store.allTasks)),
    limited: () => (limited ??= new Set(store.allTasks
      .filter((t) => t.status === 'awaiting_user' && t.awaitingReason === 'usage-limit')
      .map((t) => store.resolveTaskRunner(t)))),
  };
}

function waitsOf(task: Readonly<Task>, input: StartRuleInput, forced: ForcedStart | undefined, plan: PlanJudgement): StartWait[] {
  const { store, runs } = input;
  const byHand = task.type === 'user';
  const queued = input.queued.has(task.id);
  const waits: StartWait[] = [];
  if (task.status !== 'pending' && task.status !== 'approved') waits.push({ kind: 'started' });
  if (input.completing.has(task.id)) waits.push({ kind: 'completing' });
  if (task.type === 'ai' ? !task.prompt : task.type === 'script' && !scriptBodyOf(task)) waits.push({ kind: 'no-prompt' });
  if (!input.approved(task.id)) waits.push({ kind: 'unapproved' });
  if (!forced && input.onHold.has(task.id)) waits.push({ kind: 'on-hold' });
  const failed = forced ? [] : plan.blocked().get(task.id) ?? [];
  if (failed.length > 0) waits.push({ kind: 'blocked', failed });
  // A forced start goes past a failure, so only what is still under way holds it.
  const waiting = forced || queued ? underWay(task, store, runs, plan) : unmetDependencies(task, store, runs);
  if (waiting.length > 0) waits.push(queued ? { kind: 'queued', waiting } : { kind: 'dependencies', waiting });
  if (input.merging && mergeExcludes(classifyAttempt(opsOf(task, store)))) waits.push({ kind: 'merging' });
  // A script task runs on no runner, so no runner's limit holds it (ADR-0035).
  if (!forced && task.type === 'ai') {
    const runner = store.resolveTaskRunner(task);
    if (plan.limited().has(runner)) waits.push({ kind: 'usage-limit', runner });
  }
  if (input.startsHeld && !byHand && forced?.queued !== false) waits.push({ kind: 'start-hold' });
  // A start forced now passes the whole gate, which the user confirmed; a queued one only what they confirmed then.
  const confirmed = forced?.queued ? forced.pastGate : [];
  const unmerged = forced?.queued === false ? [] : mergeGate(task, store, runs).filter((id) => !confirmed.includes(id));
  if (unmerged.length > 0) waits.push({ kind: 'merge-gate', unmerged });
  if (byHand) waits.push({ kind: 'by-hand' });
  return waits;
}

/** What the dependency rule reads of the plan. */
type DependencyStore = Pick<PlanStore, 'allTasks' | 'get' | 'isCompleted' | 'isSkipped'>;

/**
 * The tasks a task's dependencies still hold it back for, nearest first and
 * each named once: a dependency not met yet, or, through a skipped one, the
 * nearest unmet tasks behind it. In an isolated run a dependency is met once
 * its work is on the integration branch, not merely once it passed: the
 * dependent's worktree is cut from that branch, so starting earlier would
 * hand it a tree without the work it depends on. A skipped dependency lands
 * nothing of its own, but the work it waited on is still what the dependent
 * builds on. Behind a skip, a failed or blocked task holds nothing back:
 * skipping is how the user releases the dependents of work that cannot
 * finish (ADR-0034), so only work still under way or yet to run is waited for.
 */
export function unmetDependencies(
  task: Readonly<Pick<Task, 'dependencies'>>,
  store: DependencyStore,
  runs: Pick<IsolationRunController, 'openRecord'>,
): string[] {
  return waitingBehind(task.dependencies, store, runs, { pastFailures: false });
}

/**
 * A task's unmet dependencies, less the failed or blocked ones a forced start
 * goes past. A blocked one is gone past for its failure only: the work under
 * way or yet to run that it waits on is still waited for, through it.
 */
function underWay(task: Readonly<Task>, store: DependencyStore, runs: Pick<IsolationRunController, 'openRecord'>, plan: PlanJudgement): string[] {
  return waitingBehind(task.dependencies, store, runs, { pastFailures: true, blocked: plan.blocked });
}

/**
 * Breadth first, so a task that is also a direct dependency is judged as one.
 * A skipped task is walked through to what it waited on, behind which a
 * failed or blocked task is a dead end. `pastFailures` makes a failed task a
 * dead end anywhere, and walks through a blocked one to what it waits on.
 */
function waitingBehind(
  depIds: readonly string[],
  store: DependencyStore,
  runs: Pick<IsolationRunController, 'openRecord'>,
  opts: { pastFailures: boolean; blocked?: () => ReadonlyMap<string, string[]> },
): string[] {
  const seen = new Set<string>();
  const waiting: string[] = [];
  // Only a walk through a skip or past a failure needs it, and most never take one.
  let blocked: ReadonlyMap<string, string[]> | undefined;
  const isBlocked = (id: string): boolean => (blocked ??= opts.blocked?.() ?? blockingFailures(store.allTasks)).has(id);
  const dependenciesOf = (id: string, behindSkip: boolean) => (store.get(id)?.dependencies ?? []).map((dep) => ({ id: dep, behindSkip }));
  const queue = depIds.map((id) => ({ id, behindSkip: false }));
  for (let next = queue.shift(); next !== undefined; next = queue.shift()) {
    const { id, behindSkip } = next;
    if (seen.has(id)) continue;
    seen.add(id);
    if (landed(id, store, runs)) continue;
    if (store.isSkipped(id)) {
      queue.push(...dependenciesOf(id, true));
      continue;
    }
    const failed = store.get(id)?.status === 'failed';
    if (!behindSkip && !opts.pastFailures) waiting.push(id);
    else if (!failed && !isBlocked(id)) waiting.push(id);
    else if (opts.pastFailures && !behindSkip && !failed) queue.push(...dependenciesOf(id, false));
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
 * outside a worktree — an ops task, a script task among them (ADR-0035), or a
 * user task — whose landed work is not
 * in the user's branch yet. What it acts on, or what the user checks by hand,
 * is their checkout, which does not hold that work until it is merged. Every
 * ancestor counts, not only the direct dependencies: a dependency on a
 * verification that landed nothing still means the work it verified. Empty
 * for a change task, and for any task of a run that never isolated. Judged
 * whatever the task's status: a retry of a failed ops task acts on the
 * checkout as a first start does.
 */
export function mergeGate(
  task: Readonly<Task>,
  store: Pick<PlanStore, 'get' | 'isCompleted' | 'isOps'>,
  runs: Pick<IsolationRunController, 'awaitsMerge'>,
): string[] {
  if (task.type !== 'user' && !opsOf(task, store)) return [];
  return ancestors(task, store).filter((id) => store.isCompleted(id) && runs.awaitsMerge(id));
}

/**
 * Whether a task runs as an ops task. One the plan does not hold yet — a held
 * edit adds it, or `run_script` is about to (ADR-0035) — has no root in the
 * store to ask, so it is judged by its own type and flag, as a top-level task.
 */
function opsOf(task: Readonly<Task>, store: Pick<PlanStore, 'get' | 'isOps'>): boolean {
  return store.get(task.id) ? store.isOps(task.id) : runsAsOps(task);
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
