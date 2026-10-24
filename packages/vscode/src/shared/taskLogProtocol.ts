import type { ApprovalDecision, AwaitingReason, DisplayBlock, RunnerCommand, StructuredTurnEnd, TaskStatus, TaskUsageSummary } from '@ordewell/core';

/*
 * The messages between the extension host and a task-log panel (ADR-0018, V1).
 * Types only: the host (tsup) and the panel (Vite) each compile this file, so
 * neither can drift from what the other sends. The panel is its own webview —
 * one editor tab per task — so it has its own protocol rather than borrowing
 * the chat's, which is shaped around the planner conversation.
 */

/** One message a structured task's runner has not read yet. */
export interface TaskLogQueuedMessage {
  id: string;
  text: string;
  /** The runner already has it, for its next step, so it cannot be taken back (ADR-0023). */
  handedOver?: boolean;
  /** Force sent: it goes as soon as the running turn is interrupted (ADR-0023, F1). */
  forced?: boolean;
}

/**
 * Everything the panel draws besides the log blocks: the header's identity and
 * live state, the attempt switcher, and the composer's queue. Derived on the
 * host from the reduced view and the task, so the panel never has to know the
 * plan.
 */
export interface TaskLogStatus {
  commands?: readonly RunnerCommand[];
  taskId: string;
  order: number;
  /** The task's dotted reference ("2", "2.1"), for a subtask whose own order restarts at 1. */
  orderLabel?: string;
  title: string;
  runner: string;
  planStatus: TaskStatus;
  awaitingReason?: AwaitingReason;
  /** Why a skipped task was skipped, so its header says more than "Skipped" (ADR-0018, W1). */
  skipReason?: string;
  /** "Resumes at 8:10pm" while a task paused on a usage limit resumes on its own (#84); absent otherwise. */
  resumes?: string;
  /** How many of the runner's tool requests wait for an answer (ADR-0018, A1). */
  awaitingApproval: number;
  /** A turn is live. */
  working: boolean;
  /** How the last turn ended; absent before the first one does. */
  lastTurnEnd?: StructuredTurnEnd;
  /** Messages the runner has not read yet, oldest first. */
  queued: readonly TaskLogQueuedMessage[];
  /** Attempts that have a saved log, oldest first. */
  attempts: readonly number[];
  /** Which attempt the blocks below belong to. */
  attempt: number;
  /** The task finished and can be continued in its saved session (ADR-0018, K1): the message box continues it. */
  continuable: boolean;
  /** Paused on a usage limit with a saved session: Resume now is offered, and the message box resumes it. */
  resumable?: boolean;
  /**
   * The usage line for the attempt on screen: that attempt's own spend and
   * meter on a past attempt, and the task's whole spend with the latest
   * meter on the latest one (as the TUI's task view draws it). A task with no
   * attempt ledger falls back to the loaded log's own report.
   */
  usage?: Pick<TaskUsageSummary, 'totals' | 'contextFill'>;
  /** The task's whole spend while an earlier attempt is on screen, labelled "task total" beside `usage`. */
  usageTotal?: Pick<TaskUsageSummary, 'totals' | 'contextFill'>;
}

export type HostToTaskLog =
  /** The panel opened, or switched attempt: the whole view it should draw. */
  | { type: 'init'; status: TaskLogStatus; blocks: readonly DisplayBlock[] }
  /** Blocks new or changed since the last patch, with the new order. */
  | { type: 'patch'; order: readonly string[]; changed: readonly DisplayBlock[] }
  /** The header or queue changed; the blocks did not. */
  | { type: 'status'; status: TaskLogStatus }
  | { type: 'showError'; error: string };

export type TaskLogToHost =
  | { type: 'ready' }
  | { type: 'invokeTaskCommand'; name: string; args: string }
  | { type: 'sendTaskMessage'; text: string }
  | { type: 'removeQueuedTaskMessage'; id: string }
  /** Force send (ADR-0023, F1): interrupt the running turn and deliver `text` next. */
  | { type: 'sendTaskMessageNow'; text: string }
  /** Force send a message still queued. */
  | { type: 'sendQueuedTaskMessageNow'; id: string }
  | { type: 'interruptTask' }
  /** Keep a task paused on a usage limit from resuming on its own (#84). */
  | { type: 'cancelResume' }
  /** Resume a task paused on a usage limit now, once the user says the limit has reset. */
  | { type: 'resumeNow' }
  /** Continue the finished task in its saved session, with `text` as its next turn. */
  | { type: 'continueTask'; text: string }
  /** Answer one of the runner's tool requests (ADR-0018, A1). */
  | { type: 'answerApproval'; id: string; decision: ApprovalDecision }
  /** Show an earlier attempt; the host answers with `init`. */
  | { type: 'selectAttempt'; attempt: number };
