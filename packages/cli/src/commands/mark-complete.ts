import { confirmedOverride, manualOverrideConfirmation, overrideNeedsConfirmation, resolveUserTaskRef, taskActionCommand, titledTaskRefOf, type ExecutionCommand, type OverrideDirection } from '@ordewell/core';
import { ApiClient } from '../apiClient';
import { flag, hasFlag } from '../utils';
import { allTasksOf } from '../utils/tasks';
import { askYesNo, fail } from './shared';
import { withTaskRef } from './task-control';

/**
 * Mark complete and Mark not done on an AI or script task are overrides
 * (ADR-0029): the user is asked first, naming what each does, and the daemon
 * gets their yes on the command. `--yes` is the scriptable way to have asked
 * already; with no terminal to ask on, the answer is no. A manual task is the
 * user's own sign-off and asks nothing. A daemon that cannot say what the task
 * is gets the command without a yes, and refuses it in its own words.
 */
async function overrideCommand(
  direction: OverrideDirection,
  subArgs: string[],
  api: ApiClient,
  sessionId: string,
  ref: string,
  confirm: (question: string) => Promise<boolean>,
): Promise<ExecutionCommand> {
  const command = taskActionCommand(direction, ref);
  if (hasFlag(subArgs, '--yes')) return confirmedOverride(command);
  const plan = await api.getSession(sessionId, flag(subArgs, '--workspace') || process.cwd()).then((s) => s.plan, () => null);
  const tasks = plan ? allTasksOf(plan as unknown as Record<string, unknown>) : [];
  const task = resolveUserTaskRef(tasks, ref);
  if (!task || !overrideNeedsConfirmation(task)) return command;
  const question = `${manualOverrideConfirmation(direction, `task ${titledTaskRefOf(tasks, task.id) ?? ref}`)} Go ahead?`;
  if (!(await confirm(question))) fail('Nothing was changed. Pass --yes to confirm without a prompt.');
  return confirmedOverride(command, task.status);
}

export async function handleMarkComplete(subArgs: string[], api?: ApiClient, confirm: (question: string) => Promise<boolean> = askYesNo): Promise<void> {
  await withTaskRef(
    subArgs,
    'Usage: ordewell mark-complete <task-id-or-order> [--session-id <id>] [--workspace /path] [--yes]',
    api,
    async (client, sessionId, ref) => {
      const command = await overrideCommand('complete', subArgs, client, sessionId, ref, confirm);
      try {
        const done = await client.execute(sessionId, command);
        console.log(done.message);
      } catch (err) {
        console.error(`Failed to mark task complete: ${(err as Error).message}`);
        process.exit(1);
      }
    },
  );
}

export async function handleUncomplete(subArgs: string[], api?: ApiClient, confirm: (question: string) => Promise<boolean> = askYesNo): Promise<void> {
  await withTaskRef(
    subArgs,
    'Usage: ordewell uncomplete <task-id-or-order> [--session-id <id>] [--workspace /path] [--yes]',
    api,
    async (client, sessionId, ref) => {
      const command = await overrideCommand('uncomplete', subArgs, client, sessionId, ref, confirm);
      try {
        const done = await client.execute(sessionId, command);
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
