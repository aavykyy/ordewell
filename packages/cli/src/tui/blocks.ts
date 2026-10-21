import {
  diffRows, diffSummary, formatTokenCount, loadedSkillTokens, outputLines, outputPreview, usageText,
  type DiffRow, type DiffStat,
  type ApprovalBlock, type ApprovalKind, type ApprovalSource, type DisplayBlock, type MessageBlock, type MessageRole, type PlanBlock,
  type CommandBlock, type CommandStatus, type CompactionBlock, type RunnerLoadedBlock,
  type SkillLoadBlock, type SubagentBlock, type SubagentStatus, type ThinkingDisplayBlock, type ToolBlock,
} from '@ordewell/core';
import { graphemes, pad, sanitize, style, truncate, width, wrap, wrapLines } from './ansi';
import { renderMarkdown } from './markdown';

/*
 * How the chat pane draws core's display blocks (#51). Pure: a block, the pane
 * width and the detail-all switch in, painted lines out. Every text here came
 * from a model, a tool or a runner, so it is sanitized where it is drawn.
 */

type Paint = (text: string) => string;

function countOf(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? '' : 's'}`;
}

function firstLine(text: string): string {
  return sanitize(text).trim().split('\n')[0].trim();
}

/** The end of `text` that fits in `max` columns. */
function tailOf(text: string, max: number): string {
  const clusters = graphemes(text);
  let out = '';
  let used = 0;
  for (let i = clusters.length - 1; i >= 0 && used + width(clusters[i]) <= max; i--) {
    out = clusters[i] + out;
    used += width(clusters[i]);
  }
  return out;
}

// ── Messages and thinking ────────────────────────────────────────────────────

const ROLE_PREFIX: Record<MessageRole, Paint> = {
  user: (t) => `${style.bandGrey('❯')} ${t}`,
  planner: (t) => `${style.brand('◆')} ${t}`,
  agent: (t) => `${style.brand('◆')} ${t}`,
  supervisor: (t) => `${style.yellow('◇')} ${t}`,
  wake_up: (t) => style.yellow(`↯ ${t}`),
  system: (t) => style.grey(`· ${t}`),
  error: (t) => `${style.red('✗')} ${style.red(t)}`,
};

// A wrapped line's rows after the first keep the role's colour when the first
// row is painted as a whole (system grey, error red, wake_up yellow); the
// markdown roles carry their own colour inside the text and the user's rows
// sit on a band, so those stay as they were.
const ROLE_CONTINUATION: Partial<Record<MessageRole, Paint>> = {
  system: style.grey,
  error: style.red,
  wake_up: style.yellow,
};

function messageLines(block: MessageBlock, cols: number): string[] {
  const text = sanitize(block.text);
  const room = Math.max(1, cols - 2);
  const wrapped = block.role === 'planner' || block.role === 'agent' || block.role === 'supervisor'
    ? renderMarkdown(text, room)
    : block.skills ? skillPaintedLines(text, block.skills, room) : wrap(text, room);
  const rest: Paint = ROLE_CONTINUATION[block.role] ?? ((t) => t);
  const rows = wrapped.map((line, i) => (i === 0 ? ROLE_PREFIX[block.role](line) : rest(`  ${line}`)));
  if (block.role === 'user' && block.forced) {
    const note = style.grey(' · sent now');
    if (width(rows[0]) + width(note) <= cols) rows[0] += note;
    else rows.push(` ${note}`);
  }
  return block.role === 'user' ? onBand(rows, cols) : rows;
}

/** An empty row above and below, every row painted out to the pane's edge; with colour off only the empty rows remain. */
function onBand(rows: string[], cols: number): string[] {
  const band = ['', ...rows, ''];
  return style.enabled ? band.map((row) => style.band(pad(row, cols))) : band;
}

/** Wrapped, with each `/name` that loaded a skill painted as the composer paints one being typed. */
function skillPaintedLines(text: string, skills: readonly string[], room: number): string[] {
  const tokens = loadedSkillTokens(text, skills);
  return wrapLines(text, room).map(({ line, start }) => {
    let painted = '';
    let at = 0;
    for (const token of tokens) {
      const from = Math.max(token.start - start, at);
      const to = Math.min(token.end - start, line.length);
      if (to <= from) continue;
      painted += line.slice(at, from) + style.brand(line.slice(from, to));
      at = to;
    }
    return painted + line.slice(at);
  });
}

/** The path gives way first: it is the part a reader can do without. */
function skillLoadLine(block: SkillLoadBlock, cols: number): string {
  const head = block.attaches
    ? `● /${sanitize(block.name)} will be attached to fitting tasks · `
    : block.invokedBy === 'planner'
      ? `● ${sanitize(block.name)} skill loaded by planner · `
      : `● /${sanitize(block.name)} skill loaded · `;
  const line = truncate(`${head}${truncatePath(sanitize(block.path), Math.max(1, cols - width(head)))}`, cols);
  return `${style.green('●')}${style.grey(line.slice(1))}`;
}

function thinkingLines(block: ThinkingDisplayBlock, cols: number, detailAll: boolean): string[] {
  const text = sanitize(block.text).trim();
  const head = `∴ Thinking (${countOf(text ? text.split(/\s+/).length : 0, 'word')})`;
  if (detailAll) {
    const body = text ? wrap(text, Math.max(1, cols - 2)).map((line) => style.grey(`  ${line}`)) : [];
    return [style.grey(truncate(head, cols)), ...body];
  }
  const latest = block.streaming ? (text.split('\n').at(-1) ?? '').trim() : '';
  const room = cols - width(`${head} · `);
  if (!latest || room < 2) return [style.grey(truncate(head, cols))];
  // A live line grows at its end, so a row too short for it keeps the end;
  // the ellipsis says the slice starts mid-sentence.
  const shown = width(latest) > room ? `…${tailOf(latest, room - 1)}` : latest;
  return [style.grey(`${head} · ${shown}`)];
}

// ── Command rows ─────────────────────────────────────────────────────────────

/** Rows under a command's header hang off `⎿`, and every row after the first keeps its indent. */
const OUTPUT_HEAD = '  ⎿  ';
const OUTPUT_INDENT = '     ';
const PREVIEW_LINES = 3;

function underHeader(lines: string[]): string[] {
  return lines.map((line, i) => `${i === 0 ? style.grey(OUTPUT_HEAD) : OUTPUT_INDENT}${line}`);
}

/**
 * How a command that did not succeed says so, in the colours the old research
 * log marked outcomes with: a failure is red, a refusal or a denial yellow, a
 * call cut short grey.
 */
function unsettledOutcome(block: ToolBlock): { label: string; paint: Paint } | null {
  switch (block.status) {
    case 'error':
      return { label: 'Error', paint: style.red };
    case 'denied':
      return { label: block.outcome === 'refused' ? 'Refused' : 'Denied', paint: style.yellow };
    case 'interrupted':
      return { label: 'Interrupted', paint: style.grey };
    default:
      return null;
  }
}

/**
 * The header's mark. A call still out is hollow — a static glyph, since the
 * drawn rows are cached per block and a spinner would redraw every one of
 * them per tick.
 */
function commandMark(block: ToolBlock): string {
  if (block.status === 'pending') return style.grey('○');
  return (unsettledOutcome(block)?.paint ?? style.green)('●');
}

// One word with a slash and no scheme: a file path, whose last part is the
// part worth keeping. A URL keeps its host instead.
const PATH_LIKE = /^(?![a-z][a-z0-9+.-]*:\/\/)\S*\/\S*$/i;

/** Cut a path from the left to `max` columns, starting at a directory boundary when one fits. */
function truncatePath(path: string, max: number): string {
  if (width(path) <= max) return path;
  let tail = '';
  for (const char of graphemes(path).reverse()) {
    if (width(char + tail) > max - 1) break;
    tail = char + tail;
  }
  const slash = tail.search(/[\\/]/);
  return `…${slash > 0 ? tail.slice(slash) : tail}`;
}

/**
 * `● Name(keyArg)` on one row. The argument gives way first, so the row still
 * names the tool and still closes its parenthesis. In full detail the header
 * wraps instead: nothing there is cut.
 */
function commandHeader(block: ToolBlock, cols: number, detailAll: boolean): string[] {
  const name = sanitize(block.headline.name);
  const keyArg = sanitize(block.headline.keyArg);
  // A sealed run had no network, no home and kept nothing it wrote (ADR-0036 S4).
  const tag = block.sealed ? ' · sealed' : '';
  if (detailAll) {
    return wrap(`${name}(${keyArg})${tag}`, Math.max(1, cols - 2)).map((line, i) => (i === 0 ? `${commandMark(block)} ${line}` : `  ${line}`));
  }
  const open = `● ${name}(`;
  const room = cols - width(open) - 1 - width(tag);
  const cut = PATH_LIKE.test(keyArg) ? truncatePath(keyArg, room) : truncate(keyArg, room);
  const text = room > 1 ? `${open}${cut})${tag}` : truncate(`${open}${keyArg})${tag}`, cols);
  return [`${commandMark(block)}${text.slice(1)}`];
}

/** A command's arguments as a reader wants them: `key: value` rows, a multi-line value kept as its own lines. */
function argumentLines(args: string): string[] {
  if (!args.trim()) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(args);
  } catch {
    return sanitize(args).split('\n');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return sanitize(args).split('\n');
  return Object.entries(parsed).flatMap(([key, value]) => {
    const [first, ...rest] = sanitize(typeof value === 'string' ? value : JSON.stringify(value)).split('\n');
    return [`${key}: ${first}`, ...rest];
  });
}

/**
 * What hangs off `⎿`. Collapsed: a three-line preview that counts what it
 * hides, or one status line. In full detail: everything, wrapped.
 */
function resultLines(block: ToolBlock, room: number, detailAll: boolean): string[] {
  if (block.status === 'pending') return [style.grey('Running…')];
  const fit = (line: string): string[] => (detailAll ? wrap(line, room) : [truncate(line, room)]);
  const outcome = unsettledOutcome(block);
  if (outcome) {
    const [reason, ...rest] = outputLines(block.output).map(sanitize);
    const status = fit(reason ? `${outcome.label}: ${reason}` : outcome.label).map(outcome.paint);
    return detailAll ? [...status, ...rest.flatMap(fit).map(style.grey)] : status;
  }
  if (detailAll) {
    const lines = outputLines(block.output).map(sanitize);
    // The collapsed preview counts what it hides; the expanded view marks the
    // same rows with how to fold it back — the note flips rather than vanishes.
    const note = lines.length > PREVIEW_LINES ? ['… (ctrl+o to collapse)'] : [];
    return lines.length > 0 ? [...lines.flatMap(fit), ...note].map(style.grey) : [style.grey('(no output)')];
  }
  const { lines, hiddenLineCount } = outputPreview(block.output, PREVIEW_LINES);
  if (lines.length === 0) return [style.grey('(no output)')];
  const more = hiddenLineCount > 0 ? [`… +${countOf(hiddenLineCount, 'line')} (ctrl+o to expand)`] : [];
  return [...lines.map(sanitize), ...more].map((line) => style.grey(truncate(line, room)));
}

// A diff is read rather than skimmed, so its preview runs longer than a command's.
const DIFF_PREVIEW_ROWS = 10;

const DIFF_PAINT: Record<DiffRow['kind'], (text: string) => string> = {
  added: style.green,
  removed: style.red,
  context: style.grey,
  gap: style.grey,
};
const DIFF_SIGN: Record<DiffRow['kind'], string> = { added: '+', removed: '-', context: ' ', gap: '' };

/**
 * An edit as an editor shows one: what it changed, then its lines numbered,
 * marked `+` green and `-` red. Collapsed, the head of the diff and a count of
 * the rest; in full detail, all of it.
 */
function diffLines(block: ToolBlock, diff: DiffStat, room: number, detailAll: boolean): string[] {
  const rows = diffRows(block.output);
  const gutter = Math.max(0, ...rows.map((row) => String(row.line ?? '').length));
  const draw = (row: DiffRow): string[] => {
    const text = row.kind === 'gap' ? `${' '.repeat(gutter)} ⋮` : `${String(row.line ?? '').padStart(gutter)} ${DIFF_SIGN[row.kind]} ${sanitize(row.text)}`;
    return (detailAll ? wrap(text, room) : [truncate(text, room)]).map(DIFF_PAINT[row.kind]);
  };
  const shown = detailAll ? rows : rows.slice(0, DIFF_PREVIEW_ROWS);
  const hidden = rows.length - shown.length;
  const more = hidden > 0 ? [style.grey(`… +${countOf(hidden, 'line')} (ctrl+o to expand)`)] : [];
  return [diffSummary(diff), ...shown.flatMap(draw), ...more];
}

function toolLines(block: ToolBlock, cols: number, detailAll: boolean): string[] {
  const room = Math.max(1, cols - OUTPUT_INDENT.length);
  // An edit's arguments only restate its diff (the old and new text, the whole file written).
  const diff = block.diff && block.status === 'ok' ? block.diff : null;
  const args = detailAll && !diff ? argumentLines(block.args).flatMap((line) => wrap(line, room)).map((line) => OUTPUT_INDENT + style.grey(line)) : [];
  const result = diff ? diffLines(block, diff, room, detailAll) : resultLines(block, room, detailAll);
  return [...commandHeader(block, cols, detailAll), ...args, ...underHeader(result)];
}

// ── Subagents ────────────────────────────────────────────────────────────────

const SUBAGENT_PAINT: Record<SubagentStatus, Paint> = {
  running: style.yellow,
  done: style.green,
  failed: style.red,
  stopped: style.grey,
};

const CHILD_INDENT = '    ';

/**
 * `◆ Agent: brief  status · digest` on one row. The brief gives way before the
 * status, and the digest takes only what is left: how it ended is the part a
 * glance at the row is for.
 */
function subagentHeader(block: SubagentBlock, cols: number): string {
  const brief = firstLine(block.brief);
  const steps = block.children.filter((c) => c.type === 'tool').length;
  const status = block.status === 'running' && steps > 0 ? `running · ${countOf(steps, 'step')}` : block.status;
  const head = brief ? ' Agent: ' : ' Agent';
  const briefRoom = cols - width(`◆${head}  ${status}`);
  if (briefRoom < 4) return truncate(`◆${head}${brief}  ${status}`, cols);
  const named = `${style.brand('◆')}${head}${truncate(brief, briefRoom)}  ${SUBAGENT_PAINT[block.status](status)}`;
  const digest = firstLine(block.digest);
  const digestRoom = cols - width(named) - width(' · ');
  return digest && digestRoom >= 4 ? `${named}${style.grey(` · ${truncate(digest, digestRoom)}`)}` : named;
}

/** In full detail its calls sit indented beneath it, and what it handed back hangs off `⎿` as a command's output does. */
function subagentLines(block: SubagentBlock, cols: number, detailAll: boolean): string[] {
  const header = subagentHeader(block, cols);
  if (!detailAll) return [header];
  const childCols = Math.max(1, cols - CHILD_INDENT.length);
  const children = block.children.flatMap((child) => blockLines(child, childCols, true).map((line) => CHILD_INDENT + line));
  const digest = sanitize(block.digest).trim();
  const handedBack = digest ? underHeader(wrap(digest, Math.max(1, cols - OUTPUT_INDENT.length)).map(style.grey)) : [];
  return [header, ...children, ...handedBack];
}

// ── One-line markers ─────────────────────────────────────────────────────────

const APPROVAL_KIND: Record<ApprovalKind, string> = {
  shell_command: 'Run a command',
  url_fetch: 'Fetch a URL',
  web_search: 'Search the web',
  external_path: 'Read outside the workspace',
  mcp_tool: 'Use an MCP tool',
  mcp_server: 'Start a project MCP server',
  runner_tool: 'Use a tool',
  task_start: 'Start work',
};

// A request the user answered reads "Approved": naming `asked` would state the obvious.
const DECIDED_BY: Record<Exclude<ApprovalSource, 'asked'>, string> = {
  'pre-approved': 'pre-approved',
  remembered: 'remembered',
  mode: 'policy',
  'no-channel': 'no approval channel',
  excluded: 'excluded',
  guard: 'blocked address',
  secret: 'secret check',
  budget: 'web-read budget',
  unsupported: 'not usable on this runner version',
};

/** Status first, so a long subject is what the pane cuts. */
function approvalLine(block: ApprovalBlock, cols: number): string {
  const policy = block.decidedBy && block.decidedBy !== 'asked' ? DECIDED_BY[block.decidedBy] : undefined;
  const [mark, status, paint] = block.status === 'pending'
    ? ['?', 'Waiting for you', style.yellow]
    : block.status === 'granted'
      ? ['✓', policy ? `Auto-approved (${policy})` : block.forTask ? 'Approved for this task' : 'Approved', style.green]
      : block.status === 'withdrawn'
        ? ['·', 'Withdrawn', style.grey]
        : ['⊘', policy ? `Auto-denied (${policy})` : 'Denied', style.yellow];
  const note = block.note ? `: “${firstLine(block.note)}”` : '';
  const line = `${mark} ${status} · ${APPROVAL_KIND[block.kind]}: ${firstLine(block.subject)}${note}`;
  return `${paint(mark)}${truncate(line, cols).slice(mark.length)}`;
}

/** A settled request's body is a record, so a long one is counted rather than filling the transcript. */
const SETTLED_BODY_LINES = 20;

/**
 * What a script task's start was asked for, verbatim under the request's line
 * (ADR-0035). Waiting, it is whole: the pane scrolls, and the answer is about
 * exactly this. Settled, a long one is cut with the count of what is not shown.
 */
function approvalBodyLines(block: ApprovalBlock, cols: number): string[] {
  if (!block.body) return [];
  const lines = wrap(sanitize(block.body).replace(/\n+$/, '').replace(/\t/g, '    '), Math.max(1, cols - 4)).map((line) => `    ${line}`);
  if (block.status === 'pending' || lines.length <= SETTLED_BODY_LINES) return lines;
  const hidden = lines.length - SETTLED_BODY_LINES;
  return [...lines.slice(0, SETTLED_BODY_LINES), style.grey(`    … ${hidden} more ${hidden === 1 ? 'line' : 'lines'}`)];
}

/** Keys first, so a narrow pane cuts the optional parts and never `ctrl-y`. */
function approvalKeysLine(block: ApprovalBlock, cols: number): string {
  const keys = ['ctrl-y allow', ...(block.allowForTask ? ['ctrl-t allow for task'] : []), 'ctrl-g deny (composer text is the note)'];
  return style.grey(truncate(`  ${keys.join(' · ')}`, cols));
}

/**
 * The checkpoint a task waits at, in full: it is a question to a person, so no
 * line of it is cut — a long one wraps and the pane scrolls. The keys come
 * after it, and say so when a tool request has to be answered first.
 */
export function checkpointCardLines(order: number, question: string, cols: number, approvalFirst: boolean): string[] {
  const room = Math.max(1, cols - 2);
  const first = approvalFirst ? wrap('answer the tool request above first (ctrl-y / ctrl-g), then:', room) : [];
  return [
    truncate(`${style.accent('◆')} ${style.bold(`Task ${order} asks`)}`, cols),
    ...wrap(sanitize(question).trim(), room).map((line) => `  ${line}`),
    ...first.map((line) => style.grey(`  ${line}`)),
    ...CHECKPOINT_CHOICES.flatMap(([key, text]) => choiceLines(key, text, room)),
  ];
}

const CHECKPOINT_CHOICES: ReadonlyArray<readonly [string, string]> = [
  ['enter', 'reply: the task goes on with what you typed'],
  ['ctrl-y', 'approve as is'],
  ['ctrl-g', 'reject (with nothing typed, a plain no)'],
];
const CHOICE_KEY_WIDTH = 6;

/** The key in the accent, then its meaning wrapped under itself, so a narrow pane never cuts either. */
function choiceLines(key: string, text: string, room: number): string[] {
  const hang = CHOICE_KEY_WIDTH + 2;
  const [head = '', ...rest] = wrap(text, Math.max(1, room - hang));
  return [
    `  ${style.accent(style.bold(pad(key, CHOICE_KEY_WIDTH)))}  ${style.grey(head)}`,
    ...rest.map((line) => `  ${' '.repeat(hang)}${style.grey(line)}`),
  ];
}

// ── A task's runner commands (#66) ───────────────────────────────────────────

const COMMAND_PAINT: Record<CommandStatus, Paint> = {
  running: style.yellow,
  done: style.green,
  failed: style.red,
  stopped: style.grey,
};

/** `❯ /name args  status`, and what a command that runs without the model printed hanging off `⎿`. */
function runnerCommandLines(block: CommandBlock, cols: number, detailAll: boolean): string[] {
  const typed = sanitize(`/${block.name}${block.args ? ` ${block.args}` : ''}`);
  const status = `  ${block.status}`;
  const head = `${style.accent('❯')} ${truncate(typed, Math.max(1, cols - 2 - width(status)))}${COMMAND_PAINT[block.status](status)}`;
  const room = Math.max(1, cols - OUTPUT_INDENT.length);
  const printed = outputLines(block.output).map(sanitize);
  const shown = detailAll ? printed.flatMap((line) => wrap(line, room)) : printed.slice(0, PREVIEW_LINES).map((line) => truncate(line, room));
  return [head, ...underHeader(shown.map(style.grey))];
}

function compactionLine(block: CompactionBlock, cols: number): string {
  const sizes = block.preTokens !== undefined && block.postTokens !== undefined
    ? ` · ${formatTokenCount(block.preTokens)} → ${formatTokenCount(block.postTokens)} tokens`
    : '';
  const text = block.trigger === 'auto' && !sizes ? '≡ Context compacted by the runner on its own' : `≡ Context compacted${sizes}`;
  return style.grey(truncate(text, cols));
}

/** One line unless the pane shows detail: what a user's own setup brought into the task is there to look up, not to read every time. */
function runnerLoadedLines(block: RunnerLoadedBlock, cols: number, detailAll: boolean): string[] {
  const of = (kind: RunnerLoadedBlock['commands'][number]['kind']) => block.commands.filter((c) => c.kind === kind).map((c) => `/${sanitize(c.name)}`);
  const skills = of('skill');
  const commands = of('command');
  const builtins = of('builtin');
  const counts = [
    countOf(skills.length, 'skill'), countOf(commands.length, 'command'), countOf(builtins.length, 'built-in command'), countOf(block.mcpServers.length, 'MCP server'),
  ];
  const head = truncate(`● Runner loaded ${counts.join(', ')}`, cols);
  const lines = [`${style.green('●')}${style.grey(head.slice(1))}`];
  if (!detailAll) return lines;
  const room = Math.max(1, cols - OUTPUT_INDENT.length);
  const list = (label: string, names: string[]) => (names.length > 0 ? wrap(`${label}: ${names.join(' ')}`, room) : []);
  const servers = block.mcpServers.map((m) => `${sanitize(m.name)}${m.status ? ` (${sanitize(m.status)})` : ''}`);
  return [
    ...lines,
    ...[...list('skills', skills), ...list('commands', commands), ...list('built-in', builtins), ...(servers.length > 0 ? wrap(`MCP servers: ${servers.join(', ')}`, room) : [])]
      .map((line) => OUTPUT_INDENT + style.grey(line)),
  ];
}

function planLine(block: PlanBlock, cols: number): string {
  const count = block.taskCount === undefined ? '' : ` (${countOf(block.taskCount, 'task')})`;
  const text = block.status === 'building' ? 'Building plan…' : `Plan ${block.status}${count}`;
  return `${style.brand('◇')}${truncate(`◇ ${text}`, cols).slice(1)}`;
}

function blockLines(block: DisplayBlock, cols: number, detailAll: boolean): string[] {
  switch (block.type) {
    case 'message':
      return messageLines(block, cols);
    case 'thinking':
      return thinkingLines(block, cols, detailAll);
    case 'tool':
      return toolLines(block, cols, detailAll);
    case 'subagent':
      return subagentLines(block, cols, detailAll);
    case 'approval':
      return [approvalLine(block, cols), ...approvalBodyLines(block, cols)];
    case 'plan':
      return [planLine(block, cols)];
    case 'skill_load':
      return [skillLoadLine(block, cols)];
    case 'command':
      return runnerCommandLines(block, cols, detailAll);
    case 'compaction':
      return [compactionLine(block, cols)];
    case 'runner_loaded':
      return runnerLoadedLines(block, cols, detailAll);
    // Pinned under the pane rather than drawn in it — see `tokenLine`.
    case 'usage':
      return [];
  }
}

// ── The pane ─────────────────────────────────────────────────────────────────

interface Drawn {
  cols: number;
  detailAll: boolean;
  lines: string[];
}

// Core hands back the same object for every block an input did not touch, so
// a streaming reply re-draws only itself — Markdown and wrapping are the cost
// of a frame, and a long conversation would otherwise pay it per delta.
const drawnBlocks = new WeakMap<DisplayBlock, Drawn>();

function drawn(block: DisplayBlock, cols: number, detailAll: boolean): string[] {
  const cached = drawnBlocks.get(block);
  if (cached && cached.cols === cols && cached.detailAll === detailAll) return cached.lines;
  const lines = blockLines(block, cols, detailAll);
  drawnBlocks.set(block, { cols, detailAll, lines });
  return lines;
}

/** The conversation as chat-pane lines, a blank line after each block; `answering` is the request the task view's keys answer, which carries them under it. The token line is not among them. */
export function conversationLines(blocks: readonly DisplayBlock[], cols: number, detailAll: boolean, answering?: ApprovalBlock): string[] {
  const lines: string[] = [];
  for (const [i, block] of blocks.entries()) {
    if (block.type === 'usage') continue;
    lines.push(...drawn(block, cols, detailAll));
    if (block === answering) lines.push(approvalKeysLine(block, cols));
    // A skill load sits right under the message that loaded it.
    if (blocks[i + 1]?.type !== 'skill_load') lines.push('');
  }
  return lines;
}

/**
 * The planner's usage as one row — `ctx 61k (6%) · $0.42` — or null when
 * neither the context nor a cost is known. Core words it, so every surface
 * agrees; the totals already count every subagent.
 */
export function tokenLine(blocks: readonly DisplayBlock[], cols: number): string | null {
  const usage = blocks[blocks.length - 1];
  const text = usage?.type === 'usage' ? usageText(usage) : null;
  return text ? style.grey(truncate(text, cols)) : null;
}

/** A flagged assignment and what it means for the task as it stands (core words it, so every surface agrees). */
export function assignmentFlagText(row: { assignmentFlag: string | null; assignmentConsequence: string | null }): string {
  return `${row.assignmentFlag} — ${row.assignmentConsequence}`;
}
