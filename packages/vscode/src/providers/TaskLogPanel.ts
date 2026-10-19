import * as vscode from 'vscode';
import { latestTaskCommands } from '../shared/taskCommands';
import { canContinue, isMeasured, pausedOnLimit, resumeLabel, taskUsageSummary, usageLine, type CommandOutcome, type DisplayBlock, type ExecutionActor, type ExecutionCommand, type PendingApproval, type SessionMessage, type Task, type TaskLogEvent } from '@ordewell/core';
import { EMPTY_TASK_LOG_FOLLOW, followTaskLog } from '@ordewell/core/plan-utils';
import { diffConversation } from '../shared/conversationPatch';
import { renderWebviewHtml } from './webviewHtml';
import type { HostToTaskLog, TaskLogStatus, TaskLogToHost } from '../shared/taskLogProtocol';

/**
 * The Session calls a task-log panel makes (ADR-0018, M1, A1, K1). Narrowed to
 * the ones the panel owns, so its test needs no Session — the concrete
 * Session satisfies this structurally.
 */
export interface TaskLogSession {
  taskLogAttempts(taskId: string): number[];
  taskLog(taskId: string, attempt: number): TaskLogEvent[];
  /** Every control in the panel is a command at the seam, run as the user (ADR-0029). */
  execute(command: ExecutionCommand, actor: ExecutionActor): Promise<CommandOutcome>;
  invokeTaskCommand(taskId: string, name: string, args: string): string;
  outstandingApprovals(): PendingApproval[];
}

export interface TaskLogPanelDeps {
  session: TaskLogSession;
  getTask: (taskId: string) => Task | undefined;
  log: (msg: string) => void;
}

// A plan event that can change the task the header describes. Everything else
// the panel hears is ignored, so a planner's text deltas cost it nothing.
const TASK_STATE_EVENTS: ReadonlySet<SessionMessage['type']> = new Set([
  'status_update', 'task_updated', 'task_started', 'execution_complete', 'execution_stopped',
]);

/**
 * One task's log tab (ADR-0018, V1): an editor webview that draws a structured
 * task's saved attempt and follows it live. It loads the attempt's file on
 * open, so closing and reopening shows the full history, then folds the
 * `task_log` broadcasts the recorder streams. It never writes the log and
 * never touches the task — messaging, removing a queued message, interrupting
 * and answering a request all go through the command seam as the user,
 * exactly as the chat's controls do.
 */
export class TaskLogPanel {
  private follow = followTaskLog(EMPTY_TASK_LOG_FOLLOW, { type: 'opened' });
  private sent: readonly DisplayBlock[] = [];
  private sequence = 0;
  private ready = false;
  private lastStatus = '';

  constructor(
    private readonly panel: vscode.WebviewPanel,
    private readonly taskId: string,
    private readonly deps: TaskLogPanelDeps,
    extensionUri: vscode.Uri,
    onDisposed: () => void,
  ) {
    panel.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(extensionUri, 'dist', 'webviews')],
    };
    panel.webview.html = renderWebviewHtml({
      webview: panel.webview,
      extensionUri,
      script: 'tasklog.js',
      title: 'Task log',
    });
    panel.webview.onDidReceiveMessage((msg: TaskLogToHost) => this.handle(msg));
    panel.onDidDispose(() => onDisposed());
  }

  /** Bring the tab to the front; used when "Open log" is clicked on an open panel. */
  reveal(): void { this.panel.reveal(); }

  dispose(): void { this.panel.dispose(); }

  /**
   * A session event. Only this task's log, on the attempt on screen, changes
   * the blocks; a task-bearing event refreshes the header either way.
   */
  receive(msg: SessionMessage): void {
    if (msg.type === 'task_log') {
      if (msg.taskId !== this.taskId) return;
      const previous = this.follow.attempt;
      this.follow = followTaskLog(this.follow, { type: 'live', attempt: msg.attempt, events: msg.events, position: this.position(++this.sequence) });
      if (this.ready && this.follow.attempt > previous) this.load(this.follow.attempt);
      else this.push();
      return;
    }
    if (TASK_STATE_EVENTS.has(msg.type)) this.pushStatus();
  }

  private handle(msg: TaskLogToHost): void {
    switch (msg.type) {
      case 'ready':
        this.ready = true;
        // The first attempt may not have existed when the panel was built.
        if (this.follow.attempt === 0) this.loadLatest();
        else this.postInit();
        return;
      case 'selectAttempt':
        this.selectAttempt(msg.attempt);
        return;
      case 'invokeTaskCommand':
        this.control(() => { this.deps.session.invokeTaskCommand(this.taskId, msg.name, msg.args); });
        return;
      case 'sendTaskMessage':
        this.controlAsync(() => this.userCommand({ command: 'message_task', task: this.taskId, text: msg.text }));
        return;
      case 'removeQueuedTaskMessage':
        this.controlAsync(() => this.userCommand({ command: 'remove_queued', task: this.taskId, id: msg.id }));
        return;
      case 'sendTaskMessageNow':
        this.controlAsync(() => this.userCommand({ command: 'message_task', task: this.taskId, text: msg.text, force: true }));
        return;
      case 'sendQueuedTaskMessageNow':
        this.controlAsync(() => this.userCommand({ command: 'force_send_queued', task: this.taskId, id: msg.id }));
        return;
      case 'interruptTask':
        this.controlAsync(() => this.userCommand({ command: 'interrupt_task', task: this.taskId }));
        return;
      case 'cancelResume':
        this.controlAsync(() => this.userCommand({ command: 'cancel_resume', task: this.taskId }));
        return;
      case 'resumeNow':
        this.follow = { ...this.follow, followLatest: true };
        this.controlAsync(() => this.userCommand({ command: 'retry_task', task: this.taskId, from: 'session' }));
        return;
      case 'continueTask':
        // The continue is a new attempt: show it, even from an earlier one.
        this.follow = { ...this.follow, followLatest: true };
        this.controlAsync(() => this.userCommand({ command: 'retry_task', task: this.taskId, from: 'session', message: msg.text }));
        return;
      // The card settles when the task log reports the answer.
      case 'answerApproval':
        this.controlAsync(() => this.userCommand({
          command: 'answer_approval',
          task: this.taskId,
          approval: msg.id,
          answer: msg.decision.decision,
          ...(msg.decision.decision === 'deny' && msg.decision.note ? { note: msg.decision.note } : {}),
        }));
        return;
    }
  }

  private selectAttempt(attempt: number): void {
    if (!this.follow.attempts.includes(attempt)) return;
    this.load(attempt);
  }

  private loadLatest(): void {
    const attempts = this.deps.session.taskLogAttempts(this.taskId);
    this.follow = { ...this.follow, attempts };
    this.load(attempts.at(-1) ?? 0);
  }

  private position(seq = this.sequence): { stream: string; seq: number } {
    return { stream: 'in-process', seq };
  }

  private load(attempt: number): void {
    this.follow = followTaskLog(this.follow, { type: 'picked', attempt });
    // Session reads and broadcasts share this stack, so the local sequence
    // marks exactly what the synchronous read contains, just as the daemon's.
    const events = attempt > 0 ? this.deps.session.taskLog(this.taskId, attempt) : [];
    this.follow = followTaskLog(this.follow, { type: 'loaded', attempt, events, position: this.position() });
    this.sent = [];
    if (this.ready) this.postInit();
  }

  private postInit(): void {
    const status = this.status();
    this.sent = this.follow.view.blocks;
    this.lastStatus = JSON.stringify(status);
    this.panel.title = taskTabTitle(status);
    this.panel.webview.postMessage({ type: 'init', status, blocks: this.follow.view.blocks } satisfies HostToTaskLog);
  }

  private push(): void {
    if (!this.ready) return;
    const patch = diffConversation(this.sent, this.follow.view.blocks);
    this.sent = this.follow.view.blocks;
    if (patch) {
      this.panel.webview.postMessage({ type: 'patch', order: patch.order, changed: patch.changed } satisfies HostToTaskLog);
    }
    this.pushStatus();
  }

  private pushStatus(): void {
    if (!this.ready) return;
    const status = this.status();
    const key = JSON.stringify(status);
    if (key === this.lastStatus) return;
    this.lastStatus = key;
    this.panel.title = taskTabTitle(status);
    this.panel.webview.postMessage({ type: 'status', status } satisfies HostToTaskLog);
  }

  private status(): TaskLogStatus {
    const task = this.deps.getTask(this.taskId);
    const resumes = task ? resumeLabel(task) : null;
    const spend = task ? taskUsageSummary(task) : undefined;
    // A log saved before attempt ledgers still measured its own usage; it is
    // the only report there is, and the TUI task view draws it too.
    const logged = this.follow.view.usage;
    const loggedLine = logged && isMeasured(logged.totals) ? usageLine(logged) : undefined;
    const usage = spend && spend.attempts > 0
      ? { totals: spend.totals, ...(spend.contextFill ? { contextFill: spend.contextFill } : {}) }
      : loggedLine
        ? { totals: loggedLine.totals, ...(loggedLine.contextFill ? { contextFill: loggedLine.contextFill } : {}) }
        : undefined;
    return {
      commands: latestTaskCommands(this.deps.session, this.taskId),
      taskId: this.taskId,
      order: task?.order ?? 0,
      title: task?.title ?? '',
      runner: task?.assignedRunner ?? '',
      planStatus: task?.status ?? 'pending',
      awaitingReason: task?.awaitingReason,
      ...(resumes ? { resumes } : {}),
      awaitingApproval: this.deps.session.outstandingApprovals()
        .filter((p) => p.request.kind === 'runner_tool' && p.request.taskId === this.taskId).length,
      working: this.follow.view.working,
      lastTurnEnd: this.follow.view.lastTurnEnd,
      queued: this.follow.view.queued,
      attempts: this.follow.attempts,
      attempt: this.follow.attempt,
      continuable: task ? canContinue(task) : false,
      resumable: task ? pausedOnLimit(task) && canContinue(task) : false,
      ...(usage ? { usage } : {}),
    };
  }

  private control(run: () => void): void {
    try {
      run();
    } catch (err) {
      this.showError(err);
    }
  }

  // A refusal is the seam's answer, shown in the panel rather than swallowed
  // by an unhandled rejection.
  private async userCommand(command: ExecutionCommand): Promise<void> {
    const outcome = await this.deps.session.execute(command, { kind: 'user' });
    if (!outcome.ok) throw new Error(outcome.message);
  }

  private controlAsync(run: () => Promise<void>): void {
    run().catch((err: unknown) => this.showError(err));
  }

  private showError(err: unknown): void {
    const error = err instanceof Error ? err.message : String(err);
    this.deps.log(`Task log control failed: ${error}`);
    this.panel.webview.postMessage({ type: 'showError', error } satisfies HostToTaskLog);
  }
}

/** The tab title ADR-0018 asks for: `Task N · <title>`. */
export function taskTabTitle(status: Pick<TaskLogStatus, 'order' | 'title'>): string {
  return `Task ${status.order} · ${status.title}`;
}
