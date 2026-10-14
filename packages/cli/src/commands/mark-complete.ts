import { ApiClient } from '../apiClient';
import { flag } from '../utils';
import { withResolvedTask } from './task-control';

export async function handleMarkComplete(subArgs: string[], api?: ApiClient): Promise<void> {
  await withResolvedTask(
    subArgs,
    'Usage: ordewell mark-complete <task-id-or-order> [--session-id <id>]',
    api,
    async (client, sessionId, taskId) => {
      try {
        await client.markTaskComplete(sessionId, taskId);
        console.log('Task marked complete.');
      } catch (err) {
        console.error(`Failed to mark task complete: ${(err as Error).message}`);
        process.exit(1);
      }
    },
  );
}

export async function handleUncomplete(subArgs: string[], api?: ApiClient): Promise<void> {
  await withResolvedTask(
    subArgs,
    'Usage: ordewell uncomplete <task-id-or-order> [--session-id <id>]',
    api,
    async (client, sessionId, taskId) => {
      try {
        await client.markTaskIncomplete(sessionId, taskId);
        console.log('Task marked not done.');
      } catch (err) {
        console.error(`Failed to mark task not done: ${(err as Error).message}`);
        process.exit(1);
      }
    },
  );
}

/**
 * Skip ends the task without landing its work, and lets what depends on it go
 * ahead. It is not a mark complete: only that vouches for the work.
 */
export async function handleSkip(subArgs: string[], api?: ApiClient): Promise<void> {
  await withResolvedTask(
    subArgs,
    'Usage: ordewell skip <task-id-or-order> [--reason <text>] [--session-id <id>]',
    api,
    async (client, sessionId, taskId) => {
      try {
        await client.skipTask(sessionId, taskId, flag(subArgs, '--reason'));
        console.log('Task skipped: none of its work lands, and the tasks that depend on it go ahead without it.');
      } catch (err) {
        console.error(`Failed to skip task: ${(err as Error).message}`);
        process.exit(1);
      }
    },
  );
}
