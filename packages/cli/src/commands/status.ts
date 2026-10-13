import { taskUsageText } from '../tui/blocks';
import { writeFileSync } from 'fs';
import { flag, hasFlag, readLastSession } from '../utils';
import { iconFor } from '../utils/output';
import { flattenTasks, taskOrderLabel, taskRowView, planUsage } from '@ordewell/core';
import { allTasksOf } from '../utils/tasks';
import { ensureDaemon, resolvePort } from '../daemon';
import { ApiClient, type SessionMeta } from '../apiClient';

export async function handleStatus(subArgs: string[], injectedApi?: ApiClient): Promise<void> {
  const sessionId = flag(subArgs, '--session-id');
  const workspace = flag(subArgs, '--workspace') || process.cwd();
  const outputPath = flag(subArgs, '--output');
  // --output implies JSON: writing the human table to a file helps nobody.
  const asJson = hasFlag(subArgs, '--json') || Boolean(outputPath);

  const port = injectedApi ? resolvePort(subArgs) : await ensureDaemon(resolvePort(subArgs));
  const api = injectedApi || new ApiClient(port);

  if (sessionId) {
    const session = await api.getSession(sessionId, workspace);
    if (asJson) {
      emitJson(session, outputPath);
      return;
    }
    printOneSession(sessionId, session.meta, session.plan);
  } else {
    const sessions = await api.getSessions(workspace);
    if (asJson) {
      emitJson(sessions, outputPath);
      return;
    }
    if (sessions.length === 0) {
      console.log(`No sessions found in ${workspace}.`);
      return;
    }
    console.log(`${sessions.length} session(s):\n`);
    for (const s of sessions) {
      console.log(`  ${s.id.slice(-8)}  ${s.status.padEnd(10)}  ${s.taskCount} tasks  ${(s.runners || []).join(',').padEnd(12)}  ${s.goal.slice(0, 60)}`);
    }
    const last = readLastSession(workspace);
    if (last) {
      console.log(`\n  Last active: ${last.sessionId.slice(-8)} ("${last.goal.slice(0, 50)}")`);
    }
    console.log(`\n  API server: http://127.0.0.1:${port}`);
  }
}

function emitJson(payload: unknown, outputPath?: string): void {
  const json = JSON.stringify(payload, null, 2);
  if (!outputPath) {
    console.log(json);
    return;
  }
  try {
    writeFileSync(outputPath, json + '\n');
    console.log(`Wrote ${outputPath}`);
  } catch (err) {
    console.error(`Failed to write ${outputPath}: ${(err as Error).message}`);
    process.exit(1);
  }
}

function printOneSession(
  sessionId: string,
  meta: SessionMeta,
  plan: Record<string, unknown>,
): void {
  const allTasks = allTasksOf(plan);
  const everyTask = flattenTasks(allTasks);
  const count = (status: string) => everyTask.filter((t) => t.status === status).length;

  console.log(`Session:  ${sessionId}`);
  console.log(`Goal:     ${meta.goal}`);
  console.log(`Runner:   ${(meta.runners || []).join(', ')}  |  Status: ${meta.status}`);
  console.log(`Phase:    ${plan?.phase || 'unknown'}  |  Created: ${meta.createdAt}`);
  console.log(`Tasks:    ${everyTask.length} total  |  ${count('completed')} done  |  ${count('failed')} failed  |  ${count('in_progress')} running  |  ${count('blocked')} blocked\n`);

  const usage = planUsage(allTasks);
  if (usage.attempts) console.log(`Tasks total: ${taskUsageText(usage)}`);
  for (const t of allTasks) {
    const icon = iconFor(t.status);
    const model = t.assignedModel ? ` (${t.assignedModel.modelLabel})` : '';
    const shortId = (t.id ?? '').slice(-8);
    console.log(`  ${taskOrderLabel(t).padStart(2)}. ${icon} [${shortId}] ${t.title}${model}`);
    const row = taskRowView({ ...t, dependencies: t.dependencies ?? [] });
    if (row.usage) console.log(`      ${taskUsageText(row.usage)}`);
    for (const sub of t.subtasks || []) {
      const subIcon = iconFor(sub.status);
      const subModel = sub.assignedModel ? ` (${sub.assignedModel.modelLabel})` : '';
      const subShortId = (sub.id ?? '').slice(-8);
      console.log(`    ${taskOrderLabel(sub, t)}. ${subIcon} [${subShortId}] ${sub.title}${subModel}`);
      const subRow = taskRowView({ ...sub, dependencies: sub.dependencies ?? [] });
      if (subRow.usage) console.log(`        ${taskUsageText(subRow.usage)}`);
    }
  }
}
