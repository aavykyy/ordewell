import { taskUsageText } from '../tui/blocks';
import { writeFileSync } from 'fs';
import { flag, hasFlag, readLastSession } from '../utils';
import { iconFor } from '../utils/output';
import { blockedByLabel, blockingFailures, skippedLabel, flattenTasks, taskOrderLabel, taskRowView, planUsage, waitsForApproval, type ApprovalRecord } from '@ordewell/core';
import { allTasksOf } from '../utils/tasks';
import { ensureDaemon, resolvePort } from '../daemon';
import { ApiClient, type SessionMeta } from '../apiClient';
import { handoffBase, isolationOfPlan } from '../isolation';

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
  const blocked = blockingFailures(everyTask.map((t) => ({ ...t, subtasks: [], dependencies: t.dependencies ?? [] })));
  const count = (status: string) => everyTask.filter((t) => t.status === status || (status === 'blocked' && blocked.has(t.id))).length;

  console.log(`Session:  ${sessionId}`);
  console.log(`Goal:     ${meta.goal}`);
  console.log(`Runner:   ${(meta.runners || []).join(', ')}  |  Status: ${meta.status}`);
  console.log(`Phase:    ${plan?.phase || 'unknown'}  |  Created: ${meta.createdAt}`);
  const isolation = isolationOfPlan(plan);
  if (isolation) console.log(`Base:     ${handoffBase(isolation.handoff, 8)}`);
  console.log(`Tasks:    ${everyTask.length} total  |  ${count('completed')} done  |  ${count('failed')} failed  |  ${count('in_progress')} running  |  ${count('blocked')} blocked  |  ${count('skipped')} skipped\n`);

  const usage = planUsage(allTasks);
  if (usage.attempts) console.log(`Tasks total: ${taskUsageText(usage)}`);
  const record = servedApprovalRecord(plan);
  const approval = (row: { waitsForApproval: string | null }, ref: string) => (row.waitsForApproval
    ? `${row.waitsForApproval}: \`ordewell force-start ${ref}\` approves it, \`ordewell run\` approves all`
    : null);
  for (const t of allTasks) {
    const icon = iconFor(blocked.has(t.id) ? 'blocked' : t.status);
    const model = t.assignedModel ? ` (${t.assignedModel.modelLabel})` : '';
    const shortId = (t.id ?? '').slice(-8);
    console.log(`  ${taskOrderLabel(t).padStart(2)}. ${icon} [${shortId}] ${t.title}${model}`);
    const row = taskRowView({ ...t, dependencies: t.dependencies ?? [], waitsForApproval: waitsForApproval(t, record) }, { tasks: allTasks });
    const waiting = approval(row, taskOrderLabel(t));
    if (waiting) console.log(`      ${waiting}`);
    if (row.blockedBy) console.log(`      ${blockedByLabel(row.blockedBy)}`);
    if (row.status === 'skipped') console.log(`      ${skippedLabel(row.skipReason)}`);
    if (row.usage) console.log(`      ${taskUsageText(row.usage)}`);
    for (const sub of t.subtasks || []) {
      const subIcon = iconFor(blocked.has(sub.id) ? 'blocked' : sub.status);
      const subModel = sub.assignedModel ? ` (${sub.assignedModel.modelLabel})` : '';
      const subShortId = (sub.id ?? '').slice(-8);
      console.log(`    ${taskOrderLabel(sub, t)}. ${subIcon} [${subShortId}] ${sub.title}${subModel}`);
      const subRow = taskRowView({ ...sub, dependencies: sub.dependencies ?? [], waitsForApproval: waitsForApproval(sub, record) }, { parent: t, tasks: allTasks });
      const subWaiting = approval(subRow, taskOrderLabel(sub, t));
      if (subWaiting) console.log(`        ${subWaiting}`);
      if (subRow.blockedBy) console.log(`        ${blockedByLabel(subRow.blockedBy)}`);
      if (subRow.status === 'skipped') console.log(`        ${skippedLabel(subRow.skipReason)}`);
      if (subRow.usage) console.log(`        ${taskUsageText(subRow.usage)}`);
    }
  }
}

/** The approval record the daemon serves with the plan; one it lacks reads as no approval, which singles nothing out. */
function servedApprovalRecord(plan: Record<string, unknown>): ApprovalRecord {
  const approvedTasks = Array.isArray(plan?.approvedTasks) ? plan.approvedTasks.filter((id): id is string => typeof id === 'string') : undefined;
  return { approved: plan?.approved === true, ...(approvedTasks ? { approvedTasks } : {}) };
}
