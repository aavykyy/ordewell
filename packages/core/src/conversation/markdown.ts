import MarkdownIt from 'markdown-it';

/*
 * The one Markdown parser every surface draws a model's text from. The text
 * can be steered by what the model read, so what it may turn into — no raw
 * HTML, no image, no link but a web one — is settled here, where no surface
 * can loosen it.
 */

// `breaks`: a chat reply's single newline is a line break, as it reads in the
// raw text the model wrote, not a space as in a CommonMark document.
const md = new MarkdownIt({ html: false, linkify: true, breaks: true });

// Only a URL written with its scheme is linked. Fuzzy matching would turn file
// names into links (.md, .rs, .py and .sh are all country domains).
md.linkify.set({ fuzzyLink: false, fuzzyEmail: false });

// Every link passes here, linkify's and autolinks' included. An allowlist, not
// markdown-it's javascript/vbscript/file/data denylist: a vscode: or command:
// URI would act inside the editor, and a relative URL resolves against the
// webview's own origin.
md.validateLink = (url) => /^https?:/i.test(url);

// A remote image would make the webview fetch a URL the model chose. It is
// replaced in the tokens rather than at render time, so no surface gets one.
md.core.ruler.after('linkify', 'image_as_text', (state) => {
  for (const block of state.tokens) {
    if (!block.children) continue;
    block.children = block.children.map((token) => {
      if (token.type !== 'image') return token;
      const text = new state.Token('text', '', 0);
      text.content = token.content || (token.attrGet('src') ?? '');
      return text;
    });
  }
});

md.renderer.rules.link_open = (tokens, idx, options, _env, self) => {
  tokens[idx].attrSet('target', '_blank');
  tokens[idx].attrSet('rel', 'noopener');
  return self.renderToken(tokens, idx, options);
};

// A table made its own scroll container is still fitted to its parent's width,
// squashing every column; a box around it scrolls and the table keeps its own.
md.renderer.rules.table_open = (tokens, idx, options, _env, self) => `<div class="md-table">${self.renderToken(tokens, idx, options)}`;
md.renderer.rules.table_close = () => '</table></div>\n';

/**
 * One markdown-it token, as far as a surface reads it. Declared here rather
 * than re-exporting markdown-it's class so a surface depends on core alone.
 */
export interface MarkdownToken {
  readonly type: string;
  readonly tag: string;
  readonly nesting: 1 | 0 | -1;
  readonly level: number;
  readonly content: string;
  readonly markup: string;
  readonly info: string;
  readonly block: boolean;
  readonly hidden: boolean;
  readonly map: readonly [number, number] | null;
  readonly attrs: readonly (readonly [string, string])[] | null;
  readonly children: readonly MarkdownToken[] | null;
}

/** The parsed blocks of a model's text, for a surface that paints them itself (the TUI). */
export function markdownTokens(text: string): readonly MarkdownToken[] {
  return md.parse(text, {});
}

/** A model's text as HTML, safe to set as a webview element's innerHTML. */
export function markdownHtml(text: string): string {
  return md.render(text);
}
