import { describe, expect, it } from 'vitest';
import { parseToml } from '../toml';
import { parseJsonc } from '../repoConfig';

describe('parseToml', () => {
  it('reads tables, dotted keys, inline tables, arrays and every string form', () => {
    const doc = parseToml([
      'top = 1_000 # a comment',
      'site."google.com" = true',
      '[mcp_servers.probe]',
      'command = "C:\\\\bin\\\\serve.exe"',
      "args = ['--raw\\\\path', \"tab\\there\", \"\\u00e9\"]",
      'env = { A = "1", "B C" = \'2\' }',
      'multi = [',
      '  "x", # inside an array',
      '  "y",',
      ']',
    ].join('\n'));

    expect(doc.top).toBe(1000);
    expect(doc.site).toEqual({ 'google.com': true });
    expect(doc.mcp_servers).toEqual({
      probe: { command: 'C:\\bin\\serve.exe', args: ['--raw\\\\path', 'tab\there', 'é'], env: { A: '1', 'B C': '2' }, multi: ['x', 'y'] },
    });
  });

  it('does not take a header written inside a multi-line string for a table', () => {
    const doc = parseToml([
      'note = """',
      '[mcp_servers.hidden]',
      'command = "x"',
      '"""',
      "literal = '''",
      '[mcp_servers.also]',
      "'''",
      'joined = """one \\',
      '   two"""',
    ].join('\n'));

    expect(doc.mcp_servers).toBeUndefined();
    expect(doc.note).toBe('[mcp_servers.hidden]\ncommand = "x"\n');
    expect(doc.joined).toBe('one two');
  });

  it('reads arrays of tables, and a table under the last of them', () => {
    const doc = parseToml(['[[profiles]]', 'name = "a"', '[[profiles]]', 'name = "b"', '[profiles.extra]', 'on = false'].join('\n'));

    expect(doc.profiles).toEqual([{ name: 'a' }, { name: 'b', extra: { on: false } }]);
  });

  it('refuses what it cannot read rather than guessing', () => {
    expect(() => parseToml('[mcp_servers.probe]\ncommand = "unterminated')).toThrow(/line 2/);
    expect(() => parseToml('a = 1 b = 2')).toThrow(/end of the line/);
  });
});

describe('parseJsonc', () => {
  it('drops comments and trailing commas, and leaves strings that look like either alone', () => {
    expect(parseJsonc([
      '{',
      '  // a line comment',
      '  "url": "https://example.com//path", /* a block',
      '  comment */ "odd": "a,]b",',
      '  "list": [1, 2,],',
      '}',
    ].join('\n'))).toEqual({ url: 'https://example.com//path', odd: 'a,]b', list: [1, 2] });
  });
});
