import { render } from './render';
import { initialState, reduce, type Action, type Effect } from './reducer';
import { style } from './ansi';
import { DOT_TICKS, chatActivity } from './layout';
import { anyTaskRunning, type TuiState } from './state';

export interface AppDeps {
  initial?: Partial<TuiState>;
  /** Paint one frame; the array holds exactly one line per terminal row. */
  draw(frame: string[]): void;
  perform(effect: Effect): Promise<void>;
  onExit(): void;
  /** Called whenever the session on screen becomes a different one. */
  onSessionChange?(sessionId: string, state: TuiState): void;
}

export interface App {
  start(): void;
  dispatch(action: Action): void;
  getState(): TuiState;
}

/**
 * The state loop: action → reduce → draw → run effects. Effects are fired and
 * forgotten; their results arrive as further actions, so a slow daemon call
 * never blocks a keystroke.
 *
 * Renders are batched via a microtask: when multiple actions arrive in the
 * same synchronous burst (a `status_update` that fans out into per-task
 * dispatches, a rapid key sequence), only the final state is painted. The
 * initial `start()` render and the exit path render synchronously.
 */
export function createApp(deps: AppDeps): App {
  let state = initialState(deps.initial);
  let exited = false;

  let dotTicks = 0;
  const spinnerInterval = setInterval(() => {
    if (anyTaskRunning(state)) {
      dispatch({ type: 'spinnerTick' });
      return;
    }
    // Only the status dot moves here, and it changes colour once per DOT_TICKS,
    // so repaint at that pace rather than at the plan spinner's. Colour off
    // (a pipe, NO_COLOR) leaves nothing to pulse, so nothing repaints.
    if (style.enabled && chatActivity(state)?.busy && ++dotTicks % DOT_TICKS === 0) {
      dispatch({ type: 'spinnerTick', by: DOT_TICKS });
    }
  }, 120);

  let renderPending = false;
  function scheduleRender(): void {
    if (renderPending) return;
    renderPending = true;
    queueMicrotask(() => {
      renderPending = false;
      deps.draw(render(state));
    });
  }

  function dispatch(action: Action): void {
    if (exited) return;

    const result = reduce(state, action);
    const previousSession = state.sessionId;
    state = result.state;
    if (state.sessionId && state.sessionId !== previousSession) deps.onSessionChange?.(state.sessionId, state);

    if (state.exiting) {
      exited = true;
      clearInterval(spinnerInterval);
      deps.onExit();
      return;
    }

    scheduleRender();
    for (const effect of result.effects) fire(effect);
  }

  function fire(effect: Effect): void {
    if (effect.type === 'exit') {
      exited = true;
      clearInterval(spinnerInterval);
      deps.onExit();
      return;
    }
    // A failing effect already reports itself as an error turn; swallow the
    // rejection here so one bad call cannot take the whole session down.
    void deps.perform(effect).catch(() => {});
  }

  return {
    start() {
      deps.draw(render(state));
      fire({ type: 'refresh' });
    },
    dispatch,
    getState: () => state,
  };
}
