import {
  bodyPanes, bottomRowInView, type BodyPanes, chatScrollMax, planOffset, planScrollExtent, revealOffset, rowNearestView, selectionArea, selectionColumns, stackedPaneAtRow,
  topRowInView,
} from '../layout';
import { selectedText } from '../render';
import type { Cell, Focus, Selection, TuiState } from '../state';
import type { Key } from '../keys';
import { clamp, step, type Step } from './shared';

// ── Scrolling ────────────────────────────────────────────────────────────────
//
// Wheel, page keys and the help sheet's arrows all move one of three offsets,
// and each one is clamped here — where it is written — against the pane's real
// extent as `layout.ts` measures it.
//
// Clamping only in the renderer is what made the panes read as frozen: the
// offset kept growing past the end of the content while the view stayed put, so
// every notch back the other way was absorbed silently until the counter fell
// under the bound again. An offset that can never exceed what is scrollable has
// no dead zone in either direction.

export const WHEEL_NOTCH = 3;

/** One page, less a line of overlap so the reader keeps their place across the jump. */
export function pageNotch(viewport: number): number {
  return Math.max(1, viewport - 1);
}

/**
 * Lines a scroll key moves, positive being *back* through the content, or
 * `null` when it is not a scroll key. The viewport is measured only for the
 * page keys — every other keystroke in the chat pane comes through here on its
 * way to the editor — and it is the viewport of the pane being scrolled: a
 * stacked pane is shorter than the body, and a page of the body's height would
 * skip the lines in between.
 */
export function scrollDelta(key: Key, state: TuiState, pane: Focus): number | null {
  if (key.name === 'scrollup') return WHEEL_NOTCH;
  if (key.name === 'scrolldown') return -WHEEL_NOTCH;
  if (key.name !== 'pageup' && key.name !== 'pagedown') return null;
  const { chat, plan } = bodyPanes(state);
  const page = pageNotch((pane === 'plan' && plan ? plan : chat).rows);
  return key.name === 'pageup' ? page : -page;
}

export const isWheel = (key: Key): boolean => key.name === 'scrollup' || key.name === 'scrolldown';

/** A key that only moves a viewport, so scrolling never dismisses a task view's notice. */
export const isScrollKey = (key: Key): boolean =>
  key.name === 'pageup' || key.name === 'pagedown' || isWheel(key) || key.name === 'wheelignored';

export const isMouseSelect = (key: Key): boolean =>
  key.name === 'mousedown' || key.name === 'mousedrag' || key.name === 'mouseup';

/**
 * The pane a mouse report belongs to — a wheel notch or the press that starts a
 * drag: the one the pointer is over, falling back to the focused one when there
 * is no plan pane or the report carried no coordinates.
 *
 * Focus-based routing is what made one pane read as frozen — hovering the task
 * list while typing in the chat scrolled the chat, so the list under the
 * pointer never moved. The keyboard's page keys keep following focus, because
 * the keyboard has no pointer to ask.
 *
 * The divider counts as the plan side: a one-column dead strip between two
 * scrollable panes is a bug the user would experience as the wheel randomly
 * failing, and a press landing on it as a selection that refuses to start.
 *
 * Stacked, the panes are told apart by row instead, and the rows under the body
 * (status, composer, footer) are neither pane's — they fall back to focus.
 */
export function pointerPane(state: TuiState, key: Key): Focus {
  return pointedPane(bodyPanes(state), key) ?? state.focus;
}

/** The pane the pointer is over, or `null` when it is over neither or reported no position. */
function pointedPane(panes: BodyPanes, key: Key): Focus | null {
  if (!panes.plan) return null;
  if (panes.mode === 'stacked') return key.row === undefined ? null : stackedPaneAtRow(panes, key.row);
  return key.col === undefined ? null : key.col <= panes.chat.cols ? 'chat' : 'plan';
}

export function scrollPointed(state: TuiState, key: Key): Step {
  const delta = key.name === 'scrollup' ? WHEEL_NOTCH : -WHEEL_NOTCH;
  return pointerPane(state, key) === 'plan' ? scrollPlan(state, delta, false) : scrollChat(state, delta);
}

export function scrollChat(state: TuiState, delta: number): Step {
  return step({ ...state, scroll: clamp(state.scroll + delta, chatScrollMax(state)) });
}

/**
 * Full detail redraws the transcript at a different height, and the viewport
 * has to move with it. A tail-pinned view stays pinned — that is what the pin
 * means; a scrolled-back view takes on the height change, since the scroll
 * bound moves by exactly what the blocks above the viewport grew or shrank,
 * which leaves the line at the top of the pane where it was.
 */
export function toggleDetail(state: TuiState): Step {
  const flipped = { ...state, detailAll: !state.detailAll };
  const bound = chatScrollMax(state);
  const expanded = chatScrollMax(flipped);
  const scroll = flipped.scroll === 0 ? 0 : clamp(flipped.scroll + expanded - bound, expanded);
  return step({ ...flipped, scroll });
}

/**
 * Puts the plan pane's viewport where the selection (or the open prompt's
 * caret) is on screen, moving it no further than that takes — so anything that
 * changes what the pane holds or how tall it is can call this without the view
 * jumping when the selection is still visible.
 */
export function settlePlan(state: TuiState): TuiState {
  const layout = planScrollExtent(state);
  if (layout.rows === 0) return state;
  return { ...state, planScroll: revealOffset(layout, planOffset(layout, state.planScroll), layout.anchor) };
}

/**
 * Re-clamps both panes to the sizes they now have. Anything that moves the
 * boundary between them (a resize, a focus change in a body too short to hold
 * both) leaves each offset measured against a height it no longer has.
 */
export function settlePanes(state: TuiState): TuiState {
  return settlePlan({ ...state, scroll: clamp(state.scroll, chatScrollMax(state)) });
}

/**
 * The plan pane's offset is absolute and independent of the selection, so the
 * cursor can walk inside the viewport without it scrolling. Scrolling instead
 * drags the selection along only as far as keeping it on screen needs: a page
 * key lands it on the row at the edge the reader is heading for, a wheel notch
 * leaves it be while any of it is still visible. An open prompt editor keeps
 * its selection — moving that would collapse the task under the caret.
 */
export function scrollPlan(state: TuiState, delta: number, paged: boolean): Step {
  const layout = planScrollExtent(state);
  const from = planOffset(layout, state.planScroll);
  const to = clamp(from - delta, layout.maxScroll);
  const scrolled = { ...state, planScroll: to };
  if (state.taskEditor || layout.rowSpans.length === 0) return step(scrolled);

  const back = delta > 0;
  if (!paged) {
    return step({ ...scrolled, selectedTask: rowNearestView(layout, to, state.selectedTask) });
  }
  if (to === from) return step({ ...scrolled, selectedTask: back ? 0 : layout.rowSpans.length - 1 });
  return step({ ...scrolled, selectedTask: back ? bottomRowInView(layout, to) : topRowInView(layout, to) });
}

// ── Selection ────────────────────────────────────────────────────────────────

/**
 * Where a mouse report lands *within the region the drag belongs to*: the
 * reported cell, pulled back inside that region in both directions. This is
 * what stops a drag that wandered across the divider — or off the bottom of the
 * transcript into the plan — from selecting the neighbour: it extends down the
 * origin pane instead, which is the only way a copied line can be one pane's
 * text rather than a splice of both. A drag that starts on the chrome under the
 * body has no pane to pin to, so it takes whole frame rows instead.
 */
function selectionCell(state: TuiState, pane: Focus, from: number, key: Key, panes: BodyPanes): Cell {
  const area = selectionArea(state, pane, from, panes);
  const row = clampRange(key.row ?? area.firstRow, area.firstRow, area.lastRow);
  const { firstCol, lastCol } = selectionColumns(area, row);
  return { col: clampRange(key.col ?? firstCol, firstCol, lastCol), row };
}

function clampRange(value: number, low: number, high: number): number {
  return Math.max(low, Math.min(high, value));
}

/** Whether the drag never left the cell it started in — a click, not a range. */
const isClick = (selection: Selection): boolean =>
  selection.anchor.col === selection.head.col && selection.anchor.row === selection.head.row;

export function handleMouseSelect(state: TuiState, key: Key): Step {
  if (key.name === 'mousedown') {
    // The pane is decided once, here, and carried for the whole drag —
    // `pointerPane` is the same aim the wheel uses, divider fallback included.
    // Under the body there is no pane to aim at, but the row still decides the
    // region, so the composer is selectable whole in either layout.
    const panes = bodyPanes(state);
    const pane = pointedPane(panes, key) ?? state.focus;
    const cell = selectionCell(state, pane, key.row ?? 1, key, panes);
    return step({ ...state, selection: { anchor: cell, head: cell, pane } });
  }

  const { selection } = state;
  // A drag or release with nothing anchored is a report from before this app
  // owned the mouse (a tmux reattach mid-drag), not the tail of a selection.
  if (!selection) return step(state);

  const moved = { ...selection, head: selectionCell(state, selection.pane, selection.anchor.row, key, bodyPanes(state)) };
  if (key.name === 'mousedrag') return step({ ...state, selection: moved });

  // A click with no movement is how the user dismisses a selection; treating it
  // as a zero-width range would leave the old highlight up and copy nothing.
  if (isClick(moved)) return step({ ...state, selection: null });
  return step({ ...state, selection: null }, [{ type: 'copyText', text: selectedText({ ...state, selection: moved }) }]);
}
