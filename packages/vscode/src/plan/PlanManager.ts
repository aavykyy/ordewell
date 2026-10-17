import * as vscode from 'vscode';
import { latestTaskCommands } from '../shared/taskCommands';
import {
  Session, LegacyPlanState, Task, flattenTasks, RunnerId, DiscoveredModel, enabledRunners,
  saveState, clearState, ModelResolver, RunnerRegistry, plannerNotReadyFor, describePlannerNotReady, CHAT_COMMANDS, taskStartedNotice,
  createEmptyPlan, installedPlannerAnswered, markRequestFor, pastGateConfirmation, titledRefs, PlannerNotReadyError, PlannerTurnDiscardedError, PlannerTurnStoppedError, type INotification, type IRunner, type TaskRowAction,
  type ExecutionCommand,
} from '@ordewell/core';
import type { TaskDraft, TaskEdit } from '../shared/protocol';
import type { ChatViewProvider } from '../providers/ChatViewProvider';
import { VsCodeConfig } from '../adapters/VsCodeConfig';
import { VsCodeFileSystem } from '../adapters/VsCodeFileSystem';
import { handleIsolationBlocked } from './isolation';
import { removalPrompt, taskFromDraft } from './taskEdit';
import { ALREADY_DELIVERED } from '../providers/TaskLogPanel';

export interface PlanManagerDeps {
  session: Session;
  chatProvider: ChatViewProvider;
  modelResolver: ModelResolver;
  runnerRegistry: RunnerRegistry;
  config: VsCodeConfig;
  fsAdapter: VsCodeFileSystem;
  runner: IRunner;
  notifications: INotification;
  getCurrentPlan: () => LegacyPlanState;
  setCurrentPlan: (plan: LegacyPlanState) => void;
  getCurrentGoal: () => string;
  setCurrentGoal: (goal: string) => void;
  /** Whether a planner turn holds the session — read off the session, never tracked here. */
  isGeneratingPlan: () => boolean;
  persistState: () => void;
  saveCurrentSession: () => void;
  log: (msg: string) => void;
}

export function findTask(plan: LegacyPlanState, id: string): Task | undefined {
  return flattenTasks(plan.tasks).find((t) => t.id === id);
}

export async function discoverModelsForPlan(deps: PlanManagerDeps): Promise<Partial<Record<RunnerId, DiscoveredModel[]>>> {
  return deps.modelResolver.modelsForRunners(enabledRunners(deps.config));
}

export function resolveRunnerSet(
  deps: PlanManagerDeps,
  pendingRunners?: RunnerId[],
  currentPlanRunners?: RunnerId[],
): RunnerId[] | null {
  const enabled = enabledRunners(deps.config).filter((r) => deps.runnerRegistry.get(r));
  if (enabled.length === 0) {
    deps.chatProvider.showError('No runner is enabled. Toggle runners in the chat header first.');
    return null;
  }
  if (pendingRunners && pendingRunners.length > 0) {
    const valid = pendingRunners.filter((r) => enabled.includes(r));
    if (valid.length > 0) return valid;
  }
  // Fall back to the current plan's runners (e.g. regeneration) rather than
  // expanding to ALL enabled runners — the user's prior selection should
  // persist, not be silently widened to include a runner they toggled off.
  if (currentPlanRunners && currentPlanRunners.length > 0) {
    const valid = currentPlanRunners.filter((r) => enabled.includes(r));
    if (valid.length > 0) return valid;
  }
  return enabled;
}

export function finishPlannerTurn(
  plan: LegacyPlanState,
  deps: PlanManagerDeps,
  opts?: { planChanged?: boolean },
): void {
  const planChanged = opts?.planChanged ?? true;
  if (plan.tasks.length > 0) {
    if (planChanged) {
      deps.chatProvider.showPlan(plan);
    }
  } else {
    deps.chatProvider.setState('planDraft');
  }
  saveState(plan, deps.fsAdapter.getWorkspaceRoot());
  deps.saveCurrentSession();
}

export function reportPlannerError(err: unknown, deps: PlanManagerDeps): void {
  // Message text is not evidence: a real failure can mention "aborted" (a
  // runner's "transaction aborted"). Core converts a stop, whatever the backend
  // named its error, to PlannerTurnStoppedError; only that and a platform
  // AbortError count.
  const isAbort = err instanceof PlannerTurnDiscardedError || err instanceof PlannerTurnStoppedError || (err instanceof Error && err.name === 'AbortError');
  // The stop already ended the turn on screen; a discarded turn belonged to a
  // session the user has already left.
  if (isAbort) return;
  // The session refuses a turn on a planner that cannot plan; the chat says
  // so with its own commands, and as the way out rather than a failure.
  if (err instanceof PlannerNotReadyError) {
    deps.chatProvider.showError(describePlannerNotReady(err.reason, CHAT_COMMANDS));
    return;
  }
  const message = err instanceof Error ? err.message : String(err);
  deps.chatProvider.showError(`Planner failed: ${message}`);
}

/**
 * The rule the session's own planner gate applies to every turn (a harness
 * planner needs no key, ADR-0009), worded with the chat's own commands. Read
 * per provider, as the vendor transport reads its key: a fallback to another
 * vendor's key passed here only for the transport to refuse the turn.
 */
export function plannerPreflightError(config: PlanManagerDeps['config']): string | null {
  const reason = plannerNotReadyFor(config);
  return reason ? describePlannerNotReady(reason, CHAT_COMMANDS) : null;
}

/**
 * The session owns the turn — its busy state, its stop, and its planner gate,
 * which waits for the activation probe and judges readiness (ADR-0009); a
 * failure is all that is left to report. Nothing waits here: a wait the
 * session could not see read as idle, and a prompt typed during it started
 * over as a new goal.
 */
async function inPlannerTurn(deps: PlanManagerDeps, run: () => Promise<void>): Promise<void> {
  try {
    await run();
  } catch (err) {
    reportPlannerError(err, deps);
  }
}

/**
 * Settle a plan a planner turn handed back: it becomes the host's plan, and
 * the webview is re-shown it only when its tasks changed.
 */
function adoptTurnPlan(prior: string, plan: LegacyPlanState, deps: PlanManagerDeps): void {
  deps.setCurrentPlan(plan);
  finishPlannerTurn(plan, deps, { planChanged: JSON.stringify(plan.tasks) !== prior });
}

export async function handleStartPlanning(
  userDescription: string,
  deps: PlanManagerDeps,
  pendingRunners?: RunnerId[],
): Promise<void> {
  const runners = resolveRunnerSet(deps, pendingRunners, deps.getCurrentPlan().runners);
  if (!runners) {
    return;
  }
  // Until the installed agents are detected, the enabled default is a guess:
  // with no pick of the user's, the session reads the enabled runners itself
  // once its planner gate opens, rather than plan for an agent not installed.
  const requested = !pendingRunners?.length && !installedPlannerAnswered() ? undefined : runners;
  // A goal still waiting for the probe is replaced by this one in the session.
  await inPlannerTurn(deps, async () => {
    const plan = await deps.session.startPlanning(userDescription, requested);
    deps.setCurrentGoal(userDescription);
    deps.setCurrentPlan(plan);
    finishPlannerTurn(plan, deps);
  });
}

export async function handleContinueConversation(
  text: string,
  deps: PlanManagerDeps,
): Promise<void> {
  await inPlannerTurn(deps, async () => {
    const prior = JSON.stringify(deps.getCurrentPlan().tasks);
    adoptTurnPlan(prior, await deps.session.continueConversation(text), deps);
  });
}

/**
 * Send now in the planner chat (ADR-0023, F5): the Session stops the turn in
 * flight and answers `text` in the turn that replaces it. The run's tasks are
 * untouched, and the host's held prompts are not given back — they drain in
 * order once the forced turn ends.
 */
export async function handleSendMessageNow(
  text: string,
  deps: PlanManagerDeps,
): Promise<void> {
  await inPlannerTurn(deps, async () => {
    const prior = JSON.stringify(deps.getCurrentPlan().tasks);
    adoptTurnPlan(prior, await deps.session.forceSendPrompt(text), deps);
  });
}

/**
 * Planner-driven merge (issue #18): route a merge request through the planner
 * conversation loop so the LLM produces the combined task, validated atomically
 * via applyTaskOps with corrective retries — not a mechanical client-side stub.
 * A pre-flight compatibility failure (canMergeTasks) throws before any LLM call.
 */
export async function handleMergePlan(taskIds: string[], deps: PlanManagerDeps): Promise<void> {
  if (taskIds.length < 2) return;
  await inPlannerTurn(deps, async () => {
    const prior = JSON.stringify(deps.getCurrentPlan().tasks);
    adoptTurnPlan(prior, await deps.session.requestMerge(taskIds), deps);
  });
}

/**
 * Planner-driven split (issue #18): ask the planner LLM to decompose one task
 * into a sequence of smaller tasks. Same conversation-loop / repair path as
 * merge; the model generates the breakdown (no manual per-task specs).
 */
export async function handleSplitPlan(taskId: string, deps: PlanManagerDeps): Promise<void> {
  await inPlannerTurn(deps, async () => {
    const prior = JSON.stringify(deps.getCurrentPlan().tasks);
    adoptTurnPlan(prior, await deps.session.requestSplit(taskId), deps);
  });
}

/**
 * One execution button's command, run as the user through the command seam
 * (ADR-0029), so it is checked and kept in the timeline with who asked. A
 * refusal is thrown, so the caller's existing catch shows it.
 */
export async function executeUserCommand(session: Pick<Session, 'execute'>, command: ExecutionCommand): Promise<void> {
  const outcome = await session.execute(command, { kind: 'user' });
  if (!outcome.ok) throw new Error(outcome.message);
}

/** A new run leaves a skipped task skipped, as it leaves a completed one done: running it again is a retry. */
function approvedTasks(tasks: Task[]): Task[] {
  return tasks.map((t) => ({
    ...t,
    status: t.status === 'completed' || t.status === 'skipped' ? t.status : 'approved',
    subtasks: approvedTasks(t.subtasks ?? []),
  }));
}

export async function handleApprovePlan(deps: PlanManagerDeps): Promise<void> {
  deps.log('=== handleApprovePlan START ===');
  // A run under way keeps going: Execute then approves what waits for approval, and the session says how many (#95).
  if (deps.session.isExecuting) {
    try {
      await executeUserCommand(deps.session, { command: 'run_plan' });
    } catch (err) {
      vscode.window.showErrorMessage(`Could not approve the waiting tasks: ${err instanceof Error ? err.message : String(err)}`);
    }
    return;
  }
  const plan = deps.getCurrentPlan();
  // The run_plan below is the approval, and the Session records it. New task objects, not edits in place: the plan's tasks are the Session's
  // snapshot of its store, and the plan object itself must stay the same one
  // so `loadPlan` keeps the live planner conversation. Saved once, after the
  // approval is complete — an earlier write would persist approved status over
  // tasks that have not been approved yet.
  plan.tasks = approvedTasks(plan.tasks);
  deps.session.loadPlan(plan, deps.getCurrentGoal(), deps.fsAdapter.getWorkspaceRoot());
  deps.chatProvider.planApproved();
  deps.chatProvider.clearIsolationHandoff();
  saveState(plan, deps.fsAdapter.getWorkspaceRoot());
  deps.saveCurrentSession();
  try {
    deps.log('Running the plan through the command seam...');
    await executeUserCommand(deps.session, { command: 'run_plan' });
    deps.log(`run_plan returned. isRunning=${deps.session.isExecuting}, status=${deps.session.status}`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    deps.log(`Orchestrator start failed: ${msg}`);
    vscode.window.showErrorMessage(`Failed to start execution: ${msg}`);
  }
  deps.log('=== handleApprovePlan END ===');
}

/**
 * A restored plan can exist on the host before the Session has adopted it
 * (legacy globalState, defensive paths). Adopt it so the conversational loop
 * has plan state to work with — without forking a new session file.
 */
function ensureSessionPlan(deps: PlanManagerDeps): void {
  if (deps.session.planState) return;
  const plan = deps.getCurrentPlan();
  if (plan.tasks.length === 0 && !(plan.conversationHistory && plan.conversationHistory.length > 0)) return;
  try {
    deps.session.loadPlan(plan, deps.getCurrentGoal(), deps.fsAdapter.getWorkspaceRoot(), { persist: false });
  } catch (err) {
    deps.log(`ensureSessionPlan failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

export async function handleSendMessage(
  text: string,
  deps: PlanManagerDeps,
  pendingRunners: RunnerId[] | undefined,
  setPendingRunners: (r: RunnerId[] | undefined) => void,
): Promise<void> {
  setPendingRunners(pendingRunners);

  const plan = deps.getCurrentPlan();
  const hasDialogue = (plan.conversationHistory?.length ?? 0) > 0;

  // Unified loop (post-plan chat included): the model decides per turn whether
  // to reply, emit targeted task edits, or re-plan. While a runner is live the
  // turn is taken at once too, and its edits apply to tasks not yet started
  // (ADR-0029). handleStartPlanning remains only for a truly fresh session.
  if (deps.session.isExecuting || plan.tasks.length > 0 || hasDialogue || deps.session.isConversationActive) {
    ensureSessionPlan(deps);
    await handleContinueConversation(text, deps);
  } else {
    await handleStartPlanning(text, deps, pendingRunners);
  }
}

/** The Session's plan becomes the host's, and the webview is shown it. */
function showSessionPlan(deps: PlanManagerDeps): void {
  if (deps.session.planState) deps.setCurrentPlan(deps.session.planState);
  deps.chatProvider.showPlan(deps.getCurrentPlan());
}

function settleDirectEdit(deps: PlanManagerDeps): void {
  showSessionPlan(deps);
  deps.persistState();
  deps.saveCurrentSession();
}

function applyTaskEdit(session: Session, taskId: string, edit: TaskEdit): Promise<unknown> {
  switch (edit.kind) {
    // A runner change re-derives the task's model, effort and mode from the
    // new runner's catalog, which only the session can read.
    case 'runner': return session.setTaskRunner(taskId, edit.runner);
    case 'model': return session.updateTask(taskId, { assignedModel: edit.assignment });
    case 'mode': return session.updateTask(taskId, { taskMode: edit.mode });
    case 'prompt': return session.updateTask(taskId, { prompt: edit.prompt, description: edit.prompt || undefined });
    case 'dependencies': return session.setTaskDependencies(taskId, edit.dependencies);
    case 'skills': return session.updateTask(taskId, { skills: edit.skills });
    case 'ops': return session.updateTask(taskId, { ops: edit.ops });
  }
}

/**
 * A field edit from a task card, through the Session like every other edit
 * so it is validated, broadcast and scheduled for. The plan is re-shown
 * either way: the card must end up showing what was accepted, not what was
 * attempted.
 */
export async function handleTaskEdit(taskId: string, edit: TaskEdit, deps: PlanManagerDeps): Promise<void> {
  try {
    await applyTaskEdit(deps.session, taskId, edit);
  } catch (err) {
    void vscode.window.showWarningMessage(err instanceof Error ? err.message : String(err));
  }
  settleDirectEdit(deps);
}

export async function handleAddTask(draft: TaskDraft, deps: PlanManagerDeps): Promise<void> {
  const task = taskFromDraft(draft);
  if (!task) return;
  await deps.session.addTask(task);
  settleDirectEdit(deps);
}

export async function handleRemoveTask(taskId: string, deps: PlanManagerDeps): Promise<void> {
  const confirm = await vscode.window.showWarningMessage(removalPrompt(deps.session.planTasks, taskId), { modal: true }, 'Remove');
  if (confirm !== 'Remove') return;
  await deps.session.removeTask(taskId);
  if (deps.session.planTasks.length > 0) {
    settleDirectEdit(deps);
    return;
  }
  if (deps.session.planState) deps.setCurrentPlan(deps.session.planState);
  deps.chatProvider.setState('empty');
  deps.chatProvider.run.reset();
  clearState(deps.fsAdapter.getWorkspaceRoot());
  deps.persistState();
}

/** A rejection resumes the paused agent with the reason, rather than cancelling the task. */
export function handleCheckpointAnswer(taskId: string, approved: boolean, reason: string | undefined, deps: PlanManagerDeps): void {
  if (approved) deps.session.approveCheckpoint(taskId);
  else deps.session.rejectCheckpoint(taskId, reason ?? '');
}

/**
 * Talking to a task (ADR-0018, M1). A refusal — one not running — is the Session's answer, shown rather than swallowed.
 */
export async function handleTaskControl(
  control:
    | { kind: 'message' | 'messageNow'; text: string }
    | { kind: 'removeQueued' | 'queuedNow'; id: string }
    | { kind: 'interrupt' },
  taskId: string,
  deps: Pick<PlanManagerDeps, 'session'>,
): Promise<void> {
  try {
    if (control.kind === 'message') await executeUserCommand(deps.session, { command: 'message_task', task: taskId, text: control.text });
    else if (control.kind === 'messageNow') deps.session.forceSendTaskMessage(taskId, control.text);
    else if (control.kind === 'removeQueued') deps.session.removeQueuedTaskMessage(taskId, control.id);
    else if (control.kind === 'queuedNow') {
      if (!deps.session.forceSendQueuedTaskMessage(taskId, control.id)) throw new Error(ALREADY_DELIVERED);
    } else await deps.session.interruptTask(taskId);
  } catch (err) {
    void vscode.window.showWarningMessage(err instanceof Error ? err.message : String(err));
  }
}

/**
 * Stop aborts the current planner turn only — never the plan, the dialogue or
 * the persisted state; that is a new session. The session stays busy until the
 * turn has unwound, so a prompt sent meanwhile is held, not raced against it.
 */
export function handleStopPlanning(deps: PlanManagerDeps): void {
  deps.session.abortPlannerTurn();
  deps.session.aiServiceInstance.reset();
  deps.chatProvider.conversation.stop();
  deps.log('Research stopped');
}

/**
 * Everything of the old session goes: the planner turn, the runners, the
 * Session's own plan and conversation (a partial reset leaves the old tasks
 * in its PlanStore, and the planner presents them as the current plan), the
 * view and the saved state.
 */
export function handleNewSession(deps: Pick<PlanManagerDeps,
  'session' | 'chatProvider' | 'fsAdapter' | 'setCurrentPlan' | 'setCurrentGoal' | 'log'>): void {
  // Abandons the planner turn in flight, or one still waiting for the probe:
  // it settles as discarded, which is not reported into the new session.
  deps.session.reset();
  deps.setCurrentPlan(createEmptyPlan());
  deps.setCurrentGoal('');
  deps.chatProvider.setState('empty');
  deps.chatProvider.conversation.reset();
  deps.chatProvider.run.reset();
  clearState(deps.fsAdapter.getWorkspaceRoot());
  deps.log('New session started');
}

/**
 * A force start or a single-task run passes a merge gate (ADR-0020) once the
 * user has seen, in a real modal, which work the task would act without. True
 * when nothing gates the task or the user went ahead.
 */
export async function confirmPastGate(taskId: string, session: Pick<Session, 'mergeGate' | 'planState'>): Promise<boolean> {
  const unmerged = session.mergeGate(taskId);
  if (unmerged.length === 0) return true;
  const choice = await vscode.window.showWarningMessage(
    pastGateConfirmation(titledRefs(unmerged, session.planState?.tasks ?? [])),
    { modal: true },
    'Start anyway',
  );
  return choice === 'Start anyway';
}

/** The webview's names for the task row actions that end in a mark. */
const ROW_ACTION: Record<string, TaskRowAction> = { markComplete: 'complete', markIncomplete: 'uncomplete' };

export async function handleSystemCommand(
  command: string,
  taskId: string,
  deps: PlanManagerDeps,
): Promise<void> {
  try {
    switch (command) {
      case 'cancel':
        await executeUserCommand(deps.session, { command: 'stop_task', task: taskId });
        break;
      case 'cancelResume':
        deps.session.cancelScheduledResume(taskId);
        break;
      case 'cancelPlannerResend':
        deps.session.cancelPlannerResend();
        break;
      case 'resumeNow':
        await deps.session.resumeNow(taskId);
        break;
      case 'retry':
        await executeUserCommand(deps.session, { command: 'retry_task', task: taskId, from: 'fresh' });
        break;
      // Skip lands nothing, so it is never a mark: only Mark complete vouches for work.
      case 'skip':
        await executeUserCommand(deps.session, { command: 'skip_task', task: taskId });
        break;
      case 'markComplete':
      case 'markIncomplete':
        await (markRequestFor(ROW_ACTION[command]) === 'uncomplete'
          ? deps.session.markTaskIncomplete(taskId)
          : deps.session.markTaskComplete(taskId));
        break;
      case 'forceStart':
        if (!(await confirmPastGate(taskId, deps.session))) return;
        deps.chatProvider.clearIsolationHandoff();
        await deps.session.forceStartTask(taskId);
        break;
      case 'runTask': {
        // A start past a merge gate is a force start, which the seam has no
        // command for; the confirmation stays, and the seam runs an ungated one.
        const gated = deps.session.mergeGate(taskId).length > 0;
        if (!(await confirmPastGate(taskId, deps.session))) return;
        deps.chatProvider.clearIsolationHandoff();
        if (gated) await deps.session.forceStartTask(taskId);
        else await executeUserCommand(deps.session, { command: 'run_task', task: taskId });
        break;
      }
      case 'executePlan':
        await handleApprovePlan(deps);
        break;
      case 'stopExecution': {
        // A stop with nothing running is a no-op, not a refusal: the button already said stopped.
        // That holds only while nothing can still start, or "stopped" would be untrue (ADR-0029).
        const outcome = await deps.session.execute({ command: 'stop_run' }, { kind: 'user' });
        if (!outcome.ok && (deps.session.isExecuting || deps.session.startsPending)) throw new Error(outcome.message);
        deps.runner.stopAll();
        deps.chatProvider.setState('planDraft');
        break;
      }
    }
  } catch (err) {
    void vscode.window.showWarningMessage(err instanceof Error ? err.message : String(err));
  }
  deps.chatProvider.showPlan(deps.getCurrentPlan());
  deps.persistState();
}

export function handleSessionMessage(
  msg: import('@ordewell/core').SessionMessage,
  deps: PlanManagerDeps,
): void {
  deps.chatProvider.conversation.receive(msg);
  // Every session event feeds the run view too; the card badges, isolation
  // marks and merge/handoff cards are drawn from it, not from the plan.
  deps.chatProvider.run.receive(msg);
  if (msg.type === 'approval_request') {
    // The chat card is the question now, so make sure the user is looking at
    // it. Nothing blocks here: the session's research loop awaits the answer on
    // the broadcast seam, and the webview answers through `resolveApproval`.
    deps.chatProvider.reveal();
    return;
  }
  switch (msg.type) {
    // Runner chatter was dropped here entirely, so a task that failed mid-run
    // showed a red card and nothing else. The webview keeps only the tail.
    case 'task_output':
      deps.chatProvider.sendTaskOutput(msg.taskId, msg.text);
      break;
    case 'task_started':
      deps.chatProvider.postMessage({ type: 'taskCommands', taskId: msg.taskId, commands: [] });
      deps.chatProvider.conversation.note('system', taskStartedNotice(msg.title, msg.runner));
      break;
    case 'status_update': {
      // The run view already holds each task's status; the dock reads a
      // plan-level one, the provider's to keep, never the Session's plan's.
      deps.chatProvider.showPlan(deps.getCurrentPlan(), deps.session.isExecuting
        ? 'running'
        : deps.session.status === 'completed'
          ? 'completed'
          : 'draft');
      break;
    }
    // The Session changes the plan itself (a live turn's edits, a run setting)
    // and announces the result; the card follows it.
    case 'plan_generated':
      deps.chatProvider.showPlan(deps.getCurrentPlan());
      break;
    case 'execution_complete': {
      const plan = deps.getCurrentPlan();
      deps.chatProvider.showPlan(plan);
      deps.persistState();
      break;
    }
    case 'execution_stopped': {
      deps.chatProvider.showPlan(deps.getCurrentPlan(), 'draft');
      deps.persistState();
      break;
    }
    case 'review_needed': {
      const plan = deps.getCurrentPlan();
      deps.chatProvider.showPlan(plan);
      break;
    }
    // A dirty tree parked the run. The user's way out is a real modal: stash
    // and continue, run in the shared root this once, or cancel.
    case 'isolation_blocked':
      handleIsolationBlocked(msg.message, deps);
      break;
    // What Merge all did, whether this host asked for it or another surface did,
    // is folded onto the run view above. A full merge with nothing left to
    // isolate is the end of the run: core has cleared it up, and the per-task
    // marks go with the cards.
    case 'isolation_merge':
      if (msg.result.outcome === 'merged' && !deps.session.isolationView()) deps.chatProvider.clearIsolationHandoff();
      break;
    // Drawn by the conversation view or the run view above, or not by this
    // surface at all. Named so a new SessionMessage variant fails to compile
    // until someone decides what it means here.
    case 'checkpoint':
    case 'isolation_handoff':
    case 'planner_message':
    case 'plan_token':
    case 'planner_text_delta':
    case 'planner_thinking_delta':
    case 'planner_liveness':
    case 'research_step':
    case 'research_step_done':
    case 'review_approved':
    case 'task_updated':
    case 'planner_turn_started':
    case 'planner_skill_loaded':
    case 'plan_edit_held':
    case 'planner_turn_ended':
    case 'planner_text_retracted':
    case 'planner_usage':
    case 'subagent_started':
    case 'subagent_finished':
    case 'approval_settled':
    case 'approval_decided':
    case 'execution_action':
      break;
    case 'task_log':
      if (msg.events.some((event) => event.type === 'runner_loaded')) {
        deps.chatProvider.postMessage({ type: 'taskCommands', taskId: msg.taskId, commands: latestTaskCommands(deps.session, msg.taskId) });
      }
      break;
    default: {
      const exhaustive: never = msg;
      return exhaustive;
    }
  }
}
