import { describe, it, expect, beforeAll } from 'vitest';
import { renderMarkdown } from '../markdown';
import { stripAnsi, palette, style, width } from '../ansi';

beforeAll(() => {
  // Deterministic frames: colour codes would only make the assertions noisy.
  style.enabled = false;
});

const md = (source: string, cols = 80): string[] => renderMarkdown(source, cols);

describe('renderMarkdown — block elements', () => {
  it('strips leading/trailing blank lines and carriage returns', () => {
    expect(md('\r\n\nhello\r\n\n')).toEqual(['hello']);
  });

  it('renders headings without the hash markers', () => {
    expect(md('# Title')).toEqual(['Title']);
    expect(md('### Deep heading')).toEqual(['Deep heading']);
    expect(md('## Closed ##')).toEqual(['Closed']);
  });

  it('renders bullets with a • regardless of the source marker', () => {
    expect(md('- one\n* two\n+ three')).toEqual(['• one', '• two', '• three']);
  });

  it('preserves bullet indentation for nested lists', () => {
    expect(md('- top\n  - nested')).toEqual(['• top', '  • nested']);
  });

  it('renders blockquotes with a │ gutter', () => {
    expect(md('> quoted text')).toEqual(['│ quoted text']);
  });

  it('renders a horizontal rule across the full width', () => {
    const [rule] = md('---', 20);
    expect(rule).toBe('─'.repeat(20));
  });

  it('drops code fences but keeps code content verbatim and indented', () => {
    const out = md('```ts\nconst x = **not bold**;\n```');
    expect(out).toEqual(['  const x = **not bold**;']);
  });

  it('treats an unclosed fence as code until the end', () => {
    expect(md('```\nline1\nline2')).toEqual(['  line1', '  line2']);
  });

  it('wraps long paragraphs at the requested width', () => {
    const out = md('word '.repeat(40).trim(), 20);
    expect(out.length).toBeGreaterThan(1);
    for (const line of out) expect(width(line)).toBeLessThanOrEqual(20);
  });
});

describe('renderMarkdown — inline formatting', () => {
  it('strips bold and italic markers', () => {
    expect(md('**bold** and *italic* and __also__ and _this_')).toEqual([
      'bold and italic and also and this',
    ]);
  });

  it('keeps underscores inside identifiers untouched', () => {
    expect(md('set ORDEWELL_AUTONOMOUS_MODE=1 before running')).toEqual([
      'set ORDEWELL_AUTONOMOUS_MODE=1 before running',
    ]);
  });

  it('unwraps inline code spans', () => {
    expect(md('run `npm install` now')).toEqual(['run npm install now']);
  });

  it('renders links as text (url) and images as their alt text', () => {
    expect(md('[docs](https://example.com)')).toEqual(['docs (https://example.com)']);
    expect(md('![diagram](https://example.com/x.png)')).toEqual(['diagram']);
  });
});

describe('renderMarkdown — tables', () => {
  const table = '| Name | Role |\n| --- | --- |\n| Ada | Engineer |\n| Grace | Admiral |';

  it('renders aligned columns with a rule under the header', () => {
    const out = md(table);
    expect(out[0]).toMatch(/^Name\s+│ Role/);
    expect(out[1]).toContain('─┼─');
    expect(out[2]).toMatch(/^Ada\s+│ Engineer/);
    expect(out[3]).toMatch(/^Grace\s+│ Admiral/);
  });

  it('requires a rule row — a lone pipe line is plain text', () => {
    expect(md('| just | text |')).toEqual(['| just | text |']);
  });

  it('shrinks columns to fit narrow terminals without overflowing', () => {
    const wide = '| Column A | Column B |\n| --- | --- |\n| a very long cell value here | short |';
    for (const line of md(wide, 30)) expect(width(line)).toBeLessThanOrEqual(30);
  });

  it('falls back to a stacked layout when columns would collapse below readability', () => {
    const cramped = '| Header one | Header two |\n| --- | --- |\n| aaa | bbb |';
    const out = md(cramped, 8);
    const flat = out.join('\n');
    expect(flat).not.toContain('│');
    expect(flat).toContain('one: aaa');
    expect(flat).toContain('two: bbb');
    for (const line of out) expect(width(line)).toBeLessThanOrEqual(8);
  });

  // markdown-it follows GFM: a line after the table's rows with no blank line
  // between is one more row, where the hand-written parser ended the table.
  it('ends the table at a blank line', () => {
    const out = md('| a | b |\n| --- | --- |\n| 1 | 2 |\n\nplain text after');
    expect(out[out.length - 1]).toBe('plain text after');
    expect(out).toContain('');
  });

  it('keeps a table of narrow columns as a grid when it fits', () => {
    const out = md('| a | b |\n| --- | --- |\n| 1 | 2 |');
    expect(out[0]).toMatch(/^a\s+│ b/);
    expect(out[2]).toMatch(/^1\s+│ 2/);
  });
});

describe('renderMarkdown — a table too wide for the pane', () => {
  const wide = [
    '| What\'s needed | Effort |',
    '| --- | --- |',
    '| Wire the parser in | Small |',
    '| Drop the old one | Medium |',
    '| Prune dead fixtures | Tiny |',
  ].join('\n');

  it('is one record per row, a rule between records', () => {
    const out = md(wide, 8);
    const rule = '─'.repeat(8);
    expect(out.filter((line) => line === rule)).toHaveLength(2);
    const records = out.join('\n').split(`\n${rule}\n`).map((record) => record.replace(/\n/g, ' '));
    expect(records).toEqual([
      "What's needed: Wire the parser in Effort: Small",
      "What's needed: Drop the old one Effort: Medium",
      "What's needed: Prune dead fixtures Effort: Tiny",
    ]);
    expect(out[0]).not.toBe(rule);
    expect(out[out.length - 1]).not.toBe(rule);
    for (const line of out) expect(width(line)).toBeLessThanOrEqual(8);
  });

  it('is not a grid', () => {
    expect(md(wide, 8).join('\n')).not.toContain('│');
  });
});

describe('renderMarkdown — what the hand-written parser had to be taught', () => {
  it('keeps an escaped pipe in its cell', () => {
    const out = md('| Name | Note |\n| --- | --- |\n| a\\|b | plain |');
    expect(out[2]).toMatch(/^a\|b\s+│ plain/);
  });

  it('keeps an escaped pipe inside a code span in its cell', () => {
    const out = md('| Command | Does |\n| --- | --- |\n| `a \\| b` | pipes |');
    expect(out).toHaveLength(3);
    expect(out[2]).toMatch(/^a \| b\s+│ pipes/);
  });

  it('indents a nested list under its parent and numbers an ordered one', () => {
    expect(md('- top\n  1. first\n  2. second\n- next')).toEqual([
      '• top',
      '  1. first',
      '  2. second',
      '• next',
    ]);
  });

  it('keeps a code block inside a list item under the item', () => {
    expect(md('- step\n\n  ```sh\n  npm test\n  ```\n\n- done')).toEqual([
      '• step',
      '',
      '    npm test',
      '',
      '• done',
    ]);
  });

  it('keeps a loose list loose and a tight one tight', () => {
    expect(md('- a\n- b')).toEqual(['• a', '• b']);
    expect(md('- a\n\n- b')).toEqual(['• a', '', '• b']);
  });

  it('separates blocks only where the source did', () => {
    expect(md('Intro:\n- a\n\nafter')).toEqual(['Intro:', '• a', '', 'after']);
  });

  it('keeps a code block\'s pipes and angle brackets as written', () => {
    expect(md('```\n| a | b |\n<tag>\n```')).toEqual(['  | a | b |', '  <tag>']);
  });
});

describe('renderMarkdown — links', () => {
  it('prints the URL of a web link after its text', () => {
    expect(md('see [the docs](https://example.com/a?b=1) now')).toEqual(['see the docs (https://example.com/a?b=1) now']);
  });

  it('prints a bare URL once', () => {
    expect(md('open https://example.com/x today')).toEqual(['open https://example.com/x today']);
  });

  it.each([
    '[x](javascript:alert(1))',
    '[x](file:///etc/passwd)',
    '[x](vscode://file/a)',
    '[x](/relative/path)',
  ])('leaves %s as the text typed', (source) => {
    expect(md(source)).toEqual([source]);
  });

  it('shows an image as its alt text', () => {
    expect(md('![diagram](https://example.com/x.png)')).toEqual(['diagram']);
  });
});

describe('renderMarkdown — wrapping painted text', () => {
  it('never cuts a colour sequence when a long code span is hard-split', () => {
    style.enabled = true;
    // The 256-colour brand code the audit reproduced with; truecolor is a
    // different length, which moves the chunk boundaries.
    const truecolor = palette.truecolor;
    palette.truecolor = false;
    try {
      for (const length of [145, 223, 301]) {
        const path = `/${'a'.repeat(length)}`;
        const out = md(`See \`${path}\` here.`, 78);
        for (const line of out) {
          // Anything left after the well-formed SGR codes is a sequence cut in
          // half: the terminal aborts it and prints the rest as text, and the
          // colour it opened is never closed.
          // eslint-disable-next-line no-control-regex
          expect(line.replace(/\x1b\[[0-9;]*m/g, '')).not.toContain('\x1b');
          expect(width(line)).toBeLessThanOrEqual(78);
        }
        expect(out.map(stripAnsi).join('')).toContain(path);
      }
    } finally {
      palette.truecolor = truecolor;
      style.enabled = false;
    }
  });
});

describe('renderMarkdown — streaming and nesting', () => {
  it('paints a table whose delimiter row has not arrived as text', () => {
    expect(md('| a | b |\n| --')).toEqual(['| a | b |', '| --']);
  });

  it('keeps emphasis and code readable inside a heading, with colour on', () => {
    style.enabled = true;
    try {
      const [line] = md('# Use `npm` **now**');
      expect(stripAnsi(line)).toBe('Use npm now');
      // The code word keeps the heading's bold: nothing resets it early.
      expect(line.slice(0, line.indexOf('npm'))).toContain('\x1b[1m');
    } finally {
      style.enabled = false;
    }
  });
});
