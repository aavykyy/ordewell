import type { GlobalRunSettings } from '@ordewell/core';
import { type SurfacePlan, type DiscoveredModel, type RunnerId, type RunView, type RunTask, type AiProvider } from '@ordewell/core';
import { DEFAULT_RUNNERS, EMPTY_HOLD, EMPTY_RUN, type PromptHold } from '@ordewell/core/plan-utils';
import type { HostToWebview, PlannerBackend, RunnerMeta } from '../../shared/protocol';
import { applyConversationPatch, EMPTY_PATCHED_VIEW, type PatchedView } from '../../shared/conversationPatch';
import { appendTaskOutput, type TaskOutputMap } from './taskOutput';
import { isPlanRevision, nextDock } from './planDock';
import type { RunnerMode } from './components/TaskCard';

export interface RunnerInfo {
  id: string;
  displayName: string;
}

export interface ModelOption {
  id: string;
  label: string;
  provider: string;
  apiProvider?: AiProvider;
  description?: string;
  pricing?: string;
}

/** Everything the host feeds the webview, plus the two gates that decide which of its messages to drop. */
export interface HostState {
  /** The planner conversation, held by the host and patched in here (#53). */
  conversation: PatchedView;
  plan: SurfacePlan | null;
  isExecuting: boolean;
  isResearchActive: boolean;
  conversationBusy: boolean;
  error: string;
  models: DiscoveredModel[];
  modelsByRunner: Partial<Record<string, DiscoveredModel[]>>;
  runnerList: RunnerInfo[];
  enabledRunnerIds: string[];
  runners: RunnerId[];
  /** Queued prompts: what the host is holding for the next planner turn. */
  held: PromptHold;
  /** The last queued text the host gave back; `seq` makes a repeat of the same words land again. */
  unsent: { text: string; seq: number } | null;
  modesByRunner: Record<string, RunnerMode[]>;
  modelConfig: { orchestrator: string; orchestratorProvider?: string } | null;
  /** The user's autonomy level, run settings (ADR-0030) and parallel limit; null until the host sends them. */
  runSettings: { autonomous: boolean; run: GlobalRunSettings; maxParallel: number } | null;
  /** Bumped by each `/settings`: App opens the Settings panel at its Run block. */
  settingsRequest: number;
  modelOptions: ModelOption[];
  configuredProviders: AiProvider[];
  /** Who plans (ADR-0009): the backends offered, the one in use, and its runner + effort. */
  planner: { backends: PlannerBackend[]; provider: string; runner?: string; effort?: string };
  isReady: boolean;
  modelDiscoveryErrors: Record<string, string>;
  skills: { name: string; description: string; appliesTo?: 'planner' | 'task' }[];
  taskSkills: { name: string; description: string }[];
  checkpoint: { taskId: string; taskTitle: string; summary: string; pausedAt: number } | null;
  /**
   * The checkpoint the user answered, by task id and question. A run view that
   * still carries the question — the status update clearing the task has not
   * arrived, or another task's update landed first — must not re-open the
   * panel; only a different question does.
   */
  answeredCheckpoint: { taskId: string; summary: string } | null;
  taskOutput: TaskOutputMap;
  /**
   * The run as the host folded every session event (#S8c): each task's plan
   * fields and status, the merge view, usage, run settings, handoff and last
   * Merge all result. The per-task badges and the isolation cards read here.
   */
  run: RunView;
  /** Is the plan dock open? See planDock.ts for when this flips. */
  dockExpanded: boolean;
  /** The dock's dragged cap in px, remembered by the host; undefined keeps the stylesheet's default. */
  dockHeight: number | undefined;
  /** The user stopped the turn: plan updates are dropped until the host closes it. */
  stopped: boolean;
  /** The user started a new session: errors from the old one's turn are dropped. */
  sessionCleared: boolean;
}

export const INITIAL_HOST_STATE: HostState = {
  conversation: EMPTY_PATCHED_VIEW,
  plan: null,
  isExecuting: false,
  isResearchActive: false,
  conversationBusy: false,
  error: '',
  models: [],
  modelsByRunner: {},
  runnerList: [],
  enabledRunnerIds: [...DEFAULT_RUNNERS],
  runners: [...DEFAULT_RUNNERS],
  held: EMPTY_HOLD,
  unsent: null,
  modesByRunner: {},
  modelConfig: null,
  runSettings: null,
  settingsRequest: 0,
  modelOptions: [],
  configuredProviders: [],
  planner: { backends: [], provider: '' },
  isReady: false,
  modelDiscoveryErrors: {},
  skills: [],
  taskSkills: [],
  checkpoint: null,
  answeredCheckpoint: null,
  taskOutput: {},
  run: EMPTY_RUN,
  dockExpanded: false,
  dockHeight: undefined,
  stopped: false,
  sessionCleared: false,
};

export type SessionResetKind = 'empty' | 'restore' | 'new';

type Updatable<T> = T | ((prev: T) => T);

/** A host message, stamped with the clock so the reducer stays pure. */
export type HostMessage = HostToWebview & { now: number };

export type HostAction =
  | HostMessage
  | { type: 'resetSession'; kind: SessionResetKind }
  | { type: 'turnStopped' }
  | { type: 'turnRequested' }
  | { type: 'patchPlan'; plan: Updatable<SurfacePlan | null> }
  | { type: 'patchResearchActive'; active: boolean }
  | { type: 'patchExecuting'; executing: boolean }
  | { type: 'patchError'; error: string }
  | { type: 'patchReady'; ready: boolean }
  | { type: 'patchRunners'; runners: Updatable<RunnerId[]> }
  | { type: 'checkpointAnswered' }
  | { type: 'patchDockHeight'; height: number | undefined }
  | { type: 'patchDockExpanded'; expanded: Updatable<boolean> };

/**
 * Clears what belongs to the previous session. Fields per kind:
 * - all kinds: error, plan, the run, checkpoint, task output, and the dock (the
 *   run's per-task badges are keyed by task id, so they must not outlive the
 *   plan they described).
 * - 'restore' and 'new' also: stop the running/planning flags and drop queued
 *   prompts. 'empty' leaves them: the host's own `state` says what runs next,
 *   and queued prompts survive an emptied plan.
 * - 'restore' re-opens the gates (a restore always leaves the chat usable);
 *   'new' closes both, so the old session's late plan updates and errors
 *   are dropped until the user's next send or a planner turn.
 * The conversation is never cleared here: the host owns it and resets it.
 */
export function resetSession(state: HostState, kind: SessionResetKind): HostState {
  const next: HostState = {
    ...state,
    error: '',
    plan: null,
    checkpoint: null,
    answeredCheckpoint: null,
    taskOutput: {},
    run: EMPTY_RUN,
    dockExpanded: nextDock(state.dockExpanded, 'session-reset'),
  };
  if (kind === 'empty') return next;
  next.isResearchActive = false;
  next.isExecuting = false;
  next.held = EMPTY_HOLD;
  next.stopped = kind === 'new';
  next.sessionCleared = kind === 'new';
  return next;
}

function resolve<T>(value: Updatable<T>, prev: T): T {
  return typeof value === 'function' ? (value as (p: T) => T)(prev) : value;
}

export function reduceHost(state: HostState, action: HostAction): HostState {
  switch (action.type) {
    case 'resetSession':
      return resetSession(state, action.kind);

    case 'turnStopped':
      return { ...state, stopped: true, isResearchActive: false };

    case 'turnRequested':
      return { ...state, stopped: false, sessionCleared: false, error: '', isResearchActive: true };

    case 'patchPlan':
      return { ...state, plan: resolve(action.plan, state.plan) };

    case 'patchResearchActive':
      return { ...state, isResearchActive: action.active };

    case 'patchExecuting':
      return { ...state, isExecuting: action.executing };

    case 'patchError':
      return { ...state, error: action.error };

    case 'patchReady':
      return { ...state, isReady: action.ready };

    case 'patchRunners':
      return { ...state, runners: resolve(action.runners, state.runners) };

    case 'checkpointAnswered':
      // The question is answered here, before the run says so: remember it so
      // the next run view still carrying it does not re-open the panel.
      return {
        ...state,
        checkpoint: null,
        answeredCheckpoint: state.checkpoint
          ? { taskId: state.checkpoint.taskId, summary: state.checkpoint.summary }
          : state.answeredCheckpoint,
      };

    case 'patchDockHeight':
      return { ...state, dockHeight: action.height };

    case 'patchDockExpanded':
      return { ...state, dockExpanded: resolve(action.expanded, state.dockExpanded) };

    case 'setState': {
      const base = action.state === 'empty' ? resetSession(state, 'empty') : state;
      return { ...base, isResearchActive: action.state === 'researching', isExecuting: action.state === 'approved' };
    }

    case 'planUpdated': {
      if (state.stopped) return state;
      const incoming: SurfacePlan | null = action.plan ?? null;
      let next: HostState = { ...state, plan: incoming };
      // Not a turn's end: a run's status tick arrives mid-turn too, and the
      // host's `plannerTurn` is what says a turn is over.
      if (incoming) next.isExecuting = incoming.status === 'running';
      if (incoming && incoming.tasks && incoming.tasks.length > 0) {
        // One `planUpdated` carries two different events. A revision opens
        // the dock; a status tick during execution must not, or a running
        // plan would fight a user who collapsed it.
        const previous = state.plan?.tasks ?? [];
        next = {
          ...next,
          dockExpanded: nextDock(state.dockExpanded, isPlanRevision(previous, incoming.tasks) ? 'plan-revised' : 'plan-progressed'),
        };
      }
      return next;
    }

    case 'restoreChat':
      return resetSession(state, 'restore');

    case 'conversationPatch':
      return { ...state, conversation: applyConversationPatch(state.conversation, action) };

    // The stop gate lasts until the host has closed the stopped turn; a new
    // turn is never gated.
    case 'plannerTurn':
      return { ...state, stopped: false, isResearchActive: action.active };

    case 'conversationBusy':
      return { ...state, conversationBusy: !!action.busy };

    case 'showError':
      if (state.sessionCleared) return state;
      return { ...state, error: action.error, isResearchActive: false };

    case 'taskOutput':
      return { ...state, taskOutput: appendTaskOutput(state.taskOutput, action.taskId, action.text ?? '') };

    // The run view replaces the per-field status, isolation and merge
    // messages: one fold, and the checkpoint panel follows from it — so a
    // webview that rejoins is re-told a checkpoint it never saw arrive.
    case 'runView': {
      const question = checkpointOf(action.view);
      // A question the user already answered must not re-open the panel while
      // the run still carries it. A different question is a new ask, and clears
      // the memory; so does a view with no question at all.
      const answered = !!question && state.answeredCheckpoint?.taskId === question.taskId
        && state.answeredCheckpoint.summary === question.summary;
      const checkpoint = question && !answered
        ? state.checkpoint?.taskId === question.taskId
          ? { ...question, pausedAt: state.checkpoint.pausedAt }
          : { ...question, pausedAt: action.now }
        : null;
      return { ...state, run: action.view, checkpoint, answeredCheckpoint: answered ? state.answeredCheckpoint : null };
    }

    case 'setModels':
      return { ...state, models: action.models ?? [] };

    case 'setModelsByRunner':
      return { ...state, modelsByRunner: action.modelsByRunner ?? {} };

    case 'setModesByRunner':
      return { ...state, modesByRunner: action.modesByRunner ?? {} };

    case 'setModelConfig':
      return { ...state, modelConfig: action.modelConfig ?? null };

    case 'setModelOptions':
      return { ...state, modelOptions: action.modelOptions ?? [] };

    case 'setConfiguredProviders':
      return { ...state, configuredProviders: action.providers ?? [], isReady: true };

    case 'setPlannerBackends':
      return {
        ...state,
        planner: {
          backends: action.backends ?? [],
          provider: action.provider ?? '',
          runner: action.runner,
          effort: action.effort || undefined,
        },
      };

    case 'setModelDiscoveryErrors':
      return { ...state, modelDiscoveryErrors: action.errors ?? {} };

    case 'setRunners': {
      const list = action.runners ?? [];
      const ids = list.filter((r: RunnerMeta) => r.enabled).map((r: RunnerMeta) => r.id);
      let runners: RunnerId[];
      if (ids.length === 1) runners = ids;
      else if (ids.length === 0) runners = [...DEFAULT_RUNNERS];
      else {
        const valid = state.runners.filter((r) => ids.includes(r));
        runners = valid.length > 0 ? valid : ids;
      }
      return {
        ...state,
        runnerList: list.map((r: RunnerMeta) => ({ id: r.id, displayName: r.displayName })),
        enabledRunnerIds: ids,
        runners,
      };
    }

    case 'heldPrompts':
      return { ...state, held: action.prompts };

    case 'promptUnsent':
      return { ...state, unsent: { text: action.text, seq: (state.unsent?.seq ?? 0) + 1 } };

    case 'setTaskSkills':
      return { ...state, taskSkills: action.skills ?? [] };

    case 'setSkills':
      return { ...state, skills: action.skills ?? [] };

    case 'planDockHeight':
      return { ...state, dockHeight: action.height };

    case 'setRunSettings':
      return { ...state, runSettings: { autonomous: action.autonomous, run: action.run, maxParallel: action.maxParallel } };

    case 'openSettings':
      return { ...state, settingsRequest: state.settingsRequest + 1 };

    default:
      return state;
  }
}

/** The task, if any, parked at a checkpoint: the whole question the panel draws. */
function checkpointOf(view: RunView): { taskId: string; taskTitle: string; summary: string } | null {
  const find = (tasks: readonly RunTask[]): { taskId: string; taskTitle: string; summary: string } | null => {
    for (const task of tasks) {
      if (task.status === 'awaiting_user' && task.awaitingReason === 'checkpoint' && task.checkpoint) {
        return { taskId: task.id, taskTitle: task.title, summary: task.checkpoint };
      }
      const nested = find(task.subtasks);
      if (nested) return nested;
    }
    return null;
  };
  return find(view.tasks);
}
