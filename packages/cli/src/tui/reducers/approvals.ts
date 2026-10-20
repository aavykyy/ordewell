import { reconcileApprovals, type ApprovalRequestMessage } from '@ordewell/core';
import type { Key } from '../keys';
import type { ApprovalRequestView, TuiState } from '../state';
import { approvalScrollMax, bodyRows } from '../layout';
import { WHEEL_NOTCH, pageNotch } from './pointer';
import { clamp, step, type Step } from './shared';

/**
 * Queue rather than stack: the planner blocks on each request, so showing them
 * one at a time keeps the modal honest about what is actually waiting. The open
 * modal is itself the head of the queue, hence the id check against both.
 */
export function enqueueApproval(state: TuiState, request: ApprovalRequestView): TuiState {
  const open = state.overlay?.kind === 'approval' ? state.overlay.request : null;
  if (open?.id === request.id) return state;
  if (state.pendingApprovals.some((p) => p.id === request.id)) return state;
  if (open) return { ...state, pendingApprovals: [...state.pendingApprovals, request] };
  return { ...state, overlay: { kind: 'approval', request } };
}

/** Retire a request answered elsewhere (another surface, or the planner's timeout). */
export function dropApproval(state: TuiState, approvalId: string): TuiState {
  const pending = state.pendingApprovals.filter((p) => p.id !== approvalId);
  const open = state.overlay?.kind === 'approval' ? state.overlay.request : null;
  if (open?.id !== approvalId) return { ...state, pendingApprovals: pending };
  return showNextApproval({ ...state, pendingApprovals: pending, overlay: null });
}

/**
 * The planner's requests the session says are still waiting, for a TUI that
 * was not listening the whole time: each one gets its card and its turn in the
 * modal, and one answered meanwhile — on another surface, or by its timeout —
 * leaves both, so it cannot be answered again from here.
 */
export function syncApprovals(state: TuiState, waiting: readonly ApprovalRequestMessage[]): TuiState {
  const ids = new Set(waiting.map((request) => request.id));
  const open = state.overlay?.kind === 'approval' ? [state.overlay.request] : [];
  const answered = [...open, ...state.pendingApprovals].filter((request) => !ids.has(request.id));
  const dropped = answered.reduce((current, request) => dropApproval(current, request.id), { ...state, conversation: reconcileApprovals(state.conversation, waiting) });
  // A task runner's request is answered in its task view, never in the planner's modal.
  return waiting.reduce((current, { id, kind, subject, scope, detail, body }) => (kind === 'runner_tool'
    ? current
    : enqueueApproval(current, { id, kind, subject, scope, ...(detail ? { detail } : {}), ...(body ? { body } : {}) })), dropped);
}

function showNextApproval(state: TuiState): TuiState {
  const [next, ...rest] = state.pendingApprovals;
  if (!next) return { ...state, overlay: null };
  return { ...state, overlay: { kind: 'approval', request: next }, pendingApprovals: rest };
}

export function handleApprovalKey(
  state: TuiState,
  overlay: Extract<NonNullable<TuiState['overlay']>, { kind: 'approval' }>,
  key: Key,
): Step {
  const grant = key.name === 'enter' || key.char === 'y' || key.char === 'Y';
  const deny = key.name === 'escape' || key.char === 'n' || key.char === 'N';
  // Anything else is left alone: a stray keypress must not answer for the user.
  if (!grant && !deny) return step(state);

  const { request } = overlay;
  // No line of its own: the request's approval block shows the verdict, from
  // the session's `approval_settled` rather than from this keypress.
  return step(showNextApproval({ ...state, overlay: null }), state.sessionId
    ? [{ type: 'respondApproval', sessionId: state.sessionId, approvalId: request.id, granted: grant }]
    : []);
}

/**
 * Moves a request's body in view, or null when the key is no scroll key or the
 * request has no body to scroll. The wheel is the card's own here, as the
 * body is what the answer is about.
 */
export function scrollApproval(
  state: TuiState,
  overlay: Extract<NonNullable<TuiState['overlay']>, { kind: 'approval' }>,
  key: Key,
): Step | null {
  if (!overlay.request.body) return null;
  const page = pageNotch(bodyRows(state));
  const move: Record<string, number> = { down: 1, up: -1, pagedown: page, pageup: -page, scrolldown: WHEEL_NOTCH, scrollup: -WHEEL_NOTCH };
  const delta = move[key.name];
  if (delta === undefined) return null;
  return step({ ...state, overlay: { ...overlay, scroll: clamp((overlay.scroll ?? 0) + delta, approvalScrollMax(state)) } });
}
