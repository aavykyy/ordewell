import { followTurn, reduceConversation, stopTurn, type ConversationInput, type ConversationView, type GatedConversation, type LocalEntry } from '@ordewell/core';
import type { TuiState } from './state';

/*
 * The one way anything reaches the chat pane: core's conversation reducer.
 * Text is kept exactly as it arrived — a turn adopts the user's prompt only if
 * the two match — and made safe to paint where it is drawn (see `sanitize`).
 */

function show(state: TuiState, { view: conversation, gate: turnGate }: GatedConversation): TuiState {
  const gated = turnGate === state.turnGate ? state : { ...state, turnGate };
  if (conversation === state.conversation) return gated;
  return { ...gated, conversation };
}

function fold(state: TuiState, input: ConversationInput): TuiState {
  return show(state, { view: reduceConversation(state.conversation, input), gate: state.turnGate });
}

/**
 * A line the TUI adds itself: the user's prompt, a notice, an error. It brings
 * the pane to the tail, because it answers something the reader just did —
 * unless `followTail` is false, as for the copy count: that reports on text
 * already on screen, so it must leave the reader where they are.
 */
export function say(state: TuiState, role: LocalEntry['role'], text: string, followTail = true): TuiState {
  const said = fold(state, { type: 'local_entry', role, text });
  if (!followTail) return said;
  return said.conversation.nextId > state.conversation.nextId ? { ...said, scroll: 0 } : said;
}

/** A planner message from the session, folded into the conversation. */
export function hear(state: TuiState, message: ConversationInput): TuiState {
  return show(state, followTurn(state.conversation, state.turnGate, message));
}

/** The user stopped the planner: its turn ends on screen now, and what it still streams is dropped (core's stop rule). */
export function cutTurn(state: TuiState): TuiState {
  return show(state, stopTurn(state.conversation, state.turnGate));
}

/**
 * The pane wiped with the session's bookkeeping kept: ids stay unique, the
 * transcript markers already shown are not shown again by the next plan, and
 * the token line counts the session, not the screen.
 */
export function wiped(view: ConversationView): ConversationView {
  return { ...view, blocks: view.blocks.filter((b) => b.type === 'usage') };
}
