import React from 'react';
import { describe, it, expect, beforeEach } from 'vitest';
import { fireEvent, render } from '@testing-library/react';
import App from '../App';
import { api, post } from './hostBridge';

const runnersBlock = (): HTMLElement | undefined =>
  [...document.querySelectorAll<HTMLElement>('.setup-block')]
    .find((b) => b.querySelector('.setup-block-title')?.textContent === 'Runners');

const pill = (name: string): HTMLElement | null =>
  [...(runnersBlock()?.querySelectorAll<HTMLElement>('.runner-pill') ?? [])]
    .find((p) => p.textContent?.includes(name)) ?? null;

/** The installed list with Claude Code on, OpenCode off: what a saved choice of one runner looks like. */
function installedList(): void {
  post({
    type: 'setRunners',
    runners: [
      { id: 'claude-code', displayName: 'Claude Code', enabled: true },
      { id: 'opencode', displayName: 'OpenCode', enabled: false },
    ],
  });
}

describe('the Runners block', () => {
  beforeEach(() => {
    render(<App />);
  });

  it('offers an installed runner that is off, in a state of its own', () => {
    installedList();

    const off = pill('OpenCode');
    expect(off).not.toBeNull();
    expect(off!.className).toContain('disabled');
    expect(off!.getAttribute('title')).toMatch(/enable/i);
    expect(runnersBlock()?.textContent).not.toContain('No coding agent detected');
  });

  it('asks the host to enable it, and shows it on at once', () => {
    installedList();
    api.postMessage.mockClear();

    fireEvent.click(pill('OpenCode')!);

    expect(api.postMessage).toHaveBeenCalledWith({ type: 'setRunnerEnabled', runnerId: 'opencode', enabled: true, requestId: expect.any(String) });
    expect(pill('OpenCode')!.className).toContain('on');
  });

  it('offers every installed runner when none is enabled, rather than claiming none is installed', () => {
    post({
      type: 'setRunners',
      runners: [
        { id: 'claude-code', displayName: 'Claude Code', enabled: false },
        { id: 'codex', displayName: 'Codex', enabled: false },
      ],
    });

    expect(pill('Claude Code')?.className).toContain('disabled');
    expect(pill('Codex')?.className).toContain('disabled');
    expect(runnersBlock()?.textContent).not.toContain('No coding agent detected');
  });
});
