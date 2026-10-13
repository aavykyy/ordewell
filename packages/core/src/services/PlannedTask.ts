import { v4 as uuidv4 } from 'uuid';
import { Task, RunnerId, TaskModelAssignment, createTask, flattenTasksWithParents, inheritedSkills, skillNames } from '../models/Task';
import { plannedMode, type RunnerModeInfo } from './ModeResolver';
import { checkModelAndModeValidity, type EditCatalog } from './TaskEditValidator';

/** One reason a planned task was refused, pinned to the task and field it is about. */
export interface PlanTaskError {
  /** Absent when the envelope itself is wrong rather than one of its tasks. */
  taskId?: string;
  field: string;
  message: string;
}

/** What a planned task may be given: the runners it may run on and their modes. */
export interface IntakeCatalog {
  runners: readonly RunnerId[];
  /** Absent when no runner's modes are known: the mode is then guessed (ADR-0031). */
  runnerModes?: Partial<Record<RunnerId, readonly RunnerModeInfo[]>>;
  autonomousDefault?: boolean;
  /**
   * An edit's assigned models are checked against the catalog and refused; a
   * submitted plan's are coerced after it lands instead (ADR-0003).
   */
  models?: EditCatalog;
}

/** Where a planned task lands, which decides what it inherits. */
export interface Placement {
  /** The task it is a subtask of. */
  parent?: Pick<Task, 'title' | 'sliceType' | 'autonomy'> & { readOnly: boolean };
  /**
   * A task made from others — a merge, or a split part: what the planner
   * leaves out comes from these fields, and it stays read-only when they were.
   */
  from?: { fields: Partial<Task>; readOnly: boolean };
  /**
   * An edit's tasks get ids of their own, so a planner cannot name one after
   * a task already in the plan. A submitted plan keeps the planner's, which
   * its dependencies are written against; one it left out is made up.
   */
  freshIds?: boolean;
}

export interface PlannedTask {
  task: Task;
  /** Rules the task, or one of its subtasks, breaks on its own. */
  errors: PlanTaskError[];
  /**
   * What the planner asked for that is not its to set — a mode, or read-only
   * on a manual task (ADR-0031). A whole plan lands without it; an edit is
   * refused.
   */
  ignored: PlanTaskError[];
  /** The planner's id for each task of the tree that was given a fresh one. */
  renamed: Map<string, string>;
}

/** The planner names no mode (ADR-0031): it says read-only, and the mode follows. */
export const MODE_NOT_THE_PLANNERS = '"taskMode" is the user\'s to choose — set "readOnly": true on a task that must not change files, and leave it out otherwise';

/** A manual task runs in no mode, so it cannot be read-only. */
export const MANUAL_NOT_READ_ONLY = '"readOnly" is for AI tasks — a manual task runs in no mode';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' || typeof value === 'number' ? String(value) : undefined;
}

/**
 * Why a task may not be an ops task (ADR-0020), or null when it may: the flag
 * decides where the task runs, and a manual task runs nowhere, a subtask
 * where its parent does.
 */
export function opsPlacementRefusal(type: Task['type'], isSubtask: boolean): string | null {
  if (type !== 'ai') return 'is a manual task — only an AI task can be an ops task';
  if (isSubtask) return 'is a subtask, which runs with its parent — only a top-level task can be an ops task';
  return null;
}

/** How an error names a task, so the planner can find the object it wrote. */
export function taskWhere(title: string, parentTitle?: string): string {
  return parentTitle !== undefined ? `subtask "${title}" of "${parentTitle}"` : `Task "${title}"`;
}

/**
 * What each planned task asked to attach, as the planner wrote it. Kept beside
 * the task rather than on it: {@link skillNames} drops a name no skill could
 * have, and the plan's skill check still owes a warning for it. A copy of the
 * task (assignment coercion) does not carry it, so check what was planned.
 */
const skillsAsked = new WeakMap<Task, unknown[]>();

/** The `skills` a planned task was submitted with, before normalization; undefined for a task not planned here. */
export function requestedSkills(task: Task): readonly unknown[] | undefined {
  return skillsAsked.get(task);
}

/** The model as a task stores it; a top-level `thinkingEffort` is the model's, as the effort has one home. */
function modelOf(raw: Record<string, unknown>, from: TaskModelAssignment | undefined): TaskModelAssignment | undefined {
  const effort = text(raw.thinkingEffort);
  if (isRecord(raw.assignedModel)) {
    const m = raw.assignedModel;
    return {
      modelId: text(m.modelId) ?? '',
      modelLabel: text(m.modelLabel) ?? '',
      thinkingEffort: text(m.thinkingEffort) ?? effort,
    };
  }
  return from && effort !== undefined ? { ...from, thinkingEffort: effort } : from;
}

/**
 * Build a task from what a planner wrote, by whichever route it arrived: a
 * submitted plan, or an edit that adds, merges or splits. Every fallback a
 * planner's omission meets is here, so the routes cannot drift apart:
 *
 * - the runner is the one named, else the task's it is made from, else the
 *   first one allowed — never a substitute for one named but unknown, which
 *   {@link checkPlanInvariants} refuses;
 * - an AI task's prompt is its own, else its description, else its title, so
 *   it is never unschedulable;
 * - the mode is decided here from read-only or not, never named (ADR-0031);
 * - an AI subtask with no slice classification takes its parent's: an `ai`
 *   sub-step of an AFK slice is AFK. Not a blanket default, which would strip
 *   a human gate the planner intended; a manual subtask must still say HITL.
 */
export function plannedTask(spec: unknown, catalog: IntakeCatalog, at: Placement = {}): PlannedTask {
  const raw = isRecord(spec) ? spec : {};
  const { parent, from, freshIds } = at;
  const base = from?.fields ?? {};
  const errors: PlanTaskError[] = [];
  const ignored: PlanTaskError[] = [];
  const renamed = new Map<string, string>();

  const title = text(raw.title) ?? '';
  const where = taskWhere(title, parent?.title);
  const plannerId = text(raw.id);
  const id = freshIds || !plannerId ? uuidv4() : plannerId;
  if (freshIds && plannerId) renamed.set(plannerId, id);

  const type: Task['type'] = raw.type === 'user' || raw.type === 'ai' ? raw.type : base.type ?? 'ai';
  const ai = type === 'ai';
  const assignedRunner = text(raw.assignedRunner) ?? base.assignedRunner ?? catalog.runners[0] ?? 'claude-code';
  const description = text(raw.description) ?? base.description ?? title;

  // A manual task stores no ops flag, so this is the one place it can still be seen.
  if (raw.ops === true && !ai) errors.push({ taskId: id, field: 'ops', message: `${where} ${opsPlacementRefusal(type, !!parent)}` });
  if (raw.taskMode !== undefined) ignored.push({ taskId: id, field: 'taskMode', message: `${where}: ${MODE_NOT_THE_PLANNERS}` });
  if (!ai && raw.readOnly === true) ignored.push({ taskId: id, field: 'readOnly', message: `${where}: ${MANUAL_NOT_READ_ONLY}` });
  // A read-only task's subtasks run as tasks of their own, so they would
  // otherwise get write access the planner said the work must not have.
  const asked = typeof raw.readOnly === 'boolean' ? raw.readOnly : undefined;
  const readOnly = ai && (asked ?? from?.readOnly ?? parent?.readOnly ?? false);

  let taskMode = base.taskMode;
  if (ai && catalog.runners.includes(assignedRunner)) {
    const mode = plannedMode(assignedRunner, catalog.runnerModes, { readOnly, current: base.taskMode }, catalog.autonomousDefault ?? true);
    if (!mode.ok) errors.push({ taskId: id, field: 'readOnly', message: `${where}: ${mode.error}` });
    else if (mode.mode !== undefined) taskMode = mode.mode;
  }
  // With no runner modes to read, `plan` is the guess that keeps a read-only task from writing.
  if (taskMode === undefined && readOnly && !catalog.runnerModes) taskMode = 'plan';

  const assignedModel = ai ? modelOf(raw, base.assignedModel) : undefined;
  // Only a model the planner named: one carried over from the tasks a merge or split is made of was never its pick.
  if (assignedModel && isRecord(raw.assignedModel) && catalog.models && catalog.runners.includes(assignedRunner)) {
    const validity = checkModelAndModeValidity(assignedRunner, assignedModel, undefined, catalog.models);
    if (!validity.ok) errors.push({ taskId: id, field: 'assignedModel', message: `${where}: ${validity.error}` });
  }

  const slice = (value: unknown): 'AFK' | 'HITL' | undefined => (value === 'AFK' || value === 'HITL' ? value : undefined);
  // Explicit child values always win; inheritance only fills a gap, and only for `ai` tasks.
  const autonomy = ai ? slice(raw.autonomy) ?? base.autonomy ?? parent?.autonomy : undefined;
  const sliceType = slice(raw.sliceType) ?? base.sliceType ?? (ai ? parent?.sliceType : undefined);

  const subtasks: Task[] = [];
  if (Array.isArray(raw.subtasks)) {
    for (const s of raw.subtasks) {
      const child = plannedTask(s, catalog, { parent: { title, sliceType, autonomy, readOnly }, freshIds });
      subtasks.push(child.task);
      errors.push(...child.errors);
      ignored.push(...child.ignored);
      for (const [was, now] of child.renamed) renamed.set(was, now);
    }
  }

  const task = createTask({
    id,
    order: Number(raw.order ?? 0),
    title,
    description,
    type,
    dependencies: Array.isArray(raw.dependencies) ? raw.dependencies.map(String) : base.dependencies ?? [],
    prompt: text(raw.prompt) || base.prompt || (ai ? description || title || undefined : undefined),
    userSteps: Array.isArray(raw.userSteps)
      ? raw.userSteps.map((s) => (isRecord(s) ? s : {})).map((s) => ({ order: Number(s.order ?? 0), instruction: String(s.instruction ?? ''), completed: false }))
      : base.userSteps,
    subtasks,
    assignedModel,
    assignedRunner,
    taskMode,
    autonomy,
    sliceType,
    userStoriesCovered: Array.isArray(raw.userStoriesCovered) ? raw.userStoriesCovered.map(String) : base.userStoriesCovered,
    ops: raw.ops !== undefined ? raw.ops === true : base.ops,
    skills: from ? inheritedSkills(raw.skills, base.skills) : skillNames(raw.skills),
  });
  if (Array.isArray(raw.skills)) skillsAsked.set(task, raw.skills);
  return { task, errors, ignored, renamed };
}

/**
 * The rules a plan's tasks are held to together, subtasks included, whichever
 * route they arrived by.
 */
export function checkPlanInvariants(tasks: readonly Task[], runners: readonly RunnerId[]): PlanTaskError[] {
  const rows = flattenTasksWithParents(tasks);
  const errors: PlanTaskError[] = [];
  const seen = new Set<string>();
  for (const { task: t, parent } of rows) {
    const where = taskWhere(t.title, parent?.title);
    const fail = (field: string, message: string) => errors.push({ taskId: t.id, field, message });
    if (seen.has(t.id)) fail('id', `${where} has id "${t.id}", which another task in the plan has too: every task, subtasks included, needs an id of its own`);
    seen.add(t.id);
    if (t.autonomy === 'AFK' && t.userSteps && t.userSteps.length > 0) {
      fail('userSteps', `${where} has autonomy "AFK" but contains userSteps. AFK tasks must not have user touchpoints.`);
    }
    if (t.type === 'user' && t.sliceType && t.sliceType !== 'HITL') {
      fail('sliceType', `User ${where} has sliceType "${t.sliceType}". User tasks must have sliceType "HITL".`);
    }
    const opsRefused = t.ops ? opsPlacementRefusal(t.type, parent !== null) : null;
    if (opsRefused) fail('ops', `${where} ${opsRefused}`);
    if (t.type !== 'user' && !runners.includes(t.assignedRunner)) {
      fail('assignedRunner', `${where} has invalid assignedRunner "${t.assignedRunner}". Expected one of: ${runners.join(', ')}`);
    }
  }
  const ids = new Set(rows.map((r) => r.task.id));
  for (const { task: t, parent } of rows) {
    for (const dep of t.dependencies) {
      if (!ids.has(dep)) errors.push({ taskId: t.id, field: 'dependencies', message: `${taskWhere(t.title, parent?.title)} depends on "${dep}", which is not a task in the plan` });
    }
  }
  const cycle = findCycle(rows.map((r) => r.task));
  // Pinned to a task on the cycle: a plan whose only fault is a rule a task
  // breaks is worth naming back to the planner, not re-asking for as JSON.
  if (cycle) errors.push({ taskId: cycle[0].id, field: 'dependencies', message: `Dependency cycle detected: ${[...cycle, cycle[0]].map((t) => `"${t.title}"`).join(' → ')}` });
  return errors;
}

/** The tasks on one dependency cycle, in dependency order, or null when there is none. A self-dependency is a cycle of one. */
export function findCycle(tasks: readonly Task[]): Task[] | null {
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const path: string[] = [];
  const done = new Set<string>();
  const visit = (id: string): string[] | null => {
    if (done.has(id)) return null;
    const at = path.indexOf(id);
    if (at >= 0) return path.slice(at);
    path.push(id);
    for (const dep of byId.get(id)?.dependencies ?? []) {
      const hit = visit(dep);
      if (hit) return hit;
    }
    path.pop();
    done.add(id);
    return null;
  };
  for (const t of tasks) {
    const hit = visit(t.id);
    if (hit) return hit.map((id) => byId.get(id)!);
  }
  return null;
}

/** The title of a task on a dependency cycle, or null when there is none. */
export function detectCycle(tasks: readonly Task[]): string | null {
  return findCycle(tasks)?.[0].title ?? null;
}
