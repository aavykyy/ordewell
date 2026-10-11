import { isRecord } from './repoConfig';

/**
 * A TOML reader for the runner config files Ordewell reads for a planner
 * (ADR-0028). It covers what those files use — tables, arrays of tables,
 * dotted keys, every string form, arrays, inline tables, numbers and
 * booleans — and keeps dates and other bare values as their text. What it
 * gets wrong can only hide a server from the planner or show one Codex would
 * not have loaded; an approved server runs as parsed here, never re-read.
 */
export function parseToml(text: string): Record<string, unknown> {
  return new TomlReader(text).document();
}

class TomlError extends Error {}

const BARE_KEY = /[A-Za-z0-9_-]/;
const ESCAPES: Record<string, string> = { b: '\b', t: '\t', n: '\n', f: '\f', r: '\r', '"': '"', '\\': '\\', e: '\x1b' };

class TomlReader {
  private i = 0;

  constructor(private readonly src: string) {}

  document(): Record<string, unknown> {
    const root: Record<string, unknown> = {};
    let table = root;
    for (;;) {
      this.skipBlank(true);
      if (this.i >= this.src.length) return root;
      if (this.src.startsWith('[[', this.i)) {
        this.i += 2;
        const path = this.key();
        this.expect(']]');
        const parent = this.tableAt(root, path.slice(0, -1));
        const last = path[path.length - 1];
        const list = parent[last] ?? (parent[last] = []);
        if (!Array.isArray(list)) throw this.fail(`${path.join('.')} is not an array of tables`);
        table = {};
        list.push(table);
      } else if (this.src[this.i] === '[') {
        this.i += 1;
        const path = this.key();
        this.expect(']');
        table = this.tableAt(root, path);
      } else {
        const path = this.key();
        this.skipBlank(false);
        this.expect('=');
        this.skipBlank(false);
        const owner = this.tableAt(table, path.slice(0, -1));
        owner[path[path.length - 1]] = this.value();
      }
      this.endOfLine();
    }
  }

  private tableAt(from: Record<string, unknown>, path: string[]): Record<string, unknown> {
    let table = from;
    for (const part of path) {
      const next = table[part];
      if (next === undefined) table = (table[part] = {}) as Record<string, unknown>;
      else if (isRecord(next)) table = next;
      else if (Array.isArray(next) && isRecord(next[next.length - 1])) table = next[next.length - 1] as Record<string, unknown>;
      else throw this.fail(`${part} is not a table`);
    }
    return table;
  }

  private key(): string[] {
    const parts: string[] = [];
    for (;;) {
      this.skipBlank(false);
      const ch = this.src[this.i];
      if (ch === '"') parts.push(this.basicString());
      else if (ch === '\'') parts.push(this.literalString());
      else {
        const start = this.i;
        while (this.i < this.src.length && BARE_KEY.test(this.src[this.i])) this.i++;
        if (this.i === start) throw this.fail('expected a key');
        parts.push(this.src.slice(start, this.i));
      }
      this.skipBlank(false);
      if (this.src[this.i] !== '.') return parts;
      this.i++;
    }
  }

  private value(): unknown {
    const ch = this.src[this.i];
    if (this.src.startsWith('"""', this.i)) return this.multilineString('"""');
    if (this.src.startsWith('\'\'\'', this.i)) return this.multilineString('\'\'\'');
    if (ch === '"') return this.basicString();
    if (ch === '\'') return this.literalString();
    if (ch === '[') return this.array();
    if (ch === '{') return this.inlineTable();
    const start = this.i;
    while (this.i < this.src.length && !/[\s,\]}#]/.test(this.src[this.i])) this.i++;
    const raw = this.src.slice(start, this.i);
    if (!raw) throw this.fail('expected a value');
    if (raw === 'true' || raw === 'false') return raw === 'true';
    const number = raw.replace(/_/g, '');
    if (/^[+-]?(\d+(\.\d+)?([eE][+-]?\d+)?|0x[0-9a-fA-F]+|0o[0-7]+|0b[01]+|inf|nan)$/.test(number)) return Number(number);
    return raw;
  }

  private array(): unknown[] {
    this.i++;
    const items: unknown[] = [];
    for (;;) {
      this.skipBlank(true);
      if (this.src[this.i] === ']') { this.i++; return items; }
      items.push(this.value());
      this.skipBlank(true);
      if (this.src[this.i] === ',') this.i++;
      else if (this.src[this.i] !== ']') throw this.fail('expected , or ] in an array');
    }
  }

  private inlineTable(): Record<string, unknown> {
    this.i++;
    const table: Record<string, unknown> = {};
    for (;;) {
      this.skipBlank(true);
      if (this.src[this.i] === '}') { this.i++; return table; }
      const path = this.key();
      this.expect('=');
      this.skipBlank(false);
      this.tableAt(table, path.slice(0, -1))[path[path.length - 1]] = this.value();
      this.skipBlank(true);
      if (this.src[this.i] === ',') this.i++;
      else if (this.src[this.i] !== '}') throw this.fail('expected , or } in an inline table');
    }
  }

  private basicString(): string {
    this.i++;
    let out = '';
    while (this.src[this.i] !== '"') {
      if (this.i >= this.src.length || this.src[this.i] === '\n') throw this.fail('unterminated string');
      out += this.src[this.i] === '\\' ? this.escape() : this.src[this.i++];
    }
    this.i++;
    return out;
  }

  private literalString(): string {
    const end = this.src.indexOf('\'', this.i + 1);
    const body = end < 0 ? '' : this.src.slice(this.i + 1, end);
    if (end < 0 || body.includes('\n')) throw this.fail('unterminated string');
    this.i = end + 1;
    return body;
  }

  private multilineString(quote: string): string {
    this.i += 3;
    if (this.src[this.i] === '\n') this.i++;
    else if (this.src.startsWith('\r\n', this.i)) this.i += 2;
    let out = '';
    for (;;) {
      if (this.i >= this.src.length) throw this.fail('unterminated string');
      if (this.src.startsWith(quote, this.i)) {
        // Up to two quotes may close the string's content: `""""` ends in one `"`.
        let extra = 0;
        while (extra < 2 && this.src[this.i + 3 + extra] === quote[0]) extra++;
        out += quote[0].repeat(extra);
        this.i += 3 + extra;
        return out;
      }
      if (quote === '"""' && this.src[this.i] === '\\') {
        const rest = /^\\[ \t]*\r?\n[\s]*/.exec(this.src.slice(this.i, this.i + 256));
        if (rest) { this.i += rest[0].length; continue; }
        out += this.escape();
        continue;
      }
      out += this.src[this.i++];
    }
  }

  private escape(): string {
    const code = this.src[this.i + 1];
    if (code in ESCAPES) { this.i += 2; return ESCAPES[code]; }
    const width = code === 'u' ? 4 : code === 'U' ? 8 : 0;
    const hex = this.src.slice(this.i + 2, this.i + 2 + width);
    if (!width || !/^[0-9a-fA-F]+$/.test(hex) || hex.length !== width) throw this.fail('bad escape');
    this.i += 2 + width;
    return String.fromCodePoint(parseInt(hex, 16));
  }

  /** Spaces, tabs and comments; newlines too when `newlines`. */
  private skipBlank(newlines: boolean): void {
    while (this.i < this.src.length) {
      const ch = this.src[this.i];
      if (ch === ' ' || ch === '\t' || (newlines && (ch === '\n' || ch === '\r'))) this.i++;
      else if (ch === '#') while (this.i < this.src.length && this.src[this.i] !== '\n') this.i++;
      else return;
    }
  }

  private endOfLine(): void {
    this.skipBlank(false);
    if (this.i < this.src.length && this.src[this.i] !== '\n' && this.src[this.i] !== '\r') throw this.fail('expected the end of the line');
  }

  private expect(token: string): void {
    this.skipBlank(false);
    if (!this.src.startsWith(token, this.i)) throw this.fail(`expected ${token}`);
    this.i += token.length;
  }

  private fail(message: string): TomlError {
    const line = this.src.slice(0, this.i).split('\n').length;
    return new TomlError(`line ${line}: ${message}`);
  }
}
