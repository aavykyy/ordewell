import * as vscode from 'vscode';
import type { SessionMessage, Task } from '@ordewell/core';
import { TaskLogPanel, taskTabTitle, type TaskLogSession } from './TaskLogPanel';

/** The editor tab's view type; one panel per task is keyed by task id, not by this. */
export const TASK_LOG_VIEW_TYPE = 'ordewellTaskLog';

export interface TaskLogRegistryDeps {
  extensionUri: vscode.Uri;
  session: () => TaskLogSession;
  getTask: (taskId: string) => Task | undefined;
  /** The task's dotted reference ("2", "2.1"): a subtask's own order restarts at 1. */
  orderLabel?: (taskId: string) => string | undefined;
  log: (msg: string) => void;
}

/**
 * The open task-log tabs, keyed by task (ADR-0018, V1). Nothing here opens a
 * panel by itself: `open` is what the chat's "Open log" reaches, and reusing an
 * already-open tab focuses it rather than opening a second. Every session
 * event is offered to each open panel, which filters to its own task.
 */
export class TaskLogRegistry {
  private readonly panels = new Map<string, TaskLogPanel>();

  constructor(private readonly deps: TaskLogRegistryDeps) {}

  open(taskId: string): void {
    const existing = this.panels.get(taskId);
    if (existing) {
      existing.reveal();
      return;
    }
    const task = this.deps.getTask(taskId);
    if (!task) {
      this.deps.log(`No task ${taskId} to open a task log for.`);
      return;
    }
    const panel = vscode.window.createWebviewPanel(
      TASK_LOG_VIEW_TYPE,
      taskTabTitle({ order: task.order, orderLabel: this.deps.orderLabel?.(taskId), title: task.title }),
      vscode.ViewColumn.Active,
      { enableScripts: true, retainContextWhenHidden: true },
    );
    this.attach(panel, taskId);
  }

  /**
   * Ties a panel to its task. A restored panel is one VS Code recreated after
   * a window reload, so its task may have left the plan meanwhile: it is
   * dropped rather than left empty. The webview saves its task id with
   * `setState` exactly so a reload can find it again.
   */
  restore(panel: vscode.WebviewPanel, state: unknown): void {
    const taskId = restoredTaskId(state);
    const existing = taskId ? this.panels.get(taskId) : undefined;
    if (!taskId || !this.deps.getTask(taskId) || existing) {
      panel.dispose();
      return;
    }
    this.attach(panel, taskId);
  }

  /** Registers the serializer that reopens task-log tabs across a window reload. */
  register(): vscode.Disposable {
    return vscode.window.registerWebviewPanelSerializer(TASK_LOG_VIEW_TYPE, {
      deserializeWebviewPanel: async (panel, state) => { this.restore(panel, state); },
    });
  }

  receive(msg: SessionMessage): void {
    for (const panel of this.panels.values()) panel.receive(msg);
  }

  dispose(): void {
    for (const panel of [...this.panels.values()]) panel.dispose();
    this.panels.clear();
  }

  private attach(panel: vscode.WebviewPanel, taskId: string): void {
    const controller = new TaskLogPanel(
      panel,
      taskId,
      { session: this.deps.session(), getTask: this.deps.getTask, orderLabel: this.deps.orderLabel, log: this.deps.log },
      this.deps.extensionUri,
      () => { this.panels.delete(taskId); },
    );
    this.panels.set(taskId, controller);
  }
}

function restoredTaskId(state: unknown): string | undefined {
  if (typeof state !== 'object' || state === null) return undefined;
  const id = (state as { taskId?: unknown }).taskId;
  return typeof id === 'string' ? id : undefined;
}
