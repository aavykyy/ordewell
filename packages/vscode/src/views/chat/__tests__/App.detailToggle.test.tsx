import React from 'react';
import { describe, it, expect, beforeEach } from 'vitest';
import { render, fireEvent } from '@testing-library/react';
import type { ResearchStep, SessionMessage } from '@ordewell/core';
import App from '../App';
import { hostBridge, post } from './hostBridge';

const TURN = 'turn-1';
const turnStarted = (prompt?: string): SessionMessage => ({ type: 'planner_turn_started', turnId: TURN, ...(prompt ? { prompt } : {}) });
const thought = (text: string): SessionMessage => ({ type: 'planner_thinking_delta', turnId: TURN, text });
const call: SessionMessage = { type: 'research_step', tool: 'read_file', args: '{"path":"a.ts"}', toolCallId: 'tc-1', turnId: TURN };
const done: SessionMessage = {
  type: 'research_step_done', turnId: TURN,
  step: { id: 's', tool: 'read_file', args: '{"path":"a.ts"}', result: 'a body', timestamp: '', success: true, outcome: 'success', toolCallId: 'tc-1' } as ResearchStep,
};

const group = () => document.querySelector('.activity-group-toggle') as HTMLButtonElement;
const row = (selector: string) => document.querySelector(`${selector} button[aria-expanded]`) as HTMLButtonElement;

describe('activity disclosures in the planner chat (ADR-0017, X1)', () => {
  let host: ReturnType<typeof hostBridge>;
  beforeEach(() => {
    render(<App />);
    host = hostBridge();
  });

  it('has no expand-all control and no header reserved for one', () => {
    host.session(turnStarted('look around'), thought('Scanning…'), call, done);
    expect(document.querySelector('.chat-header')).toBeNull();
    expect(document.querySelector('.detail-toggle')).toBeNull();
    expect([...document.querySelectorAll('button')].some((b) => /expand all|collapse all/i.test(b.textContent ?? ''))).toBe(false);
  });

  it('folds a turn\'s thinking and calls into one line, opened a level at a time', () => {
    host.session(turnStarted('look around'), thought('Scanning…'), call);
    expect(group().textContent).toBe('Reading a file');
    host.session(done);
    expect(group().textContent).toBe('Read a file');
    expect(document.querySelector('.cmd-row')).toBeNull();

    fireEvent.click(group());
    expect(document.querySelector('.activity-think-line')!.textContent).toBe('Scanning…');
    expect(document.querySelector('.cmd-row-preview')!.textContent).toBe('a body');
    expect(document.querySelector('.activity-think-pre')).toBeNull();
    expect(document.querySelector('.cmd-row-output')).toBeNull();

    fireEvent.click(row('.cmd-row'));
    expect(document.querySelector('.cmd-row-output')!.textContent).toBe('a body');
    expect(document.querySelector('.activity-think-pre')).toBeNull();

    fireEvent.click(row('.activity-think'));
    expect(document.querySelector('.activity-think-pre')!.textContent).toBe('Scanning…');
  });

  it('keeps the planner\'s reply out of the group, between the calls it narrates', () => {
    host.session(turnStarted('look around'), call, done, { type: 'planner_message', content: 'Hello.', timestamp: '', turnId: TURN });
    expect([...document.querySelectorAll('.conversation > *')].map((el) => el.className.split(' ')[0])).toEqual(['chat-msg', 'activity-group', 'chat-msg']);
  });

  it('starts a new session with nothing open, though its blocks reuse the old ids', () => {
    host.session(turnStarted('look around'), call, done);
    fireEvent.click(group());
    fireEvent.click(row('.cmd-row'));
    expect(document.querySelector('.cmd-row-output')).toBeTruthy();

    host.provider.conversation.reset();
    post({ type: 'setState', state: 'empty' });
    host.session(turnStarted('again'), call, done);
    expect(group().getAttribute('aria-expanded')).toBe('false');
    expect(document.querySelector('.cmd-row')).toBeNull();
  });

  it('rebuilds a reloaded session collapsed, from its saved blocks', () => {
    host.session(turnStarted('look around'), call, done);
    fireEvent.click(group());
    host.provider.restoreChat({
      conversationHistory: [{ role: 'user', content: 'saved goal', timestamp: '2026-01-01T00:00:00.000Z' }],
      researchLog: [{ id: 's', tool: 'read_file', args: '{"path":"b.ts"}', result: 'b body', timestamp: '2026-01-01T00:00:01.000Z', success: true, outcome: 'success' }],
      plannerUsage: { totals: {} },
    });
    expect(group().textContent).toBe('Read a file');
    expect(group().getAttribute('aria-expanded')).toBe('false');
  });

  it('opens nothing in a conversation rebuilt in place, though its blocks reuse the old ids', () => {
    const saved = (goal: string, path: string) => ({
      conversationHistory: [{ role: 'user' as const, content: goal, timestamp: '2026-01-01T00:00:00.000Z' }],
      researchLog: [{ id: 's', tool: 'read_file' as const, args: JSON.stringify({ path }), result: `${path} body`, timestamp: '2026-01-01T00:00:01.000Z', success: true, outcome: 'success' as const }],
      plannerUsage: { totals: {} },
    });
    host.provider.restoreChat(saved('the goal', 'a.ts'));
    fireEvent.click(group());
    fireEvent.click(row('.cmd-row'));
    expect(document.querySelector('.cmd-row-output')!.textContent).toBe('a.ts body');

    // A reload the host makes without a restore: another conversation, numbered afresh. (A compaction no
    // longer rebuilds anything: it folds in where it happened, so what was open stays open.)
    host.provider.conversation.reload(saved('Another conversation', 'b.ts'));
    expect(document.querySelector('.chat-msg-user')!.textContent).toBe('Another conversation');
    expect(group().getAttribute('aria-expanded')).toBe('false');
    expect(document.querySelector('.cmd-row')).toBeNull();
  });
});
