import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { MessageBlock, ToolBlock } from '@ordewell/core';
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

describe('model Markdown is sanitized before it is parsed (#83)', () => {
  // Only the TUI's own colour may remain: any other escape would act on the terminal.
  const strayEscapes = (lines: string[]): string[] =>
    // eslint-disable-next-line no-control-regex
    lines.join('\n').replace(/\x1b\[[0-9;]*m/g, '').match(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g) ?? [];

  it('drops control sequences in a paragraph, heading, table cell, code block and link', () => {
    const text = [
      '# Head\x1b]0;owned\x07ing',
      'text \x1b[2Kwith \x1b[31mred\x1b[0m and a bell\x07',
      '',
      '| a | b |',
      '| --- | --- |',
      '| x\x1b[10Cy | z |',
      '',
      '```',
      'code\x1b[Hline',
      '```',
      '',
      '[docs\x1b[2J](https://example.com/\x1b[31m)',
    ].join('\n');
    const lines = conversationLines([message('planner', text)], 60, false);
    expect(strayEscapes(lines)).toEqual([]);
    const plain = stripAnsi(lines.join('\n'));
    expect(plain).toContain('Heading');
    expect(plain).toContain('text with red and a bell');
    expect(plain).toContain('xy');
    expect(plain).toContain('codeline');
    expect(plain).toContain('docs');
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
    expect(plainRows([{ type: 'compaction', id: 'b1', trigger: 'manual', preTokens: 24939, postTokens: 3615 }])).toEqual(['≡ Context compacted · 25k → 3.6k tokens']);
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

describe('a command that ran sealed (ADR-0036 S4)', () => {
  const sealedRun = (over: Partial<ToolBlock> = {}): ToolBlock => ({
    type: 'tool', id: 'b1', tool: 'bash', headline: { name: 'Bash', keyArg: 'for f in *.md; do wc -l "$f"; done' },
    args: '{"command":"for f in *.md; do wc -l \\"$f\\"; done"}', status: 'ok', outcome: 'success',
    output: '3 README.md', outputLineCount: 1, sealed: true, ...over,
  });
  const plainRows = (block: ToolBlock, cols = 80, detailAll = false) =>
    conversationLines([block], cols, detailAll).map(stripAnsi).filter((row) => row !== '');

  it('says so after the command, and still closes it when the row is short', () => {
    expect(plainRows(sealedRun())).toEqual(['● Bash(for f in *.md; do wc -l "$f"; done) · sealed', '  ⎿  3 README.md']);
    expect(plainRows(sealedRun(), 30)[0]).toBe('● Bash(for f in *.m…) · sealed');
    expect(plainRows(sealedRun(), 80, true)[0]).toBe('● Bash(for f in *.md; do wc -l "$f"; done) · sealed');
  });

  it('leads a failure with its own reason', () => {
    const failed = sealedRun({ status: 'error', outcome: 'failure', output: 'Command exited 6:\ncurl: (6) Could not resolve host' });
    expect(plainRows(failed)[1]).toBe('  ⎿  Error: Command exited 6:');
  });
});
