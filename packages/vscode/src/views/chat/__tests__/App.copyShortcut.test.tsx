import React from 'react';
import { describe, it, expect, beforeEach } from 'vitest';
import { render, fireEvent } from '@testing-library/react';
import type { SessionMessage } from '@ordewell/core';
import App from '../App';
import { api, hostBridge, post } from './hostBridge';

/*
 * jsdom has no OS clipboard and no VS Code webview host, so these tests cannot
 * prove a native Cmd+C reaches the clipboard. They cover the half Ordewell
 * owns: no handler of ours swallows a copy chord, moves focus, or replaces the
 * DOM a selection is anchored in.
 */

const TURN = 'turn-1';
const turnStarted = (prompt: string): SessionMessage => ({ type: 'planner_turn_started', turnId: TURN, prompt });
const delta = (text: string): SessionMessage => ({ type: 'planner_text_delta', turnId: TURN, segmentId: 's1', text });
const reply = (content: string): SessionMessage => ({ type: 'planner_message', content, timestamp: '', turnId: TURN });
const turnEnded = (): SessionMessage => ({ type: 'planner_turn_ended', turnId: TURN, outcome: 'message' });

const textarea = () => document.querySelector('.chat-input-row textarea') as HTMLTextAreaElement;
const plannerText = () => document.querySelector('.chat-msg-planner .chat-msg-content') as HTMLElement;
const codeText = () => plannerText().querySelector('code')!.firstChild as Text;

const selected = () => window.getSelection()?.toString() ?? '';

function select(node: Node, start = 0, end = node.textContent?.length ?? 0): string {
  const range = document.createRange();
  range.setStart(node, start);
  range.setEnd(node, end);
  const selection = window.getSelection()!;
  selection.removeAllRanges();
  selection.addRange(range);
  return selection.toString();
}

const COPY_CHORDS = [
  ['Cmd+C (macOS)', { key: 'c', code: 'KeyC', metaKey: true }],
  ['Ctrl+C (Windows/Linux)', { key: 'c', code: 'KeyC', ctrlKey: true }],
] as const;

describe('copy chords in the planner chat', () => {
  let host: ReturnType<typeof hostBridge>;

  beforeEach(() => {
    render(<App />);
    host = hostBridge();
    host.session(turnStarted('how do I run the tests?'), delta('Run `npm test` before you commit.'), reply('Run `npm test` before you commit.'), turnEnded());
    api.postMessage.mockClear();
  });

  it.each(COPY_CHORDS)('%s leaves a transcript selection to the browser: not prevented, no focus move, nothing posted', (_name, init) => {
    expect(select(codeText())).toBe('npm test');
    const active = document.activeElement;

    const notPrevented = fireEvent.keyDown(plannerText(), init);
    fireEvent.keyUp(plannerText(), init);

    expect(notPrevented).toBe(true);
    expect(selected()).toBe('npm test');
    expect(document.activeElement).toBe(active);
    expect(api.postMessage.mock.calls).toEqual([]);
  });

  it.each(COPY_CHORDS)('%s in the composer keeps the typed selection and its focus', (_name, init) => {
    fireEvent.change(textarea(), { target: { value: 'hello world' } });
    textarea().focus();
    textarea().setSelectionRange(0, 5);

    const notPrevented = fireEvent.keyDown(textarea(), init);

    expect(notPrevented).toBe(true);
    expect(document.activeElement).toBe(textarea());
    expect([textarea().selectionStart, textarea().selectionEnd]).toEqual([0, 5]);
    expect(textarea().value).toBe('hello world');
    expect(api.postMessage.mock.calls).toEqual([]);
  });

  it('does not prevent the copy, cut or paste events themselves', () => {
    expect(select(codeText())).toBe('npm test');

    expect(fireEvent.copy(plannerText())).toBe(true);
    expect(fireEvent.cut(textarea())).toBe(true);
    expect(fireEvent.paste(textarea())).toBe(true);
    expect(selected()).toBe('npm test');
  });
});

describe('selection retention in the planner chat', () => {
  let host: ReturnType<typeof hostBridge>;

  beforeEach(() => {
    render(<App />);
    host = hostBridge();
  });

  it('keeps a selection in a settled reply when another reply streams', () => {
    host.session(turnStarted('how do I run the tests?'), delta('Run `npm test` before you commit.'), reply('Run `npm test` before you commit.'), turnEnded());
    expect(select(codeText())).toBe('npm test');
    const active = document.activeElement;

    host.session(turnStarted('and then?'), delta('Then open the pull request.'));
    host.session(delta(' Then wait for CI.'));

    expect(selected()).toBe('npm test');
    expect(document.activeElement).toBe(active);
  });

  it('keeps the exact selection inside a streaming reply when the next delta arrives', () => {
    host.session(turnStarted('how do I run the tests?'), delta('Run `npm test` before you commit.'));
    expect(select(codeText())).toBe('npm test');
    const active = document.activeElement;

    host.session(delta(' Then open the pull request.'));

    expect(selected()).toBe('npm test');
    expect(document.activeElement).toBe(active);
    expect(plannerText().textContent).toContain('Then open the pull request.');
  });

  it('keeps a backward selection inside a streaming reply when the next delta arrives', () => {
    host.session(turnStarted('how do I run the tests?'), delta('Run `npm test` before you commit.'));
    const code = codeText();
    const selection = window.getSelection()!;
    selection.setBaseAndExtent(code, 8, code, 0);
    expect(selection.toString()).toBe('npm test');
    expect(selection.anchorOffset).toBe(8);
    const active = document.activeElement;

    host.session(delta(' Then open the pull request.'));

    expect(selected()).toBe('npm test');
    expect(window.getSelection()?.anchorOffset).toBe(8);
    expect(document.activeElement).toBe(active);
  });

  it('keeps a selection inside a streaming reply when it settles into the final message', () => {
    host.session(turnStarted('how do I run the tests?'), delta('Run `npm test` before you commit.'));
    expect(select(codeText())).toBe('npm test');
    const active = document.activeElement;

    host.session(reply('Run `npm test` before you commit.'), turnEnded());

    expect(selected()).toBe('npm test');
    expect(document.activeElement).toBe(active);
  });

  it('keeps a selection through host messages that do not touch the conversation', () => {
    host.session(turnStarted('how do I run the tests?'), delta('Run `npm test` before you commit.'), reply('Run `npm test` before you commit.'), turnEnded());
    expect(select(codeText())).toBe('npm test');

    post({ type: 'plannerLiveness' });
    post({ type: 'taskOutput', taskId: 't1', text: 'building…' });

    expect(selected()).toBe('npm test');
  });
});
