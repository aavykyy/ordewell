import { markdownTokens, type MarkdownToken } from '@ordewell/core';
import { pad, style, width, wrap } from './ansi';

/*
 * Terminal painting for the tokens of core's shared Markdown parser (#83): the
 * grammar — and what a link or image may turn into — is settled there, so this
 * file only decides colours, wrapping and widths.
 */

type Paint = (text: string) => string;

interface Context {
  room: number;
  /** Applied under every inline run, so a heading or a table's header row keeps its style around code and emphasis. */
  base: readonly Paint[];
}

/** Render a model's Markdown into terminal lines no wider than `cols`. The text must already be sanitized. */
export function renderMarkdown(source: string, cols: number): string[] {
  return blocks(markdownTokens(source), { room: Math.max(1, cols), base: [] });
}

/** Index of the token closing the container opened at `open`. */
function closeOf(tokens: readonly MarkdownToken[], open: number): number {
  const { level } = tokens[open];
  for (let i = open + 1; i < tokens.length; i += 1) {
    if (tokens[i].nesting === -1 && tokens[i].level === level) return i;
  }
  return tokens.length - 1;
}

/**
 * The source line after the last one a block's content sits on. A container's
 * own `map` also covers the blank lines that trail it, which would hide the gap
 * to the block after it; its innermost tokens end where their text does.
 */
function lastLine(tokens: readonly MarkdownToken[]): number | null {
  let last: number | null = null;
  for (const token of tokens) {
    if (token.nesting === 0 && token.map && (last === null || token.map[1] > last)) last = token.map[1];
  }
  // A table's cells carry no map of their own, and its table_open's is exact.
  return last ?? tokens[0]?.map?.[1] ?? null;
}

function blocks(tokens: readonly MarkdownToken[], ctx: Context): string[] {
  const out: string[] = [];
  let previousEnd: number | null = null;

  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i];
    if (token.nesting === -1) continue;

    const end = token.nesting === 1 ? closeOf(tokens, i) : i;
    const children = tokens.slice(i + 1, end);
    const lines = block(token, children, ctx);
    const last = lastLine([token, ...children]);
    i = end;
    if (lines === null) continue;

    // The source's own blank lines decide where the gaps are: a tight list
    // stays tight, a loose one keeps its spacing, and a heading typed right
    // above its text is not pushed away from it.
    const start = token.map?.[0] ?? null;
    if (previousEnd !== null && start !== null && start > previousEnd && out.length > 0) out.push('');
    previousEnd = last ?? previousEnd;
    out.push(...lines);
  }
  return out;
}

function block(token: MarkdownToken, children: readonly MarkdownToken[], ctx: Context): string[] | null {
  switch (token.type) {
    case 'paragraph_open':
      return wrap(inline(children[0]?.children ?? [], ctx.base, '\n'), ctx.room);
    case 'heading_open': {
      const level = Number(token.tag.slice(1));
      const base = level <= 2 ? [style.bold, style.brand] : [style.bold];
      return wrap(inline(children[0]?.children ?? [], [...ctx.base, ...base], '\n'), ctx.room);
    }
    case 'fence':
    case 'code_block':
      return token.content.replace(/\n$/, '').split('\n')
        .flatMap((line) => wrap(`  ${line}`, ctx.room))
        .map(style.grey);
    case 'hr':
      return [style.grey('─'.repeat(ctx.room))];
    case 'blockquote_open': {
      const inner = blocks(children, { room: Math.max(1, ctx.room - 2), base: [...ctx.base, style.grey] });
      return inner.map((line) => `${style.grey('│')} ${line}`);
    }
    case 'bullet_list_open':
      return list(children, ctx, () => '•');
    case 'ordered_list_open': {
      const start = Number(token.attrs?.find(([name]) => name === 'start')?.[1] ?? 1);
      let n = start - 1;
      return list(children, ctx, (item) => {
        n += 1;
        return `${item.info || n}${item.markup || '.'}`;
      });
    }
    case 'table_open':
      return table(children, ctx);
    default:
      return null;
  }
}

function list(items: readonly MarkdownToken[], ctx: Context, marker: (item: MarkdownToken) => string): string[] {
  const out: string[] = [];
  let previousEnd: number | null = null;
  for (let i = 0; i < items.length; i += 1) {
    const item = items[i];
    if (item.type !== 'list_item_open') continue;
    const end = closeOf(items, i);
    const mark = marker(item);
    const hang = ' '.repeat(width(mark) + 1);
    const content = items.slice(i + 1, end);
    const inner = blocks(content, { ...ctx, room: Math.max(1, ctx.room - hang.length) });
    i = end;

    const start = item.map?.[0] ?? null;
    if (previousEnd !== null && start !== null && start > previousEnd) out.push('');
    previousEnd = lastLine(content) ?? previousEnd;
    (inner.length > 0 ? inner : ['']).forEach((line, row) => out.push(row === 0 ? `${mark} ${line}` : line && `${hang}${line}`));
  }
  return out;
}

// ── Inline ───────────────────────────────────────────────────────────────────

/**
 * An inline run as one painted string. Each word is painted on its own: the
 * wrapper breaks rows at spaces, and a style opened before a break would not
 * be open on the row after it.
 */
function inline(tokens: readonly MarkdownToken[], base: readonly Paint[], lineBreak: '\n' | ' '): string {
  const active: Paint[] = [...base];
  const paint = (text: string): string =>
    text.split(' ').map((word) => (word ? active.reduce((acc, apply) => apply(acc), word) : word)).join(' ');

  let out = '';
  let href: string | null = null;
  let linkText = '';
  const emit = (text: string): void => {
    out += paint(text);
    if (href !== null) linkText += text;
  };

  for (const token of tokens) {
    switch (token.type) {
      case 'text':
      case 'image':
        emit(token.content);
        break;
      case 'code_inline':
        active.push(style.brand);
        emit(token.content);
        active.pop();
        break;
      case 'softbreak':
      case 'hardbreak':
        out += lineBreak;
        break;
      case 'strong_open':
        active.push(style.bold);
        break;
      case 'em_open':
        active.push(style.italic);
        break;
      case 's_open':
        active.push(style.dim);
        break;
      case 'link_open':
        href = token.attrs?.find(([name]) => name === 'href')?.[1] ?? null;
        linkText = '';
        if (href !== null) active.push(style.underline);
        break;
      case 'link_close':
        if (href !== null) {
          active.pop();
          // A terminal cannot open what it does not print; a link whose text
          // already is the URL (an autolink) would only say it twice.
          if (linkText !== href) out += paint(' ') + style.grey(`(${href})`);
        }
        href = null;
        break;
      case 'strong_close':
      case 'em_close':
      case 's_close':
        active.pop();
        break;
      default:
        if (token.content) emit(token.content);
    }
  }
  return out;
}

// ── Tables ───────────────────────────────────────────────────────────────────

function table(tokens: readonly MarkdownToken[], ctx: Context): string[] {
  const headers: string[] = [];
  const rows: string[][] = [];
  let inHead = false;
  let row: string[] | null = null;

  for (const token of tokens) {
    if (token.type === 'thead_open') inHead = true;
    else if (token.type === 'thead_close') inHead = false;
    else if (token.type === 'tr_open') row = [];
    else if (token.type === 'tr_close' && row) {
      if (inHead) headers.push(...row);
      else rows.push(row);
      row = null;
    } else if (token.type === 'inline' && row) {
      row.push(inline(token.children ?? [], inHead ? [style.bold] : [], ' '));
    }
  }
  return renderTable(headers, rows, ctx.room);
}

function renderTable(headers: string[], rows: string[][], cols: number): string[] {
  const separator = ' │ ';
  const separatorWidth = width(separator);
  const available = Math.max(headers.length, cols - separatorWidth * (headers.length - 1));
  const natural = headers.map((header, column) =>
    Math.max(width(header), ...rows.map((row) => width(row[column] ?? ''))),
  );
  const columnWidths = fitTableColumns(natural, available);

  // A column that was already narrower than the floor is not a collapse.
  if (columnWidths.some((size, index) => size < Math.min(4, natural[index]))) return renderRecords(headers, rows, cols);

  const renderRow = (cells: string[]): string[] => {
    const wrapped = headers.map((_, index) => wrap(cells[index] ?? '', columnWidths[index]));
    const height = Math.max(...wrapped.map((cell) => cell.length));
    return Array.from({ length: height }, (_, line) =>
      wrapped.map((cell, column) => pad(cell[line] ?? '', columnWidths[column])).join(separator),
    );
  };

  const rule = columnWidths.map((size) => style.grey('─'.repeat(size))).join(style.grey('─┼─'));
  return [...renderRow(headers), rule, ...rows.flatMap(renderRow)];
}

function fitTableColumns(natural: number[], available: number): number[] {
  const widths = [...natural];
  let total = widths.reduce((sum, size) => sum + size, 0);
  while (total > available) {
    const widest = widths.reduce((best, size, index) => size > widths[best] ? index : best, 0);
    if (widths[widest] <= 3) break;
    widths[widest] -= 1;
    total -= 1;
  }
  return widths;
}

/**
 * A table too wide for the pane, one record per row. A rule separates the
 * records: a cell that wraps looks like the next field without one.
 */
function renderRecords(headers: string[], rows: string[][], cols: number): string[] {
  return rows.flatMap((row, rowIndex) => [
    ...(rowIndex === 0 ? [] : [style.grey('─'.repeat(cols))]),
    ...headers.flatMap((header, column) => wrap(`${header}: ${row[column] ?? ''}`, cols)),
  ]);
}
