import { Task, flattenTasksWithParents, RunnerId, DiscoveredModel, TaskModelAssignment, TaskMode } from '../models/Task';
import { canSetDependencies } from './TaskOps';
import { effectiveAllowlist } from './ModelAllowlistResolver';
import { unavailableModeReason, type RunnerModeInfo } from './ModeResolver';
import { NOT_STARTED } from '../taskRow/status';
import { opsPlacementRefusal } from './PlannedTask';

/**
 * Who is making the edit. The planner (`applyTaskOps`) and the direct-edit
 * path (`Session.updateTask`/`setTaskDependencies`, reached by the TUI, the
 * webview task card, and `PUT /tasks/:taskId`) are deliberately asymmetric —
 * see CONTEXT.md, "Direct edit vs planner edit". The planner may not reach
 * into a task that is running or already finished; the direct path may,
 * because it is the user editing their own plan, and pays what that costs at
 * the call site (cancelling a live runner, releasing blocked dependents).
 */
export type TaskEditActor = 'planner' | 'direct';

export interface TaskEditCheck {
  ok: boolean;
  error?: string;
  /**
   * Fields a type flip strips of meaning, to be force-cleared by the caller
   * (set to `undefined` in the applied changes) and named in whatever summary
   * reaches the transcript. Only lists fields the target actually had a value
   * for — nothing to clear reads as nothing lost.
   */
  clear?: (keyof Task)[];
  /** Fields a flip forces to a value rather than strips — a user task is always HITL — applied with {@link clear}. */
  set?: Partial<Task>;
}

/**
 * Why the planner may not touch a task execution has reached, worded with what
 * would be accepted instead: the note goes back to the model, mid-run
 * included, so it can act on it rather than retry the same edit (ADR-0029).
 * Null for a task the planner may edit.
 */
export function lockedTaskRefusal(task: Pick<Task, 'title' | 'status'>, action = 'changed'): string | null {
  if (task.status === 'in_progress') return `"${task.title}" is running and cannot be ${action} now: the user can stop it first, or change it after it finishes`;
  if (task.status === 'completed') return `"${task.title}" is completed and cannot be ${action}: rearm it to run it again, or add a new task for further work`;
  return null;
}

/**
 * Why a task's model or effort cannot change while its runner is up, for
 * every actor. The plan follows a switch made with the runner's own command
 * instead (#106), so that is offered beside stopping it.
 */
export function liveModelRefusal(task: Pick<Task, 'title'>): string {
  return `"${task.title}" has a live runner, so its model and effort cannot change now: stop the task first, or use the runner's own /model`;
}

/**
 * Why a task cannot move to another runner while its runner is up: the move
 * re-derives the model from the new runner, under the same lock as
 * {@link liveModelRefusal}, and no runner's own command can make it.
 */
export function liveRunnerRefusal(task: Pick<Task, 'title'>): string {
  return `"${task.title}" has a live runner, so its runner cannot change now: stop the task first`;
}

function sameAssignment(a: TaskModelAssignment | undefined, b: TaskModelAssignment | undefined): boolean {
  return a?.modelId === b?.modelId && a?.thinkingEffort === b?.thinkingEffort;
}

const AI_ONLY_FIELDS = ['assignedModel', 'taskMode', 'autonomy', 'ops'] as const satisfies readonly (keyof Task)[];

/**
 * The catalog a model/task-mode edit is checked against — the same discovered
 * models and manifest modes the planner was shown in the per-turn catalog
 * block (`PlannerConversation.catalogBlock`), so a refusal here can never name something
 * as invalid that the planner was never told about, or vice versa.
 */
export interface EditCatalog {
  modelsByRunner: Partial<Record<RunnerId, DiscoveredModel[]>>;
  runnerModes: Partial<Record<RunnerId, RunnerModeInfo[]>>;
  /** Raw (unfiltered) allowlist, keyed by runner — the same shape `coerceAssignments` takes. */
  perRunnerAllowlist?: Partial<Record<RunnerId, string[]>>;
  /** Full (true) or Guarded: the mode a task the planner writes lands on unless it is read-only (ADR-0031). Full when absent. */
  autonomousDefault?: boolean;
  /**
   * Whether a task's runner is up now. Its model is then the runner's (#106):
   * the process was started on one and only the runner's own command moves it,
   * so an edit from outside would leave the plan naming what is not running.
   * Absent means none is.
   */
  liveRunner?: (taskId: string) => boolean;
}

/**
 * Whether an assigned model and task mode are things the target runner
 * actually offers. Invented ids are refused rather than silently substituted
 * downstream (`coerceAssignments` remains the safety net for paths that never
 * go through this validator) — the planner gets the refusal, with the runner
 * named, through the same repair loop as every other edit rejection.
 *
 * `catalog` is optional: callers with no discovered catalog on hand (most unit
 * tests, a runner with no manifest modes) skip these checks rather than
 * refusing everything sight-unseen.
 */
export function checkModelAndModeValidity(
  runner: RunnerId,
  assignedModel: TaskModelAssignment | undefined,
  taskMode: TaskMode | undefined,
  catalog: EditCatalog | undefined,
): TaskEditCheck {
  if (!catalog) return { ok: true };

  if (assignedModel) {
    const models = catalog.modelsByRunner[runner];
    if (models) {
      const modelId = assignedModel.modelId;
      const allowed = effectiveAllowlist(catalog.perRunnerAllowlist?.[runner], runner, catalog.modelsByRunner);
      // An allowlisted id discovery doesn't list is one `filterModelsForPrompt`
      // shows the planner anyway — refusing it here would contradict the
      // catalog block; the runner validates it last.
      if (!models.some((m) => m.modelId === modelId) && !allowed?.includes(modelId)) {
        return { ok: false, error: `Runner "${runner}" does not offer model "${modelId}"` };
      }
      if (allowed && !allowed.includes(modelId)) {
        return { ok: false, error: `Model "${modelId}" is excluded by the allowlist for runner "${runner}"` };
      }
    }
  }

  if (taskMode !== undefined) {
    const modes = catalog.runnerModes[runner];
    if (modes && modes.length > 0 && !modes.some((m) => m.id === taskMode)) {
      return { ok: false, error: `Runner "${runner}" has no task mode "${taskMode}": valid modes: ${modes.map((m) => m.id).join(', ')}` };
    }
    const unavailable = unavailableModeReason(modes, taskMode);
    if (unavailable) return { ok: false, error: `Mode "${taskMode}" of runner "${runner}" is unavailable on this host: ${unavailable}` };
  }

  return { ok: true };
}

/**
 * Coherence between `type` and the fields that only make sense for one side
 * of it. Deriving user steps from an AI prompt (or vice versa) would fabricate
 * instructions nobody wrote (ADR-0001: the plan is the source of truth), so a
 * flip that lacks the content the new type needs is refused rather than
 * silently patched — the planner gets that refusal back through the repair
 * loop; a direct edit gets it as a thrown reason. A flip that IS well-formed
 * clears the fields that stopped meaning anything, named for the caller.
 */
function typeCoherenceCheck(target: Task, changes: Partial<Task>): TaskEditCheck | null {
  if (!changes.type || changes.type === target.type) return null;

  if (changes.type === 'user') {
    if (!Array.isArray(changes.userSteps) || changes.userSteps.length === 0) {
      return { ok: false, error: `"${target.title}" cannot become a manual task without user steps: include "userSteps" in this edit` };
    }
    return {
      ok: true,
      clear: AI_ONLY_FIELDS.filter((f) => target[f] !== undefined),
      // User tasks are held to HITL, so a flip that kept the AI task's slice would be refused by the plan's own rules.
      ...(target.sliceType !== 'HITL' ? { set: { sliceType: 'HITL' as const } } : {}),
    };
  }

  // changes.type === 'ai'
  if (!changes.prompt || !changes.prompt.trim()) {
    return { ok: false, error: `"${target.title}" cannot become an AI task without a prompt: include "prompt" in this edit` };
  }
  return { ok: true, clear: target.userSteps && target.userSteps.length > 0 ? ['userSteps'] : [] };
}

/**
 * Whether a task may become an ops task, or stop being one (ADR-0020). Only a
 * top-level AI task can be ops, and the flag decides where the task runs, so
 * once it has started it is fixed, like its runner session.
 */
function opsCheck(target: Task, isSubtask: boolean, changes: Partial<Task>): TaskEditCheck | null {
  if (!('ops' in changes) || !!changes.ops === !!target.ops) return null;
  if (!NOT_STARTED.has(target.status)) {
    return { ok: false, error: `"${target.title}" has started, so whether it is an ops task is fixed` };
  }
  if (!changes.ops) return null;
  const refused = opsPlacementRefusal(changes.type ?? target.type, isSubtask);
  return refused ? { ok: false, error: `"${target.title}" ${refused}` } : null;
}

/**
 * The rules governing one task edit, shared by both actors. Lock rules
 * (running/completed) apply to the planner only, except that a task's model
 * and runner are nobody's to change while its runner is up ({@link liveModelRefusal},
 * {@link liveRunnerRefusal}). Well-formedness rules — like
 * a hand-set dependency list, the one edit that can leave the plan
 * unschedulable, and type/content coherence on an AI↔MAN flip — describe the
 * task rather than who asked, so they run for both, through the same
 * {@link canSetDependencies} guard the pickers and the API read.
 *
 * `tasks` is the plan tree: the target is found at any depth, and its
 * dependencies are checked among its siblings, the list its order is in.
 */
export function validateTaskEdit(
  actor: TaskEditActor,
  tasks: readonly Task[],
  taskId: string,
  changes: Partial<Task>,
  catalog?: EditCatalog,
): TaskEditCheck {
  const found = flattenTasksWithParents(tasks).find(({ task }) => task.id === taskId);
  if (!found) return { ok: false, error: 'Task not found' };
  const { task: target, parent } = found;

  const locked = actor === 'planner' ? lockedTaskRefusal(target, 'modified') : null;
  if (locked) return { ok: false, error: locked };
  const coherence = typeCoherenceCheck(target, changes);
  // Read on the edit as it lands: a flip to manual clears the model without the patch naming it.
  const landing = coherence?.clear?.includes('assignedModel') ? { ...changes, assignedModel: undefined } : changes;
  if ('assignedModel' in landing && !sameAssignment(landing.assignedModel, target.assignedModel) && catalog?.liveRunner?.(taskId)) {
    return { ok: false, error: liveModelRefusal(target) };
  }
  if ('assignedRunner' in changes && changes.assignedRunner !== target.assignedRunner && catalog?.liveRunner?.(taskId)) {
    return { ok: false, error: liveRunnerRefusal(target) };
  }

  if (changes.dependencies) {
    const depCheck = canSetDependencies(parent?.subtasks ?? tasks, taskId, changes.dependencies);
    if (!depCheck.ok) return depCheck;
  }

  if (coherence && !coherence.ok) return coherence;

  const ops = opsCheck(target, parent !== null, changes);
  if (ops) return ops;

  const validity = checkModelAndModeValidity(changes.assignedRunner ?? target.assignedRunner, changes.assignedModel, changes.taskMode, catalog);
  if (!validity.ok) return validity;

  return coherence ?? { ok: true };
}
