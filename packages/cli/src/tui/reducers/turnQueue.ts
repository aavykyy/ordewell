import { aheadOfDraft, drainNext, unsendAll, unsendLatest as unsendNewest } from '@ordewell/core';
import { commit } from '../editor';
import { plannerInFlight, planPaneOpen, type TuiState } from '../state';
import { cutTurn, say } from '../transcript';
import { step, type Effect, type Step } from './shared';

/**
 * A planner turn ending is the moment the next queued prompt goes out. The
 * actions that end a turn (`planUpdated`'s settle branch, `failed`) funnel
 * through here: one prompt is spoken and sent, and the status says planning
 * again only while the queue keeps going.
 *
 * Nothing is drained when no turn was in flight — a failure during execution,
 * or a plan refresh running alongside a run, is not a settling turn.
 */
export function drainQueue(state: TuiState, settled: TuiState): Step {
  const next = drainNext(state.queuedPrompts);
  // The arm aimed at the turn that just ended lapses with it — the next turn
  // starts unarmed, and its first Esc has to earn the stop again.
  const ended = disarmStop({ ...settled, stopRequested: false, forceSendPending: null });
  if (!next) return step(ended);
  const spoken = say(ended, 'user', next.text);
  const effect: Effect | null = state.sessionId
    ? { type: 'sendMessage', sessionId: state.sessionId, message: next.text }
    : null;
  return step(
    { ...spoken, queuedPrompts: next.rest, planner: 'planning' },
    effect ? [effect] : [],
  );
}

/**
 * A force send that never started its turn gives the prompt back: to the
 * composer, above what was typed since, or to its place in the queue.
 */
export function restoreForced(state: TuiState): TuiState {
  const { forceSendPending: forced } = state;
  if (!forced) return state;
  const cleared = { ...state, forceSendPending: null };
  if (forced.queueIndex === undefined) {
    const text = aheadOfDraft(forced.text, state.editor.text);
    return { ...cleared, editor: { ...state.editor, text, cursor: text.length } };
  }
  const queued = [...state.queuedPrompts];
  queued.splice(Math.min(forced.queueIndex, queued.length), 0, forced.text);
  return { ...cleared, queuedPrompts: queued };
}

/** The arm lapsed — through the scheduled effect or a different key. */
export function disarmStop(state: TuiState): TuiState {
  return state.stopArmed ? { ...state, stopArmed: false } : state;
}

/** How long a first Esc holds the stop armed before it lapses. */
export const STOP_ARM_MS = 2000;

/**
 * Call off the turn. An approval prompt on screen goes with it, and so does
 * the queue behind it: the prompts the user held back belong to a turn that no
 * longer exists, so they return to the editor to edit and resend rather than
 * firing off after the stop.
 */
export function stopPlanning(state: TuiState, sessionId: string): Step {
  const dismissed = state.overlay?.kind === 'approval'
    ? { ...state, overlay: null, pendingApprovals: [] }
    : state;
  return step(queueToEditor(cutTurn({ ...dismissed, stopArmed: false, stopRequested: true, forceSendPending: null })), [{ type: 'cancelPlanning', sessionId }]);
}

/**
 * The prompts parked behind a dead turn go back where they were typed, in the
 * order they were queued, above any draft. `/stop` arrives with the editor
 * already cleared (the command consumed it); a session let go mid-turn may
 * find something typed since.
 */
export function queueToEditor(state: TuiState): TuiState {
  const all = unsendAll(state.queuedPrompts);
  if (!all) return state;
  const text = aheadOfDraft(all.text, state.editor.text);
  return { ...state, queuedPrompts: all.rest, editor: { ...state.editor, text, cursor: all.text.length } };
}

/**
 * Takes the newest queued prompt back: its text goes above whatever draft is
 * in the box, separated by a newline, and the planner keeps running. The editor
 * is rebuilt wholesale rather than patched, because the takeback replaces what
 * the user was composing rather than joining its history.
 */
function unsendLatest(state: TuiState): Step {
  const latest = unsendNewest(state.queuedPrompts);
  if (!latest) return step(state);
  const text = aheadOfDraft(latest.text, state.editor.text);
  return step({
    ...state,
    queuedPrompts: latest.rest,
    stopArmed: false,
    editor: { ...state.editor, text, cursor: latest.text.length, historyIndex: state.editor.history.length, draft: '' },
  });
}

/**
 * Send now in the planner chat (ADR-0023, F5): stop the planner turn in flight
 * and answer the composer's text in the turn that replaces it — or, with the
 * composer empty, the newest queued prompt. Turn-scoped: the run's tasks are
 * never touched, and the prompts still held keep their order behind the forced
 * one. Only reached while a turn is in flight; with none it is a plain send
 * (see `submit`).
 */
export function forceSendPlanner(state: TuiState): Step {
  if (!state.sessionId) return step(state);
  const text = state.editor.text.trim();
  if (text) {
    return step({ ...state, editor: commit(state.editor), stopRequested: false, forceSendPending: { text } }, [
      { type: 'forceSendPlannerMessage', sessionId: state.sessionId, message: text },
    ]);
  }
  const latest = unsendNewest(state.queuedPrompts);
  if (!latest) return step(say(state, 'system', 'Nothing to send now: type a message, or queue one with enter.'));
  const forced = { text: latest.text, queueIndex: latest.rest.length };
  return step({ ...state, queuedPrompts: latest.rest, stopRequested: false, forceSendPending: forced }, [
    { type: 'forceSendPlannerMessage', sessionId: state.sessionId, message: latest.text },
  ]);
}

/**
 * Esc on an in-flight planner turn, in order of the user's intent:
 * 1. take back the newest queued prompt (the planner keeps running);
 * 2. arm a stop — a second Esc commits it, anything else disarms;
 * 3. commit the stop.
 *
 * Returns null when this is not one of those cases, so the key goes on to
 * whatever else owns it. An approval prompt is included: ESC there would
 * otherwise deny one tool call, which the planner answers by issuing the next
 * one. Every other overlay (help, pickers, confirm) keeps its own ESC, and so
 * does the plan pane while it has a task's prompt editor or revealed subtask
 * rows open — those are things the user opened and can close.
 */
export function plannerEscape(state: TuiState): Step | null {
  if (!plannerInFlight(state) || !state.sessionId
      || (state.overlay && state.overlay.kind !== 'approval')
      || planPaneOpen(state)) return null;
  if (state.queuedPrompts.length > 0) return unsendLatest(state);
  if (state.stopArmed) return stopPlanning(state, state.sessionId);
  const arm = state.stopArmToken + 1;
  return step({ ...state, stopArmed: true, stopArmToken: arm }, [{ type: 'disarmStop', afterMs: STOP_ARM_MS, arm }]);
}
