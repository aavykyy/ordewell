import type { IAiService } from './AiService';
import type { PlannerBackendId } from '../interfaces/IConfig';

export interface PlannerBackendOptions {
  /** The planner provider configured now. */
  provider(): PlannerBackendId;
  /** A backend for the provider configured now. */
  create(): IAiService;
  /** Whether a planner turn is running on the backend. */
  busy(): boolean;
}

/**
 * The planner transport for the provider configured *right now* (ADR-0009),
 * and the one place it is let go.
 *
 * Resolved on every read rather than once at construction, because a Session
 * outlives the choice: VS Code hosts exactly one for the whole window, and the
 * webview pills and `/planner` switch backends underneath it. A service
 * captured at construction kept the old backend and was handed the new one's
 * model — an OpenCode model id spawned as `claude --model opencode/…`.
 *
 * Letting a backend go — a switch to another provider, or settings that its
 * client was built from — waits until no planner turn is running on it:
 * `reset()` cuts the call in flight off, and the turn would end with neither an
 * answer nor its inputs. A model or effort change needs no reset: a turn on a
 * live context that no longer matches the configuration replays instead
 * (`conversationMatchesConfig`). A harness planner holds an OS process, so a
 * backend replaced is always reset, never just dropped.
 */
export class PlannerBackend {
  private live: IAiService | null;
  private liveProvider: PlannerBackendId | null = null;
  /** Settings it was built from changed while a turn ran on it. */
  private stale = false;

  /** `pinned`: a backend injected whole, which is reset but never replaced. */
  constructor(private readonly options: PlannerBackendOptions | { pinned: IAiService; busy(): boolean }) {
    this.live = 'pinned' in options ? options.pinned : null;
  }

  current(): IAiService {
    if (!this.live || !this.options.busy()) this.settle();
    return this.live!;
  }

  /** What the backend was built from changed: it is reset now, or as soon as the turn running on it ends. */
  settingsChanged(): void {
    this.stale = true;
    if (!this.options.busy()) this.settle();
  }

  /** Make the switch or the reset that waited, if one did. Call while no turn runs: as one is about to take the conversation, and as one lets it go. */
  settle(): void {
    const { options } = this;
    if ('pinned' in options) {
      if (this.stale) options.pinned.reset();
      this.stale = false;
      return;
    }
    const provider = options.provider();
    if (this.live && this.liveProvider === provider) {
      if (this.stale) this.live.reset();
      this.stale = false;
      return;
    }
    this.live?.reset();
    this.live = options.create();
    this.liveProvider = provider;
    this.stale = false;
  }
}
