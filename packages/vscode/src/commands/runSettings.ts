import * as vscode from 'vscode';
import { ACT_RISK, AUTORUN_RISK, type GlobalRunSettings } from '@ordewell/core';

async function confirmed(title: string, detail: string, confirm: string): Promise<boolean> {
  return (await vscode.window.showWarningMessage(title, { modal: true, detail }, confirm)) === confirm;
}

/** What turning Act or autorun on asks first, whether from the Settings panel or the extension host (ADR-0030). */
export async function confirmRisks(changes: Partial<GlobalRunSettings>): Promise<boolean> {
  if (changes.supervisorLevel === 'act' && !(await confirmed('Let the supervisor act?', `At Act the supervisor runs, stops and retries tasks, edits the plan and merges, without asking you. ${ACT_RISK}`, 'Let it act'))) return false;
  if (changes.autorun === true && !(await confirmed('Start plans without review?', `Each plan the planner submits starts at once, as if you had pressed Execute. ${AUTORUN_RISK}`, 'Turn autorun on'))) return false;
  return true;
}
