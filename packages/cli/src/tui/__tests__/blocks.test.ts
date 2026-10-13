import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { MessageBlock } from '@ordewell/core';
import { stripAnsi, style } from '../ansi';
import { conversationLines } from '../blocks';

const message = (role: MessageBlock['role'], text: string): MessageBlock =>
  ({ type: 'message', id: 'b1', role, text, streaming: false });

const rows = (role: MessageBlock['role'], text: string): string[] =>
  conversationLines([message(role, text)], 16, false).filter((row) => row !== '');

let wasEnabled: boolean;
beforeEach(() => { wasEnabled = style.enabled; style.enabled = true; });
afterEach(() => { style.enabled = wasEnabled; });

describe('a wrapped line keeps the colour it started in', () => {
  const long = 'alpha beta gamma delta epsilon zeta';

  it('paints every row of a system notice grey, under one bullet', () => {
    const lines = rows('system', long);
    expect(lines.length).toBeGreaterThan(1);
    for (const line of lines) expect(line.startsWith('\x1b[90m')).toBe(true);
    expect(stripAnsi(lines.join('')).match(/·/g)).toHaveLength(1);
  });

  it('paints every row of an error red', () => {
    const lines = rows('error', long);
    expect(lines.length).toBeGreaterThan(1);
    for (const line of lines) expect(line).toContain('\x1b[31m');
  });

  it('leaves an agent\'s continuation rows unpainted, as before', () => {
    const lines = rows('agent', long);
    expect(lines.length).toBeGreaterThan(1);
    expect(lines[1].startsWith('\x1b[')).toBe(false);
  });
});
