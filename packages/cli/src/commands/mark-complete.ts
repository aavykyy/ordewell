import { taskActionCommand } from '@ordewell/core';
import { ApiClient } from '../apiClient';
import { flag } from '../utils';
import { withTaskRef } from './task-control';

export async function handleMarkComplete(subArgs: string[], api?: ApiClient): Promise<void> {
  await withTaskRef(
    subArgs,
    'Usage: ordewell mark-complete <task-id-or-order> [--session-id <id>]',
    api,
    async (client, sessionId, ref) => {
      try {
        const done = await client.execute(sessionId, taskActionCommand('complete', ref));
        console.log(done.message);
      } catch (err) {
        console.error(`Failed to mark task complete: ${(err as Error).message}`);
        process.exit(1);
      }
    },
  );
}

export async function handleUncomplete(subArgs: string[], api?: ApiClient): Promise<void> {
  await withTaskRef(
    subArgs,
    'Usage: ordewell uncomplete <task-id-or-order> [--session-id <id>]',
    api,
    async (client, sessionId, ref) => {
      try {
        const done = await client.execute(sessionId, taskActionCommand('uncomplete', ref));
        console.log(done.message);
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
  await withTaskRef(
    subArgs,
    'Usage: ordewell skip <task-id-or-order> [--reason <text>] [--session-id <id>]',
    api,
    async (client, sessionId, ref) => {
      try {
        const done = await client.execute(sessionId, taskActionCommand('skip', ref, flag(subArgs, '--reason')));
        console.log(done.message);
      } catch (err) {
        console.error(`Failed to skip task: ${(err as Error).message}`);
        process.exit(1);
      }
    },
  );
}
