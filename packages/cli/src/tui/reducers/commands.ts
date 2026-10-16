import {
  EMPTY_CONVERSATION, EMPTY_HOLD, EMPTY_RUN, NO_TURN, PROVIDER_PRIORITY, TERMINAL_UI_COMMANDS, autonomyLevelLabel, parseAutonomyLevel, parseMaxParallel, runnerForProvider, getProviderMeta, isApiProvider, isPlannerBackend, type AiProvider,
} from '@ordewell/core';
import { handoffCommand } from '../handoff';
import { vendorModelRefusal } from '../../plannerModelSwitch';
import { findCommand, type ParsedCommand } from '../slash';
import { findTask, plannerInFlight, type PickerItem, type TuiState } from '../state';
import { modelsForRunner } from '../taskAssignment';
import { say } from '../transcript';
import { DEFAULT_EFFORT, picker, pickerItemsFor, plannerEffortItems, providerErrorHint } from './pickers';
import { plannerStepper } from './plannerStepper';
import { openStepper } from './stepper';
import { taskActionEffect } from './planPane';
import { answerCheckpoint, continueTaskStep, openTaskView } from './taskView';
import {
  addTask, confirmForceStartPastGate, openTaskDepsPicker, taskCommand, taskOpsCommand, taskEffortCommand, taskModeCommand, taskModelCommand, taskRunnerCommand, taskSkillsCommand,
} from './taskEdits';
import { stopPlanning } from './turnQueue';
import { withRun } from './incoming';
import { automergeCommand, autorunCommand, supervisorCommand } from './runSettings';
import { openSettings } from './settings';
import { fail, step, withSession, type Effect, type Step, type TaskAction } from './shared';

export const unknownCommand = (state: TuiState, name: string): Step =>
  fail(state, `Unknown command: /${name} — type /help to see what's available.`);

export function runCommand(state: TuiState, { name, args }: ParsedCommand): Step {
  if (!findCommand(name)) return unknownCommand(state, name);

  switch (name) {
    case 'help':
      return step({ ...state, overlay: { kind: 'help', scroll: 0 } });
    case 'quit':
      return step({ ...state, exiting: true }, [{ type: 'exit' }]);
    case 'refresh':
      return step(state, [{ type: 'refresh', announce: true }]);

    case 'run':
      return withSession(state, (sessionId) => step(state, [{ type: 'execute', sessionId }]));
    case 'approve':
      return withSession(state, (sessionId) =>
        step({ ...state, planApproved: true }, [{ type: 'execute', sessionId }]),
      );
    case 'stop':
      // A planner turn first, as Esc does: a turn sent mid-run is the newer
      // thing the user started, and the run outlives it for a second /stop.
      // Stopping a turn brings the queue behind it back into the editor, the
      // way the Esc route does.
      return withSession(state, (sessionId) =>
        plannerInFlight(state)
          ? stopPlanning(state, sessionId)
          : step(state, [{ type: 'stopExecution', sessionId }]),
      );

    case 'model':
      return setModel(state, args);
    case 'planner':
      return setPlanner(state, args);
    case 'planner-effort':
      return setPlannerEffort(state, args);
    case 'key':
      return setKey(state, args);
    case 'allowlist':
      return allowlist(state, args);
    case 'runners':
      return runners(state, args);
    case 'auto':
      return setAutonomous(state, args[0]);
    case 'supervisor':
      return supervisorCommand(state, args);
    case 'automerge':
      return automergeCommand(state, args[0]);
    case 'autorun':
      return autorunCommand(state, args[0]);
    case 'parallel':
      return setMaxParallel(state, args[0]);
    case 'settings':
      return openSettings(state);
    case 'mouse':
      return setMouseCapture(state, args[0]);

    case 'sessions':
      return step(
        { ...state, overlay: { kind: 'picker', picker: picker('Sessions', [], { kind: 'load-session' }, { filterable: true }) } },
        [{ type: 'loadSessions' }],
      );
    case 'handoff':
      return handoffCommand(state, args[0]);
    case 'fork':
      return withIdlePlanner(state, (sessionId) => step(state, [{ type: 'forkConversation', sessionId }]));
    case 'rewind':
      return rewind(state, args[0]);
    case 'compact':
      return withIdlePlanner(state, (sessionId) =>
        step({ ...state, planner: 'condensing' }, [{ type: 'compactConversation', sessionId }]),
      );
    case 'new':
      return requestNewSession(state);
    case 'save':
      return withSession(state, (sessionId) => step(state, [{ type: 'saveSession', sessionId }]));
    case 'load':
      return args[0]
        ? step(state, [{ type: 'loadSession', sessionId: args[0] }])
        : fail(state, 'Usage: /load <session-id> — or run /sessions to pick one.');
    case 'delete':
      return args[0]
        ? step(state, [{ type: 'deleteSession', sessionId: args[0] }])
        : fail(state, 'Usage: /delete <session-id>');

    case 'add-task':
      return addTask(state, args.join(' '));
    case 'remove-task':
      return taskCommand(state, args[0], (sessionId, taskId) =>
        step(state, [{ type: 'removeTask', sessionId, taskId }]),
      );
    case 'continue':
      return taskCommand(state, args[0], (sessionId, taskId) => {
        const text = args.slice(1).join(' ').trim();
        if (!text) return fail(state, 'Usage: /continue <id> <message>');
        // The daemon owns the rule and says why it refuses, so nothing is pre-judged here.
        return continueTaskStep(state, sessionId, taskId, text);
      });
    case 'open':
      return taskCommand(state, args[0], (sessionId, taskId) => openTaskView(state, sessionId, taskId));
    case 'checkpoint':
      return taskCommand(state, args[0], (sessionId, taskId) => {
        const answer = args[1]?.toLowerCase();
        const reason = args.slice(2).join(' ').trim();
        if (answer !== 'approve' && answer !== 'reject') return fail(state, 'Usage: /checkpoint <id> approve|reject [reason]');
        if (answer === 'approve' && reason) return fail(state, 'Approving takes no note — reject with a reason to tell the task something.');
        return answerCheckpoint(state, sessionId, taskId, answer, reason);
      });
    case 'task-runner':
      return taskRunnerCommand(state, args);
    case 'task-model':
      return taskModelCommand(state, args);
    case 'task-effort':
      return taskEffortCommand(state, args);
    case 'task-mode':
      return taskModeCommand(state, args);
    case 'task-ops':
      return taskOpsCommand(state, args);
    case 'task-skills':
      return taskSkillsCommand(state, args);
    case 'task-deps':
      return taskCommand(state, args[0], (_sessionId, taskId) =>
        openTaskDepsPicker(state, findTask(state.tasks, taskId)!),
      );
    case 'complete':
    case 'uncomplete':
    case 'skip':
    case 'retry':
    case 'cancel':
    case 'force-start':
      return taskCommand(state, args[0], (sessionId, taskId) => {
        const task = findTask(state.tasks, taskId);
        if (name === 'force-start' && task?.mergeGate?.length) return confirmForceStartPastGate(state, task);
        return step(state, [taskActionEffect(state, sessionId, taskId, name as TaskAction)]);
      });
  }

  return fail(state, `/${name} is not wired up yet.`);
}

/**
 * Fork, rewind and compact edit the conversation, so they wait out a planner turn — the
 * daemon refuses them too, but saying so here costs no round trip. A task run
 * is no obstacle: none of them touches the plan it is executing.
 */
export function withIdlePlanner(state: TuiState, run: (sessionId: string) => Step): Step {
  return withSession(state, (sessionId) =>
    plannerInFlight(state)
      ? fail(state, 'The planner is still answering — wait for its reply, or /stop it first.')
      : run(sessionId),
  );
}

/** `on`/`off` when given explicitly, otherwise the opposite of what is set now. */
function resolveToggle(arg: string | undefined, current: boolean): boolean | null {
  const value = arg?.toLowerCase();
  if (value === 'on') return true;
  if (value === 'off') return false;
  if (value === undefined) return !current;
  return null;
}

// Only asks when there is something to lose; an empty/idle session resets
// silently. Mirrors the VS Code extension's confirm-before-reset.
function requestNewSession(state: TuiState): Step {
  const hasContent = state.tasks.length > 0 || state.conversation.blocks.length > 0 || state.goal !== '' || state.status !== 'idle' || plannerInFlight(state);
  if (!state.sessionId || !hasContent) return newSession(state);
  return step({
    ...state,
    overlay: {
      kind: 'confirm',
      title: 'Start a new session?',
      message: 'The current plan will be cleared and any running tasks stopped.',
      action: { kind: 'new-session' },
    },
  });
}

export function newSession(state: TuiState): Step {
  // Without this, the outgoing session's execution stream stays open and its
  // task updates keep landing on whatever id matches in the fresh state below.
  const closeEffects: Effect[] = state.sessionId ? [{ type: 'closeSession', sessionId: state.sessionId }] : [];
  return step(withRun({
    ...state,
    sessionId: null,
    goal: '',
    taskView: null,
    planApproved: false,
    conversation: EMPTY_CONVERSATION,
    turnGate: NO_TURN,
    selectedTask: 0,
    expandedTaskId: null,
    taskEditor: null,
    scroll: 0,
    planScroll: null,
    status: 'idle',
    planner: 'idle',
    // Prompts belong to the session that raised them; the old planner is gone
    // and its pending requests deny on their own timeout.
    pendingApprovals: [],
    queuedPrompts: EMPTY_HOLD,
    stopArmed: false,
    forceSendPending: null,
    overlay: state.overlay?.kind === 'approval' ? null : state.overlay,
  }, EMPTY_RUN), closeEffects);
}

function setModel(state: TuiState, args: string[]): Step {
  if (args[0] === 'set' && args[1]) {
    // A harness planner can only run its own agent's models (ADR-0009), so the
    // typed path gets the same scoping the picker does.
    const runner = runnerForProvider(state.plannerProvider);
    const known = runner ? modelsForRunner(state.models, runner) : [];
    if (runner && known.length > 0 && !known.some((m) => m.id === args[1])) {
      return fail(state, `${args[1]} was not discovered for ${runner}.`);
    }
    // A cold catalog cannot vouch for an id, but a vendor's is plainly not the agent's.
    const refusal = known.length === 0 ? vendorModelRefusal(state.plannerProvider, args[1], TERMINAL_UI_COMMANDS.pickPlanner) : null;
    if (refusal) return fail(state, refusal);
    return step(state, [{ type: 'setModel', modelId: args[1] }]);
  }
  if (args.length > 0 && args[0] !== 'set') return fail(state, 'Usage: /model [set <model-id>]');

  const items = pickerItemsFor(state, { kind: 'set-model' });
  return step(
    {
      ...state,
      overlay: {
        kind: 'picker',
        picker: picker('Planner model', items, { kind: 'set-model' }, { hint: providerErrorHint(state), filterable: true }),
      },
    },
    [{ type: 'loadModels' }],
  );
}

function setPlanner(state: TuiState, args: string[]): Step {
  if (args[0]) {
    const id = args[0].toLowerCase();
    if (!isPlannerBackend(id)) {
      return fail(state, `Unknown planner: ${id}. Run /planner with no arguments to see the list.`);
    }
    return step(state, [{ type: 'setPlanner', provider: id }]);
  }
  const opened = openStepper(state, plannerStepper);
  // The model step lists the chosen backend's catalog, so fetch it fresh; the
  // open stepper refills when it lands.
  return { ...opened, effects: [...opened.effects, { type: 'loadModels' }] };
}

function setPlannerEffort(state: TuiState, args: string[]): Step {
  const items = plannerEffortItems(state, state.plannerProvider, state.orchestratorModel, state.plannerEffort);
  if (args[0]) {
    const wanted = args[0].toLowerCase();
    const match = items.find((i) => !i.disabled && (i.id === wanted || (wanted === 'default' && i.id === DEFAULT_EFFORT)));
    if (!match) {
      const available = items.filter((i) => !i.disabled && i.id !== DEFAULT_EFFORT).map((i) => i.id);
      return fail(state, available.length > 0
        ? `Unknown effort: ${args[0]}. Available: ${available.join(', ')}, default.`
        : (items[0]?.label ?? 'No effort levels available.'));
    }
    return step(state, [{ type: 'setPlannerEffort', effort: match.id === DEFAULT_EFFORT ? '' : match.id }]);
  }
  return step({
    ...state,
    overlay: {
      kind: 'picker',
      picker: picker('Planner thinking effort', items, { kind: 'set-planner-effort' }, {
        hint: "How hard the planning agent thinks per turn. Higher costs latency and tokens against your subscription.",
      }),
    },
  });
}

function setKey(state: TuiState, args: string[]): Step {
  if (args[0] === 'set' && args[1]) {
    const provider = args[1].toLowerCase();
    if (!isApiProvider(provider)) {
      return fail(state, `Unknown provider: ${provider}. Run /key with no arguments to see the list.`);
    }
    if (!args[2]) {
      return step({
        ...state,
        overlay: keyPrompt(provider),
      });
    }
    return step(state, [{ type: 'setApiKey', provider, key: args.slice(2).join(' ') }]);
  }

  const items: PickerItem[] = PROVIDER_PRIORITY.map((id) => ({
    id,
    label: getProviderMeta(id).label,
    detail: getProviderMeta(id).apiKeyEnvVar,
    selected: state.configuredProviders.includes(id),
  }));
  return step({ ...state, overlay: { kind: 'picker', picker: picker('API provider key', items, { kind: 'set-key' }) } });
}

export function keyPrompt(provider: AiProvider): TuiState['overlay'] {
  const meta = getProviderMeta(provider);
  return {
    kind: 'prompt',
    title: `${meta.label} API key`,
    hint: `Stored as ${meta.apiKeyEnvVar} in your .env`,
    value: '',
    action: { kind: 'api-key', provider, envVar: meta.apiKeyEnvVar },
  };
}

function allowlist(state: TuiState, args: string[]): Step {
  const [sub, runner, ...rest] = args;

  if (sub === 'set') {
    if (!runner || rest.length === 0) return fail(state, 'Usage: /allowlist set <runner> <id1,id2,…>');
    if (state.runners.length > 0 && !state.runners.some((r) => r.id === runner)) {
      return fail(state, `Unknown runner "${runner}".`);
    }
    const modelIds = rest.join(' ').split(',').map((s) => s.trim()).filter(Boolean);
    if (modelIds.length === 0) return fail(state, 'Usage: /allowlist set <runner> <id1,id2,…>');
    // Same rule the picker enforces, for the typed path: an id this runner was
    // never discovered with cannot be spawned, so refuse rather than persist it.
    // Skipped when nothing is discovered yet — that says nothing about the ids.
    const known = modelsForRunner(state.models, runner);
    if (state.models.length > 0 && known.length > 0) {
      const stray = modelIds.filter((id) => !known.some((m) => m.id === id));
      if (stray.length > 0) {
        return fail(state, `Not discovered for ${runner}: ${stray.join(', ')}.`);
      }
    }
    return step(state, [{ type: 'setAllowlist', runner, modelIds }]);
  }

  if (sub === 'clear') {
    if (!runner) return fail(state, 'Usage: /allowlist clear <runner>');
    return step(state, [{ type: 'setAllowlist', runner, modelIds: [] }]);
  }

  if (sub === 'show' || sub === undefined) {
    const items: PickerItem[] = state.runners.map((r) => ({
      id: r.id,
      label: r.name,
      detail: describeAllowlist(state.allowlist[r.id]),
    }));
    return step(
      {
        ...state,
        overlay: {
          kind: 'picker',
          picker: picker('Limit models for which runner?', items, { kind: 'choose-allowlist-runner' }),
        },
      },
      // The model list the next picker is built from must be the runner's real
      // one; refresh it while the user is still choosing a runner.
      [{ type: 'loadModels' }],
    );
  }

  return fail(state, 'Usage: /allowlist [set <runner> <ids> | clear <runner>]');
}

function describeAllowlist(ids: string[] | undefined): string {
  if (!ids || ids.length === 0) return 'no restriction';
  return `${ids.length} model${ids.length === 1 ? '' : 's'} allowed`;
}

function runners(state: TuiState, args: string[]): Step {
  const [runner, arg] = args;

  if (runner) {
    const known = state.runners.find((r) => r.id === runner);
    const enabled = resolveToggle(arg, known?.enabled ?? true);
    if (enabled === null) return fail(state, 'Usage: /runners [<runner-id> on|off]');
    return step(state, [{ type: 'setRunnerEnabled', runner, enabled }]);
  }

  const action = { kind: 'set-runners' as const };
  const items = pickerItemsFor(state, action);
  return step({ ...state, overlay: {
    kind: 'picker',
    picker: picker('Runners', items, action, {
      hint: 'Enabled runners are the ones the planner may assign work to.',
      multi: true,
      chosen: state.runners.filter((r) => r.enabled).map((r) => r.id),
    }),
  } });
}

function setMaxParallel(state: TuiState, arg: string | undefined): Step {
  if (!arg) return step(say(state, 'system', `Up to ${state.maxParallel} AI task${state.maxParallel === 1 ? '' : 's'} run at once — /parallel <n> changes it.`));
  const limit = parseMaxParallel(arg);
  if (limit === null) return fail(state, 'Usage: /parallel [<number of tasks, 1 or more>]');
  return step({ ...state, maxParallel: limit }, [{ type: 'setMaxParallel', limit }]);
}

function setAutonomous(state: TuiState, arg: string | undefined): Step {
  if (arg === undefined) return step(say(state, 'system', `Autonomy level: ${autonomyLevelLabel(state.autonomous)} — /auto full or /auto guarded changes it for new plans.`));
  const enabled = parseAutonomyLevel(arg);
  if (enabled === null) return fail(state, 'Usage: /auto [full|guarded]');
  // Updated here, not from the effect: the daemon never answers this setting
  // back (it is written to the settings file locally), and a stale flag would
  // freeze the toggle and the badge.
  return step({ ...state, autonomous: enabled }, [{ type: 'setAutonomous', enabled }]);
}

/**
 * Capture no longer costs the user their selection — the app does the selecting
 * itself now, and confines it to one pane so a copied line cannot be a splice
 * of chat and plan. What `off` still buys is the *terminal's* own selection,
 * which spans both panes and is the only one that can reach a scrollback the
 * alt screen has already scrolled away. The notice names both, because a
 * command whose only stated effect is one the user cannot see is a mystery.
 */
function setMouseCapture(state: TuiState, arg: string | undefined): Step {
  const enabled = resolveToggle(arg, state.mouseCapture);
  if (enabled === null) return fail(state, 'Usage: /mouse [on|off]');
  const noted = say(
    // A selection made under capture is meaningless once the terminal owns the
    // mouse again, and its highlight would sit on screen with nothing able to
    // move it.
    { ...state, mouseCapture: enabled, selection: null },
    'system',
    enabled
      ? 'Mouse capture on — the wheel scrolls, and dragging selects within one pane and copies on release.'
      : "Mouse capture off — the terminal's own drag-select is back, across both panes; scroll with pgup/pgdn.",
  );
  return step(noted, [{ type: 'setMouseCapture', enabled }]);
}

function rewind(state: TuiState, arg: string | undefined): Step {
  return withIdlePlanner(state, (sessionId) => {
    if (arg === undefined) {
      return step(
        { ...state, rewindTargets: null, overlay: { kind: 'picker', picker: picker('Rewind to before…', [], { kind: 'rewind' }, { filterable: true, hint: 'Rewinding forks the conversation from just before the chosen message; the original is kept and the tasks ride along.' }) } },
        [{ type: 'loadRewindTargets', sessionId }],
      );
    }
    if (!/^\d+$/.test(arg)) return fail(state, 'Usage: /rewind [<message>] — or /rewind alone to pick one.');
    return step(state, [{ type: 'loadRewindTargets', sessionId, pick: Number(arg) }]);
  });
}

const REWIND_OPTIONS = [
  { label: 'Restore Conversation', confirms: true },
  { label: 'Never mind', confirms: false },
];

/** Both ways to name a message — the picker and `/rewind <n>` — end at the same confirmation. */
export function pickRewindTarget(state: TuiState, index: number): Step {
  return withIdlePlanner({ ...state, overlay: null }, () => {
    const target = state.rewindTargets?.find((t) => t.index === index);
    if (!target) return fail({ ...state, overlay: null }, `No message ${index} to rewind to — /rewind alone lists them.`);
    return step({
      ...state,
      overlay: {
        kind: 'confirm',
        title: 'Rewind',
        message: 'Confirm you want to restore to the point before you sent this message:',
        quote: target.content,
        note: 'The conversation will be forked.\nThe code will be unchanged.',
        action: { kind: 'rewind', index },
        choice: { options: REWIND_OPTIONS, index: 0 },
      },
    });
  });
}
