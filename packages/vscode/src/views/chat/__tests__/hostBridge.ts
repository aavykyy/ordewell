import { act, fireEvent } from '@testing-library/react';
import type * as vscode from 'vscode';
import type { SessionMessage } from '@ordewell/core';
import { ChatViewProvider } from '../../../providers/ChatViewProvider';
import type { HostToWebview } from '../../../shared/protocol';

export function post(msg: HostToWebview): void {
  act(() => {
    window.dispatchEvent(new MessageEvent('message', { data: msg }));
  });
}

/**
 * The extension host's side of the chat, posting straight into the mounted
 * webview — so a test drives the conversation with session events, exactly as
 * the planner would, and sees what the webview draws from the host's view.
 */
export function hostBridge() {
  const provider = new ChatViewProvider({ toString: () => 'file:///ext' } as unknown as vscode.Uri);
  provider.postMessage = post;
  return {
    provider,
    session(...msgs: SessionMessage[]): void {
      for (const msg of msgs) provider.conversation.receive(msg);
      provider.conversation.flush();
    },
  };
}

export const api = (globalThis as unknown as { __vscodeApi: { postMessage: import('vitest').Mock } }).__vscodeApi;

/** The top-level rows of the conversation, by the class that names their kind. */
export function rowKinds(): string[] {
  return [...document.querySelectorAll('.conversation > *')].map((el) => el.className.split(' ')[0]);
}

/** Opens every run of activity still folded, as a reader would to see its rows. */
export function openActivity(): void {
  document.querySelectorAll<HTMLButtonElement>('.activity-group-toggle[aria-expanded="false"]').forEach((b) => fireEvent.click(b));
}

/** The rows inside the open runs of activity, in order, by the class that names their kind. */
export function activityRows(): string[] {
  return [...document.querySelectorAll('.activity-group-body > *')].map((el) => el.className.split(' ')[0]);
}
