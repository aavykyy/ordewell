import { approvalLabel, awaitingLabel, skippedLabel } from '@ordewell/core/plan-utils';
import type { TaskLogStatus } from '../../shared/taskLogProtocol';

export type TaskLogStateKind = 'approval' | 'working' | 'waiting' | 'checkpoint' | 'done' | 'failed' | 'idle';

export interface TaskLogState {
  kind: TaskLogStateKind;
  label: string;
}

/**
 * What a task log's header says the task is doing (ADR-0018, V1): a runner
 * settled status first, then a runner request waiting for an answer (A1),
 * then the live turn and the saved reason it waits. The words come from core,
 * so a task that needs the user reads the same here as on its card and in the
 * TUI (ADR-0018, W1).
 */
export function taskLogState(
  status: Pick<TaskLogStatus, 'working' | 'awaitingReason' | 'awaitingApproval' | 'planStatus' | 'skipReason' | 'lastTurnEnd'>,
): TaskLogState {
  if (status.planStatus === 'completed') return { kind: 'done', label: 'Done' };
  if (status.planStatus === 'failed') return { kind: 'failed', label: 'Failed' };
  if (status.planStatus === 'skipped') return { kind: 'idle', label: skippedLabel(status.skipReason ?? null) };
  const approvals = approvalLabel(status.awaitingApproval);
  if (approvals) return { kind: 'approval', label: approvals };
  if (status.working) return { kind: 'working', label: 'Working' };
  if (status.planStatus === 'awaiting_user') {
    const label = awaitingLabel({ status: status.planStatus, awaitingReason: status.awaitingReason }) ?? 'Waiting for your input';
    return { kind: status.awaitingReason === 'checkpoint' ? 'checkpoint' : 'waiting', label };
  }
  if (status.planStatus === 'blocked') return { kind: 'waiting', label: 'Blocked' };
  if (status.lastTurnEnd === 'failed') return { kind: 'failed', label: 'Turn failed' };
  if (status.lastTurnEnd === 'interrupted') return { kind: 'idle', label: 'Interrupted' };
  return { kind: 'idle', label: 'Idle' };
}
