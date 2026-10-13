import { serializeTask, type RunInput, type RunTask, type RunTaskStatus, type RunView, type SerializedTask, type SerializedTaskStatus, type SurfacePlan, type SurfacePlanState, type SurfaceTask } from './SessionMessage';
import type { IsolationHandoff } from '../interfaces/IWorktreeIsolation';

export const EMPTY_RUN: RunView = { tasks: [], runMerge: null, handoff: null, mergeResult: null };

type PlanFields = Omit<RunTask, keyof RunTaskStatus>;

/**
 * The one decision of which task fields are status-only: what is named here
 * no plan carries, so only a status update changes it and a plan refresh
 * keeps it. Everything else is the plan's.
 */
function split({ verdict, idleSince, isolation, checkpoint, queued, continuable, awaitingApproval, mergeGate, forcedPastGate, ...plan }: RunTask): { plan: PlanFields; status: RunTaskStatus } {
  return { plan, status: { verdict, idleSince, isolation, checkpoint, queued, continuable, awaitingApproval, mergeGate, forcedPastGate } };
}

/**
 * The plan's tasks over what the view already holds: plan fields from the
 * plan, absent meaning none; status-only fields as the stream last said.
 */
function refresh(previous: readonly RunTask[], tasks: readonly SerializedTask[]): RunTask[] {
  const held = new Map<string, RunTask>();
  const index = (list: readonly RunTask[]): void => list.forEach((t) => { held.set(t.id, t); index(t.subtasks); });
  index(previous);
  const fold = ({ subtasks, ...task }: SerializedTask): RunTask => {
    const was = held.get(task.id);
    const { checkpoint, ...status } = was ? split(was).status : {};
    // The question is answered once the plan says the task no longer waits at it.
    const waits = task.status === 'awaiting_user' && task.awaitingReason === 'checkpoint';
    return { ...task, ...status, ...(waits && checkpoint ? { checkpoint } : {}), subtasks: subtasks.map(fold) };
  };
  return tasks.map(fold);
}

/** A plan carries the task's wait and usage too, but a status update is the newer word on them. */
function withStatus({ awaitingReason: _reason, resumeAt: _resumeAt, attemptUsage: _usage, ...plan }: PlanFields, { id: _id, ...status }: SerializedTaskStatus): Omit<RunTask, 'subtasks'> {
  return { ...plan, ...status };
}

/** A status update says everything about a task's status: what it leaves out, the task no longer has. */
function applyStatus(tasks: readonly RunTask[], updates: ReadonlyMap<string, SerializedTaskStatus>): RunTask[] {
  return tasks.map((task) => {
    const subtasks = applyStatus(task.subtasks, updates);
    const update = updates.get(task.id);
    return update ? { ...withStatus(split(task).plan, update), subtasks } : { ...task, subtasks };
  });
}

/** `tasks` itself when `change` leaves the task named alone, or no task has that id. */
function changeTask(tasks: RunTask[], taskId: string, change: (task: RunTask) => RunTask): RunTask[] {
  let changed = false;
  const next = tasks.map((task) => {
    const updated = task.id === taskId ? change(task) : task;
    const subtasks = changeTask(updated.subtasks, taskId, change);
    if (updated === task && subtasks === task.subtasks) return task;
    changed = true;
    return { ...updated, subtasks };
  });
  return changed ? next : tasks;
}

const PATCHABLE: ReadonlySet<string> = new Set<keyof PlanFields>([
  'order', 'title', 'type', 'status', 'description', 'dependencies', 'assignedRunner', 'assignedModel', 'taskMode', 'prompt',
  'userSteps', 'autonomy', 'sliceType', 'userStoriesCovered', 'awaitingReason', 'resumeAt', 'ops', 'skills', 'addedBy', 'attemptUsage',
]);

function patchTask(task: RunTask, changes: Record<string, unknown>): RunTask {
  const fields = Object.entries(changes).filter(([key]) => PATCHABLE.has(key));
  if (fields.length === 0) return task;
  // The patch is the `Partial<Task>` PlanEditor applied; past the filter, only plan fields remain.
  return { ...task, ...(Object.fromEntries(fields) as Partial<PlanFields>) };
}

function startTask(task: RunTask): RunTask {
  return task.status === 'in_progress' ? task : running(task);
}

function running({ awaitingReason: _reason, resumeAt: _resumeAt, checkpoint: _checkpoint, ...task }: RunTask): RunTask {
  return { ...task, status: 'in_progress' };
}

function handoffOf({ type: _type, ...handoff }: Extract<RunInput, { type: 'isolation_handoff' }>): IsolationHandoff {
  return handoff;
}

/**
 * A saved plan keeps finished tasks in its execution log and the rest pending;
 * rejoined, the log wins for a task in both, being what actually happened.
 */
function planTasks(plan: SurfacePlan | SurfacePlanState): SurfaceTask[] {
  if ('tasks' in plan) return plan.tasks;
  const byId = new Map<string, SurfaceTask>();
  for (const task of [...plan.pendingTasks, ...(plan.phase === 'executing' ? plan.executionLog : [])]) byId.set(task.id, task);
  return [...byId.values()].sort((a, b) => a.order - b.order);
}

export function reduceRun(view: RunView, input: RunInput): RunView {
  switch (input.type) {
    case 'plan_generated':
      return { ...view, tasks: refresh(view.tasks, input.plan.tasks), runSettings: input.plan.runSettings };
    case 'plan_snapshot':
      return {
        ...view,
        tasks: refresh(view.tasks, planTasks(input.plan).map(serializeTask)),
        // A saved plan's phase-tagged form has no run settings to say.
        runSettings: 'tasks' in input.plan ? input.plan.runSettings : view.runSettings,
      };
    case 'status_update':
      return {
        ...view,
        tasks: applyStatus(view.tasks, new Map(input.tasks.map((t) => [t.id, t]))),
        runMerge: input.runMerge ?? null,
        usage: input.usage,
      };
    case 'task_started':
    case 'task_updated': {
      const tasks = changeTask(view.tasks, input.taskId, (task) => (input.type === 'task_started' ? startTask(task) : patchTask(task, input.changes)));
      return tasks === view.tasks ? view : { ...view, tasks };
    }
    case 'isolation_handoff':
      return { ...view, handoff: handoffOf(input) };
    case 'isolation_merge':
      return input.result.outcome === 'merged'
        ? { ...view, mergeResult: input.result, handoff: null, runMerge: null }
        : { ...view, mergeResult: input.result };
    // A checkpoint's whole question and every status `review_needed` implies
    // arrive in the status update that follows; `review_needed`'s own list is
    // flat, so as a plan it would lift subtasks to the top level.
    case 'checkpoint':
    case 'review_needed':
    case 'review_approved':
    case 'execution_complete':
    case 'execution_stopped':
    case 'execution_action':
    case 'task_output':
    case 'task_log':
    case 'isolation_blocked':
    case 'planner_message':
    case 'planner_turn_started':
    case 'planner_skill_loaded':
    case 'planner_turn_ended':
    case 'planner_text_delta':
    case 'planner_thinking_delta':
    case 'planner_text_retracted':
    case 'planner_usage':
    case 'planner_liveness':
    case 'subagent_started':
    case 'subagent_finished':
    case 'research_step':
    case 'research_step_done':
    case 'plan_token':
    case 'approval_request':
    case 'approval_settled':
    case 'approval_decided':
      return view;
    default: {
      // Listed rather than defaulted, so a new message fails to compile until
      // someone decides what it does to a run.
      const unhandled: never = input;
      return unhandled;
    }
  }
}
