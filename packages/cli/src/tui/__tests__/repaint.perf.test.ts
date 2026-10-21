import { describe, it } from 'vitest';
import { monitorEventLoopDelay } from 'perf_hooks';
import type { MessageBlock } from '@ordewell/core';
import { createApp } from '../app';
import { initialState, type TuiState, type TaskView } from '../state';
import type { Action } from '../reducers/shared';

const yieldMacrotask = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

function task(id: string, order: number): TaskView {
  return {
    id, order, title: `Task ${order}: make the ${id} route handle a long and winding request`, type: 'ai',
    status: 'in_progress', dependencies: [], assignedRunner: 'claude-code', taskMode: 'acceptEdits',
    assignedModel: { modelId: 'claude-sonnet-4', modelLabel: 'Claude Sonnet 4' },
  };
}

/** The transcript a long run leaves: enough blocks that re-drawing all of them is visible. */
function longConversation(): TuiState['conversation'] {
  const blocks: MessageBlock[] = Array.from({ length: 300 }, (_, i) => ({
    type: 'message',
    id: `b${i + 1}`,
    role: i % 3 === 0 ? 'user' : 'planner',
    text: `Message ${i + 1}: ${'the planner is working through a long plan and its reply keeps growing. '.repeat(3)}`,
    streaming: false,
  }));
  return { blocks, nextId: blocks.length + 1 };
}

function harness(state: TuiState) {
  const frames: { rows: number; bytes: number; at: number }[] = [];
  let lastDispatch = 0;
  let blocked = 0;
  const app = createApp({
    initial: state,
    draw: (frame) => {
      const at = performance.now();
      blocked += at - lastDispatch;
      frames.push({ rows: frame.length, bytes: frame.reduce((n, row) => n + row.length, 0), at });
    },
    perform: async () => {},
    onExit: () => {},
  });
  return {
    app,
    frames,
    dispatch(action: Action) {
      lastDispatch = performance.now();
      app.dispatch(action);
    },
    blocked: () => blocked,
  };
}

describe('repaint measurement', () => {
  it('measures the flood and the huge block', async () => {
    const h = harness(initialState({
      rows: 50, cols: 200, sessionId: 's1', status: 'executing', focus: 'plan',
      tasks: Array.from({ length: 6 }, (_, i) => task(`t${i + 1}`, i + 1)),
      conversation: longConversation(),
    }));
    h.app.start();
    await yieldMacrotask();

    const started = performance.now();
    const flood: Action[] = [];
    for (let i = 0; i < 400; i++) {
      if (i % 4 === 0) {
        flood.push({ type: 'sessionMessage', sessionId: 's1', message: { type: 'planner_text_delta', turnId: 'turn', segmentId: 'seg', text: `token ${i} ` } });
      } else if (i % 4 === 1) {
        flood.push({ type: 'statusUpdate', sessionId: 's1', tasks: Array.from({ length: 6 }, (_, n) => ({ id: `t${n + 1}`, status: 'in_progress', verdict: null })) });
      } else if (i % 4 === 2) {
        flood.push({ type: 'taskLog', sessionId: 's1', taskId: 't1', attempt: 1, events: [{ type: 'text_delta', text: `step ${i}\n` }] });
      } else {
        flood.push({ type: 'spinnerTick' });
      }
    }
    for (const action of flood) {
      h.dispatch(action);
      await yieldMacrotask();
    }
    const floodMs = performance.now() - started;
    const floodFrames = h.frames.length;

    // Open the task view, then deliver one multi-megabyte test run at once.
    h.dispatch({ type: 'taskViewRequested', sessionId: 's1', taskId: 't1' });
    await yieldMacrotask();
    h.dispatch({ type: 'taskLogLoaded', sessionId: 's1', taskId: 't1', attempt: 1, events: [] });
    await yieldMacrotask();
    h.dispatch({ type: 'taskLog', sessionId: 's1', taskId: 't1', attempt: 1, events: [{ type: 'turn_start', message: 'Run the tests.' }] });
    await yieldMacrotask();
    h.dispatch({ type: 'taskLog', sessionId: 's1', taskId: 't1', attempt: 1, events: [{ type: 'command', name: 'npm', args: 'test' }] });
    await yieldMacrotask();

    const huge = Array.from({ length: 80_000 }, (_, i) => `  ✓ test case ${i} passes in the integration suite`).join('\n');
    const delay = monitorEventLoopDelay({ resolution: 5 });
    delay.enable();
    const beforeFrames = h.frames.length;
    const hugeStart = performance.now();
    h.dispatch({ type: 'taskLog', sessionId: 's1', taskId: 't1', attempt: 1, events: [{ type: 'command_output', text: huge }] });
    await yieldMacrotask();
    const hugeMs = performance.now() - hugeStart;
    delay.disable();
    const hugeFrames = h.frames.length - beforeFrames;

    console.log(JSON.stringify({
      floodActions: flood.length,
      floodMs: Math.round(floodMs),
      floodFrames,
      framesPerSecond: Math.round((floodFrames / floodMs) * 1000),
      floodBlockedMs: Math.round(h.blocked()),
      hugeBytes: huge.length,
      hugeMs: Math.round(hugeMs),
      hugeFrames,
      hugeMaxDelayMs: Math.round(delay.max / 1e6),
      hugeP99DelayMs: Math.round(delay.percentile(99) / 1e6),
    }, null, 2));
  }, 30_000);
});
