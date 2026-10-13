import { EMPTY_RUN, reduceRun, type RunTask, type RunView, type SessionMessage } from '@ordewell/core';
import type { HostToWebview } from './shared/protocol';

/**
 * The run the chat webview draws (#S8c), held on the host: every
 * `SessionMessage` folds through core's `reduceRun` here, and the webview only
 * ever mirrors the result. A webview that joins mid-run is sent the session's
 * `runSnapshot()` through `adopt`, so a task blocked on a runner approval — or
 * waiting at a checkpoint — is drawn without waiting for the next update.
 */
export class RunViewHost {
  private view: RunView = EMPTY_RUN;

  constructor(private readonly post: (msg: HostToWebview) => void) {}

  get current(): RunView {
    return this.view;
  }

  receive(msg: SessionMessage): void {
    this.show(reduceRun(this.view, msg));
  }

  /** What a client that had folded every message would hold, for one that joins now. */
  adopt(view: RunView): void {
    this.show(view);
  }

  reset(): void {
    this.show(EMPTY_RUN);
  }

  /**
   * The run's isolation is gone — discarded, or a plan restarted. No single
   * message says so on every path, so the marks and cards are cleared here
   * rather than left stale until a status update happens to omit them.
   */
  clearIsolation(): void {
    this.show({ ...this.view, tasks: clearIsolation(this.view.tasks), handoff: null, mergeResult: null, runMerge: null });
  }

  private show(view: RunView): void {
    if (view === this.view) return;
    this.view = view;
    this.post({ type: 'runView', view });
  }
}

function clearIsolation(tasks: readonly RunTask[]): RunTask[] {
  return tasks.map(({ isolation: _isolation, ...task }) => ({ ...task, subtasks: clearIsolation(task.subtasks) }));
}
