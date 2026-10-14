import {
  isAwaitingReason, isSupervisorLevel, reduceRun,
  type DisplayBlock, type PlanSnapshot, type RunInput, type RunTask, type RunView, type SessionMessage, type SettingsResponse, type SurfacePlan, type SurfacePlanState,
} from '@ordewell/core';
import { sanitize } from '../ansi';
import {
  isTaskRunning, plannerInFlight, type TaskView, type TuiState,
} from '../state';
import { isolationOfPlan } from '../../isolation';
import { hear } from '../transcript';
import { dropApproval, enqueueApproval } from './approvals';
import { withDeferral } from '../handoff';

/**
 * A plan's text, safe to lay out. Every field here was written by a model, so
 * it gets the same treatment a planner turn does — see `sanitize`.
 */
const planText = (value: unknown, fallback = ''): string => sanitize(String(value ?? fallback));

/**
 * The same, for a field the pane paints on one row. A newline surviving into
 * one of these would be written into the middle of a row rather than wrapped,
 * which moves the terminal's cursor down a line and shoves the rest of the
 * frame with it — the plan pane's meta rows are `truncate`d, not wrapped, so
 * nothing downstream would split it.
 */
const planLabel = (value: unknown, fallback = ''): string => planText(value, fallback).replace(/\n+/g, ' ');

/** A wire value as a record to read fields off, or an empty one when it is not an object at all. */
const asRecord = (value: unknown): Record<string, unknown> =>
  typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};

/**
 * A plan the TUI read whole — a route's answer, a loaded session — as the run
 * input that folds it. Live from the planner it is one flat `tasks` array; a
 * persisted session is phase-tagged, its finished tasks in `executionLog` and
 * the rest in `pendingTasks`. Both reach `reduceRun` through here.
 */
export function planSnapshot(plan: unknown): PlanSnapshot {
  const record = asRecord(plan);
  if (Array.isArray(record.tasks)) return { type: 'plan_snapshot', plan: record as unknown as SurfacePlan };
  return {
    type: 'plan_snapshot',
    plan: {
      ...record,
      phase: record.phase ?? 'executing',
      pendingTasks: Array.isArray(record.pendingTasks) ? record.pendingTasks : [],
      executionLog: Array.isArray(record.executionLog) ? record.executionLog : [],
    } as unknown as SurfacePlanState,
  };
}

/**
 * One run-view task as the pane's `TaskView`, recursing into subtasks sorted by
 * order so the dotted labels read in plan order.
 */
function runTaskToView(t: RunTask): TaskView {
  const model = t.assignedModel;
  return {
    id: String(t.id),
    order: typeof t.order === 'number' ? t.order : 0,
    title: planLabel(t.title, 'Untitled task'),
    description: planText(t.description ?? t.title),
    prompt: typeof t.prompt === 'string' ? sanitize(t.prompt) : undefined,
    type: t.type === 'user' ? 'user' : 'ai',
    attemptUsage: Array.isArray(t.attemptUsage) ? t.attemptUsage : undefined,
    status: planLabel(t.status, 'pending'),
    idleSince: t.idleSince ?? null,
    dependencies: Array.isArray(t.dependencies) ? t.dependencies.map((id) => planLabel(id)) : [],
    assignedRunner: typeof t.assignedRunner === 'string' ? planLabel(t.assignedRunner) : undefined,
    taskMode: typeof t.taskMode === 'string' ? planLabel(t.taskMode) : undefined,
    assignedModel: model
      ? {
          modelId: planLabel(model.modelId),
          modelLabel: planLabel(model.modelLabel ?? model.modelId),
          ...(typeof model.thinkingEffort === 'string' ? { thinkingEffort: planLabel(model.thinkingEffort) } : {}),
          ...(Array.isArray(model.availableVariants) ? { availableVariants: model.availableVariants.map((variant) => planLabel(variant)) } : {}),
        }
      : undefined,
    isolation: t.isolation as TaskView['isolation'],
    awaitingReason: t.status === 'awaiting_user' && isAwaitingReason(t.awaitingReason) ? t.awaitingReason : undefined,
    ...(t.status === 'awaiting_user' && t.awaitingReason === 'usage-limit' && typeof t.resumeAt === 'string' ? { resumeAt: t.resumeAt } : {}),
    ...(t.status === 'skipped' && typeof t.skipReason === 'string' ? { skipReason: sanitize(t.skipReason) } : {}),
    checkpoint: typeof t.checkpoint === 'string' ? sanitize(t.checkpoint) : undefined,
    continuable: t.continuable === true,
    awaitingApproval: t.awaitingApproval,
    ...(t.ops === true ? { ops: true } : {}),
    ...(Array.isArray(t.skills) && t.skills.length > 0 ? { skills: t.skills.map((name) => planLabel(name)) } : {}),
    ...(t.addedBy ? { addedBy: t.addedBy } : {}),
    ...(Array.isArray(t.mergeGate) && t.mergeGate.length > 0 ? { mergeGate: t.mergeGate.map((title) => planLabel(title)) } : {}),
    ...(Array.isArray(t.forcedPastGate) && t.forcedPastGate.length > 0 ? { forcedPastGate: t.forcedPastGate.map((title) => planLabel(title)) } : {}),
    subtasks: t.subtasks.length > 0
      ? [...t.subtasks].sort((a, b) => (a.order ?? 0) - (b.order ?? 0)).map(runTaskToView)
      : undefined,
  };
}

/** The run's own supervisor level, read off the run settings a run carries. */
function supervisorOfRun(runSettings: RunView['runSettings']): Pick<TuiState, 'runSupervisor'> {
  if (!runSettings) return { runSupervisor: null };
  const unsupervised = typeof runSettings.unsupervised === 'string' ? runSettings.unsupervised : undefined;
  return {
    runSupervisor: {
      level: isSupervisorLevel(runSettings.supervisorLevel) ? runSettings.supervisorLevel : 'off',
      ...(unsupervised ? { unsupervised } : {}),
    },
  };
}

/** The pane's fields, all derived from the run view the surface folds. */
export function withRun(state: TuiState, run: RunView): TuiState {
  return {
    ...state,
    run,
    tasks: run.tasks.map(runTaskToView),
    handoff: run.handoff ?? null,
    runMerge: run.runMerge
      ? { waitingAtGate: run.runMerge.waitingAtGate, paused: run.runMerge.paused, handoff: { repos: run.runMerge.repos, landed: run.runMerge.landed } }
      : null,
    runAutoMerge: run.runSettings?.mergeAtGatesAutomatically ?? null,
    ...supervisorOfRun(run.runSettings),
  };
}

/** One run input into the surface's view; a fold that changes nothing returns the state unchanged. */
export function foldRun(state: TuiState, input: RunInput): TuiState {
  const run = reduceRun(state.run, input);
  return run === state.run ? state : withRun(state, run);
}

function mapRunTasks(tasks: RunTask[], map: (task: RunTask) => RunTask): RunTask[] {
  return tasks.map((task) => ({ ...map(task), subtasks: mapRunTasks(task.subtasks, map) }));
}

/**
 * A persisted plan's run record, read on a load that had no live stream to tell
 * it: each task's isolation mark and the run's handoff. A run the surface
 * already holds — from the connect snapshot or its own stream — keeps its
 * deferral for the same run.
 */
export function applyIsolationRecord(state: TuiState, plan: unknown): TuiState {
  const record = isolationOfPlan(plan);
  if (!record) return state;
  const { run } = state;
  return withRun(state, {
    ...run,
    tasks: mapRunTasks(run.tasks, (task) => ({ ...task, isolation: (record.tasks[task.id] ?? { state: 'none' }) as RunTask['isolation'] })),
    handoff: withDeferral(record.handoff, run.handoff),
  });
}

/** Isolation belongs to one session's run: forget it all, the handoff and every task's mark. */
export function clearRunIsolation(run: RunView): RunView {
  return {
    ...run,
    handoff: null,
    runMerge: null,
    mergeResult: null,
    tasks: mapRunTasks(run.tasks, ({ isolation: _dropped, ...task }) => task),
  };
}

export function applySettings(state: TuiState, settings: Partial<SettingsResponse>): TuiState {
  return {
    ...state,
    orchestratorModel:
      typeof settings.orchestratorModel === 'string' ? settings.orchestratorModel : state.orchestratorModel,
    plannerProvider:
      typeof settings.aiProvider === 'string' ? settings.aiProvider : state.plannerProvider,
    plannerEffort:
      typeof settings.plannerThinkingEffort === 'string' ? settings.plannerThinkingEffort : state.plannerEffort,
    plannerModels:
      settings.plannerModels && typeof settings.plannerModels === 'object' ? settings.plannerModels : state.plannerModels,
    maxParallel: typeof settings.maxParallel === 'number' ? settings.maxParallel : state.maxParallel,
    allowlist:
      settings.modelAllowlist && typeof settings.modelAllowlist === 'object'
        ? (settings.modelAllowlist as Record<string, string[]>)
        : state.allowlist,
    runSettings: settings.run ?? state.runSettings,
  };
}

/**
 * What a run is doing right now, from the tasks themselves. It used to be the
 * last `task_started` title, which went on naming a task long after it had
 * finished — and said nothing once the run was only waiting on the user.
 */
export function runLabel(tasks: TaskView[], runMerge: TuiState['runMerge'] = null): string {
  const running = tasks.filter(isTaskRunning);
  if (running.length > 0) {
    const [first] = running;
    const name = first.assignedRunner ? `${first.title} · ${first.assignedRunner}` : first.title;
    return running.length > 1 ? `${name} (+${running.length - 1} more)` : name;
  }
  const waiting = tasks.filter((t) => t.status === 'awaiting_user').length;
  if (waiting > 0) return waiting === 1 ? '1 task waits for you' : `${waiting} tasks wait for you`;
  // As plain as a task that waits on the user: the run waits on a merge (ADR-0020).
  return runMerge?.paused ? 'paused for Merge all — /handoff merge' : '';
}

/** A label for the status row, which is one row: text from a model flattened onto it. */
const statusText = (text: string): string => sanitize(text).replace(/\s+/g, ' ').trim();

/** What the conversation has in flight: calls awaiting their result, and subagents still at work, oldest first. */
function inFlight(blocks: readonly DisplayBlock[]): string[] {
  return blocks.flatMap((block): string[] => {
    if (block.type === 'tool') return block.status === 'pending' ? [statusText(`${block.headline.name}(${block.headline.keyArg})`)] : [];
    if (block.type !== 'subagent' || block.status !== 'running') return [];
    return [statusText(`Agent(${block.brief})`), ...inFlight(block.children)];
  });
}

/**
 * The status row during a planner turn, read off the conversation: it says
 * researching while a call is out, and names the newest one. A parallel round
 * opens several calls at once, so it counts the rest rather than flickering
 * between filenames and leaving whichever landed last.
 */
function turnActivity(state: TuiState): TuiState {
  if (!plannerInFlight(state)) return state;
  const open = inFlight(state.conversation.blocks);
  const status = open.length > 0 ? 'researching' : 'planning';
  const newest = open.at(-1) ?? '';
  const busyLabel = open.length > 1 ? `${newest} (+${open.length - 1} more)` : newest;
  return status === state.status && busyLabel === state.busyLabel ? state : { ...state, status, busyLabel };
}

/**
 * One planner message into the TUI. The conversation view takes all of it; an
 * approval request also queues its modal, since the planner waits on the answer.
 */
export function followSession(state: TuiState, message: SessionMessage): TuiState {
  const heard = turnActivity(hear(state, message));
  if (message.type === 'approval_request') {
    const { id, kind, subject, scope, detail } = message;
    // A task runner's request is answered in its task view, never in the planner's modal.
    if (kind === 'runner_tool') return heard;
    return enqueueApproval(heard, { id, kind, subject, scope, ...(detail ? { detail } : {}) });
  }
  return message.type === 'approval_settled' ? dropApproval(heard, message.id) : heard;
}
