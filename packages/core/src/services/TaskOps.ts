import {
  Task, RunnerId, flattenTasks,
  addTaskToPlan, removeTaskFromPlan, updateTaskInPlan, renumberTasks,
  opsFlag, inheritedOps, skillNames,
} from '../models/Task';
import { resolveTaskRef } from './TaskRefs';
import { extractObjectsWithKey, stripTrailingCommas, escapeControlCharsInStrings, PlanParseError, TASK_OPS_ENVELOPE_KEY } from './JsonExtractor';
import { validateTaskEdit, lockedTaskRefusal, type EditCatalog, type TaskEditActor, type TaskEditCheck } from './TaskEditValidator';
import { plannedTask, checkPlanInvariants, detectCycle, taskWhere, MODE_NOT_THE_PLANNERS, MANUAL_NOT_READ_ONLY, type IntakeCatalog, type PlannedTask, type PlanTaskError } from './PlannedTask';
import { plannedMode, taggedReadOnlyMode, type PlannedMode } from './ModeResolver';

/**
 * Targeted task edits emitted by the planner conversation (the 'task_ops'
 * ConversationTurn). Task references accept a task id, a "#<order>" ref, or a
 * bare order number — cheap models rarely echo UUIDs correctly.
 */
/**
 * A task as the planner writes it: its fields, less the mode, plus whether it
 * must not change files (ADR-0031), and `thinkingEffort` as a name for its
 * model's effort, so an effort can change without restating the model.
 */
export type PlannerTaskSpec = Partial<Task> & { readOnly?: boolean; thinkingEffort?: string | null };

export type TaskOp =
  | { op: 'update'; taskId: string; changes: PlannerTaskSpec }
  | { op: 'add'; task: PlannerTaskSpec; handle?: string }
  | { op: 'remove'; taskId: string }
  | { op: 'reorder'; taskIds: string[] }
  | { op: 'merge'; taskIds: string[]; merged: PlannerTaskSpec; handle?: string }
  | { op: 'split'; taskId: string; parts: PlannerTaskSpec[]; handle?: string }
  | { op: 'rearm'; taskId: string; changes?: PlannerTaskSpec };

/** Fields the planner may change on an existing task. Everything else (id, status, verdict…) is system-owned. */
export const UPDATABLE_FIELDS: (keyof Task)[] = [
  'title', 'description', 'prompt', 'dependencies', 'assignedRunner', 'assignedModel', 'taskMode', 'type', 'userSteps', 'autonomy', 'sliceType', 'ops', 'skills',
];

/**
 * The edit protocol as the planner reads it, kept beside the applier so the
 * prose can never undersell (or oversell) what {@link applyTaskOps} accepts.
 * `executionNote` rides on the ordering rule because that is the rule a
 * running execution changes.
 */
export function taskOpsProtocol(executionNote = '', tools = false): string[] {
  const updateChanges = [...UPDATABLE_FIELDS.filter((f) => f !== 'taskMode'), 'thinkingEffort', 'readOnly']
    .map((f) => (f === 'dependencies' ? '"dependencies"?:["<id or #order>"]' : `"${f}"?`))
    .join(',');
  return [
    tools ? '- To modify specific tasks, call edit_plan, never a JSON reply. Its argument is:' : '- To modify specific tasks, reply with ONLY this JSON object:',
    tools ? '  {"ops": [' : '  {"taskOps": [',
    `    {"op":"update","taskId":"<id or #order>","changes":{${updateChanges}}},`,
    '    {"op":"add","task":{"title","description","prompt","dependencies":["<id or #order>"],"assignedRunner"?,"assignedModel"?,"readOnly"?,"ops"?},"handle"?:"<name>"},',
    '    {"op":"remove","taskId":"<id or #order>"},',
    '    {"op":"reorder","taskIds":["<id or #order>", "... every task exactly once"]},   // only to re-prioritise INDEPENDENT tasks',
    '    {"op":"merge","taskIds":["<id or #order>", "..."],"merged":{"title","description","prompt"?,"assignedRunner"?,"assignedModel"?,...},"handle"?:"<name>"},',
    '    {"op":"split","taskId":"<id or #order>","parts":[{"title","description","prompt"?,"assignedRunner"?,"assignedModel"?,...}, ...],"handle"?:"<name>"},',
    `    {"op":"rearm","taskId":"<id or #order>","changes"?:{${updateChanges}}}`,
    '  ]}',
    tools ? '- For sweeping changes, you may instead call submit_plan with the full plan.' : '- For sweeping changes, you may instead emit a full {"tasks":[...]} plan JSON.',
    'Every "<id or #order>" ref in a batch resolves against the plan shown above, before any op in the batch runs — an earlier remove/merge/split never shifts what a later "#N" means. "#N" is top-level task N; a subtask is named by its dotted label ("#2.1"), as the plan lists it.',
    'Give "add", "merge", or "split" a "handle" (any name you choose, unused elsewhere in this batch) to let a LATER op in the same batch reference the task it produces — for "split", the handle names its last part. A handle used before its defining op is rejected.',
    `When creating or changing tasks, set "assignedRunner" and "assignedModel" ({"modelId","modelLabel","thinkingEffort"?}) using only the runners and models ${tools ? 'list_runners and list_models return' : 'listed in <available_models>'}.`,
    'Set "readOnly": true on a task that must not change any file, and "readOnly": false to lift it; you never set "taskMode". A task you move, split or edit keeps being read-only or not unless you say otherwise, and so do the subtasks of a read-only task you add.',
    'Keep dependencies consistent: no cycles, no references to removed tasks, and never touch running or completed tasks — "rearm" is the one exception, below.',
    ...(tools ? ['edit_plan checks the batch when you call it and answers with what it will change, or with the error to fix — call it again in the same reply. The edit is applied when your reply ends; edits you make in one reply join one batch.'] : []),
    'Just declare the dependencies you want — display order is repaired for you afterwards, so a rewire or a newly added prerequisite never needs a "reorder" op. Only a task that is running or completed cannot be shifted, so an edit that would need one to move is rejected.' + executionNote,
    'Flipping "type" between "ai" and "user" is a content change, not just a label: an update to "user" needs "userSteps" in the SAME op, and an update to "ai" needs "prompt" in the SAME op — the model/mode/effort/autonomy fields (flipping to "user", which also makes the task HITL) or the userSteps (flipping to "ai") are cleared automatically.',
    '"skills" in "changes" REPLACES the task\'s whole skill list. To add one, send the names the plan block shows in its skills:[...] plus the new one; to drop one, send the rest; [] removes them all.',
    '"rearm" puts a failed OR completed task back to pending — verdict and output summary are cleared, any dependents it had blocked are released, and it may carry field changes (e.g. a corrected "prompt") applied in the same op. A running task cannot be re-armed. Never rearm a task just to relabel it — only when it should actually run again.',
  ];
}

export function textHasTaskOps(text: string): boolean {
  return text.includes(`"${TASK_OPS_ENVELOPE_KEY}"`);
}

/** Parse a `{"taskOps":[...]}` reply. Throws PlanParseError when the JSON is unusable. */
export function parseTaskOpsJson(text: string): TaskOp[] {
  // Extract by the taskOps key specifically — a reply may also carry a
  // tasks-keyed object (schema echo, example), which must not shadow the ops.
  // Candidates are tried back to front: the last emission is the final answer.
  const { matches, fallback } = extractObjectsWithKey(text, TASK_OPS_ENVELOPE_KEY);
  const candidates = matches.length > 0 ? [...matches].reverse() : [fallback.json];

  let lastError: PlanParseError | null = null;
  for (const json of candidates) {
    try {
      return parseTaskOpsObject(json, text);
    } catch (err) {
      if (!(err instanceof PlanParseError)) throw err;
      if (!lastError) lastError = err;
    }
  }
  throw lastError ?? new PlanParseError('No JSON object found in task-ops reply', text);
}

function parseTaskOpsObject(json: string, text: string): TaskOp[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(escapeControlCharsInStrings(stripTrailingCommas(json)));
  } catch (err) {
    throw new PlanParseError(`Task-ops JSON is invalid: ${err instanceof Error ? err.message : String(err)}`, text);
  }
  const ops = (parsed as { taskOps?: unknown }).taskOps;
  if (!Array.isArray(ops) || ops.length === 0) {
    throw new PlanParseError('"taskOps" must be a non-empty array', text);
  }
  for (const op of ops) {
    if (typeof op !== 'object' || op === null || typeof (op as { op?: unknown }).op !== 'string') {
      throw new PlanParseError('Every task op needs an "op" field (update | add | remove | reorder | merge | split)', text);
    }
  }
  return ops as TaskOp[];
}

type RefResolution = { id: string } | { error: string };

/**
 * Resolve an op's task reference to a task id: a batch handle, or anything
 * {@link resolveTaskRef} reads.
 *
 * Order labels and title matches are pinned to `originalTree` — the plan as it
 * stood before the batch began — so an earlier op's renumbering can never
 * make a later op's "#4" land on a different task than the planner saw. A
 * literal id has no such drift (ids are stable across mutations), so id
 * matches check `liveTree` — the batch's current, mutated tasks — which is
 * also how a later op reaches a task created earlier in the same batch
 * without a handle (e.g. a split's own chained parts).
 */
function resolveRef(
  ref: unknown,
  originalTree: readonly Task[],
  liveTree: Task[],
  handleOwner: Map<string, number>,
  handleId: Map<string, string>,
  opIndex: number,
): RefResolution {
  if (typeof ref !== 'string' && typeof ref !== 'number') return { error: `invalid reference "${String(ref)}"` };
  const s = String(ref).trim();

  const ownerIdx = handleOwner.get(s);
  if (ownerIdx !== undefined) {
    if (ownerIdx >= opIndex) {
      return { error: `handle "${s}" is defined by a later op in this batch and cannot be referenced yet` };
    }
    const id = handleId.get(s);
    if (!id) return { error: `handle "${s}" was never resolved` };
    return { id };
  }

  if (findInTasks(liveTree, s)) return { id: s };
  const task = resolveTaskRef(originalTree, s);
  return task ? { id: task.id } : { error: `task "${s}" not found` };
}

/** The fields of a planner's `changes` it may set, with the ops flag read as every entry point reads it. */
function updatableChanges(raw: Partial<Task> | undefined): Partial<Task> {
  const changes: Partial<Task> = {};
  for (const key of UPDATABLE_FIELDS) {
    if (raw && key in raw) (changes as Record<string, unknown>)[key] = (raw as Record<string, unknown>)[key];
  }
  if ('ops' in changes) changes.ops = opsFlag(changes.ops);
  if ('skills' in changes) changes.skills = skillNames(changes.skills);
  return changes;
}

function findInTasks(tasks: readonly Task[], id: string): Task | undefined {
  return flattenTasks(tasks).find((t) => t.id === id);
}

function findTopLevel(tasks: Task[], id: string): Task | undefined {
  return tasks.find((t) => t.id === id);
}

/** A task the repair may not reposition: execution has already reached it. */
function isPinned(t: Task): boolean {
  return t.status === 'in_progress' || t.status === 'completed';
}

/**
 * Reorder top-level tasks so every dependency comes before its dependents,
 * moving as little as possible: pinned tasks keep the exact slot they are in,
 * and each free slot goes to the earliest-listed movable task whose
 * dependencies are already placed — so tasks the graph does not constrain keep
 * their relative order. Assumes an acyclic graph (the caller checks first).
 */
function repairOrder(tasks: Task[]): { tasks: Task[] } | { error: string } {
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const placed = new Set<string>();
  const movable = tasks.filter((t) => !isPinned(t));
  const result: Task[] = [];
  // Dependencies outside this list (a subtask id) constrain nothing here.
  const blockerOf = (t: Task): Task | undefined => {
    const id = t.dependencies.find((d) => byId.has(d) && !placed.has(d));
    return id ? byId.get(id) : undefined;
  };
  const place = (t: Task) => { result.push(t); placed.add(t.id); };

  for (const occupant of tasks) {
    if (isPinned(occupant)) {
      const blocker = blockerOf(occupant);
      if (blocker) return { error: pinnedRefusal(blocker, occupant, 'before') };
      place(occupant);
      continue;
    }
    const next = movable.findIndex((t) => !blockerOf(t));
    if (next < 0) {
      // Nothing is schedulable and the graph is acyclic, so every movable task
      // left waits — directly or through others — on a pinned task further down
      // that would have to come up to free this slot.
      const [stuck, pin] = trailToPin(movable[0], blockerOf);
      return { error: pinnedRefusal(stuck, pin, 'after') };
    }
    place(movable.splice(next, 1)[0]);
  }
  return { tasks: result };
}

/** Walk the waiting-on chain from `task` down to the pinned task holding it up. */
function trailToPin(task: Task, blockerOf: (t: Task) => Task | undefined): [Task, Task] {
  let at = task;
  for (;;) {
    const blocker = blockerOf(at);
    if (!blocker || isPinned(blocker)) return [at, blocker ?? at];
    at = blocker;
  }
}

/** `"B" #2→#1, "A" #1→#3` for every task the repair actually moved, or null. */
function describeMoves(before: Task[], after: Task[]): string | null {
  const wasAt = new Map(before.map((t, i) => [t.id, i + 1]));
  const moved = after
    .map((t, i) => ({ t, from: wasAt.get(t.id)!, to: i + 1 }))
    .filter((m) => m.from !== m.to);
  return moved.length ? moved.map((m) => `"${m.t.title}" #${m.from}→#${m.to}`).join(', ') : null;
}

function pinnedRefusal(other: Task, pin: Task, side: 'before' | 'after'): string {
  const word = pin.status === 'in_progress' ? 'running' : 'completed';
  return `"${other.title}" would have to run ${side} "${pin.title}", which is ${word} and cannot be moved`;
}

export interface ApplyTaskOpsResult {
  ok: boolean;
  tasks: readonly Task[];
  errors: string[];
  /** Human-readable summary of what changed, for the chat transcript. */
  summary: string[];
}

/**
 * Pre-flight check for a merge: would collapsing the selected tasks into one
 * (rewiring every dependent of any selected task to the survivor) keep the
 * dependency graph valid? Rejects locked tasks and merges whose rewiring would
 * introduce a cycle. Display order is NOT checked here — neither
 * consecutiveness (a UI concern) nor a dependency the merge pulls out of order,
 * which {@link applyTaskOps} repairs; refusing on order would make this
 * pre-flight stricter than the applier it stands in for.
 */
export function canMergeTasks(tasks: readonly Task[], selectedIds: string[]): { ok: boolean; error?: string } {
  if (selectedIds.length < 2) return { ok: false, error: 'Select at least two tasks to merge' };
  const idSet = new Set(selectedIds);
  const toMerge = tasks.filter((t) => idSet.has(t.id));
  if (toMerge.length < 2) return { ok: false, error: 'At least two valid tasks are required to merge' };
  for (const t of toMerge) {
    if (t.status === 'in_progress') return { ok: false, error: `"${t.title}" is running and cannot be merged` };
    if (t.status === 'completed') return { ok: false, error: `"${t.title}" is completed and cannot be merged` };
  }
  const ordered = [...toMerge].sort((a, b) => a.order - b.order);
  const survivorId = '__merge_sim__';
  const sim: Task[] = tasks
    .filter((t) => !idSet.has(t.id))
    .map((t) => ({ ...t, dependencies: t.dependencies.map((d) => (idSet.has(d) ? survivorId : d)).filter((d) => d !== t.id) }));
  const unionDeps = [...new Set(toMerge.flatMap((t) => t.dependencies))].filter((d) => !idSet.has(d));
  sim.push({ ...ordered[0], id: survivorId, title: '__merge_sim__', order: ordered[0].order, dependencies: unionDeps });
  const cycle = detectCycle(sim);
  if (cycle) return { ok: false, error: `Merging would create a dependency cycle involving "${cycle}"` };
  return { ok: true };
}

/**
 * The shape the dependency helpers below read. Structural rather than `Task`,
 * because the TUI projects tasks into its own `TaskView`: a surface's
 * dependency picker and the API's validation must agree on which dependencies
 * are legal, and a signature only core can satisfy would have forced the TUI
 * to keep a second copy of the rule.
 */
export interface TaskRef {
  id: string;
  order: number;
  title: string;
  dependencies: string[];
}

/** The tasks listing `taskId` as a dependency — exactly what removing it detaches. */
export function dependentsOf<T extends Pick<TaskRef, 'id' | 'dependencies'>>(tasks: T[], taskId: string): T[] {
  return tasks.filter((t) => t.id !== taskId && t.dependencies.includes(taskId));
}

/**
 * The tasks that may become dependencies of `taskId`: those displayed before it.
 *
 * Offering only earlier tasks is what keeps a hand-edited graph valid without a
 * cycle check — dependencies then only ever point backwards in display order,
 * the same invariant `applyTaskOps` enforces. Omit `taskId` for a task that does
 * not exist yet: it lands last, so every current task is a candidate.
 */
export function dependencyCandidates<T extends Pick<TaskRef, 'id' | 'order'>>(tasks: readonly T[], taskId?: string): T[] {
  if (!taskId) return [...tasks];
  const target = tasks.find((t) => t.id === taskId);
  return target ? tasks.filter((t) => t.order < target.order) : [];
}

/** Pre-flight check for a hand-edited dependency list: every id exists and comes earlier. */
export function canSetDependencies<T extends TaskRef>(
  tasks: readonly T[],
  taskId: string,
  dependencies: string[],
): { ok: boolean; error?: string } {
  const target = tasks.find((t) => t.id === taskId);
  if (!target) return { ok: false, error: 'Task not found' };
  const allowed = new Set(dependencyCandidates(tasks, taskId).map((t) => t.id));
  for (const dep of dependencies) {
    if (dep === taskId) return { ok: false, error: `"${target.title}" cannot depend on itself` };
    const found = tasks.find((t) => t.id === dep);
    if (!found) return { ok: false, error: `Unknown dependency "${dep}"` };
    if (!allowed.has(dep)) {
      return { ok: false, error: `"${target.title}" cannot depend on "${found.title}", which comes after it in the plan` };
    }
  }
  return { ok: true };
}

/** Pre-flight check for a split: the task exists and is not locked by execution. */
export function canSplitTask(tasks: readonly Task[], taskId: string): { ok: boolean; error?: string } {
  const target = tasks.find((t) => t.id === taskId);
  if (!target) return { ok: false, error: 'Task not found' };
  if (target.status === 'in_progress') return { ok: false, error: `"${target.title}" is running and cannot be split` };
  if (target.status === 'completed') return { ok: false, error: `"${target.title}" is completed and cannot be split` };
  return { ok: true };
}


function askedReadOnly(spec: PlannerTaskSpec | undefined): boolean | undefined {
  return typeof spec?.readOnly === 'boolean' ? spec.readOnly : undefined;
}

function isReadOnly(task: Task, catalog: EditCatalog | undefined): boolean {
  return task.taskMode !== undefined && task.taskMode === taggedReadOnlyMode(catalog?.runnerModes[task.assignedRunner]);
}

/**
 * The mode a planner edit lands a task on (ADR-0031). A task stays read-only
 * or not unless the planner says otherwise, so a move or split never quietly
 * gives a read-only task write access. Undefined mode with no catalog to read
 * the runner's modes from.
 */
function landingMode(runner: RunnerId, readOnly: boolean | undefined, current: string | undefined, catalog: EditCatalog | undefined): PlannedMode {
  return plannedMode(runner, catalog?.runnerModes, { readOnly, current }, catalog?.autonomousDefault ?? true);
}

/** The fields an edit changed, as the planner names them: `readOnly` when that flipped, never the mode it landed on (ADR-0031). */
function changedFields(target: Task, changes: Partial<Task>, catalog: EditCatalog | undefined): string[] {
  const fields = Object.keys(changes).filter((f) => f !== 'taskMode');
  if ('taskMode' in changes && isReadOnly({ ...target, ...changes }, catalog) !== isReadOnly(target, catalog)) fields.push('readOnly');
  return fields;
}

/**
 * Apply task ops to a snapshot of the plan, atomically: either every op
 * applies and the result validates (deps resolve, no cycles, running and
 * completed tasks untouched), or nothing is returned and `errors` explains
 * why. The caller commits `tasks` on ok.
 */
export function applyTaskOps(
  currentTasks: readonly Task[],
  newOps: TaskOp[],
  runners: RunnerId[],
  catalog?: EditCatalog,
  held: readonly TaskOp[] = [],
): ApplyTaskOpsResult {
  // Ops already accepted earlier in the batch apply first; errors number only
  // the new ones, as the planner wrote them in the call it is answered for.
  const ops = [...held, ...newOps];
  const opLabel = (i: number) => (i < held.length ? `earlier op ${i + 1} (${ops[i].op})` : `op ${i - held.length + 1} (${ops[i].op})`);
  let tasks: Task[] = JSON.parse(JSON.stringify(currentTasks));
  const errors: string[] = [];
  const summary: string[] = [];

  // Batch handles: planner-chosen names for a task an add/merge/split op is
  // about to create, so a later op in the same batch can reference it before
  // it has a real id. Pre-scanned up front — a bad handle refuses the whole
  // batch before anything mutates.
  const handleOwner = new Map<string, number>();
  const handleId = new Map<string, string>();
  for (const [i, op] of ops.entries()) {
    const handle = (op as { handle?: unknown }).handle;
    if (handle === undefined) continue;
    if (typeof handle !== 'string' || !handle.trim()) {
      errors.push(`${opLabel(i)}: handle must be a non-empty string`);
      continue;
    }
    if (handleOwner.has(handle)) {
      errors.push(`${opLabel(i)}: handle "${handle}" is already used earlier in this batch`);
      continue;
    }
    if (resolveTaskRef(currentTasks, handle)) {
      errors.push(`${opLabel(i)}: handle "${handle}" collides with an existing task reference`);
      continue;
    }
    handleOwner.set(handle, i);
  }
  if (errors.length) return { ok: false, tasks: currentTasks, errors, summary: [] };

  const resolveDeps = (deps: unknown, opIndex: number): { ids: string[]; bad: string[] } => {
    const ids: string[] = [];
    const bad: string[] = [];
    const liveFlat = flattenTasks(tasks);
    for (const d of Array.isArray(deps) ? deps : []) {
      const r = resolveRef(d, currentTasks, tasks, handleOwner, handleId, opIndex);
      if ('error' in r) { bad.push(`${String(d)} (${r.error})`); continue; }
      if (!liveFlat.some((t) => t.id === r.id)) { bad.push(`${String(d)} (no longer exists in this batch)`); continue; }
      ids.push(r.id);
    }
    return { ids, bad };
  };

  const intake: IntakeCatalog = { runners, runnerModes: catalog?.runnerModes, autonomousDefault: catalog?.autonomousDefault, models: catalog };

  /**
   * A planned task's dependency refs, at every depth, as ids: a subtask may
   * name a task of its own tree by the id the planner gave it, or any task in
   * the plan the way every op does.
   */
  const resolveTree = (planned: PlannedTask, opIndex: number): { task: Task } | { error: string } => {
    const walk = (t: Task, parentTitle?: string): Task | string => {
      const ids: string[] = [];
      const bad: string[] = [];
      for (const d of t.dependencies) {
        const own = planned.renamed.get(d);
        if (own) { ids.push(own); continue; }
        const r = resolveDeps([d], opIndex);
        ids.push(...r.ids);
        bad.push(...r.bad);
      }
      if (bad.length) return `unknown dependencies${parentTitle !== undefined ? ` of ${taskWhere(t.title, parentTitle)}` : ''}: ${bad.join(', ')}`;
      const subtasks: Task[] = [];
      for (const sub of t.subtasks) {
        const done = walk(sub, t.title);
        if (typeof done === 'string') return done;
        subtasks.push(done);
      }
      return { ...t, dependencies: ids.filter((id) => id !== t.id), subtasks };
    };
    const done = walk(planned.task);
    return typeof done === 'string' ? { error: done } : { task: done };
  };

  /** Why the edit cannot have this planned task: a rule it breaks, or something it asked for that is not the planner's. */
  const refusalOf = (planned: PlannedTask): string | undefined => [...planned.ignored, ...planned.errors][0]?.message;

  /**
   * The resolve-and-validate half shared by "update" and "rearm": resolve the
   * target, apply the field allowlist and runner check, run the edit validator
   * under the op's audience, then resolve any dependency refs. `refuseRunning`
   * is rearm's extra lock check, kept before the field work so its message wins.
   */
  const prepareEdit = (
    op: { taskId: string; changes?: PlannerTaskSpec },
    opIndex: number,
    label: string,
    audience: TaskEditActor,
    refuseRunning = false,
  ): { target: Task; changes: Partial<Task>; check: TaskEditCheck } | { error: string } => {
    const ref = resolveRef(op.taskId, currentTasks, tasks, handleOwner, handleId, opIndex);
    if ('error' in ref) return { error: `${label}: ${ref.error}` };
    const target = findInTasks(tasks, ref.id);
    if (!target) return { error: `${label}: task "${op.taskId}" no longer exists in this batch (removed, merged, or split by an earlier op)` };
    if (refuseRunning && target.status === 'in_progress') return { error: `${label}: ${lockedTaskRefusal(target, 're-armed')}` };
    if (op.changes && 'taskMode' in op.changes) return { error: `${label}: ${MODE_NOT_THE_PLANNERS}` };
    const changes = updatableChanges(op.changes);
    if (op.changes && 'thinkingEffort' in op.changes) {
      const model = changes.assignedModel ?? target.assignedModel;
      if (!model) return { error: `${label}: "thinkingEffort" is the assigned model's — set "assignedModel" with it` };
      changes.assignedModel = { ...model, thinkingEffort: op.changes.thinkingEffort ?? undefined };
    }
    // Dependency refs are still unresolved (e.g. "#3") at this point, so the
    // check runs on everything but them; resolveDeps below handles them once
    // they're real ids.
    const changesForCheck: Partial<Task> = { ...changes };
    delete changesForCheck.dependencies;
    const check = validateTaskEdit(audience, tasks, target.id, changesForCheck, catalog);
    if (!check.ok) return { error: `${label}: ${check.error}` };
    for (const field of check.clear ?? []) (changes as Record<string, unknown>)[field] = undefined;
    Object.assign(changes, check.set);
    const readOnly = askedReadOnly(op.changes);
    if (readOnly === true && (changes.type ?? target.type) === 'user') return { error: `${label}: ${MANUAL_NOT_READ_ONLY}` };
    const moved = changes.assignedRunner !== undefined && changes.assignedRunner !== target.assignedRunner;
    const becomesAi = changes.type === 'ai' && target.type === 'user';
    // A runner not allowed has no mode to land on; the plan's rules refuse it once the op is applied.
    const known = runners.includes(changes.assignedRunner ?? target.assignedRunner);
    if (known && (readOnly !== undefined || moved || becomesAi) && (changes.type ?? target.type) !== 'user') {
      const mode = landingMode(changes.assignedRunner ?? target.assignedRunner, readOnly ?? isReadOnly(target, catalog), target.taskMode, catalog);
      if (!mode.ok) return { error: `${label}: ${mode.error}` };
      if (mode.mode !== undefined && mode.mode !== target.taskMode) changes.taskMode = mode.mode;
    }
    if ('dependencies' in changes) {
      const { ids, bad } = resolveDeps(changes.dependencies, opIndex);
      if (bad.length) return { error: `${label}: unknown dependencies: ${bad.join(', ')}` };
      changes.dependencies = ids.filter((id) => id !== target.id);
    }
    return { target, changes, check };
  };

  // A rule the batch ends in breach of is the op's that first broke it. What
  // the plan already broke before the batch — a task on a runner disabled
  // since, say — is not, so it never blocks an unrelated edit. A breach is
  // told by its task and rule, not its wording: the wording carries the title,
  // which an edit may change.
  const breachKey = (e: PlanTaskError) => `${e.taskId ?? ''}\u0000${e.field}`;
  const standing = new Set(checkPlanInvariants(currentTasks, runners).map(breachKey));
  const brokenBy = new Map<string, string>();
  let lastLabel = opLabel(0);

  for (const [i, op] of ops.entries()) {
    const label = opLabel(i);
    switch (op.op) {
      case 'update': {
        const prep = prepareEdit(op, i, label, 'planner');
        if ('error' in prep) { errors.push(prep.error); break; }
        const { target, changes, check } = prep;
        if (Object.keys(changes).length === 0) {
          const readOnly = askedReadOnly(op.changes);
          if (readOnly !== undefined && isReadOnly(target, catalog) === readOnly) { summary.push(`"${target.title}" is already ${readOnly ? '' : 'not '}read-only`); break; }
          errors.push(`${label}: no valid changes provided`);
          break;
        }
        tasks = updateTaskInPlan(tasks, target.id, changes);
        const clearedNote = check.clear?.length ? `; cleared ${check.clear.join(', ')}` : '';
        const fields = changedFields(target, changes, catalog);
        summary.push(`Updated "${target.title}"${fields.length ? ` (${fields.join(', ')})` : ''}${clearedNote}`);
        break;
      }
      case 'add': {
        const spec = op.task ?? {};
        if (!spec.title) { errors.push(`${label}: new task needs a title`); break; }
        const planned = plannedTask(spec, intake, { freshIds: true });
        const refused = refusalOf(planned);
        if (refused) { errors.push(`${label}: ${refused}`); break; }
        const resolved = resolveTree(planned, i);
        if ('error' in resolved) { errors.push(`${label}: ${resolved.error}`); break; }
        tasks = addTaskToPlan(tasks, resolved.task);
        if (op.handle) handleId.set(op.handle, resolved.task.id);
        summary.push(`Added "${spec.title}"`);
        break;
      }
      case 'remove': {
        const ref = resolveRef(op.taskId, currentTasks, tasks, handleOwner, handleId, i);
        if ('error' in ref) { errors.push(`${label}: ${ref.error}`); break; }
        const target = findInTasks(tasks, ref.id);
        if (!target) { errors.push(`${label}: task "${op.taskId}" no longer exists in this batch (removed, merged, or split by an earlier op)`); break; }
        const locked = lockedTaskRefusal(target, 'removed');
        if (locked) { errors.push(`${label}: ${locked}`); break; }
        tasks = removeTaskFromPlan(tasks, target.id);
        summary.push(`Removed "${target.title}"`);
        break;
      }
      case 'reorder': {
        const refs = (op.taskIds ?? []).map((r) => resolveRef(r, currentTasks, tasks, handleOwner, handleId, i));
        const badRef = refs.find((r): r is { error: string } => 'error' in r);
        if (badRef) { errors.push(`${label}: ${badRef.error}`); break; }
        const resolved = (refs as { id: string }[]).map((r) => findTopLevel(tasks, r.id));
        if (resolved.some((t) => !t)) { errors.push(`${label}: unknown task in reorder list`); break; }
        const orderIds = resolved.map((t) => t!.id);
        if (new Set(orderIds).size !== tasks.length) {
          errors.push(`${label}: reorder must list every top-level task exactly once (${tasks.length} tasks)`);
          break;
        }
        const byId = new Map(tasks.map((t) => [t.id, t]));
        tasks = renumberTasks(orderIds.map((id) => byId.get(id)!));
        summary.push('Reordered tasks');
        break;
      }
      case 'merge': {
        const refs = (op.taskIds ?? []).map((r) => resolveRef(r, currentTasks, tasks, handleOwner, handleId, i));
        const badRef = refs.find((r): r is { error: string } => 'error' in r);
        if (badRef) { errors.push(`${label}: ${badRef.error}`); break; }
        const resolved = (refs as { id: string }[]).map((r) => findTopLevel(tasks, r.id));
        if (resolved.some((t) => !t)) { errors.push(`${label}: unknown task in merge list (already removed, merged, or split by an earlier op)`); break; }
        const toMerge = [...new Map(resolved.map((t) => [t!.id, t!])).values()].sort((a, b) => a.order - b.order);
        if (toMerge.length < 2) { errors.push(`${label}: merge needs at least two tasks`); break; }
        const locked = toMerge.map((t) => lockedTaskRefusal(t, 'merged')).find((refusal) => refusal !== null);
        if (locked) { errors.push(`${label}: ${locked}`); break; }
        const idSet = new Set(toMerge.map((t) => t.id));
        const unionDepsRaw = [...new Set(toMerge.flatMap((t) => t.dependencies))].filter((d) => !idSet.has(d));
        const { ids, bad } = resolveDeps(unionDepsRaw, i);
        if (bad.length) { errors.push(`${label}: unknown dependencies: ${bad.join(', ')}`); break; }
        const spec = op.merged ?? {};
        if (!spec.title) { errors.push(`${label}: merged task needs a title`); break; }
        // Read-only only when every merged task was: one that writes makes the merged task write.
        const writes = toMerge.find((t) => !isReadOnly(t, catalog));
        const stories = [...new Set(toMerge.flatMap((t) => t.userStoriesCovered ?? []))];
        const planned = plannedTask(spec, intake, {
          freshIds: true,
          from: {
            readOnly: !writes,
            fields: {
              description: toMerge.map((t) => t.description).filter(Boolean).join('\n\n'),
              prompt: toMerge.map((t) => t.prompt).filter(Boolean).join('\n\n---\n\n') || undefined,
              type: toMerge.some((t) => t.type === 'user') ? 'user' : 'ai',
              assignedRunner: toMerge[0].assignedRunner,
              assignedModel: toMerge.find((t) => t.assignedModel)?.assignedModel,
              taskMode: (writes ?? toMerge[0]).taskMode,
              autonomy: toMerge.find((t) => t.autonomy)?.autonomy,
              sliceType: toMerge.find((t) => t.sliceType)?.sliceType,
              ops: inheritedOps(toMerge),
              skills: toMerge.flatMap((t) => t.skills ?? []),
              userStoriesCovered: stories.length ? stories : undefined,
            },
          },
        });
        const refused = refusalOf(planned);
        if (refused) { errors.push(`${label}: ${refused}`); break; }
        const built = resolveTree({ ...planned, task: { ...planned.task, dependencies: [] } }, i);
        if ('error' in built) { errors.push(`${label}: ${built.error}`); break; }
        const mergedTask: Task = { ...built.task, dependencies: ids };
        const mergedId = mergedTask.id;
        const firstId = toMerge[0].id;
        const result: Task[] = [];
        let inserted = false;
        for (const t of tasks) {
          if (idSet.has(t.id)) {
            if (!inserted && t.id === firstId) { result.push(mergedTask); inserted = true; }
            continue;
          }
          result.push({ ...t, dependencies: t.dependencies.map((d) => (idSet.has(d) ? mergedId : d)) });
        }
        if (!inserted) result.push(mergedTask);
        tasks = renumberTasks(result);
        if (op.handle) handleId.set(op.handle, mergedId);
        summary.push(`Merged ${toMerge.length} tasks into "${spec.title}"`);
        break;
      }
      case 'split': {
        const ref = resolveRef(op.taskId, currentTasks, tasks, handleOwner, handleId, i);
        if ('error' in ref) { errors.push(`${label}: ${ref.error}`); break; }
        const target = findTopLevel(tasks, ref.id);
        if (!target) { errors.push(`${label}: task "${op.taskId}" not found`); break; }
        const locked = lockedTaskRefusal(target, 'split');
        if (locked) { errors.push(`${label}: ${locked}`); break; }
        const parts = op.parts ?? [];
        if (parts.length < 2) { errors.push(`${label}: split needs at least two parts`); break; }
        const newTasks: Task[] = [];
        let prevId: string | undefined;
        let buildError = false;
        for (let p = 0; p < parts.length; p++) {
          const spec = parts[p];
          if (!spec || !spec.title) { errors.push(`${label}: split part ${p + 1} needs a title`); buildError = true; break; }
          // Part 0 inherits the original's (external) dependencies, resolved
          // against the current plan. Later parts chain onto the previous part
          // — a sibling id created in this same op, so it needs no resolution.
          let deps: string[];
          if (p === 0) {
            const { ids, bad } = resolveDeps(target.dependencies, i);
            if (bad.length) { errors.push(`${label}: split part 1 unknown dependencies: ${bad.join(', ')}`); buildError = true; break; }
            deps = ids;
          } else {
            deps = prevId ? [prevId] : [];
          }
          const planned = plannedTask(spec, intake, {
            freshIds: true,
            from: {
              readOnly: isReadOnly(target, catalog),
              fields: {
                type: target.type,
                assignedRunner: target.assignedRunner,
                assignedModel: target.assignedModel,
                taskMode: target.taskMode,
                autonomy: target.autonomy,
                sliceType: target.sliceType,
                ops: inheritedOps([target]),
                skills: target.skills,
                userStoriesCovered: target.userStoriesCovered,
              },
            },
          });
          const refused = refusalOf(planned);
          if (refused) { errors.push(`${label}: split part ${p + 1}: ${refused}`); buildError = true; break; }
          const resolved = resolveTree({ ...planned, task: { ...planned.task, dependencies: [] } }, i);
          if ('error' in resolved) { errors.push(`${label}: split part ${p + 1}: ${resolved.error}`); buildError = true; break; }
          const nt: Task = { ...resolved.task, dependencies: deps };
          newTasks.push(nt);
          prevId = nt.id;
        }
        if (buildError) break;
        const tailId = newTasks[newTasks.length - 1].id;
        const result: Task[] = [];
        for (const t of tasks) {
          if (t.id === target.id) { result.push(...newTasks); continue; }
          result.push({ ...t, dependencies: t.dependencies.map((d) => (d === target.id ? tailId : d)) });
        }
        tasks = renumberTasks(result);
        if (op.handle) handleId.set(op.handle, tailId);
        summary.push(`Split "${target.title}" into ${newTasks.length} tasks`);
        break;
      }
      case 'rearm': {
        // Re-arming is the sanctioned exception to the planner lock — its whole
        // point is to touch a task the lock would otherwise refuse — so it
        // validates as a direct edit; well-formedness still applies.
        const prep = prepareEdit(op, i, label, 'direct', true);
        if ('error' in prep) { errors.push(prep.error); break; }
        const { target, changes, check } = prep;
        tasks = updateTaskInPlan(tasks, target.id, { ...changes, status: 'pending', verdict: undefined, outputSummary: undefined, awaitingReason: undefined, resumeAt: undefined });
        // Dependents parked at 'blocked' by this task's earlier failure have
        // nothing else to release them — the scheduler reads `status` directly,
        // not a live recomputation of the dependency graph.
        for (const dep of flattenTasks(tasks)) {
          if (dep.status === 'blocked' && dep.dependencies.includes(target.id)) {
            tasks = updateTaskInPlan(tasks, dep.id, { status: 'pending' });
          }
        }
        const clearedNote = check.clear?.length ? `; cleared ${check.clear.join(', ')}` : '';
        const fields = changedFields(target, changes, catalog);
        const changedNote = fields.length ? ` (${fields.join(', ')})` : '';
        summary.push(`Re-armed "${target.title}"${changedNote}${clearedNote}`);
        break;
      }
      default:
        errors.push(`${label}: unknown op "${(op as { op: string }).op}"`);
    }
    if (errors.length) break;
    lastLabel = label;
    // Invariants are judged on the final state, so a later op may complete an
    // earlier one; here they only record which op a breach belongs to.
    const now = new Set(checkPlanInvariants(tasks, runners).map(breachKey));
    for (const key of brokenBy.keys()) if (!now.has(key)) brokenBy.delete(key);
    for (const key of now) if (!standing.has(key) && !brokenBy.has(key)) brokenBy.set(key, label);
  }

  if (!errors.length) {
    for (const e of checkPlanInvariants(tasks, runners)) {
      const key = breachKey(e);
      if (!standing.has(key)) errors.push(`${brokenBy.get(key) ?? lastLabel}: ${e.message}`);
    }
  }

  // Display order is maintained, not demanded: whatever the batch produced,
  // the plan comes back with dependencies ahead of their dependents. The
  // planner never has to re-declare the whole order to move one task.
  if (!errors.length) {
    const repaired = repairOrder(tasks);
    if ('error' in repaired) {
      errors.push(repaired.error);
    } else {
      const moves = describeMoves(tasks, repaired.tasks);
      if (moves) summary.push(`Reordered to keep dependencies first: ${moves}`);
      tasks = renumberTasks(repaired.tasks);
    }
  }

  return errors.length
    ? { ok: false, tasks: currentTasks, errors, summary: [] }
    : { ok: true, tasks, errors: [], summary };
}
