import React from 'react';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, fireEvent, act } from '@testing-library/react';
import App from '../App';
import { api, post } from './hostBridge';

const textarea = () => document.querySelector('.chat-input-row textarea') as HTMLTextAreaElement;
const type = (text: string) => fireEvent.change(textarea(), { target: { value: text } });
const press = (key: string) => fireEvent.keyDown(textarea(), { key });
const posted = () => api.postMessage.mock.calls.map(([msg]) => msg as { type: string });

describe('queued prompts', () => {
  beforeEach(() => {
    render(<App />);
    api.postMessage.mockClear();
  });

  it('follows the newly queued prompt into view, not just new conversation blocks', () => {
    post({ type: 'plannerTurn', active: true });
    const list = document.querySelector('.message-list') as HTMLElement;
    let top = 0;
    Object.defineProperty(list, 'scrollHeight', { configurable: true, get: () => 600 });
    Object.defineProperty(list, 'scrollTop', { configurable: true, get: () => top, set: (v: number) => { top = v; } });

    post({ type: 'heldPrompts', prompts: ['also cover caching'] });

    expect(top).toBe(600);
  });

  it('holds a prompt typed while the planner answers, and draws it as queued rather than sent', () => {
    post({ type: 'plannerTurn', active: true });

    expect(textarea().disabled).toBe(false);
    type('also cover caching');
    press('Enter');

    expect(api.postMessage).toHaveBeenCalledWith({ type: 'holdPrompt', text: 'also cover caching' });
    expect(posted().some((m) => m.type === 'sendMessage')).toBe(false);
    expect(textarea().value).toBe('');

    post({ type: 'heldPrompts', prompts: ['also cover caching'] });

    const items = [...document.querySelectorAll('.conversation-queued .queued-prompt')];
    expect(items).toHaveLength(1);
    expect(items[0].textContent).toContain('also cover caching');
    expect(items[0].textContent).toContain('queued');
    expect(document.querySelector('.chat-msg-user')).toBeNull();
  });

  it('takes the newest back with its ×, above the draft, and planning keeps going', () => {
    post({ type: 'plannerTurn', active: true });
    post({ type: 'heldPrompts', prompts: ['one', 'two'] });
    type('half a thought');

    const unsend = document.querySelectorAll('.queued-prompt-unsend');
    expect(unsend).toHaveLength(1);
    fireEvent.click(unsend[0]);

    expect(api.postMessage).toHaveBeenCalledWith({ type: 'unsendPrompt' });
    // The host answers with what it really took back.
    post({ type: 'promptUnsent', text: 'two' });
    post({ type: 'heldPrompts', prompts: ['one'] });

    expect(textarea().value).toBe('two\nhalf a thought');
    expect(document.querySelectorAll('.queued-prompt')).toHaveLength(1);
    expect(posted().some((m) => m.type === 'stopResearch')).toBe(false);
    expect(document.querySelector('.chat-msg-working')).not.toBeNull();
  });

  it('takes the newest back on Esc while something is queued, instead of arming a stop', () => {
    post({ type: 'plannerTurn', active: true });
    post({ type: 'heldPrompts', prompts: ['one'] });
    type('draft');

    press('Escape');

    expect(api.postMessage).toHaveBeenCalledWith({ type: 'unsendPrompt' });
    expect(textarea().value).toBe('draft');
    expect(document.querySelector('.stop-hint')).toBeNull();
    expect(posted().some((m) => m.type === 'stopResearch')).toBe(false);
  });

  describe('double Esc', () => {
    afterEach(() => vi.useRealTimers());

    it('warns on the first Esc and stops the turn on the second, keeping the draft', () => {
      post({ type: 'plannerTurn', active: true });
      type('draft');

      press('Escape');

      expect(document.querySelector('.stop-hint')?.textContent).toBe('Press Esc again to stop');
      expect(posted().some((m) => m.type === 'stopResearch')).toBe(false);
      expect(textarea().value).toBe('draft');

      press('Escape');

      expect(api.postMessage).toHaveBeenCalledWith({ type: 'stopResearch' });
      expect(document.querySelector('.stop-hint')).toBeNull();
      expect(textarea().value).toBe('draft');
    });

    it('lets the warning lapse, so a later Esc only warns again', () => {
      vi.useFakeTimers();
      post({ type: 'plannerTurn', active: true });

      press('Escape');
      act(() => { vi.advanceTimersByTime(2_500); });

      expect(document.querySelector('.stop-hint')).toBeNull();
      press('Escape');
      expect(posted().some((m) => m.type === 'stopResearch')).toBe(false);
      expect(document.querySelector('.stop-hint')).not.toBeNull();
    });
  });

  it('clears the input on Esc outside a turn, with nothing to stop or unsend', () => {
    type('never mind');

    press('Escape');

    expect(textarea().value).toBe('');
    expect(document.querySelector('.stop-hint')).toBeNull();
    expect(posted()).toEqual([]);
  });

  it('names the keys that stop a turn on the stop button', () => {
    post({ type: 'plannerTurn', active: true });

    expect(document.querySelector('.send-btn')?.getAttribute('title')).toBe('Stop (Esc Esc)');
  });

  it('offers Send now on each held row, and posts that row\'s position', () => {
    post({ type: 'plannerTurn', active: true });
    post({ type: 'heldPrompts', prompts: ['one', 'two'] });

    const buttons = [...document.querySelectorAll('.queued-prompt-now')];
    expect(buttons).toHaveLength(2);
    fireEvent.click(buttons[1]);

    expect(api.postMessage).toHaveBeenCalledWith({ type: 'sendHeldPromptNow', index: 1 });
  });

  it('shows a Send now beside the composer while a turn runs, and it force sends the typed text', () => {
    post({ type: 'plannerTurn', active: true });
    type('stop, use Postgres');

    const sendNow = document.querySelector('.chat-input-send-now');
    expect(sendNow).toBeTruthy();
    fireEvent.click(sendNow!);

    expect(api.postMessage).toHaveBeenCalledWith({ type: 'sendMessageNow', text: 'stop, use Postgres' });
    expect(textarea().value).toBe('');
  });

  it('sends now on Ctrl+Enter', () => {
    post({ type: 'plannerTurn', active: true });
    type('stop, use Postgres');

    fireEvent.keyDown(textarea(), { key: 'Enter', ctrlKey: true });

    expect(api.postMessage).toHaveBeenCalledWith({ type: 'sendMessageNow', text: 'stop, use Postgres' });
  });

  it('has no Send now button outside a turn', () => {
    type('a normal message');
    expect(document.querySelector('.chat-input-send-now')).toBeNull();
  });

  it('sends nothing on Enter with an empty input mid-turn', () => {
    post({ type: 'plannerTurn', active: true });

    press('Enter');

    expect(posted()).toEqual([]);
  });
});
