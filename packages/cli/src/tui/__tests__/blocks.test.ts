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

describe('the live thinking line keeps the end of a row too short for it', () => {
  it('never cuts a joined emoji in half', () => {
    const family = '👨‍👩‍👧';
    const block = { type: 'thinking' as const, id: 't1', text: `${'x'.repeat(40)}${family}`, streaming: true };

    // Room for the ellipsis and two columns: one whole cluster, not a dangling joiner and its last member.
    const [row] = conversationLines([block], 25, false).filter((line) => line !== '');

    expect(stripAnsi(row)).toMatch(new RegExp(`·\\s…${family}$`, 'u'));
  });
});

describe('a task\'s runner commands in its log (#66)', () => {
  const plainRows = (blocks: Parameters<typeof conversationLines>[0], detailAll = false) =>
    conversationLines(blocks, 80, detailAll).map(stripAnsi).filter((row) => row !== '');

  it('draws a command the user ran, how its turn ended, and what it printed', () => {
    expect(plainRows([{ type: 'command', id: 'b1', name: 'compact', args: 'keep the API notes', status: 'done', output: 'Compacted' }])).toEqual([
      '❯ /compact keep the API notes  done',
      '  ⎿  Compacted',
    ]);
    expect(plainRows([{ type: 'command', id: 'b1', name: 'pingskill', status: 'running', output: '' }])).toEqual(['❯ /pingskill  running']);
  });

  it('marks a compaction, with the context before and after it', () => {
    expect(plainRows([{ type: 'compaction', id: 'b1', trigger: 'manual', preTokens: 24939, postTokens: 3615 }])).toEqual(['≡ Context compacted · 24.9k → 3.6k tokens']);
    expect(plainRows([{ type: 'compaction', id: 'b1', trigger: 'auto' }])).toEqual(['≡ Context compacted by the runner on its own']);
  });

  it('collapses what the runner loaded to one line, and lists it in full detail', () => {
    const loaded = {
      type: 'runner_loaded' as const, id: 'b1',
      commands: [
        { name: 'pingskill', description: 'Reply', kind: 'skill' as const },
        { name: 'hellocmd', description: 'Say hello', kind: 'command' as const },
        { name: 'compact', description: 'Free up context', kind: 'builtin' as const },
        { name: 'model', description: 'Set the model', kind: 'builtin' as const },
      ],
      mcpServers: [{ name: 'docs-server', status: 'pending' }],
    };
    expect(plainRows([loaded])).toEqual(['● Runner loaded 1 skill, 1 command, 2 built-in commands, 1 MCP server']);
    expect(plainRows([loaded], true)).toEqual([
      '● Runner loaded 1 skill, 1 command, 2 built-in commands, 1 MCP server',
      '     skills: /pingskill',
      '     commands: /hellocmd',
      '     built-in: /compact /model',
      '     MCP servers: docs-server (pending)',
    ]);
  });
});
