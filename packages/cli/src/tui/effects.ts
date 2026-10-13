import { execSync } from 'child_process';
import {
  ALL_PROVIDERS, autonomyLevelLabel, clipboardCopyCommand, isCliProvider, isUserMessage, markRequestFor, newTaskFields, type AiProvider, type HasBinFn, type SurfacePlan,
  type PlannerModelRecall,
} from '@ordewell/core';
import { describeConnectionRefused, isConnectionRefused } from '../daemon';
import { DaemonError, WorkspaceInitNeededError, type ApiClient, type SessionFollow } from '../apiClient';
import { normalizeCatalog } from '../catalog';
import { plannerSwitchRecall } from '../plannerModelSwitch';
import type { Action, Effect } from './reducer';
import type { SessionView } from './state';
import { mergeOutcome } from '../isolation';
import { inboundFor } from './inbound';

/**
 * The slice of the daemon client the TUI needs. Derived from `ApiClient` rather
 * than restated, so a response type is declared once (the daemon contract) and
 * a test double is checked against what the client really returns.
 */
export type OrdewellApi = Pick<ApiClient,
  | 'startConversation' | 'sendConversationMessage' | 'forceSendPlannerMessage' | 'executePlan' | 'stopExecution' | 'cancelPlanning'
  | 'taskControl' | 'markTaskComplete' | 'markTaskIncomplete' | 'cancelResume'
  | 'getTaskLogAttempts' | 'getTaskLog'
  | 'sendTaskMessage' | 'removeQueuedTaskMessage' | 'forceSendTaskMessage' | 'forceSendQueuedTaskMessage'
  | 'interruptTask' | 'approveTaskCheckpoint' | 'rejectTaskCheckpoint' | 'continueTask'
  | 'addTask' | 'updateTask' | 'removeTask'
  | 'getSessions' | 'getSession' | 'adoptSession' | 'deleteSession' | 'closeSession'
  | 'forkConversation' | 'rewindTargets' | 'rewindConversation' | 'compactConversation'
  | 'reviewRunDiff' | 'mergeRun' | 'discardRun' | 'cleanupRun' | 'continueWithStash' | 'continueWithoutIsolation' | 'resolveConflictAsTask'
  | 'getSettings' | 'updateSettings' | 'updateRunSettings'
  | 'getRunners' | 'setRunnerEnabled' | 'getModels'
  | 'streamPlanning' | 'respondToApproval' | 'streamExecution' | 'closeExecutionStream' | 'followSession'
>;

export interface EffectDeps {
  api: OrdewellApi;
  workspace: string;
  /** The local daemon's port. */
  port: number;
  dispatch(action: Action): void;
  newSessionId(): string;
  /** Persists to the resolved `.env` and to `process.env`. */
  setEnvVar(key: string, value: string): void;
  /** Saves Full or Guarded in the user's settings (ADR-0030); `overridden` when the environment decides it anyway. */
  saveAutonomy(enabled: boolean): { overridden: boolean };
  /**
   * Brings the daemon back after it has gone away, resolving to whether it is
   * now answering. The TUI outlives its daemon in every direction — the daemon
   * can crash, another client can `ordewell stop --server`, a rebuild can be
   * followed by a manual restart — and `ensureDaemonOwned` runs once, at
   * launch. Without this the session is dead from the first refused connection
   * onward, with no way back short of quitting.
   */
  reviveDaemon(): Promise<boolean>;
  /** Hands the mouse to the app (wheel events) or back to the terminal (drag-select). */
  setMouseCapture(enabled: boolean): void;
  /**
   * Which binaries this host has — `clipboardCopyCommand`'s feature probe.
   * Injected only so a test can drive both the found and the missing branch;
   * the runtime leaves it out and takes core's `which`/`where` default.
   */
  hasBin?: HasBinFn;
  /** Runs `command` with `text` on its stdin. Injected for the same reason. */
  pipeToClipboard?(command: string, text: string): void;
  /** Writes raw bytes to the terminal — the OSC 52 fallback's only route out. */
  writeTerminal(data: string): void;
  exit(): void;
}

/**
 * Performs one effect and feeds results back as actions. Every path is
 * caught: a daemon hiccup becomes an error turn in the transcript, never an
 * unhandled rejection that tears down the raw-mode terminal.
 *
 * Conversation turns need no client-side queue: the reducer only routes a
 * prompt to `sendMessage` when no planner turn is in flight (see
 * `drainQueue`/`submit`), so turn serialization is decided at the source and
 * the daemon's first-turn registration race never comes up.
 */
export async function runEffect(effect: Effect, deps: EffectDeps): Promise<void> {
  try {
    await perform(effect, deps);
  } catch (err) {
    if (!isConnectionRefused(err)) {
      deps.dispatch(failedFrom(err));
      return;
    }

    // Refused at the handshake means the request never reached a server, so
    // replaying it cannot be a second execution — which is the whole reason
    // only this one errno is retried. See `isConnectionRefused`.
    let revived = false;
    try {
      revived = await deps.reviveDaemon();
    } catch {
      revived = false;
    }

    if (!revived) {
      deps.dispatch({ type: 'failed', message: describeConnectionRefused(deps.port) });
      return;
    }

    deps.dispatch({ type: 'notice', message: 'The server had stopped; started a new one and retried.' });
    try {
      await perform(effect, deps);
    } catch (retryErr) {
      // A fresh daemon holds no sessions, so the retry of anything
      // session-scoped legitimately 404s. Say which of the two happened.
      deps.dispatch(isConnectionRefused(retryErr) ? { type: 'failed', message: describeConnectionRefused(deps.port) } : failedFrom(retryErr));
    }
  }
}

/**
 * Loading a session adopts it, so a 404 here means the daemon dropped it —
 * almost always a restart. Reloading re-adopts it; say so rather than passing
 * the daemon's bare wording through.
 */
function explain(err: unknown): string {
  if (err instanceof DaemonError && err.code === 'session_not_found') {
    return 'This server is no longer holding that session — it was probably restarted. Reload it with /sessions.';
  }
  return err instanceof Error ? err.message : String(err);
}

/** The failure a rejected call becomes, carrying the daemon's reason when it gave one. */
function failedFrom(err: unknown): Extract<Action, { type: 'failed' }> {
  const code = err instanceof DaemonError ? err.code : undefined;
  return { type: 'failed', message: explain(err), ...(code ? { code } : {}) };
}

/**
 * Write settings to `.env` only once the daemon has accepted them.
 *
 * The reverse order looks harmless and is not: `.env` is the disk, and a
 * refused connection left it holding a choice that neither the daemon nor the
 * on-screen state ever saw. A planner switch writes `ORCHESTRATOR_MODEL` and
 * `ORDEWELL_PLANNER_EFFORT` in the same breath as `AI_PROVIDER` — whatever the
 * daemon resolved them to — so a failed half-write would have persisted a
 * provider with a model from the backend it just left, and the next daemon
 * started from that file, silently, with the TUI still showing the old planner.
 */
function persistAfterDaemon(deps: EffectDeps, env: Record<string, string>): void {
  for (const [key, value] of Object.entries(env)) deps.setEnvVar(key, value);
}

/** Names which of the three model outcomes a planner switch landed on — one line, into the chat pane. */
function plannerModelNotice(recall: PlannerModelRecall): string {
  switch (recall.source) {
    case 'remembered':
      return `Restored ${recall.model}.`;
    case 'catalog-default':
      return `Using its default model, ${recall.model} — pick another with /model.`;
    case 'none':
      return 'Pick a model with /model.';
  }
}

async function perform(effect: Effect, deps: EffectDeps): Promise<void> {
  const { api, dispatch, workspace } = deps;

  switch (effect.type) {
    case 'startConversation': {
      const sessionId = deps.newSessionId();
      dispatch({ type: 'sessionStarted', sessionId, goal: effect.goal });
      try {
        await converse(deps, sessionId, () => api.startConversation(sessionId, effect.goal, undefined, workspace, effect.allowInit));
      } catch (err) {
        // The daemon registers a session before the opening turn runs, so a
        // stopped one — by a force send, whose forced turn carries on — leaves
        // a session the next reply belongs to.
        if (err instanceof DaemonError && err.code === 'planner_turn_stopped') throw err;
        // Any other failure means planning never completed and the daemon
        // dropped it, so this id points at nothing — keeping it would 404
        // every following message.
        unfollow(deps, sessionId);
        dispatch({ type: 'sessionCleared' });
        // Offer to initialize instead of just reporting failure — but only
        // once: a rejection on the confirmed retry (allowInit already true)
        // falls through to the generic error path instead of looping the
        // prompt forever.
        if (err instanceof WorkspaceInitNeededError && !effect.allowInit) {
          dispatch({ type: 'workspaceNeedsInit', goal: effect.goal, workspace: err.workspace });
          return;
        }
        throw err;
      }
      return;
    }

    case 'sendMessage':
      await converse(deps, effect.sessionId, () => api.sendConversationMessage(effect.sessionId, effect.message));
      return;

    // Send now in the planner chat (ADR-0023, F5): the daemon stops the turn
    // in flight and answers the forced prompt in the turn that replaces it,
    // ahead of the queue; its reply settles here like any turn's.
    case 'forceSendPlannerMessage':
      await converse(deps, effect.sessionId, () => api.forceSendPlannerMessage(effect.sessionId, effect.message));
      return;

    case 'execute':
      await withExecutionStream(deps, effect.sessionId, () => api.executePlan(effect.sessionId));
      return;

    case 'stopExecution':
      await api.stopExecution(effect.sessionId);
      dispatch({ type: 'notice', message: 'Execution stopped.' });
      return;

    case 'cancelPlanning': {
      const { cancelled } = await api.cancelPlanning(effect.sessionId);
      // Nothing to cancel — the turn already settled (a race with the daemon,
      // not a stale request), and its own planner_message/planUpdated already
      // carries whatever feedback there is.
      if (cancelled) dispatch({ type: 'notice', message: 'Planning stopped.' });
      return;
    }

    // The arm's expiry is the runtime's to schedule: the reducer is pure, so
    // it names the delay and this owns the timer that ends the arming. Unref'd,
    // so a pending arm never holds the process open on its way out.
    case 'disarmStop': {
      const timer = setTimeout(() => dispatch({ type: 'stopDisarmed', arm: effect.arm }), effect.afterMs);
      timer.unref?.();
      return;
    }

    case 'taskAction': {
      const { sessionId, taskId, action } = effect;
      if (action === 'cancel-resume') {
        const { cancelled } = await api.cancelResume(sessionId, taskId);
        dispatch({ type: 'notice', message: cancelled ? 'Resume cancelled: retry the task once the limit resets.' : 'That task had no resume scheduled.' });
        await refreshPlan(deps, sessionId);
        return;
      }
      const request =
        action === 'cancel' || action === 'retry' || action === 'force-start'
          ? () => api.taskControl(sessionId, taskId, action)
          : markRequestFor(action) === 'uncomplete'
            ? () => api.markTaskIncomplete(sessionId, taskId)
            : () => api.markTaskComplete(sessionId, taskId);
      // A spawning action (see `taskActionEffect`) reports its progress the same
      // way a whole run does, so it needs the same stream open around it.
      await (effect.watch ? withExecutionStream(deps, sessionId, request) : request());
      await refreshPlan(deps, sessionId);
      return;
    }

    case 'addTask': {
      const fields = newTaskFields(effect.title);
      if (!fields) return;
      await api.addTask(effect.sessionId, { ...fields });
      await refreshPlan(deps, effect.sessionId);
      return;
    }

    case 'setRunSettings': {
      const settings = await api.updateRunSettings(effect.changes, effect.sessionId);
      dispatch({ type: 'settingsLoaded', settings });
      if (effect.sessionId) await refreshPlan(deps, effect.sessionId);
      return;
    }

    case 'updateTask':
      await api.updateTask(effect.sessionId, effect.taskId, effect.changes);
      await refreshPlan(deps, effect.sessionId);
      dispatch({ type: 'notice', message: effect.message });
      return;

    case 'removeTask':
      await api.removeTask(effect.sessionId, effect.taskId);
      await refreshPlan(deps, effect.sessionId);
      return;

    case 'respondApproval': {
      try {
        await api.respondToApproval(effect.sessionId, effect.approvalId, effect.granted);
      } catch {
        // The planner's own timeout denies an unanswered request, so a lost
        // answer degrades to a denial rather than a stuck session.
        dispatch({ type: 'failed', message: 'Could not deliver the approval answer — the planner will treat it as denied.' });
      }
      return;
    }

    // The card settles when the task log reports the answer, not here.
    case 'answerTaskApproval': {
      try {
        await api.respondToApproval(effect.sessionId, effect.approvalId, effect.answer);
      } catch {
        // A runner's request never times out, so a lost answer leaves it
        // waiting rather than denied.
        dispatch({ type: 'failed', message: 'Could not deliver the answer — the task is still waiting for approval.' });
      }
      return;
    }

    // The card goes when the daemon's next status says the task left the
    // checkpoint; a refusal (settled elsewhere, withdrawn) surfaces as the
    // failure the daemon words.
    case 'answerTaskCheckpoint':
      if (effect.answer === 'approve') await api.approveTaskCheckpoint(effect.sessionId, effect.taskId);
      else await api.rejectTaskCheckpoint(effect.sessionId, effect.taskId, effect.reason);
      return;

    // The saved log is read off disk (ADR-0018, P1) so the view opens with the
    // task's history; the live `task_log` stream then catches it up in place.
    case 'openTaskLog': {
      const attempts = await api.getTaskLogAttempts(effect.sessionId, effect.taskId, workspace);
      if (attempts.length === 0) {
        dispatch({ type: 'taskLogLoaded', taskId: effect.taskId, attempts: [], attempt: 0, events: [], sessionId: effect.sessionId });
        return;
      }
      const attempt = attempts[attempts.length - 1];
      const events = await api.getTaskLog(effect.sessionId, effect.taskId, attempt, workspace);
      dispatch({ type: 'taskLogLoaded', taskId: effect.taskId, attempts, attempt, events, sessionId: effect.sessionId });
      return;
    }

    case 'loadTaskAttempt': {
      const events = await api.getTaskLog(effect.sessionId, effect.taskId, effect.attempt, workspace);
      dispatch({ type: 'taskLogLoaded', taskId: effect.taskId, attempt: effect.attempt, events, sessionId: effect.sessionId });
      return;
    }

    // The daemon queues the message (or delivers it to a waiting task) and
    // broadcasts the `task_log` event that shows it; nothing to dispatch here.
    case 'sendTaskMessage':
      await api.sendTaskMessage(effect.sessionId, effect.taskId, effect.text);
      return;

    // The daemon starts the new attempt; its `task_log` and status arrive over
    // the execution stream, which a TUI not already watching a run holds open.
    case 'continueTask': {
      const { sessionId, taskId, text } = effect;
      const request = () => api.continueTask(sessionId, taskId, text);
      await (effect.watch ? withExecutionStream(deps, sessionId, request) : request());
      await refreshPlan(deps, sessionId);
      return;
    }

    case 'removeTaskMessage': {
      const { removed } = await api.removeQueuedTaskMessage(effect.sessionId, effect.taskId, effect.messageId);
      if (!removed) dispatch({ type: 'notice', message: 'That message was already delivered to the task.' });
      return;
    }

    // The task log shows the forced message at the head of the queue, then
    // the interrupt, then the turn it opens; nothing to dispatch here.
    case 'forceSendTaskMessage':
      await api.forceSendTaskMessage(effect.sessionId, effect.taskId, effect.text);
      return;

    case 'forceSendQueuedTaskMessage': {
      const { sent } = await api.forceSendQueuedTaskMessage(effect.sessionId, effect.taskId, effect.messageId);
      if (!sent) dispatch({ type: 'notice', message: 'The runner already has that message; it reads it after its current step.' });
      return;
    }

    case 'interruptTask':
      await api.interruptTask(effect.sessionId, effect.taskId);
      dispatch({ type: 'notice', message: 'Interrupting the task…' });
      return;

    case 'setModel': {
      // Daemon first, `.env` second — see `persistAfterDaemon` below. The
      // effort is the daemon's to settle: it survives only where the new
      // model offers it.
      const settled = await api.updateSettings({ orchestratorModel: effect.modelId });
      // An effort the daemon did not report is cleared, not written as the word "undefined".
      const plannerThinkingEffort = typeof settled.plannerThinkingEffort === 'string' ? settled.plannerThinkingEffort : '';
      persistAfterDaemon(deps, { ORCHESTRATOR_MODEL: effect.modelId, ORDEWELL_PLANNER_EFFORT: plannerThinkingEffort });
      dispatch({ type: 'settingsLoaded', settings: { orchestratorModel: effect.modelId, plannerThinkingEffort } });
      dispatch({ type: 'notice', message: `Planner model set to ${effect.modelId}.` });
      return;
    }

    case 'setPlanner': {
      const meta = ALL_PROVIDERS[effect.provider as AiProvider];
      if (!meta) throw new Error(`Unknown planner: ${effect.provider}`);
      // Pushed to the live daemon and written to .env, like every other
      // provider setting. The daemon builds a fresh config per session, so the
      // switch lands on the next plan without a restart. Only the provider is
      // ours to send — the daemon resolves what its model and effort should
      // become (remembered for it, that backend's catalog default, or
      // nothing) and this consumes whatever comes back.
      const env: Record<string, string> = { AI_PROVIDER: effect.provider };
      const settings = await api.updateSettings({ env });
      const recall = plannerSwitchRecall(settings);
      persistAfterDaemon(deps, { ...env, ORCHESTRATOR_MODEL: recall.model, ORDEWELL_PLANNER_EFFORT: recall.effort });
      dispatch({
        type: 'settingsLoaded',
        settings: { aiProvider: effect.provider as AiProvider, orchestratorModel: recall.model, plannerThinkingEffort: recall.effort },
      });
      dispatch({
        type: 'notice',
        message: `${isCliProvider(effect.provider as AiProvider)
          ? `Planning with ${meta.label} — no API key needed.`
          : `Planner set to ${meta.label}.`} ${plannerModelNotice(recall)}`,
      });
      await loadModels(deps);
      return;
    }

    case 'setPlannerChoice': {
      // One write, so the daemon never holds the new provider with the old
      // backend's model. An explicit model also turns off its switch recall
      // and is remembered for this provider, the way VS Code's
      // `PlannerSelection.setModel` remembers a pick.
      const env = { AI_PROVIDER: effect.provider, ORCHESTRATOR_MODEL: effect.modelId, ORDEWELL_PLANNER_EFFORT: effect.effort };
      const settings = await api.updateSettings({ env });
      persistAfterDaemon(deps, env);
      dispatch({
        type: 'settingsLoaded',
        settings: {
          ...settings,
          aiProvider: effect.provider as AiProvider,
          orchestratorModel: effect.modelId,
          plannerThinkingEffort: effect.effort,
        },
      });
      dispatch({ type: 'notice', message: effect.notice });
      return;
    }

    case 'setPlannerEffort':
      await api.updateSettings({ env: { ORDEWELL_PLANNER_EFFORT: effect.effort } });
      deps.setEnvVar('ORDEWELL_PLANNER_EFFORT', effect.effort);
      dispatch({ type: 'settingsLoaded', settings: { plannerThinkingEffort: effect.effort } });
      dispatch({ type: 'notice', message: `Planner effort set to ${effect.effort || 'the runner default'}.` });
      return;

    case 'setApiKey': {
      const meta = ALL_PROVIDERS[effect.provider as AiProvider];
      if (!meta) throw new Error(`Unknown provider: ${effect.provider}`);
      await api.updateSettings({ env: { [meta.apiKeyEnvVar]: effect.key } });
      deps.setEnvVar(meta.apiKeyEnvVar, effect.key);
      // Deliberately reports the provider, never the key — this line is on screen.
      dispatch({ type: 'notice', message: `${meta.label} key saved to ${meta.apiKeyEnvVar}.` });
      await loadModels(deps);
      return;
    }

    case 'setAllowlist': {
      // null deletes the runner's entry server-side; [] would sit in
      // settings.json as a lingering no-op restriction.
      const ids = effect.modelIds.length > 0 ? effect.modelIds : null;
      const settings = await api.updateSettings({ modelAllowlist: { [effect.runner]: ids } });
      dispatch({ type: 'settingsLoaded', settings });
      dispatch({
        type: 'notice',
        message: effect.modelIds.length
          ? `${effect.runner} limited to ${effect.modelIds.length} model(s).`
          : `${effect.runner} allowlist cleared.`,
      });
      return;
    }

    case 'setRunnerEnabled':
      await api.setRunnerEnabled(effect.runner, effect.enabled);
      await loadRunners(deps);
      dispatch({ type: 'notice', message: `${effect.runner} ${effect.enabled ? 'enabled' : 'disabled'}.` });
      return;

    case 'setRunners': {
      // One at a time: each request rewrites the same stored list, so firing
      // them together would have the last write drop the others.
      for (const change of effect.changes) {
        await api.setRunnerEnabled(change.runner, change.enabled);
      }
      await loadRunners(deps);
      dispatch({ type: 'notice', message: effect.message });
      return;
    }

    case 'setMaxParallel':
      await saveMaxParallel(deps, effect.limit);
      dispatch({ type: 'notice', message: `Up to ${effect.limit} AI task${effect.limit === 1 ? '' : 's'} now run at once.` });
      return;

    case 'saveSettings': {
      if (Object.keys(effect.run).length > 0) {
        const settings = await api.updateRunSettings(effect.run, effect.sessionId);
        dispatch({ type: 'settingsLoaded', settings });
        if (effect.sessionId) await refreshPlan(deps, effect.sessionId);
      }
      if (effect.maxParallel !== undefined) await saveMaxParallel(deps, effect.maxParallel);
      const overridden = effect.autonomous !== undefined && deps.saveAutonomy(effect.autonomous).overridden;
      dispatch({ type: 'notice', message: overridden
        ? `${effect.message} — ORDEWELL_AUTONOMOUS_MODE in the environment decides the autonomy level until it is unset.`
        : effect.message });
      return;
    }

    case 'setAutonomous': {
      const { overridden } = deps.saveAutonomy(effect.enabled);
      const level = autonomyLevelLabel(effect.enabled);
      dispatch({ type: 'notice', message: overridden
        ? `${level} is saved, but ORDEWELL_AUTONOMOUS_MODE in the environment decides the level until it is unset.`
        : `Autonomy level: ${level} for new plans.` });
      return;
    }

    case 'setMouseCapture':
      // The reducer already said which trade this is; persisting it only makes
      // the choice survive the next launch.
      deps.setMouseCapture(effect.enabled);
      deps.setEnvVar('ORDEWELL_TUI_MOUSE', String(effect.enabled));
      return;

    case 'copyText':
      copySelection(deps, effect.text);
      return;

    case 'loadModels':
      await loadModels(deps);
      return;

    case 'loadSessions':
      await loadSessions(deps);
      return;

    case 'loadSession': {
      // Followed first: a session still running goes on reporting while it loads.
      const shown = follows.get(deps.api)?.sessionId;
      // The daemon greets a live session's socket with its run before this
      // session is the one on screen, where the reducer would drop it as stale;
      // it is held until `sessionStarted` has made it the one.
      const inbound = inboundFor(deps.api, deps.dispatch, effect.sessionId);
      inbound.holdSnapshot();
      try {
        await follow(deps, effect.sessionId);
      } catch (err) {
        inbound.releaseSnapshot(false);
        throw err;
      }
      // Adopting registers the session with the daemon, which is what makes the
      // restored plan executable — `getSession` alone only reads the file.
      let adopted: Awaited<ReturnType<OrdewellApi['adoptSession']>>;
      try {
        adopted = await api.adoptSession(effect.sessionId, workspace);
      } catch (err) {
        inbound.releaseSnapshot(false);
        // The TUI stays on the session it showed, so it goes on following that one.
        if (shown) await follow(deps, shown);
        else unfollow(deps, effect.sessionId);
        throw err;
      }
      const { plan, goal } = adopted;
      dispatch({ type: 'sessionStarted', sessionId: effect.sessionId, goal });
      inbound.releaseSnapshot(true);
      dispatch(restoredChat(plan, effect.sessionId));
      dispatch({ type: 'planUpdated', plan, sessionId: effect.sessionId });
      dispatch({ type: 'notice', message: `Loaded "${goal || effect.sessionId}".` });
      return;
    }

    // The daemon has already adopted the fork, so switching is only the TUI
    // catching up — the original session is not closed: it may be running.
    case 'forkConversation': {
      const fork = await api.forkConversation(effect.sessionId);
      await follow(deps, fork.sessionId);
      dispatch({ type: 'sessionForked', sessionId: fork.sessionId, goal: fork.goal });
      dispatch(restoredChat(fork.plan, fork.sessionId));
      dispatch({ type: 'planUpdated', plan: fork.plan, sessionId: fork.sessionId });
      dispatch({ type: 'notice', message: `Forked ${effect.sessionId} into ${fork.sessionId} — you are in the fork now. /sessions to go back.` });
      return;
    }

    case 'loadRewindTargets':
      dispatch({
        type: 'rewindTargetsLoaded',
        targets: await api.rewindTargets(effect.sessionId),
        sessionId: effect.sessionId,
        ...(effect.pick !== undefined && { pick: effect.pick }),
      });
      return;

    // A rewind is a fork from an earlier point, so the TUI follows it the way
    // it follows `/fork`; the original keeps its whole conversation. The
    // rewound message comes back into the input, to edit and send again.
    case 'rewindConversation': {
      const fork = await api.rewindConversation(effect.sessionId, effect.index);
      await follow(deps, fork.sessionId);
      dispatch({ type: 'sessionForked', sessionId: fork.sessionId, goal: fork.goal });
      dispatch(restoredChat(fork.plan, fork.sessionId));
      dispatch({ type: 'planUpdated', plan: fork.plan, sessionId: fork.sessionId });
      dispatch({ type: 'inputPrefilled', text: fork.rewoundMessage, sessionId: fork.sessionId });
      dispatch({ type: 'notice', message: `Forked ${effect.sessionId} into ${fork.sessionId} from before that message — the original is kept (/sessions to go back). The message is ready to edit and resend.` });
      return;
    }

    // The redrawn transcript opens with the summary entry, which is what the
    // user gets to read — no separate notice to repeat it. The daemon also
    // broadcast that summary; `redrawn` keeps a late socket copy of it from
    // landing as a second, spoken turn.
    case 'compactConversation': {
      const { plan } = await api.compactConversation(effect.sessionId);
      const inbound = inboundFor(deps.api, deps.dispatch, effect.sessionId);
      dispatch(restoredChat(plan, effect.sessionId));
      const summary = compactionSummary(plan);
      if (summary) inbound.redrawn(summary.content, summary.timestamp);
      dispatch({ type: 'planUpdated', plan, sessionId: effect.sessionId });
      return;
    }

    case 'isolationReviewDiff':
      dispatch({ type: 'handoffDiff', diff: await api.reviewRunDiff(effect.sessionId), sessionId: effect.sessionId });
      return;

    // A conflict or a refusal is an answer, not a fault: either way the user's
    // tree is exactly as it was, and the words say what to do next. A full
    // merge of a settled run leaves nothing to hand over — the daemon has
    // cleared the run up; one mid-run leaves the run going (ADR-0020).
    case 'isolationMerge': {
      const { ok, message } = mergeOutcome(await api.mergeRun(effect.sessionId), effect.branch, effect.group === true, effect.repaired ?? []);
      if (ok && !effect.midRun) dispatch({ type: 'runCleared', sessionId: effect.sessionId });
      dispatch({ type: ok ? 'notice' : 'failed', message });
      return;
    }

    case 'isolationDiscard':
      await api.discardRun(effect.sessionId);
      dispatch({ type: 'runCleared', sessionId: effect.sessionId });
      dispatch({ type: 'notice', message: `Discarded the run and ${effect.branch}.` });
      return;

    case 'isolationCleanup':
      await api.cleanupRun(effect.sessionId);
      await refreshPlan(deps, effect.sessionId);
      dispatch({ type: 'notice', message: `Removed the run's worktrees and task branches; ${effect.branch} is kept.` });
      return;

    // Spawns runners again, so it needs the stream a run needs. Opening it ends
    // the blocked run's, which stayed open to show the ops tasks still running.
    case 'isolationContinue': {
      const { sessionId } = effect;
      await withExecutionStream(deps, sessionId, () => effect.mode === 'stash' ? api.continueWithStash(sessionId) : api.continueWithoutIsolation(sessionId));
      await refreshPlan(deps, sessionId);
      return;
    }

    case 'resolveConflict':
      await api.resolveConflictAsTask(effect.sessionId, effect.taskId);
      await refreshPlan(deps, effect.sessionId);
      dispatch({ type: 'notice', message: 'Added a task that merges the conflicted branch by hand. Run it with E (run plan); when it lands, the conflicted task lands through it.' });
      return;

    case 'deleteSession': {
      const { ok } = await api.deleteSession(effect.sessionId, workspace);
      await loadSessions(deps);
      dispatch(ok
        ? { type: 'notice', message: `Deleted ${effect.sessionId}.` }
        : { type: 'failed', message: `Could not delete ${effect.sessionId}: no saved session was removed.` });
      return;
    }

    case 'saveSession':
      // Plans are persisted server-side as they change; this only confirms it.
      dispatch({ type: 'notice', message: `Session ${effect.sessionId} saved.` });
      return;

    case 'closeSession':
      unfollow(deps, effect.sessionId);
      // Local state already moved on; a failure here must not surface as an
      // error in the new session's transcript.
      try {
        await api.closeSession(effect.sessionId);
      } catch {
        // ignore
      }
      return;

    case 'refresh':
      await Promise.all([loadRunners(deps), loadSettings(deps), loadModels(deps)]);
      if (effect.announce) dispatch({ type: 'notice', message: 'Refreshed runners, settings and models.' });
      return;

    case 'exit':
      deps.exit();
      return;
  }
}

// ── Clipboard ────────────────────────────────────────────────────────────────

const pipeToClipboardDefault = (command: string, text: string): void => {
  execSync(command, { input: text, stdio: ['pipe', 'ignore', 'ignore'] });
};

/**
 * The terminal's own "put this on the clipboard": ESC ] 52 ; c ; <base64> BEL.
 * Only reached when the host has no clipboard binary — plenty of emulators
 * (VTE before 0.76, xterm without `allowWindowOps`) drop it on the floor, which
 * is why `clipboardCopyCommand` is tried first.
 */
function osc52(text: string): string {
  return `\x1b]52;c;${Buffer.from(text, 'utf8').toString('base64')}\x07`;
}

async function saveMaxParallel(deps: EffectDeps, limit: number): Promise<void> {
  await deps.api.updateSettings({ env: { ORDEWELL_MAX_PARALLEL: String(limit) } });
  deps.setEnvVar('ORDEWELL_MAX_PARALLEL', String(limit));
}

/**
 * A released selection, onto the clipboard. Synchronous and never throwing: a
 * missing `xclip`, or one that cannot open the display, falls through to the
 * terminal route rather than reporting a copy that did not happen.
 */
function copySelection(deps: EffectDeps, text: string): void {
  if (!text) return;
  const lines = text.split('\n').length;
  const command = clipboardCopyCommand(deps.hasBin);

  if (command) {
    try {
      (deps.pipeToClipboard ?? pipeToClipboardDefault)(command, text);
      deps.dispatch({ type: 'notice', message: `Copied ${lines} ${lines === 1 ? 'line' : 'lines'}.` });
      return;
    } catch {
      // fall through to OSC 52
    }
  }

  deps.writeTerminal(osc52(text));
  deps.dispatch({
    type: 'notice',
    message: `Copied ${lines} ${lines === 1 ? 'line' : 'lines'} through the terminal — no clipboard tool here (pbcopy, xclip, xsel or wl-copy), so it only lands if your terminal supports OSC 52.`,
  });
}

// ── Shared steps ─────────────────────────────────────────────────────────────

/**
 * Runs a request that spawns runner work with the session's execution stream
 * live around it, and stays until the run settles. The stream is subscribed
 * *before* the request because the orchestrator may launch immediately: a
 * status_update emitted before the socket is listening is simply lost, which is
 * how a started task ended up with no running icon.
 */
async function withExecutionStream(
  deps: EffectDeps,
  sessionId: string,
  request: () => Promise<unknown>,
): Promise<void> {
  await follow(deps, sessionId);
  const open = runStreamsOf(deps.api);
  open.set(sessionId, (open.get(sessionId) ?? 0) + 1);
  try {
    await streamRun(deps, sessionId, request);
  } finally {
    const left = (open.get(sessionId) ?? 1) - 1;
    if (left > 0) open.set(sessionId, left);
    else open.delete(sessionId);
  }
}

async function streamRun(
  deps: EffectDeps,
  sessionId: string,
  request: () => Promise<unknown>,
): Promise<void> {
  let settleReady: (error?: Error) => void = () => {};
  const streamReady = new Promise<void>((resolve, reject) => {
    settleReady = (error) => error ? reject(error) : resolve();
  });
  const inbound = inboundFor(deps.api, deps.dispatch, sessionId);
  const stream = deps.api.streamExecution(sessionId, inbound.execution(), settleReady);
  // Surface a failed connection while it is still being established.
  void stream.catch(settleReady);
  try {
    await streamReady;
    await request();
  } catch (err) {
    // Nothing else holds this socket; left open it outlives the failed run.
    // Closed by handle: a newer stream on this session is not ours to end.
    deps.api.closeExecutionStream(stream);
    throw err;
  }
  if (await stream === 'lost') deps.dispatch({ type: 'executionLost', sessionId });
}

// ── Following the session ────────────────────────────────────────────────────

const follows = new WeakMap<object, { sessionId: string; follow: SessionFollow }>();
const runStreams = new WeakMap<object, Map<string, number>>();

function runStreamsOf(api: object): Map<string, number> {
  let open = runStreams.get(api);
  if (!open) {
    open = new Map();
    runStreams.set(api, open);
  }
  return open;
}

/**
 * Holds the TUI's one standing subscription, to the session it shows. A run's
 * own stream exists only around a request this surface made, and the planning
 * one only around a turn; a run started by anyone else — autorun as the turn
 * ends, the planner's `run_plan`, the supervisor after the last task settled —
 * was broadcast into nothing. Ensured before each request, for the reason
 * `withExecutionStream` subscribes first; anchored to the client, like
 * `inboundFor`, so a new daemon connection starts clean.
 */
async function follow(deps: EffectDeps, sessionId: string): Promise<void> {
  const current = follows.get(deps.api);
  if (current?.sessionId === sessionId) return current.follow.ready;
  current?.follow.close();
  const inbound = inboundFor(deps.api, deps.dispatch, sessionId);
  const entry = { sessionId, follow: deps.api.followSession(sessionId, inbound.execution()) };
  follows.set(deps.api, entry);
  void entry.follow.ended.then((outcome) => {
    if (follows.get(deps.api) !== entry) return;
    follows.delete(deps.api);
    // A run's own stream says so itself when it goes with the daemon; two notices for one loss is noise.
    if (outcome === 'lost' && !runStreamsOf(deps.api).has(sessionId)) deps.dispatch({ type: 'followLost', sessionId });
  });
  await entry.follow.ready;
}

function unfollow(deps: EffectDeps, sessionId: string): void {
  const current = follows.get(deps.api);
  if (current?.sessionId !== sessionId) return;
  follows.delete(deps.api);
  current.follow.close();
}

/**
 * One planner turn: its messages stream over the websocket while the REST call
 * is in flight, and the reply is either a question or a plan.
 */
async function converse(deps: EffectDeps, sessionId: string, call: () => Promise<unknown>): Promise<void> {
  const inbound = inboundFor(deps.api, deps.dispatch, sessionId);
  const stream = deps.api.streamPlanning(sessionId, inbound.planning());

  try {
    await Promise.all([stream.ready, follow(deps, sessionId)]);
    const plan = await call();
    inbound.flush();
    // Speak the turn before `planUpdated` settles it: the settle is also what
    // drains the next queued prompt, so the reply would otherwise land after
    // the prompt that queue sent, in the wrong order. The socket usually
    // delivered the same words; the backfill is dropped when it did.
    const reply = lastAssistantMessage(plan);
    if (reply) inbound.backfill(reply.content, reply.timestamp);
    deps.dispatch({ type: 'planUpdated', plan, sessionId });
  } finally {
    inbound.flush();
    stream.close();
  }
}

/** The conversation a saved plan reopens with: its transcript, research log and token line. */
function restoredChat(plan: unknown, sessionId: string): Action {
  const saved = plan as Pick<SurfacePlan, 'conversationHistory' | 'researchLog' | 'plannerUsage' | 'pendingTurns'> | null;
  return {
    type: 'chatRestored',
    history: saved?.conversationHistory ?? [],
    ...(saved?.researchLog ? { researchLog: saved.researchLog } : {}),
    ...(saved?.plannerUsage ? { plannerUsage: saved.plannerUsage } : {}),
    ...(saved?.pendingTurns ? { pendingTurns: saved.pendingTurns } : {}),
    sessionId,
  };
}

/**
 * The reply the turn settled on, with the timestamp a socket copy of it would
 * carry. Only a plain entry is a reply: the markers a turn leaves after it — a
 * plan committed, a run autorun started, a skill loaded — are drawn by their
 * own broadcasts, and spoken here they were a second planner line. Nothing
 * before the user's message is this turn's.
 */
function lastAssistantMessage(plan: unknown): { content: string; timestamp?: string } | null {
  const history = (plan as Pick<SurfacePlan, 'conversationHistory'> | null)?.conversationHistory ?? [];
  for (let i = history.length - 1; i >= 0; i--) {
    const entry = history[i];
    if (isUserMessage(entry)) return null;
    if (entry.role === 'assistant' && entry.kind === undefined) {
      const { content, timestamp } = entry;
      return { content, ...(timestamp ? { timestamp } : {}) };
    }
  }
  return null;
}

/** The summary a compaction just made the transcript's first entry, if this plan came from one. */
function compactionSummary(plan: unknown): { content: string; timestamp?: string } | null {
  const history = (plan as Pick<SurfacePlan, 'conversationHistory'> | null)?.conversationHistory ?? [];
  const entry = history.find((message) => message.kind === 'compaction');
  return entry ? { content: entry.content, ...(entry.timestamp ? { timestamp: entry.timestamp } : {}) } : null;
}

async function refreshPlan(deps: EffectDeps, sessionId: string): Promise<void> {
  const { plan } = await deps.api.getSession(sessionId, deps.workspace);
  deps.dispatch({ type: 'planUpdated', plan, sessionId });
}

async function loadModels(deps: EffectDeps): Promise<void> {
  deps.dispatch({ type: 'modelsLoaded', ...normalizeCatalog(await deps.api.getModels()) });
}

async function loadSessions(deps: EffectDeps): Promise<void> {
  const sessions = await deps.api.getSessions(deps.workspace);
  const list: SessionView[] = sessions.map((s) => ({
    id: String(s.id),
    goal: String(s.goal ?? ''),
    taskCount: Number(s.taskCount ?? 0),
    status: String(s.status ?? ''),
    createdAt: String(s.createdAt ?? ''),
  }));
  deps.dispatch({ type: 'sessionsLoaded', sessions: list });
}

async function loadRunners(deps: EffectDeps): Promise<void> {
  const state = await deps.api.getRunners();
  deps.dispatch({
    type: 'runnersLoaded',
    runners: (state.runners ?? []).map((r) => ({ id: r.id, name: r.name, enabled: r.enabled })),
    orchestratorModel: state.orchestratorModel,
  });
}

async function loadSettings(deps: EffectDeps): Promise<void> {
  deps.dispatch({ type: 'settingsLoaded', settings: await deps.api.getSettings() });
}
