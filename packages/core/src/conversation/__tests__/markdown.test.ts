import { describe, it, expect } from 'vitest';
import { markdownHtml, markdownTokens } from '../markdown';

describe('markdown configuration', () => {
  it('escapes raw HTML rather than passing it through', () => {
    expect(markdownHtml('<script>alert(1)</script>')).toBe('<p>&lt;script&gt;alert(1)&lt;/script&gt;</p>\n');
  });
});

describe('links', () => {
  it.each([
    'javascript:alert(1)', 'JaVaScRiPt:alert(1)', '&#x6a;avascript:alert(1)', 'data:text/html,<b>x</b>', 'file:///etc/passwd',
    'vscode:extension/x', 'command:workbench.action.quit', 'mailto:a@b.test', 'ftp://x.test/a', '//x.test/a', './README.md', '#top',
  ])('leaves [text](%s) as text, never an <a>', (url) => {
    expect(markdownHtml(`[click](${url})`)).not.toContain('<a');
  });

  it('opens an http or https link outside the webview', () => {
    expect(markdownHtml('[docs](https://example.com/a) and [plain](http://example.com/b)')).toBe(
      '<p><a href="https://example.com/a" target="_blank" rel="noopener">docs</a>'
      + ' and <a href="http://example.com/b" target="_blank" rel="noopener">plain</a></p>\n',
    );
  });
});

describe('images', () => {
  it('draws an image as its alt text, so nothing fetches a URL the model chose', () => {
    expect(markdownHtml('see ![the logo](https://x.test/logo.png)')).toBe('<p>see the logo</p>\n');
  });

  it('falls back to the URL as text when the image has no alt text', () => {
    expect(markdownHtml('![](https://x.test/logo.png)')).toBe('<p>https://x.test/logo.png</p>\n');
  });
});

describe('tables', () => {
  it('reads a GitHub-style table, in a box a surface can scroll sideways', () => {
    expect(markdownHtml('| a | b |\n| --- | --- |\n| 1 | 2 |')).toBe(
      '<div class="md-table"><table>\n<thead>\n<tr>\n<th>a</th>\n<th>b</th>\n</tr>\n</thead>\n'
      + '<tbody>\n<tr>\n<td>1</td>\n<td>2</td>\n</tr>\n</tbody>\n</table></div>\n',
    );
  });
});

describe('bare URLs', () => {
  it('links a bare web URL the way a written link opens', () => {
    expect(markdownHtml('see https://example.com/a')).toBe(
      '<p>see <a href="https://example.com/a" target="_blank" rel="noopener">https://example.com/a</a></p>\n',
    );
  });

  it.each(['README.md', 'www.example.com', 'a@b.test', 'mailto:a@b.test', 'ftp://x.test/a'])(
    'leaves %s as text',
    (text) => {
      expect(markdownHtml(`see ${text}`)).not.toContain('<a');
    },
  );
});

describe('links written other ways', () => {
  it.each([
    ['an autolink', '<javascript:alert(1)>'],
    ['an email autolink', '<a@b.test>'],
    ['a reference link', '[click][x]\n\n[x]: javascript:alert(1)'],
  ])('gives %s outside http(s) no <a>', (_name, text) => {
    expect(markdownHtml(text)).not.toContain('<a');
  });

  it('still links an https autolink', () => {
    expect(markdownHtml('<https://example.com>')).toContain('<a href="https://example.com" target="_blank" rel="noopener">');
  });
});

describe('tokens', () => {
  it('are the block structure a surface paints from, inline content as children', () => {
    const tokens = markdownTokens('# Title\n\nsome **bold** text');

    expect(tokens.map((t) => [t.type, t.tag])).toEqual([
      ['heading_open', 'h1'], ['inline', ''], ['heading_close', 'h1'],
      ['paragraph_open', 'p'], ['inline', ''], ['paragraph_close', 'p'],
    ]);
    expect(tokens[1].content).toBe('Title');
    expect(tokens[4].children?.map((t) => t.type)).toEqual(['text', 'strong_open', 'text', 'strong_close', 'text']);
  });

  it('carry no image and no non-web link, whatever surface reads them', () => {
    const inline = markdownTokens('![logo](https://x.test/a.png) [run](javascript:alert(1))')[1].children ?? [];

    expect(inline.map((t) => t.type)).not.toContain('image');
    expect(inline.map((t) => t.type)).not.toContain('link_open');
  });
});

describe('code', () => {
  it('keeps a fenced block verbatim, escaped, with | not read as a table', () => {
    expect(markdownHtml('```ts\nconst a = b | c < d;\n```')).toBe(
      '<pre><code class="language-ts">const a = b | c &lt; d;\n</code></pre>\n',
    );
  });
});

describe('streaming text', () => {
  it('reads a fence not yet closed as code to the end', () => {
    expect(markdownHtml('Here:\n\n```\nline one\n| a | b')).toBe(
      '<p>Here:</p>\n<pre><code>line one\n| a | b</code></pre>\n',
    );
  });

  it('shows a table whose delimiter row is half-written as its text until the row completes', () => {
    expect(markdownHtml('| a | b |\n| --')).not.toContain('<table');
    expect(markdownHtml('| a | b |\n| --')).toContain('| a | b |');
  });
});

describe('line breaks', () => {
  it('keeps a single newline as a break, as the model saw it when writing', () => {
    expect(markdownHtml('first line\nsecond line')).toBe('<p>first line<br>\nsecond line</p>\n');
  });
});
