/**
 * How far a plan's supervisor may act in its wake-up turns (ADR-0029): a plan
 * setting, saved on the run as it starts. Off: it never wakes. Watch: it
 * wakes, reads and suggests. Act: Watch, and acting within its loop guards
 * without asking.
 */
export type SupervisorLevel = 'off' | 'watch' | 'act';

export function isSupervisorLevel(value: unknown): value is SupervisorLevel {
  return value === 'off' || value === 'watch' || value === 'act';
}

/**
 * Who asked the command seam for an action (ADR-0029): the user, a planner
 * turn the user started, or the supervisor at its level.
 */
export type ExecutionActor =
  | { kind: 'user' }
  | { kind: 'planner-turn' }
  | { kind: 'supervisor'; level: SupervisorLevel }
  /** The user's standing instruction to start each plan the planner submits (ADR-0030). */
  | { kind: 'autorun' };

export type ExecutionCommandName =
  | 'run_plan'
  | 'run_task'
  | 'stop_task'
  | 'stop_run'
  | 'retry_task'
  | 'message_task'
  | 'answer_approval'
  | 'merge_all'
  | 'skip_task';

/**
 * One call at the command seam as the timeline keeps it: what was asked, by
 * whom, about which task, and how it ended — done, refused by the seam, or
 * declined by the user it asked.
 */
export interface ExecutionRecord {
  command: ExecutionCommandName;
  actor: ExecutionActor['kind'];
  /** Present when the supervisor asked. */
  level?: SupervisorLevel;
  /** `ref` is how the plan numbers it: "#4", or "#4.1" for a subtask. */
  task?: { id: string; ref: string; title: string };
  outcome: 'done' | 'refused' | 'declined';
  /** The refusal, the message sent, or the note a denial carried. */
  detail?: string;
  at: string;
}
