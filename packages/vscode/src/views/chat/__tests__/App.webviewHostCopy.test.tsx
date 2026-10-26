import React from 'react';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { render, fireEvent } from '@testing-library/react';
import type { ResearchStep } from '@ordewell/core';
import type { SessionMessage } from '@ordewell/core';
import App from '../App';
import { hostBridge, openActivity, post } from './hostBridge';

/*
 * Regression: Cmd+C / Ctrl+C of a mouse selection in the chat, routed the way
 * VS Code's desktop (Electron) webview routes it.
 *
 * In VS Code the chat is not the top frame. The webview host page
 * (vs/workbench/contrib/webview/browser/pre/index.html) listens for keydown on
 * the chat's window and, on Electron, preventDefaults every copy chord, so
 * Chromium's own copy never runs. It forwards the key to the workbench as
 * `did-keydown`; the workbench's Copy action calls webview.copy(), which posts
 * `execCommand('copy')` back to that page, and the page runs
 * contentDocument.execCommand('copy') on the chat document.
 *
 * installGuest below is that page's code, copied from the VS Code builds in
 * packages/vscode/.vscode-test (1.142.0 and 1.143.1), with contentDocument
 * = this document. The only difference between the two builds' pre/index.html
 * is 1.143's focus restore before execCommand: it refocuses the last-focused
 * element when focus sits on <body>, which here is the composer textarea.
 *
 * What jsdom cannot do, and is modelled here (labelled MODEL), so a pass is not
 * a native VS Code or OS-clipboard result:
 *  - a mousedown's default focus move (Chromium focuses the nearest focusable
 *    ancestor, or else leaves focus on <body>);
 *  - what Chromium's execCommand('copy') writes: the frame selection, which
 *    lives inside a text control while that control is focused.
 * The clipboard is a variable, not the pasteboard. Native verification is a
 * manual step in a VS Code >= 1.143 webview.
 *
 * The contracts are behavioural: the selected text survives to the routed copy
 * and is what gets copied, and the copy does not hand focus to an editable
 * control. They do not say where focus rests instead, so any fix that keeps
 * focus off the composer satisfies them.
 */

type Guest = { detach(): void; workbenchCopies: number };

function installGuest(version: '1.142.0' | '1.143.1'): Guest {
  const contentWindow = window;
  const contentDocument = document;
  const onElectron = true;
  const guest: Guest = { detach: () => {}, workbenchCopies: 0 };

  // pre/index.html (both builds), isCopyPasteOrCut
  function isCopyPasteOrCut(e: KeyboardEvent) {
    const hasMeta = e.ctrlKey || e.metaKey;
    const shiftInsert = e.shiftKey && e.keyCode === 45;
    return (hasMeta && [67, 86, 88].includes(e.keyCode)) || shiftInsert;
  }

  // 1.143.1 pre/index.html:955, 1136-1141
  const lastFocusedElements = new WeakMap<Document, HTMLElement>();
  const onFocusin = () => {
    const focused = contentDocument.activeElement as HTMLElement | null;
    if (focused && focused !== contentDocument.body && focused !== contentDocument.documentElement) {
      lastFocusedElements.set(contentDocument, focused);
    }
  };

  // 1.142.0 pre/index.html:1271-1277; 1.143.1 pre/index.html:1280-1292
  const onExecCommand = (data: string) => {
    if (version === '1.142.0') {
      contentDocument.execCommand(data);
      return;
    }
    const lastFocused = lastFocusedElements.get(contentDocument);
    if ((contentDocument.activeElement === contentDocument.body || contentDocument.activeElement === contentDocument.documentElement)
      && lastFocused?.isConnected && lastFocused.ownerDocument === contentDocument) {
      lastFocused.focus({ preventScroll: true });
    }
    contentDocument.execCommand(data);
  };

  // The workbench end of did-keydown: Cmd+C (macOS) / Ctrl+C (Windows, Linux)
  // resolves to the Copy action, whose webview implementation is
  // `webview.copy()` -> `this._send("execCommand", "copy")`.
  const workbench = (channel: string, data: { keyCode: number; metaKey: boolean; ctrlKey: boolean }) => {
    if (channel === 'did-keydown' && data.keyCode === 67 && (data.metaKey || data.ctrlKey)) {
      guest.workbenchCopies++;
      onExecCommand('copy');
    }
  };

  // pre/index.html:603-623 handleInnerKeydown (the Electron branch)
  const handleInnerKeydown = (e: KeyboardEvent) => {
    if (isCopyPasteOrCut(e)) {
      if (onElectron) e.preventDefault();
      else return;
    }
    workbench('did-keydown', { keyCode: e.keyCode, metaKey: e.metaKey, ctrlKey: e.ctrlKey });
  };

  if (version === '1.143.1') contentWindow.addEventListener('focusin', onFocusin);
  contentWindow.addEventListener('keydown', handleInnerKeydown);
  guest.detach = () => {
    contentWindow.removeEventListener('focusin', onFocusin);
    contentWindow.removeEventListener('keydown', handleInnerKeydown);
  };
  return guest;
}

type CopyObservation = { activeAtCopy: Element | null; selectionAtCopy: string; clipboard?: string };

/** MODEL: what Chromium's execCommand('copy') would put on the clipboard. */
let copyObservations: CopyObservation[];
function installExecCommand() {
  copyObservations = [];
  document.execCommand = ((command: string) => {
    if (command !== 'copy') return false;
    const active = document.activeElement;
    const copied = active instanceof HTMLTextAreaElement || active instanceof HTMLInputElement
      ? active.value.slice(active.selectionStart ?? 0, active.selectionEnd ?? 0)
      : window.getSelection()?.toString() ?? '';
    // jsdom's own document selection: it reports '' once a text control has focus.
    const observation: CopyObservation = { activeAtCopy: active, selectionAtCopy: window.getSelection()?.toString() ?? '' };
    const event = new Event('copy', { bubbles: true, cancelable: true });
    (active ?? document.body).dispatchEvent(event);
    if (!event.defaultPrevented && copied) observation.clipboard = copied;
    copyObservations.push(observation);
    return true;
  }) as typeof document.execCommand;
}

// jsdom has no isContentEditable, so read the attribute.
const isEditable = (el: Element | null): boolean =>
  el instanceof HTMLTextAreaElement || el instanceof HTMLInputElement
  || (el !== null && ['', 'true'].includes(el.closest('[contenteditable]')?.getAttribute('contenteditable') ?? 'false'));

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex], [contenteditable="true"], [contenteditable=""]';

/**
 * A mouse drag over `node`'s text, in browser order: pointerdown, mousedown
 * (then MODEL focus move, unless a handler prevented it), the range,
 * pointerup, mouseup. A handler that moves focus on pointerdown or mousedown
 * therefore runs before the default focus move, as in a browser.
 */
function mouseSelect(node: Node, start = 0, end = node.textContent?.length ?? 0): string {
  const target = (node.nodeType === Node.TEXT_NODE ? node.parentElement : node) as HTMLElement;
  const down = { button: 0, buttons: 1, detail: 1, pointerType: 'mouse' };
  fireEvent.pointerDown(target, down);
  if (fireEvent.mouseDown(target, down)) {
    const focusable = target.closest<HTMLElement>(FOCUSABLE);
    if (focusable) focusable.focus();
    else (document.activeElement as HTMLElement | null)?.blur();
  }
  const range = document.createRange();
  range.setStart(node, start);
  range.setEnd(node, end);
  const selection = window.getSelection()!;
  selection.removeAllRanges();
  selection.addRange(range);
  fireEvent.pointerUp(target, { ...down, buttons: 0 });
  fireEvent.mouseUp(target, { ...down, buttons: 0 });
  return selection.toString();
}

const CHORDS = [
  ['Cmd+C (macOS)', { key: 'c', code: 'KeyC', keyCode: 67, metaKey: true }],
  ['Ctrl+C (Windows/Linux)', { key: 'c', code: 'KeyC', keyCode: 67, ctrlKey: true }],
] as const;

function press(init: (typeof CHORDS)[number][1]): boolean {
  const target = document.activeElement ?? document.body;
  const notPrevented = fireEvent.keyDown(target, init);
  fireEvent.keyUp(target, init);
  return notPrevented;
}

const TURN = 'turn-1';
const turnStarted = (prompt: string, turnId = TURN): SessionMessage => ({ type: 'planner_turn_started', turnId, prompt });
const delta = (text: string, turnId = TURN): SessionMessage => ({ type: 'planner_text_delta', turnId, segmentId: 's1', text });
const reply = (content: string, turnId = TURN): SessionMessage => ({ type: 'planner_message', content, timestamp: '', turnId });
const turnEnded = (turnId = TURN): SessionMessage => ({ type: 'planner_turn_ended', turnId, outcome: 'message' });
const usage = (usedTokens: number, windowTokens: number, turnId = TURN): SessionMessage => ({
  type: 'planner_usage', turnId, totals: { inputTokens: usedTokens }, contextFill: { usedTokens, windowTokens },
});
const step: SessionMessage = { type: 'research_step', tool: 'task_output', args: JSON.stringify({ task: 'build' }), toolCallId: 'tu-1', turnId: TURN };
const stepDone: SessionMessage = {
  type: 'research_step_done', turnId: TURN,
  step: { id: 'rs-1', tool: 'task_output', args: JSON.stringify({ task: 'build' }), result: 'PASS src/a.test.ts', success: true, outcome: 'success', toolCallId: 'tu-1', timestamp: '' } as ResearchStep,
};

const textarea = () => document.querySelector('.chat-input-row textarea') as HTMLTextAreaElement;
const firstText = (el: Element | null): Text => {
  const walker = document.createTreeWalker(el!, NodeFilter.SHOW_TEXT, { acceptNode: (n) => (n.textContent?.trim() ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP) });
  return walker.nextNode() as Text;
};

type Surface = { name: string; setup(host: ReturnType<typeof hostBridge>): void; node(): Node; expected: string };

const SURFACES: Surface[] = [
  {
    name: 'settled planner reply',
    setup: (host) => host.session(turnStarted('how do I run the tests?'), delta('Run the suite before you commit.'), reply('Run the suite before you commit.'), turnEnded()),
    node: () => firstText(document.querySelector('.chat-msg-planner .chat-msg-content p')),
    expected: 'Run the suite before you commit.',
  },
  {
    name: 'streaming planner reply',
    setup: (host) => host.session(turnStarted('how do I run the tests?'), delta('Run the suite before you commit.')),
    node: () => firstText(document.querySelector('.chat-msg-planner .chat-msg-content p')),
    expected: 'Run the suite before you commit.',
  },
  {
    name: 'code in a planner reply',
    setup: (host) => host.session(turnStarted('how do I run the tests?'), reply('Run `npm test` before you commit.'), turnEnded()),
    node: () => document.querySelector('.chat-msg-planner .chat-msg-content code')!.firstChild!,
    expected: 'npm test',
  },
  {
    name: 'user text',
    setup: (host) => host.session(turnStarted('how do I run the tests?'), reply('Run the suite.'), turnEnded()),
    node: () => firstText(document.querySelector('.chat-msg-user .chat-msg-content')),
    expected: 'how do I run the tests?',
  },
  {
    name: 'expanded activity output row',
    setup: (host) => {
      host.session(turnStarted('what did the build say?'), step, stepDone, reply('It passed.'), turnEnded());
      openActivity();
      const toggle = document.querySelector<HTMLButtonElement>('.cmd-row-toggle[aria-expanded="false"]');
      if (toggle) fireEvent.click(toggle);
    },
    node: () => firstText(document.querySelector('.cmd-row-output')),
    expected: 'PASS src/a.test.ts',
  },
  {
    name: "UsageLine footer 'Planner ctx 88k (19%)'",
    setup: (host) => host.session(turnStarted('how do I run the tests?'), usage(88_000, 463_000), reply('Run the suite.'), turnEnded()),
    node: () => document.querySelector('.usage-line-context')!,
    expected: 'Planner ctx 88k (19%)',
  },
];

function selectRange(node: Node): string {
  return node.nodeType === Node.TEXT_NODE ? mouseSelect(node) : mouseSelect(node, 0, node.childNodes.length);
}

describe.each(['1.142.0', '1.143.1'] as const)('VS Code %s webview copy route', (version) => {
  let host: ReturnType<typeof hostBridge>;
  let guest: Guest;

  beforeEach(() => {
    installExecCommand();
    guest = installGuest(version);
    render(<App />);
    host = hostBridge();
  });
  afterEach(() => guest.detach());

  describe.each(SURFACES)('$name', (surface) => {
    it.each(CHORDS)('%s after the composer had focus copies the mouse selection', (_chord, init) => {
      // The reader typed in the composer once (as before any planner reply).
      textarea().focus();
      fireEvent.change(textarea(), { target: { value: '' } });
      surface.setup(host);

      const node = surface.node();
      expect(node, 'surface rendered').toBeTruthy();
      expect(selectRange(node)).toBe(surface.expected);

      const notPrevented = press(init);

      // The route reached the host's copy: Chromium's own copy was suppressed
      // and the workbench replayed exactly one execCommand('copy').
      expect({ nativeCopyPrevented: !notPrevented, workbenchCopies: guest.workbenchCopies, execCommands: copyObservations.length })
        .toEqual({ nativeCopyPrevented: true, workbenchCopies: 1, execCommands: 1 });
      const [copy] = copyObservations;
      // The contract: the copy neither lands in an editable control nor loses the selection.
      expect.soft(isEditable(copy.activeAtCopy), `focus at copy: ${copy.activeAtCopy?.tagName}`).toBe(false);
      expect.soft(copy.selectionAtCopy, 'selection at copy').toBe(surface.expected);
      expect.soft(copy.clipboard, 'clipboard').toBe(surface.expected);
      expect(window.getSelection()?.toString()).toBe(surface.expected);
    });
  });

  it.each(CHORDS)('%s of an account-limit value (a focusable span, tabIndex=0) copies: the control case', (_chord, init) => {
    textarea().focus();
    host.planner([{ id: 'codex', label: 'Codex', kind: 'harness', runner: 'codex', usable: true }], 'codex', 'codex');
    host.provider.setAccountLimits([{
      harness: 'codex', label: 'Codex', status: 'fresh', plan: 'plus',
      buckets: [{ id: 'codex', windows: [{ slot: 'primary', usedPercent: 24, durationMinutes: 300, resetsAt: '2026-03-02T15:00:00.000Z' }] }],
      readAt: '2026-03-02T10:00:00.000Z',
    }]);
    host.session(turnStarted('how do I run the tests?'), usage(88_000, 463_000), reply('Run the suite.'), turnEnded());
    const limit = document.querySelector('.account-limit')!;
    const text = firstText(limit);
    expect(mouseSelect(text)).toBe(text.textContent);

    press(init);

    expect(copyObservations.map((c) => ({ focusInEditable: isEditable(c.activeAtCopy), clipboard: c.clipboard })))
      .toEqual([{ focusInEditable: false, clipboard: text.textContent }]);
  });

  it.each(CHORDS)('%s of text selected inside the composer copies it and keeps focus there', (_chord, init) => {
    fireEvent.change(textarea(), { target: { value: 'hello world' } });
    textarea().focus();
    textarea().setSelectionRange(0, 5);

    const notPrevented = press(init);

    expect(notPrevented).toBe(false);
    expect(copyObservations.map((c) => ({ active: c.activeAtCopy, clipboard: c.clipboard })))
      .toEqual([{ active: textarea(), clipboard: 'hello' }]);
    expect(textarea().value).toBe('hello world');
    expect([textarea().selectionStart, textarea().selectionEnd]).toEqual([0, 5]);
  });
});

describe('the focus a mouse selection leaves behind (VS Code 1.143.1 route)', () => {
  let host: ReturnType<typeof hostBridge>;
  let guest: Guest;

  beforeEach(() => {
    installExecCommand();
    guest = installGuest('1.143.1');
    render(<App />);
    host = hostBridge();
    textarea().focus();
    host.session(turnStarted('how do I run the tests?'), usage(88_000, 463_000), reply('Run the suite before you commit.'), turnEnded());
  });
  afterEach(() => guest.detach());

  it('lands on something neither editable nor a tab stop, for a reply and for the footer', () => {
    const landed = [
      firstText(document.querySelector('.chat-msg-planner .chat-msg-content p')),
      document.querySelector('.usage-line-context')!,
    ].map((node) => {
      selectRange(node);
      const active = document.activeElement as HTMLElement;
      return { body: active === document.body, editable: isEditable(active), tabStop: active.tabIndex >= 0 };
    });

    expect(landed).toEqual([
      { body: false, editable: false, tabStop: false },
      { body: false, editable: false, tabStop: false },
    ]);
  });

  it('gives the composer back whole: after a reply is copied, a click there edits and copies its own selection', () => {
    selectRange(firstText(document.querySelector('.chat-msg-planner .chat-msg-content p')));
    press(CHORDS[0][1]);

    mouseSelect(textarea(), 0, 0);
    expect(document.activeElement).toBe(textarea());
    fireEvent.change(textarea(), { target: { value: 'hello world' } });
    textarea().setSelectionRange(6, 11);
    press(CHORDS[0][1]);

    expect(copyObservations.map((c) => c.clipboard)).toEqual(['Run the suite before you commit.', 'world']);
    expect(textarea().value).toBe('hello world');
    expect(document.activeElement).toBe(textarea());
  });
});

describe('footer selection through unrelated host updates', () => {
  beforeEach(() => {
    render(<App />);
  });

  /** A drag across the meter, anchored in its text nodes as a real drag is. */
  function dragMeter(): void {
    const meter = document.querySelector('.usage-line-context')!;
    const texts = [...meter.childNodes].filter((n): n is Text => n.nodeType === Node.TEXT_NODE);
    mouseSelect(meter, 0, 0);
    const range = document.createRange();
    range.setStart(texts[0], 0);
    range.setEnd(texts[texts.length - 1], texts[texts.length - 1].length);
    window.getSelection()!.removeAllRanges();
    window.getSelection()!.addRange(range);
  }

  it('keeps "Planner ctx 88k (19%)" selected through liveness, task output, limits and an unchanged usage repeat', () => {
    const host = hostBridge();
    host.session(turnStarted('how do I run the tests?'), usage(88_000, 463_000), reply('Run the suite.'), turnEnded());
    dragMeter();
    expect(window.getSelection()?.toString()).toBe('Planner ctx 88k (19%)');

    post({ type: 'plannerLiveness' });
    post({ type: 'taskOutput', taskId: 't1', text: 'building…' });
    post({ type: 'accountLimits', limits: [] });
    host.session(usage(88_000, 463_000, 'turn-2'));

    expect(window.getSelection()?.toString()).toBe('Planner ctx 88k (19%)');
  });
});
