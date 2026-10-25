import React from 'react';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, act, fireEvent } from '@testing-library/react';
import type { ResearchStep, SessionMessage } from '@ordewell/core';
import App from '../App';
import { api, hostBridge } from './hostBridge';

/*
 * While a planner turn is open the chat must show animated activity, however
 * quiet the model is on screen. A harness planner (Claude Code) relays its
 * thinking as a stream, then generates a tool's whole input without any event
 * until the call lands; the thinking block stays "streaming" for that stretch
 * and the working row hides behind it. Driven through the real
 * ChatViewProvider/ConversationViewHost into the mounted App, with the session
 * events such a turn emits.
 */
const TURN = 'turn-wake';
const wakeUpStarted: SessionMessage = {
  type: 'planner_turn_started', turnId: TURN, prompt: '', wakeUps: ['Task #3 limits-opencode-research finished.'], supervisor: true,
};
const userStarted: SessionMessage = { type: 'planner_turn_started', turnId: TURN, prompt: 'what did the research find?' };
const turnEnded: SessionMessage = { type: 'planner_turn_ended', turnId: TURN, outcome: 'message' };
const readCall: SessionMessage = {
  type: 'research_step', tool: 'task_output', args: JSON.stringify({ task: 'limits-opencode-research' }), toolCallId: 'tu-1', turnId: TURN,
};
// The tool result size the report showed: a long task_output.
const LONG_REPORT = `${'x'.repeat(31_235 - 40)}\n[... truncated, total 31235 chars]`;
const readDone: SessionMessage = {
  type: 'research_step_done', turnId: TURN,
  step: { id: 'rs-1', tool: 'task_output', args: JSON.stringify({ task: 'limits-opencode-research' }), result: LONG_REPORT, success: true, outcome: 'success', toolCallId: 'tu-1', timestamp: '' } as ResearchStep,
};
// The complete `thinking` line that follows the deltas is suppressed (CliAgentAiService).
const thought: SessionMessage = { type: 'planner_thinking_delta', turnId: TURN, text: 'The report says OAuth works; now I will revise the plan.' };
const text: SessionMessage = { type: 'planner_text_delta', turnId: TURN, segmentId: 's1', text: 'Reading the research output.' };
const nextCall: SessionMessage = { ...readCall, toolCallId: 'tu-2' } as SessionMessage;
// Untagged: it names no turn, so it can never say which one it belongs to.
const liveness: SessionMessage = { type: 'planner_liveness' };

const PLACEHOLDER_BUSY = 'Queue a message for when the planner is done...';
const textarea = () => document.querySelector('.chat-input-row textarea') as HTMLTextAreaElement;
/** The composer's Stop button: App passes isResearchActive as isTurnRunning. */
const busy = () => document.querySelector('.send-btn.processing') !== null;
/**
 * Any animated planner-activity element the chat draws: the working row, its
 * spinner, the text cursor (styles.css: chat-spin, chat-cursor-blink). A fix
 * that animates the thinking block or the footer instead adds its hook here.
 */
const animated = () => document.querySelector(
  '.chat-msg-working, .chat-msg-spinner, .chat-msg-cursor, [data-planner-activity="animated"]',
) !== null;
const state = () => ({ busy: busy(), animated: animated() });
const ACTIVE = { busy: true, animated: true };
const IDLE = { busy: false, animated: false };

describe('planner activity while a turn is open', () => {
  let host: ReturnType<typeof hostBridge>;
  beforeEach(() => {
    render(<App />);
    host = hostBridge();
    api.postMessage.mockClear();
  });

  it('control: a wake-up turn reading a long task_output, then silence, is animated', () => {
    host.session(wakeUpStarted, readCall, readDone, liveness, liveness);

    expect(state()).toEqual(ACTIVE);
  });

  it('H1: a wake-up turn, long task_output, thinking, then only liveness stays animated', () => {
    host.session(wakeUpStarted, readCall, readDone, thought, liveness, liveness);

    expect(busy()).toBe(true);
    expect(textarea().placeholder).toBe(PLACEHOLDER_BUSY);
    expect(animated()).toBe(true);
  });

  it('H1: a user turn with narration, a read, thinking, then silence stays animated', () => {
    host.session(userStarted, text, readCall, readDone, thought, liveness);

    expect(state()).toEqual(ACTIVE);
  });

  it('H1 minimal: a turn start and one thinking delta stay animated', () => {
    host.session(wakeUpStarted, thought);

    expect(busy()).toBe(true);
    expect(textarea().placeholder).toBe(PLACEHOLDER_BUSY);
    expect(animated()).toBe(true);
  });

  it('H1: more thinking deltas keep the turn animated', () => {
    host.session(userStarted, thought, thought, liveness, thought);

    expect(state()).toEqual(ACTIVE);
  });

  it('control: a tool call after the thinking is animated', () => {
    host.session(wakeUpStarted, thought, readCall);

    expect(state()).toEqual(ACTIVE);
  });

  it('control: streaming text then silence is animated', () => {
    host.session(userStarted, readCall, readDone, text, liveness);

    expect(state()).toEqual(ACTIVE);
  });

  it('the working row is pinned outside the scrolling conversation', () => {
    host.session(wakeUpStarted, thought);

    const row = document.querySelector('.chat-msg-working');
    expect(row).not.toBeNull();
    expect(row!.closest('.message-list')).toBeNull();
    expect(document.querySelectorAll('.chat-msg-spinner')).toHaveLength(1);
  });

  it('control: a webview resync mid-turn re-announces the open turn', () => {
    host.session(wakeUpStarted, readCall, readDone);
    host.provider.conversation.resync();

    expect(state()).toEqual(ACTIVE);
  });
});

describe('planner activity after the turn is over', () => {
  let host: ReturnType<typeof hostBridge>;
  beforeEach(() => {
    render(<App />);
    host = hostBridge();
    api.postMessage.mockClear();
  });

  it('control: no turn and only liveness shows nothing', () => {
    host.session(liveness, liveness);

    expect(state()).toEqual(IDLE);
  });

  it('control: the turn ending after thinking clears every indicator', () => {
    host.session(wakeUpStarted, readCall, readDone, thought, turnEnded);

    expect(state()).toEqual(IDLE);
  });

  it('control: late liveness and late events of an ended turn do not reactivate it', () => {
    host.session(wakeUpStarted, readCall, readDone, thought, turnEnded);
    host.session(liveness, thought, nextCall, liveness);

    expect(state()).toEqual(IDLE);
  });

  it('control: the user stopping a thinking turn clears every indicator', () => {
    host.session(wakeUpStarted, thought);
    act(() => { fireEvent.click(document.querySelector('.send-btn.processing') as Element); });
    host.provider.conversation.stop();

    expect(api.postMessage).toHaveBeenCalledWith({ type: 'stopResearch' });
    expect(state()).toEqual(IDLE);
  });

  it('control: untagged late liveness alone does not re-lock a turn the user stopped', () => {
    host.session(wakeUpStarted, thought);
    act(() => { fireEvent.click(document.querySelector('.send-btn.processing') as Element); });
    host.provider.conversation.stop();
    host.session(liveness, liveness);

    expect(state()).toEqual(IDLE);
  });

  it('control: a stopped turn still unwinding does not reactivate on its late events', () => {
    host.session(userStarted, readCall, readDone, thought);
    act(() => { fireEvent.click(document.querySelector('.send-btn.processing') as Element); });
    host.provider.conversation.stop();
    host.session(liveness, thought, nextCall, liveness);

    expect(state()).toEqual(IDLE);
  });

  it('control: a turn replaced by a new session does not reactivate on its late events', () => {
    host.session(wakeUpStarted, readCall, readDone, thought);
    host.provider.setState('empty');
    host.provider.conversation.reset();
    host.session(liveness, thought, nextCall, liveness);

    expect(state()).toEqual(IDLE);
  });

  it('H1: a new turn after a stopped one, once it thinks, is animated again', () => {
    host.session(wakeUpStarted, thought);
    act(() => { fireEvent.click(document.querySelector('.send-btn.processing') as Element); });
    host.provider.conversation.stop();
    host.session({ ...userStarted, turnId: 'turn-2' }, { ...thought, turnId: 'turn-2' } as SessionMessage);

    expect(state()).toEqual(ACTIVE);
  });
});

describe('planner activity across the watchdog threshold', () => {
  let host: ReturnType<typeof hostBridge>;
  beforeEach(() => {
    vi.useFakeTimers();
    render(<App />);
    host = hostBridge();
    api.postMessage.mockClear();
  });
  afterEach(() => vi.useRealTimers());
  const wait = (ms: number) => act(() => { vi.advanceTimersByTime(ms); });
  const stoppedResponding = { type: 'addNote', text: expect.stringContaining('stopped responding') };

  it('control: liveness across the 120s threshold keeps the turn animated', () => {
    host.session(wakeUpStarted, readCall, readDone);
    for (let i = 0; i < 6; i++) {
      wait(30_000);
      host.session(liveness);
    }

    expect(api.postMessage).not.toHaveBeenCalledWith(stoppedResponding);
    expect(state()).toEqual(ACTIVE);
  });

  it('H1: liveness across the 120s threshold after thinking keeps the turn animated', () => {
    host.session(wakeUpStarted, readCall, readDone, thought);
    for (let i = 0; i < 6; i++) {
      wait(30_000);
      host.session(liveness);
    }

    expect(api.postMessage).not.toHaveBeenCalledWith(stoppedResponding);
    expect(state()).toEqual(ACTIVE);
  });

  it('H2: fresh activity of the still-open turn after the watchdog fired restores the indicator', () => {
    host.session(wakeUpStarted, readCall);
    wait(125_000);
    expect(api.postMessage).toHaveBeenCalledWith(stoppedResponding);
    expect(busy()).toBe(false);

    // The same turn goes on: its result and a further read. No planner_turn_ended was sent.
    host.session(readDone, nextCall);

    expect(state()).toEqual(ACTIVE);
  });

  it('control: untagged liveness after the watchdog fired leaves the input free', () => {
    host.session(wakeUpStarted, readCall);
    wait(125_000);
    host.session(liveness, liveness);

    expect(state()).toEqual(IDLE);
  });

  it('control: the restored turn ending clears the indicator again', () => {
    host.session(wakeUpStarted, readCall);
    wait(125_000);
    host.session(readDone, nextCall, turnEnded);

    expect(state()).toEqual(IDLE);
  });

  it('control: the turn ending after the watchdog fired stays idle through late liveness', () => {
    host.session(wakeUpStarted, readCall);
    wait(125_000);
    host.session(turnEnded);
    host.session(liveness, liveness);

    expect(state()).toEqual(IDLE);
  });

  it('control: a stopped turn after the watchdog fired stays idle through late events', () => {
    host.session(wakeUpStarted, readCall);
    wait(125_000);
    host.provider.conversation.stop();
    host.session(readDone, liveness, nextCall);

    expect(state()).toEqual(IDLE);
  });
});
