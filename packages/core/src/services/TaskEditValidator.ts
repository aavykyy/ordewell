import { Task, flattenTasksWithParents } from '../models/Task';
import { canSetDependencies } from './PlanTree';
import { NOT_STARTED } from '../taskRow/status';
import { opsPlacementRefusal } from './PlannedTask';

/**
 * Who is making the edit. The planner (`applyTaskOps`) and the direct-edit
 * path (`PlanEditor.updateTask`, reached by the TUI, the CLI, the webview
 * task card, and `PUT /tasks/:taskId`) are deliberately asymmetric —
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

const AI_ONLY_FIELDS = ['assignedModel', 'taskMode', 'autonomy', 'ops'] as const satisfies readonly (keyof Task)[];

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
 * The rules governing one task edit that are not about what it runs on: who
 * may make it, and whether the task stays well-formed. Lock rules
 * (running/completed) apply to the planner only. Well-formedness rules — a
 * hand-set dependency list, the one edit that can leave the plan
 * unschedulable, type/content coherence on an AI↔MAN flip, and where an ops
 * task may be — describe the task rather than who asked, so they run for
 * both, through the same {@link canSetDependencies} guard the pickers and the
 * API read. What the task's runner, model, effort and mode end up as is the
 * assignment resolver's (`resolveAssignment`), and the rules the plan's tasks
 * are held to together are `checkPlanInvariants`', both for both actors too.
 *
 * `tasks` is the plan tree: the target is found at any depth, and its
 * dependencies are checked against the whole plan tree.
 */
export function validateTaskEdit(
  actor: TaskEditActor,
  tasks: readonly Task[],
  taskId: string,
  changes: Partial<Task>,
): TaskEditCheck {
  const found = flattenTasksWithParents(tasks).find(({ task }) => task.id === taskId);
  if (!found) return { ok: false, error: 'Task not found' };
  const { task: target, parent } = found;

  const locked = actor === 'planner' ? lockedTaskRefusal(target, 'modified') : null;
  if (locked) return { ok: false, error: locked };

  if (changes.dependencies) {
    const depCheck = canSetDependencies(tasks, taskId, changes.dependencies);
    if (!depCheck.ok) return depCheck;
  }

  const coherence = typeCoherenceCheck(target, changes);
  if (coherence && !coherence.ok) return coherence;

  const ops = opsCheck(target, parent !== null, changes);
  if (ops) return ops;

  return coherence ?? { ok: true };
}
