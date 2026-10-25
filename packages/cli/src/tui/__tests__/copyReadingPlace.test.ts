import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { replayTaskLog, type TaskLogEvent } from '@ordewell/core';
import { stripAnsi, style } from '../ansi';
import { runEffect, type EffectDeps } from '../effects';
import { chatScrollMax } from '../layout';
import { initialState, reduce, type Action, type Effect, type Step } from '../reducer';
import { render } from '../render';
import type { TaskView, TuiState } from '../state';
import { chatOf, messagesOf } from './chat';

const styled = style.enabled;
beforeAll(() => {
  // The frame comparisons are about visible text; colour and the selection
  // band would only add escape sequences to compare.
  style.enabled = false;
});
afterAll(() => {
  style.enabled = styled;
});

const ROWS = { rows: 24, cols: 80 };
const painted = (state: TuiState): string => render(state).map(stripAnsi).join('\n');

const mouse = (state: TuiState, name: string, col: number, row: number): Step =>
  reduce(state, { type: 'key', key: { name, col, row } });

/** Press, drag and release across the given cells, returning the release step. */
function drag(state: TuiState, from: [number, number], to: [number, number]): Step {
  const down = mouse(state, 'mousedown', from[0], from[1]).state;
  const moved = mouse(down, 'mousedrag', to[0], to[1]).state;
  return mouse(moved, 'mouseup', to[0], to[1]);
}

const copiedText = (effects: Effect[]): string => {
  const effect = effects.find((e): e is Extract<Effect, { type: 'copyText' }> => e.type === 'copyText');
  if (!effect) throw new Error('the release emitted no copyText effect');
  return effect.text;
};

/** A chat long enough that a scrolled-back viewport has content above and below it. */
const history = (over: Partial<TuiState> = {}): TuiState => initialState({
  ...ROWS,
  conversation: chatOf(...Array.from({ length: 30 }, (_, i): ['user', string] => [
    'user', `history line ${i} ${'word '.repeat(8)}`,
  ])),
  ...over,
});

const PLAN_TASKS: TaskView[] = [
  { id: 'a', order: 1, title: 'PLANTASK alpha', type: 'ai', status: 'pending', dependencies: [] },
  { id: 'b', order: 2, title: 'PLANTASK beta', type: 'ai', status: 'pending', dependencies: ['a'] },
];

const logLines = (from: number, to: number): TaskLogEvent[] => Array.from(
  { length: to - from },
  (_, i): TaskLogEvent => ({ type: 'text_delta', text: `runner line ${from + i}\n\n` }),
);

/** A task view whose runner log overflows, with the reader `scroll` lines off its tail. */
const taskLogOpen = (scroll: number): TuiState => initialState({
  ...ROWS,
  sessionId: 's1',
  scroll,
  tasks: [{ id: 't1', order: 1, title: 'Do it', type: 'ai', status: 'in_progress', dependencies: [] }],
  taskView: {
    taskId: 't1',
    view: replayTaskLog([{ type: 'turn_start', message: 'go' }, ...logLines(0, 60)]),
    attempts: [1], attempt: 1, pending: [], loaded: true, followLatest: true, queuedIndex: 0,
  },
});

/**
 * Runs the release's real effects with the real `copySelection`, swapping only
 * the two process boundaries: the clipboard command and the terminal's OSC 52
 * write. No test may reach the developer's actual clipboard.
 */
async function copyThrough(released: Step, over: Partial<EffectDeps> = {}) {
  const notices: string[] = [];
  const pipeToClipboard = vi.fn();
  const writeTerminal = vi.fn();
  let state = released.state;

  const deps = {
    api: {} as EffectDeps['api'],
    workspace: '/ws',
    port: 3742,
    dispatch: (action: Action) => {
      if (action.type === 'notice') notices.push(action.message);
      state = reduce(state, action).state;
    },
    newSessionId: () => 'session-new',
    setEnvVar: () => {},
    saveAutonomy: () => ({ overridden: false }),
    reviveDaemon: async () => true,
    setMouseCapture: () => {},
    exit: () => {},
    hasBin: () => true,
    pipeToClipboard,
    writeTerminal,
    ...over,
  } as EffectDeps;

  for (const effect of released.effects) await runEffect(effect, deps);
  return { state, notices, pipeToClipboard, writeTerminal };
}

/**
 * The copy notice is not a submitted prompt: it reports something the reader
 * did to the text already on screen, so it must not take the pane away from
 * the lines they are reading. The notice is still added below the viewport and
 * the numeric offset grows with it — asserting the painted frame is the point,
 * because an unchanged offset alone would slide what they are reading.
 */
describe('a copy while the reader is scrolled back', () => {
  it('keeps the chat viewport on the same lines when the host clipboard is used', async () => {
    const back = { ...history(), scroll: 12 };
    const before = painted(back);

    const released = drag(back, [1, 3], [60, 6]);
    // The release itself only drops the highlight and emits the copy. This is
    // the alternative cause, ruled out before the notice is even dispatched.
    expect(released.state.scroll).toBe(12);
    expect(painted(released.state)).toBe(before);

    const text = copiedText(released.effects);
    const after = await copyThrough(released);

    expect(after.pipeToClipboard).toHaveBeenCalledWith(expect.any(String), text);
    expect(after.notices).toEqual([`Copied ${text.split('\n').length} lines.`]);

    // The notice is kept at the tail, reachable with pgdn, but the viewport
    // must not have moved.
    expect(messagesOf(after.state).at(-1)?.text).toBe(`Copied ${text.split('\n').length} lines.`);
    expect(chatScrollMax(after.state)).toBeGreaterThan(chatScrollMax(back));
    expect(after.state.scroll).toBeGreaterThan(12);
    expect(painted(after.state)).toBe(before);
  });

  it('keeps the viewport on the same lines down the OSC 52 fallback path', async () => {
    const back = { ...history(), scroll: 12 };
    const before = painted(back);
    const released = drag(back, [1, 3], [60, 6]);

    const after = await copyThrough(released, { hasBin: () => false });

    expect(after.pipeToClipboard).not.toHaveBeenCalled();
    // ESC ] 52 ; c ; <base64> BEL — the terminal's own clipboard channel.
    expect(after.writeTerminal).toHaveBeenCalled();
    expect(String(after.writeTerminal.mock.calls[0]?.[0])).toContain(']52;c;');
    expect(after.notices).toHaveLength(1);
    expect(after.notices[0]).toMatch(/through the terminal/);
    expect(after.state.scroll).toBeGreaterThan(12);
    expect(painted(after.state)).toBe(before);
  });

  it('keeps the chat viewport when the copied text came from the plan pane', async () => {
    const back = history({ scroll: 12, tasks: PLAN_TASKS });
    const before = painted(back);
    const released = drag(back, [45, 6], [78, 9]);

    expect(copiedText(released.effects)).toContain('PLANTASK');
    const after = await copyThrough(released);

    expect(after.state.scroll).toBeGreaterThan(12);
    expect(painted(after.state)).toBe(before);
  });

  it('keeps the task log viewport when the copy came from the runner log', async () => {
    const back = taskLogOpen(15);
    expect(chatScrollMax(back), 'the log must overflow for this to mean anything').toBeGreaterThan(15);
    const before = painted(back);
    const released = drag(back, [1, 3], [60, 6]);

    expect(copiedText(released.effects)).toContain('runner line');
    const after = await copyThrough(released);

    // The count is still recorded, even though the task view paints the runner
    // log rather than the conversation the notice is added to.
    expect(messagesOf(after.state).at(-1)?.text).toMatch(/^Copied \d+ lines?\.$/);
    // The task view paints the runner log, not the conversation the notice
    // joins, so its content — and its offset — need not grow at all.
    expect(after.state.scroll).toBe(15);
    expect(painted(after.state)).toBe(before);
  });
});

describe('a copy while the reader is already at the tail', () => {
  it('stays pinned to the tail and shows the count', async () => {
    const tail = history({ scroll: 0 });
    const released = drag(tail, [1, 3], [60, 6]);

    const after = await copyThrough(released);

    expect(after.state.scroll).toBe(0);
    expect(painted(after.state)).toContain('Copied');
  });
});

describe('the release itself', () => {
  it('does not scroll either pane; only the notice that follows can', () => {
    const back = history({ scroll: 12, tasks: PLAN_TASKS });
    const before = painted(back);

    const chatRelease = drag(back, [1, 3], [40, 6]);
    expect(chatRelease.state.scroll).toBe(12);
    expect(painted(chatRelease.state)).toBe(before);

    const planRelease = drag(back, [45, 6], [78, 9]);
    expect(planRelease.state.scroll).toBe(12);
    expect(painted(planRelease.state)).toBe(before);
    expect(planRelease.state.planScroll).toBe(back.planScroll);
  });
});

describe('notices that are not a copy', () => {
  it('still bring the pane to the tail, as they did before', () => {
    const { state } = reduce({ ...history(), scroll: 12 }, { type: 'notice', message: 'done' });
    expect(state.scroll).toBe(0);
  });
});
