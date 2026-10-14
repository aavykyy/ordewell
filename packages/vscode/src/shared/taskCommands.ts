import type { RunnerCommand, TaskLogEvent } from '@ordewell/core';

export function loadedCommands(events: readonly TaskLogEvent[]): readonly RunnerCommand[] {
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i];
    if (event.type === 'runner_loaded') return event.commands;
  }
  return [];
}

export function latestTaskCommands(session: {
  taskLogAttempts(taskId: string): number[];
  taskLog(taskId: string, attempt: number): TaskLogEvent[];
}, taskId: string): readonly RunnerCommand[] {
  const attempts = session.taskLogAttempts(taskId);
  const attempt = attempts[attempts.length - 1];
  return attempt === undefined ? [] : loadedCommands(session.taskLog(taskId, attempt));
}
