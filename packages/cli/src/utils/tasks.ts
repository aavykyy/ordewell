import { rejoinPlanTree, resolveUserTaskRef } from '@ordewell/core';

/** The plan tree, whatever shape the plan arrived in: a saved one keeps finished tasks in a flat execution log. */
export function allTasksOf(plan: Record<string, unknown>): Array<import("@ordewell/core").Task> {
  const tasks = (plan?.pendingTasks || plan?.tasks || []) as Array<import("@ordewell/core").Task>;
  const executionLog = (plan?.executionLog || []) as Array<import("@ordewell/core").Task>;
  return rejoinPlanTree(tasks, executionLog);
}

/** Resolve a user-supplied identifier — a task reference or a unique ID prefix (see `resolveUserTaskRef`). */
export function resolveTaskId(plan: Record<string, unknown>, identifier: string): string | undefined {
  return resolveUserTaskRef(allTasksOf(plan), identifier)?.id;
}
