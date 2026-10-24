/**
 * A message or interrupt a task cannot take: it is not running, or it is
 * waiting on something a message does not answer.
 * The request is wrong, not the orchestrator, so a surface says why.
 */
export class TaskControlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TaskControlError';
  }
}
