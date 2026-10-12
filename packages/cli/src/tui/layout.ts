import { pad, sanitize, style, truncate, width, wrap, wrapLines, type WrapLine } from './ansi';
import { cursorInLines, type CursorPosition } from './editor';
import { checkpointCardLines, conversationLines, taskUsageText, usageMeasures, tokenLine } from './blocks';
import { chatEditorRoomFor, chatPaneWidth, planPaneWidth } from './geometry';
import { SLASH_COMMANDS, type SlashCategory } from './slash';
import { findTask, planRows, plannerInFlight, selectedPlanRow, waitingApproval, waitingCheckpoint, type PlanRow, type TaskView, type TuiState } from './state';
import { SUPERVISOR_LEVEL_LABEL } from '@ordewell/core';
import { modesForTask } from './taskAssignment';
import { cliVersion } from '../version';
import { TASK_EDITOR_KEYS, planFooterHints, planKeysByGroup } from './planKeys';
import { ALL_PROVIDERS, approvalLabel, awaitingLabel, hasHiddenDetail, resumeLabel, runnerForProvider, taskRowView, planUsage, type AiProvider, type ApprovalBlock, type DisplayBlock, type QueuedTaskMessage, type TaskStatusKind } from '@ordewell/core';

/**
 * What each pane's content actually is, and therefore how far it can scroll.
 *
 * `geometry.ts` exists because the reducer and the renderer both needed the
 * pane *widths* and their copies drifted. The same thing happened one level up:
 * the renderer clamped scrolling to the lines it had just built, while the
 * reducer grew the offset against an estimate — or against no bound at all — so
 * every notch past the real end was absorbed silently and the pane read as
 * frozen until the offset fell back under the bound.
 *
 * The line counts live here so both callers ask the same question. `render.ts`
 * keeps the chrome, the fitting, the pane join and the painting; the reducer
 * imports only the bounds. Nothing here touches state or emits anything.
 */

/** skills, status, input, footer — everything that is not the body. */
const CHROME_ROWS = 4;

// ── Chrome extents ───────────────────────────────────────────────────────────

/**
 * The chat input's wrapped lines, or `null` when the editor is blurred and
 * therefore always exactly one row (a literal newline would otherwise push
 * every row below it down one line).
 */
export function chatInputWrap(state: TuiState): WrapLine[] | null {
  const active = state.focus === 'chat' && !state.overlay;
  if (!active) return null;
  return wrapLines(state.editor.text, chatEditorRoomFor(state, true));
}

/**
 * The footer's key hints, unpainted. Kept next to the body extents because the
 * footer's height is what is left over for the body. The plan pane names only
 * the keys that fit the selected task and leaves the rest to the `?` sheet, so
 * it stays one row and the task list keeps the room.
 */
export function footerHints(state: TuiState): string[] {
  const selected = selectedPlanRow(state)?.task;
  // A planning turn in flight owns ESC ahead of whatever the pane would
  // otherwise bind it to. What ESC does there depends on what is waiting: a
  // queued prompt it takes back, otherwise the first press arms the stop and
  // the second commits it — so the hint names the state the key is actually in.
  // The arm itself is not named here: its cue is the status row's red line, and
  // a second one in the footer would say the same thing twice and change the
  // footer's height the moment the arm appeared.
  // The task view owns Esc while it is open, so the planner's turn-queue hint
  // would name a key behaviour that is not in force.
  const planning = plannerInFlight(state) && !state.taskView;
  const escHint = !planning ? null
    : state.queuedPrompts.length > 0 ? 'esc unsend'
    : 'esc ×2 stop planning';

  if (state.focus === 'plan') {
    // `expandedTaskId` alone only means subtask rows are revealed — the editor
    // hints belong to `taskEditor`, or a browsing parent would claim its keys
    // type into a prompt draft that isn't actually open.
    if (state.taskEditor) {
      return ['type to edit prompt', 'pgup/pgdn scroll', 'alt-enter newline', 'enter save', 'esc cancel'];
    }
    return [...(escHint ? [escHint] : []), ...planFooterHints(selected, state.status === 'executing')];
  }
  // The detail-all toggle names the direction it will go, like `m done` does.
  // Shown only once the conversation holds something it can expand: the
  // welcome alone must keep the footer to one row, or a short terminal
  // gives up a row of the welcome.
  const detailHint = hasHiddenDetail(state.taskView ? state.taskView.view.blocks : state.conversation.blocks)
    ? [state.detailAll ? 'ctrl-o collapse all' : 'ctrl-o expand all']
    : [];
  return [
    '/help', 'tab plan',
    ...detailHint,
    ...(escHint ? [escHint] : []),
    'ctrl-c quit',
  ];
}

/**
 * The queue's bubbles, one bubble per prompt, in queue order. Not part of the
 * conversation view: a prompt joins it only once it is sent.
 */
export function queuedPromptRows(state: TuiState, cols: number): string[] {
  return state.queuedPrompts.flatMap((text) => queuedBubble(text, cols));
}

/** One queued prompt wrapped under a dimmed marker, the takeback hint on its first row. */
function queuedBubble(text: string, cols: number): string[] {
  const room = Math.max(1, cols - width('◇  · queued · esc to unsend'));
  return wrap(text, room).map((line, i) => i === 0
    ? truncate(`${style.grey(`◇ ${line}`)} · queued · esc to unsend`, cols)
    : truncate(style.grey(`  ${line}`), cols));
}

/**
 * The task view's undelivered messages, one bubble each, in queue order. A
 * queued message has not reached the runner yet, and the highlighted one is
 * what ctrl-r takes back (and, with the composer empty, what ctrl-s sends
 * now); a handed-over one the runner already has and will show the model at
 * its next step; a forced one goes once the running turn is interrupted
 * (ADR-0023).
 */
export function taskQueuedRows(state: TuiState, cols: number): string[] {
  const tv = state.taskView;
  if (!tv) return [];
  return tv.view.queued.flatMap((message, i) => queuedTaskBubble(message, i === tv.queuedIndex, cols));
}

function queuedTaskTag({ handedOver, forced }: QueuedTaskMessage, selected: boolean): string {
  if (forced) return ' · sending now';
  if (handedOver) return ' · handed over';
  return selected ? ' · queued · ctrl-r removes' : ' · queued';
}

function queuedTaskBubble(message: QueuedTaskMessage, selected: boolean, cols: number): string[] {
  const { text } = message;
  const marker = selected ? style.accent('❯') : style.grey('◇');
  const tag = queuedTaskTag(message, selected);
  const room = Math.max(1, cols - width(`❯ ◇  ${tag}`));
  return wrap(text, room).map((line, i) => i === 0
    ? truncate(`${marker} ${selected ? style.bold(line) : line}${style.grey(tag)}`, cols)
    : truncate(`  ${line}`, cols));
}

/**
 * What the task view's state is, in the header's words: a runner request
 * waiting for an answer wins — the turn is live but stopped on it — then a
 * live turn, then what an `awaiting_user` task waits on (a checkpoint over
 * plain input), then the task's own status.
 */
function taskActivity(task: TaskView | undefined, working: boolean): string {
  const approvals = approvalLabel(task?.awaitingApproval);
  if (approvals) return inRow(approvals);
  if (working) return 'working';
  if (task?.status === 'awaiting_user') {
    const resumes = resumeLabel(task);
    return [inRow(awaitingLabel(task) ?? 'Waiting for your input'), resumes ? inRow(resumes) : ''].filter(Boolean).join(' · ');
  }
  return task?.status ?? '';
}

/** The task view's two pinned rows: the accent bar, and the keys it owns. */
function taskHeaderLines(state: TuiState, tv: NonNullable<TuiState['taskView']>, cols: number): string[] {
  const task = findTask(state.tasks, tv.taskId);
  const parts = [
    `→ Task ${task?.order ?? '?'}`,
    task?.title ?? '(task removed)',
    task?.assignedRunner ?? '',
    taskActivity(task, tv.view.working),
  ].filter(Boolean);
  const approval = waitingApproval(tv);
  const hint = approval
    ? ['ctrl-y allow', ...(approval.allowForTask ? ['ctrl-t allow for task'] : []), 'ctrl-g deny (composer text is the note)']
    : waitingCheckpoint(task)
      ? ['ctrl-y approve', 'ctrl-g reject (composer text is the reason)', 'ctrl-x interrupt']
      : task && resumeLabel(task)
        ? ['ctrl-x cancel resume']
        : ['ctrl-r remove queued', 'ctrl-x interrupt', 'ctrl-s send now'];
  if (approval && waitingCheckpoint(task)) hint.push('then the checkpoint');
  const index = tv.attempts.indexOf(tv.attempt);
  if (tv.attempts.length > 1) hint.push(`alt←/→ attempt ${index >= 0 ? index + 1 : 1}/${tv.attempts.length}`);
  hint.push('esc back');
  return [
    style.accent(truncate(parts.join(' · '), cols)),
    style.grey(truncate(hint.join(' · '), cols)),
  ];
}

/**
 * The standing arm of the in-flight turn's stop. Painted red at the paint site
 * and shown on the status row — always exactly one line, so appearing and
 * expiring never changes the body's height the way a footer hint would.
 */
export function stopHint(state: TuiState): string {
  return plannerInFlight(state) && state.stopArmed ? 'Press Esc again to stop' : '';
}

export function packHints(hints: string[], cols: number): string[] {
  const lines: string[] = [];
  let current = '';
  for (const hint of hints) {
    const next = current ? `${current} · ${hint}` : hint;
    if (current && next.length > cols) {
      lines.push(current);
      current = hint;
    } else {
      current = next;
    }
  }
  lines.push(current);
  return lines;
}

/**
 * Rows the body gets once the chrome has taken its share — the number the
 * renderer fits each pane to, and therefore the number every scroll bound is
 * measured against.
 */
export function bodyRows(state: TuiState): number {
  const input = chatInputWrap(state)?.length ?? 1;
  const footer = packHints(footerHints(state), state.cols).length;
  return Math.max(0, state.rows - CHROME_ROWS - input - footer + 2);
}

// ── Chat body ────────────────────────────────────────────────────────────────

interface ChatBodyMemo {
  blocks: readonly DisplayBlock[];
  cols: number;
  detailAll: boolean;
  lines: string[];
}

// The transcript is the single most expensive thing to render, but a spinner
// tick, a `status_update` flood or the user scrolling the plan pane never
// touch it — and core's conversation view hands back the same `blocks` array
// for anything that changes nothing. Memoising the lines on that reference
// lets those renders skip straight to re-fitting the cached body, which is
// what stops arrow-key scrolling on a task from lagging while a six-task plan
// runs. A single last-seen entry is all that can be reused, which is why the
// reducer asks for its scroll bound at the same width the renderer will paint
// at: the two of them share the one entry instead of evicting each other's.
let chatBodyMemo: ChatBodyMemo | null = null;

export function chatBodyLines(blocks: readonly DisplayBlock[], cols: number, detailAll: boolean, answering?: ApprovalBlock): string[] {
  const memo = chatBodyMemo;
  if (memo && memo.blocks === blocks && memo.cols === cols && memo.detailAll === detailAll) return memo.lines;
  const lines = conversationLines(blocks, cols, detailAll, answering);
  chatBodyMemo = { blocks, cols, detailAll, lines };
  return lines;
}

/**
 * The chat pane's content, the edge it hangs off, and how far back it can be
 * scrolled. `maxScroll` is the whole point: it is the exact number of lines
 * that exist above the viewport, so an offset clamped to it can never sit in a
 * dead zone the renderer will silently ignore.
 */
export interface ChatLayout {
  lines: string[];
  /** Rows pinned above the scrolling lines, which no scrolling moves. Empty for the planner chat. */
  header: string[];
  /** Rows pinned under the scrolling lines, which no scrolling moves. */
  footer: string[];
  anchor: 'top' | 'bottom';
  maxScroll: number;
}

export function chatLayout(state: TuiState, rows: number, cols: number): ChatLayout {
  const tv = state.taskView;
  // The task view draws the runner's own blocks; the planner chat draws the
  // conversation's. Both go through the same core view, so they paint alike.
  const blocks = tv ? tv.view.blocks : state.conversation.blocks;
  // The welcome (logo, setup, hints) heads the transcript for the whole
  // planning conversation and only goes once a plan exists — from then on the
  // plan pane owns the screen and the chat column is too narrow for it.
  const welcome = !tv && state.tasks.length === 0;
  // Not a block of the runner's log, so it stays out of the memoised body.
  const checkpoint = tv ? waitingCheckpoint(findTask(state.tasks, tv.taskId)) : undefined;
  const card = tv && checkpoint ? checkpointCardLines(findTask(state.tasks, tv.taskId)?.order ?? 0, checkpoint, cols, waitingApproval(tv) !== undefined) : [];
  const answering = chatBodyLines(blocks, cols, state.detailAll, tv ? waitingApproval(tv) : undefined);
  const body = card.length > 0 ? [...answering, ...card] : answering;
  const transcript = !welcome ? body : body.length === 0 ? welcomeLines(state, cols) : [...welcomeLines(state, cols), '', ...body];
  // The queued prompts paint as part of the tail, newest last — they are the
  // turns that have not gone out yet, and they travel where a sent message
  // would have appeared. A task's queue is its own, taken back one at a time.
  const bubbles = tv ? taskQueuedRows(state, cols) : queuedPromptRows(state, cols);
  const content = [...transcript, ...(bubbles.length > 0 ? ['', ...bubbles] : [])];
  const taskHeader = tv ? taskHeaderLines(state, tv, cols) : [];
  // The usage rows are the session's (or the opened task's), not lines of the
  // transcript: they keep the pane's bottom rows while everything above them
  // scrolls — unless the pane is a single row, which belongs to the conversation.
  const usage = rows <= 1 ? [] : tv ? taskUsageFooter(state, tv, blocks, cols) : tokenRow(blocks, cols);
  // The per-model rows are the expendable part: they yield to the transcript
  // so a short pane never trades its last conversation row for a breakdown.
  const footer = usage.slice(0, Math.max(1, rows - taskHeader.length - 1));
  const space = Math.max(0, rows - taskHeader.length - footer.length);
  // The welcome alone in a pane too short for it would lose its mark to the
  // newest-lines-win rule below, so the mark stays put while the rest scrolls.
  // Once the conversation starts, the welcome scrolls away like any line.
  const pinned = welcome && body.length === 0 && bubbles.length === 0 && content.length > space
    ? content.slice(0, Math.min(WELCOME_MARK_ROWS, space))
    : [];
  const header = [...taskHeader, ...pinned];
  const lines = content.slice(pinned.length);
  const room = space - pinned.length;
  // Content that fits hangs off the top so the welcome does not jump when the
  // first message lands; once it overflows the newest lines win the pane.
  return { lines, header, footer, anchor: lines.length > room ? 'bottom' : 'top', maxScroll: Math.max(0, lines.length - room) };
}

const tokenRow = (blocks: readonly DisplayBlock[], cols: number): string[] => {
  const line = tokenLine(blocks, cols);
  return line ? [line] : [];
};

/**
 * The opened task's usage for the attempt on screen: the same measures and
 * wall time its row used to carry, then one row per model when more than one
 * reported. `attemptUsage` is kept per attempt, so an earlier attempt shows its
 * own numbers; when it holds nothing for the attempt on screen (or the task has
 * no row-level usage at all) the log's own last usage block is the footer, as it
 * was before — it has no wall time to add.
 */
function taskUsageFooter(state: TuiState, tv: NonNullable<TuiState['taskView']>, blocks: readonly DisplayBlock[], cols: number): string[] {
  const task = findTask(state.tasks, tv.taskId);
  const reported = task?.attemptUsage ?? [];
  const onScreen = tv.attempt > 0 ? reported.find((a) => a.attempt === tv.attempt) : reported.at(-1);
  if (!task || !onScreen) return tokenRow(blocks, cols);
  const usage = taskRowView({ ...task, attemptUsage: [onScreen] }).usage;
  if (!usage) return tokenRow(blocks, cols);
  const models = usage.byModel ?? [];
  return [
    style.grey(truncate(taskUsageText(usage), cols)),
    ...(models.length > 1
      ? models.map((m) => style.grey(truncate(`${sanitize(m.model ?? 'unattributed')}: ${usageMeasures(m.totals, true).join(' · ')}`, cols)))
      : []),
  ];
}

/** How far back the chat pane can be scrolled at the size it is about to be painted. */
export function chatScrollMax(state: TuiState): number {
  return chatLayout(state, bodyRows(state), chatPaneWidth(state)).maxScroll;
}

// ── Welcome ──────────────────────────────────────────────────────────────────

/**
 * The planner backend as the welcome should name it, and whether it can
 * actually run: a coding agent needs its CLI installed, a vendor needs a key.
 */
function plannerSetup(state: TuiState): { label: string; ready: boolean } {
  const provider = state.plannerProvider as AiProvider;
  const registration = ALL_PROVIDERS[provider];
  if (!registration) return { label: 'not set', ready: false };
  const runner = runnerForProvider(provider);
  const ready = runner
    ? state.runners.some((r) => r.id === runner)
    : state.configuredProviders.includes(provider);
  return { label: registration.label, ready };
}

const SETUP_KEY_COLS = 10;
const SETUP_VALUE_COLS = 32;

/** The run settings (ADR-0030), the settings that let Ordewell act unasked drawn as a warning. */
function runSettingsValue(state: TuiState): string {
  const { supervisorLevel, mergeAtGatesAutomatically, autorun } = state.runSettings;
  const level = `supervisor ${SUPERVISOR_LEVEL_LABEL[supervisorLevel]}`;
  return [
    supervisorLevel === 'act' ? style.yellow(level) : level,
    `auto-merge ${mergeAtGatesAutomatically ? 'on' : 'off'}`,
    autorun ? style.yellow('autorun on') : 'autorun off',
  ].join(' · ');
}

function setupRow(label: string, value: string, command: string, cols: number): string {
  // Padded rather than truncated to the value column: a long model id keeps its
  // name and pushes the command right, instead of being cut to fit a grid.
  const gap = ' '.repeat(Math.max(2, SETUP_VALUE_COLS - width(value)));
  const head = `  ${style.grey(pad(label, SETUP_KEY_COLS))}${value}${gap}`;
  return truncate(`${head}${style.grey(command)}`, cols - 1);
}

// Plain ASCII: mathematical alphanumerics fall back to wider glyphs in most
// monospace fonts and overlap. Halves are painted separately so the cyan
// reset never clips the bold.
/**
 * The logo's icon on a braille dot grid (`#` stroke, `o` dot), traced from
 * assets/readme/logo-*.png: outer strokes that leave level, sweep into the
 * middle one and run on with it as one trunk, a one-dot gap, then the round
 * dot. Strokes are two dots thick because a line centred on 12 dot rows needs
 * an even width; the dot is three strokes across, as near the logo's four as
 * three rows allow. Only the top half is drawn — the bottom is its mirror.
 *
 * Braille rather than quadrant blocks: 2×4 dots a cell instead of 2×2 is what
 * lets three strokes and a round dot share three rows.
 */
const MARK_TOP_HALF = [
  '###...................',
  '######................',
  '....####..............',
  '......####.......oooo.',
  '........####....oooooo',
  '###############.oooooo',
];

/** Dot bits of a braille cell, by [row][column] within its 2×4 grid. */
const BRAILLE_BITS = [[0x01, 0x08], [0x02, 0x10], [0x04, 0x20], [0x40, 0x80]];

interface MarkCell { glyph: string; dot: boolean }

/** Each 4-dot band of the grid as one row of braille cells. */
function brailleRows(grid: string[]): MarkCell[][] {
  const bands = Array.from({ length: grid.length / 4 }, (_, b) => grid.slice(b * 4, b * 4 + 4));
  return bands.map((band) => Array.from({ length: Math.ceil(band[0].length / 2) }, (_, cell) => {
    let bits = 0;
    let dot = false;
    band.forEach((line, r) => BRAILLE_BITS[r].forEach((bit, c) => {
      const mark = line[cell * 2 + c];
      if (mark === '#' || mark === 'o') bits |= bit;
      if (mark === 'o') dot = true;
    }));
    return { glyph: String.fromCodePoint(0x2800 + bits), dot };
  }));
}

const MARK = brailleRows([...MARK_TOP_HALF, ...[...MARK_TOP_HALF].reverse()]);

/** Painted per frame, not at load: colour is only switched on or off once the terminal starts. */
const paintMark = (row: MarkCell[]): string => row.map(({ glyph, dot }) => dot ? style.cyan(glyph) : glyph).join('');

const MARK_GAP = '  ';

const VERSION = cliVersion();

/**
 * The middle row carries the wordmark and the version. Short of room the
 * version goes first, then the wordmark is cut; the mark itself is never
 * dropped, only cut like any row once the pane is narrower than it.
 */
function markLines(cols: number): string[] {
  const room = Math.max(0, cols - 1);
  const [top, mid, bottom] = MARK.map(paintMark);
  // Letter-spaced because a bold `ew` fuses: `w` fills its cell and synthetic
  // bold bleeds a pixel right. The halves are painted apart so the cyan reset
  // never clips the bold, with the join between them left unstyled.
  const spaced = (word: string): string => [...word].join(' ');
  const wordmark = `${style.bold(spaced('orde'))} ${style.bold(style.cyan(spaced('well')))}`;
  const named = `${mid}${MARK_GAP}${wordmark}`;
  const versioned = VERSION === 'unknown' ? named : `${named}${MARK_GAP}${style.grey(`v${VERSION}`)}`;
  const textRoom = room - width(mid) - MARK_GAP.length;
  const middle = width(versioned) <= room ? versioned
    : width(named) <= room ? named
    : textRoom > 0 ? `${mid}${MARK_GAP}${truncate(wordmark, textRoom)}`
    : truncate(mid, room);
  return [truncate(top, room), middle, truncate(bottom, room)];
}

/** The welcome's mark rows, which a pane too short for the whole welcome keeps pinned. */
const WELCOME_MARK_ROWS = MARK.length;

function welcomeLines(state: TuiState, cols: number): string[] {
  const planner = plannerSetup(state);
  const enabledRunners = state.runners.filter((r) => r.enabled).map((r) => r.name);
  const canPlan = planner.ready
    || state.runners.length > 0
    || state.configuredProviders.length > 0;

  const plannerValue = planner.ready
    ? [planner.label, state.orchestratorModel || style.yellow('no model')].join(style.grey(' · '))
    : style.yellow(planner.label === 'not set' ? 'not set' : `${planner.label} (unavailable)`);

  const prompt = wrap(style.bold('Describe a goal to start planning.'), Math.max(1, cols - 1));
  const setup = [
    style.bold('Setup'),
    setupRow('Planner', plannerValue, '/planner · /model', cols),
    setupRow(
      'Runners',
      enabledRunners.length > 0 ? enabledRunners.join(', ') : style.yellow('none enabled'),
      '/runners',
      cols,
    ),
    setupRow('Autonomy', state.autonomous ? style.yellow('Full') : 'Guarded', '/auto', cols),
    setupRow('Run', runSettingsValue(state), '/supervisor · /automerge · /autorun', cols),
    '',
  ];
  const notice = canPlan
    ? []
    : [
      ...wrap(
        style.yellow('Ordewell needs one coding agent installed (Claude Code, Codex, OpenCode) — or an API key from a provider such as OpenRouter, added with /key.'),
        Math.max(1, cols - 1),
      ),
      '',
    ];
  const tail = [...notice, style.grey('/help   all commands'), style.grey(state.workspace)];

  return [...markLines(cols), '', ...prompt, '', ...setup, ...tail];
}

// ── Plan pane ────────────────────────────────────────────────────────────────

const SPINNER = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

const STATUS_PAINT: Record<TaskStatusKind, (text: string) => string> = {
  done: style.green,
  running: style.yellow,
  quiet: style.cyan,
  failed: style.red,
  blocked: style.red,
  awaiting: style.yellow,
  todo: (text) => text,
};

/** `quiet` is static — distinct from both the busy spinner and the awaiting '?'. */
const STATUS_ICON: Record<Exclude<TaskStatusKind, 'running'>, string> = {
  done: '✓',
  failed: '✗',
  blocked: '!',
  awaiting: '?',
  quiet: '~',
  todo: '·',
};

/** A row's annotations run on inside a sentence, so core's sentence-case labels lose their capital. */
const inRow = (label: string): string => label.charAt(0).toLowerCase() + label.slice(1);

/** Inclusive indices into `PlanLayout.lines`. */
export interface LineSpan {
  start: number;
  end: number;
}

/**
 * The plan pane's content and the geometry the viewport is reasoned about in.
 * `lines[0]` is the header, which the pane pins — everything below it scrolls,
 * so at offset `n` the visible body is `lines[1 + n .. n + rows - 1]`.
 */
export interface PlanLayout {
  lines: string[];
  /** One span per plan row, in row order — rows are one to many lines tall. */
  rowSpans: LineSpan[];
  /** What the viewport must keep on screen: the open prompt's caret line, else the selected row. */
  anchor: LineSpan;
  /** Rows the pane is painted at, header included. */
  rows: number;
  maxScroll: number;
}

export function planLayout(state: TuiState, rows: number, cols: number): PlanLayout {
  const done = state.tasks.filter((t) => t.status === 'completed').length;
  const totalUsage = planUsage(state.tasks);
  const unmerged = state.runMerge?.handoff.landed.length ?? 0;
  const lines = [
    style.bold(truncate(`Plan ${done}/${state.tasks.length}`, cols)),
    totalUsage.attempts ? style.grey(truncate(`Tasks total: ${taskUsageText(totalUsage)}`, cols)) : '',
  ];
  if (unmerged > 0) {
    const hint = style.dim(truncate(`${unmerged} landed task${unmerged === 1 ? '' : 's'} not merged — /handoff merge`, cols));
    if (totalUsage.attempts) lines.push(hint);
    else lines[1] = hint;
  }
  const firstRowLine = lines.length;

  const rowSpans: LineSpan[] = [];
  const orderOf = new Map(state.tasks.map((task) => [task.id, task.order]));
  // An expanded task starts its editor at the end of its prompt. For a long
  // prompt, keeping only the task heading visible makes edits appear to do
  // nothing because the caret is below the viewport.
  let editorLine: number | undefined;
  planRows(state).forEach((row, i) => {
    const taskStart = lines.length;
    const renderedTask = taskLines(state, row, i, cols, orderOf);
    if (row.task.id === state.expandedTaskId && renderedTask.editorLine !== undefined) {
      editorLine = taskStart + renderedTask.editorLine;
    }
    lines.push(...renderedTask.lines);
    rowSpans.push({ start: taskStart, end: lines.length - 1 });
  });

  const selected = rowSpans[state.selectedTask] ?? { start: firstRowLine, end: firstRowLine };
  const anchor = editorLine === undefined ? selected : { start: editorLine, end: editorLine };
  return { lines, rowSpans, anchor, rows, maxScroll: Math.max(0, lines.length - rows) };
}

const clampOffset = (layout: PlanLayout, offset: number): number =>
  Math.max(0, Math.min(layout.maxScroll, offset));

/**
 * The offset that puts `span` fully on screen, moving `offset` no further than
 * that takes: one that is already visible stays put, one above lands on the
 * first body line, one below on the last. A span taller than the body cannot be
 * both, so its first line wins. Reaching the first row shows the spacer under
 * the header again rather than stopping one line short of it.
 */
export function revealOffset(layout: PlanLayout, offset: number, span: LineSpan): number {
  const at = clampOffset(layout, offset);
  const bodyHeight = layout.rows - 1;
  const first = span.start <= (layout.rowSpans[0]?.start ?? layout.anchor.start) ? 0 : span.start - 1;
  if (span.start < 1 + at || span.end - span.start + 1 > bodyHeight) return clampOffset(layout, first);
  if (span.end > at + layout.rows - 1) return clampOffset(layout, span.end - layout.rows + 1);
  return at;
}

/**
 * Where the plan pane's viewport actually sits: the absolute offset, clamped to
 * what exists. `null` means nothing has positioned it yet, so it is the least
 * scroll from the top that shows what the pane must keep on screen.
 */
export function planOffset(layout: PlanLayout, planScroll: number | null): number {
  if (planScroll === null) return revealOffset(layout, 0, layout.anchor);
  return clampOffset(layout, planScroll);
}

/**
 * The first row a viewport at `offset` shows in full, else the one covering its
 * top line — paging forward lands the selection where the reader's eye starts.
 */
export function topRowInView(layout: PlanLayout, offset: number): number {
  const top = 1 + offset;
  const whole = layout.rowSpans.findIndex((span) => span.start >= top && span.end <= offset + layout.rows - 1);
  if (whole >= 0) return whole;
  const covering = layout.rowSpans.findIndex((span) => span.end >= top);
  return covering >= 0 ? covering : layout.rowSpans.length - 1;
}

/** The mirror of `topRowInView`, for paging back. */
export function bottomRowInView(layout: PlanLayout, offset: number): number {
  const bottom = offset + layout.rows - 1;
  const spans = layout.rowSpans;
  for (let i = spans.length - 1; i >= 0; i--) {
    if (spans[i].start >= 1 + offset && spans[i].end <= bottom) return i;
  }
  for (let i = spans.length - 1; i >= 0; i--) {
    if (spans[i].start <= bottom) return i;
  }
  return 0;
}

/**
 * The row to keep selected once the viewport has moved to `offset`: the same
 * one while any of it is still on screen, otherwise the nearest one that is.
 */
export function rowNearestView(layout: PlanLayout, offset: number, row: number): number {
  const span = layout.rowSpans[row];
  if (!span) return row;
  if (span.end < 1 + offset) return topRowInView(layout, offset);
  if (span.start > offset + layout.rows - 1) return bottomRowInView(layout, offset);
  return row;
}

/** The plan pane's geometry at the size it is about to be painted. */
export function planScrollExtent(state: TuiState): PlanLayout {
  const cols = planPaneWidth(state);
  // A pane too narrow to show has nothing to scroll; measuring it anyway would
  // wrap every title to a column and invent an offset the user can never see.
  if (cols === 0) {
    return { lines: [], rowSpans: [], anchor: { start: 0, end: 0 }, rows: 0, maxScroll: 0 };
  }
  return planLayout(state, bodyRows(state), cols);
}

interface TaskLines {
  lines: string[];
  /** The zero-based line within `lines` containing the prompt editor caret. */
  editorLine?: number;
}

function taskLines(state: TuiState, planRow: PlanRow, index: number, cols: number, orderOf: ReadonlyMap<string, number>): TaskLines {
  const { task, parent } = planRow;
  const row = taskRowView(task, { parent, orderOf, modes: modesForTask(state.modesByRunner, task) });
  const selected = state.focus === 'plan' && index === state.selectedTask;
  const expanded = state.expandedTaskId === task.id;
  const rawIcon = row.status === 'running' ? SPINNER[state.spinnerFrame % SPINNER.length] : STATUS_ICON[row.status];
  const icon = STATUS_PAINT[row.status](rawIcon);
  const kind = row.running
    ? style.yellow('RUN')
    : row.kind === 'user'
      ? style.yellow('MAN')
      : row.kind === 'ops'
        ? style.magenta('OPS')
        : style.grey(' AI');
  const caret = selected ? style.cyan('❯') : ' ';

  // A subtask row names itself by its dotted order ("2.1") and steps in under
  // its parent; the top-level order number keeps its two-wide pad.
  const orderLabel = parent ? row.orderLabel : row.orderLabel.padStart(2);
  const indent = parent ? '  ' : '';
  const head = `${indent}${caret} ${icon} ${orderLabel} ${kind} `;
  const titleRoom = Math.max(1, cols - width(head));
  const wrappedTitle = wrap(task.title, titleRoom);
  const shownTitle = expanded ? wrappedTitle : wrappedTitle.slice(0, 2);
  if (!expanded && wrappedTitle.length > shownTitle.length) {
    const last = shownTitle.length - 1;
    shownTitle[last] = truncate(`${shownTitle[last]}…`, titleRoom);
  }
  const continuation = ' '.repeat(width(head));
  const lines = shownTitle.map((line, lineIndex) => {
    const prefix = lineIndex === 0 ? head : continuation;
    return prefix + (selected ? style.bold(line) : line);
  });

  const reported = [...new Set((row.usage?.byModel ?? []).flatMap((m) => (m.model ? [sanitize(m.model)] : [])))];
  const model = reported.length
    ? reported.join(', ')
    : task.assignedModel?.modelLabel ?? (task.type === 'ai' ? 'default model' : '');
  const effort = task.type === 'ai'
    ? `effort: ${task.assignedModel?.thinkingEffort ?? 'default'}`
    : '';
  const mode = task.type === 'ai'
    ? `mode: ${task.taskMode ?? 'default'}${row.autonomous ? style.yellow(' ⚡') : ''}`
    : '';
  const runner = task.assignedRunner ?? '';
  const bodyPad = parent ? '      ' : '    ';
  // "working" over an agent that has printed nothing for a minute hid the one
  // case that needs the user: an agent stopped at a question.
  const activity = row.approvals
    ? `${inRow(row.approvals)} — enter opens it`
    : row.status === 'quiet'
      ? 'quiet'
      : row.running ? 'working' : row.awaiting ? inRow(row.awaiting) : '';
  const skills = (task.skills ?? []).join(' · ');
  const origin = task.addedBy === 'supervisor' ? 'added by supervisor' : '';
  const meta = [activity, origin, runner, model].filter(Boolean).join(' · ');
  if (meta) lines.push(style.grey(truncate(`${bodyPad}${meta}`, cols)));
  // The one isolation state that needs the user; every other stays out of the
  // row and shows only in the expanded detail below.
  if (row.conflict) {
    const where = row.conflict.repo ? ` in ${row.conflict.repo}` : '';
    const files = row.conflict.files ? ` (${row.conflict.files})` : '';
    lines.push(style.red(truncate(`${bodyPad}⚠ merge conflict${where}${files} — its work is kept on its own branch`, cols)));
  }
  // `attempt` is absent only for a task shown straight from a reloaded plan,
  // before the live stream has caught up.
  if (row.repairing) {
    const files = row.repairing.files ? ` in ${row.repairing.files}` : '';
    const attempt = row.repairing.attempt ? ` (attempt ${row.repairing.attempt.attempt}/${row.repairing.attempt.limit})` : '';
    lines.push(style.yellow(truncate(`${bodyPad}↻ repairing conflict${files}${attempt}`, cols)));
  }
  // A merge gate holds the task as plainly as a task that waits on the user (ADR-0020).
  if (row.mergeGate) {
    lines.push(style.yellow(truncate(`${bodyPad}⏸ waits for Merge all — ${row.mergeGate.join(', ')} not merged into your branch yet`, cols)));
  }
  if (row.resumes) {
    lines.push(style.yellow(truncate(`${bodyPad}⏸ ${inRow(row.resumes)}, once the usage limit resets — c cancels the resume`, cols)));
  }
  if (row.opsChangedFiles) {
    lines.push(style.yellow(truncate(`${bodyPad}⚠ an ops task changed tracked files — check them, then m done or /retry`, cols)));
  }
  if (row.repaired?.landed) {
    lines.push(style.grey(truncate(`${bodyPad}↻ landed after repairing conflict in ${row.repaired.files}`, cols)));
  }

  let editorLine: number | undefined;
  if (expanded) {
    if (skills) lines.push(style.grey(truncate(`${bodyPad}skills: ${skills}`, cols)));
    if (effort || mode) lines.push(style.grey(truncate(`${bodyPad}${[effort, mode].filter(Boolean).join(' · ')}`, cols)));
    lines.push(style.grey(`${bodyPad}${task.status.replace(/_/g, ' ')}`));
    if (task.isolation && task.isolation.state !== 'none' && task.isolation.branch) {
      lines.push(...taskText('Branch', task.isolation.branch, cols, bodyPad));
      if (row.repos.length > 0) lines.push(...taskText('Repos', row.repos.join(', '), cols, bodyPad));
      // An integrated task's worktree is gone; naming it would point at nothing.
      if (task.isolation.state !== 'integrated' && task.isolation.worktree) {
        lines.push(...taskText('Worktree', task.isolation.worktree, cols, bodyPad));
      }
    }
    if (row.kind === 'ops') {
      lines.push(...taskText('Ops', 'Runs in your checkout, not a worktree, once the work it depends on is merged. O makes it a change task.', cols, bodyPad));
    }
    if (row.forcedPastGate) {
      lines.push(...taskText('Forced', `Started before the work of ${row.forcedPastGate.join(', ')} was merged into your branch.`, cols, bodyPad));
    }
    if (row.autonomous) {
      lines.push(...taskText('Autonomy', 'Runs without permission prompts (Full). Change the level with /auto.', cols, bodyPad));
    }
    // The prompt editor is seeded from prompt ?? description ?? title, so only
    // show the static description when it carries information the editor won't.
    const editableSeed = task.prompt ?? task.description ?? task.title;
    if (task.description && task.description !== task.title && task.description !== editableSeed) {
      lines.push(...taskText('Description', task.description, cols, bodyPad));
    }
    if (state.taskEditor) {
      // Wrap the prompt once and derive both the caret's line (for scroll
      // anchoring) and the painted rows from it — a second `cursorPosition`
      // call would re-wrap the whole prompt every frame.
      const room = Math.max(1, cols - width(bodyPad));
      const wrapped = wrapLines(state.taskEditor.text, room);
      const cp = cursorInLines(wrapped, state.taskEditor.cursor, state.taskEditor.text.length);
      editorLine = lines.length + 1 + cp.line;
      lines.push(...taskPromptLines(wrapped, cp, bodyPad));
    }
    if (row.dependencies.length > 0) {
      lines.push(...taskText('Depends on', row.dependencies.join(', '), cols, bodyPad));
    }
    // Two lines: the assignment keys plus the edit verbs no longer fit the plan
    // pane on one, and a truncated hint hides the keys it exists to teach. They
    // are named as what leaving the editor gets you, not as keys that work here
    // — while the prompt is open every letter types into it.
    lines.push(style.grey(`${bodyPad}enter save · esc cancel`));
    lines.push(style.grey(truncate(`${bodyPad}then R runner · o model · e effort · M mode · D deps · K skills`, cols)));
  }

  return { lines, editorLine };
}

function taskText(label: string, text: string, cols: number, pad = '    '): string[] {
  const room = Math.max(1, cols - width(pad));
  return [
    style.grey(`${pad}${label}`),
    ...wrap(text, room).map((line) => `${pad}${line}`),
  ];
}

/** Paints an already-wrapped prompt with its caret. Indented to match taskText. */
function taskPromptLines(wrapped: WrapLine[], cursor: CursorPosition, pad = '    '): string[] {
  return [
    style.grey(`${pad}Prompt`),
    ...wrapped.map(({ line }, i) => {
      if (i !== cursor.line) return `${pad}${line}`;
      const col = cursor.col;
      return `${pad}${line.slice(0, col)}${style.inverse(line.slice(col, col + 1) || ' ')}${line.slice(col + 1)}`;
    }),
  ];
}

// ── Help overlay ─────────────────────────────────────────────────────────────

const CATEGORY_TITLE: Record<SlashCategory, string> = {
  planning: 'Planning',
  tasks: 'Tasks',
  models: 'Models & providers',
  skills: 'Skills',
  session: 'Sessions',
  system: 'System',
};

/** Which sheet the help overlay shows: the slash commands, or the plan pane's keys (`?`). */
export type HelpSheet = 'commands' | 'keys';

/**
 * The sheet, the rows of it that fit, and how far it scrolls. The sheet
 * is taller than most terminals, and it is the one overlay with an offset of
 * its own — so it needs the same exact bound the panes do.
 */
export interface HelpLayout {
  lines: string[];
  /** Rows of the sheet the frame can show at once. */
  room: number;
  maxScroll: number;
}

/** The key sheet's rows: one table, grouped, built from the entries the footer picks its hints from. */
function keySheetBody(cols: number): string[] {
  const body: string[] = [];
  for (const [group, keys] of planKeysByGroup()) {
    body.push(style.bold(group));
    for (const { keys: label, meaning } of keys) {
      body.push(`  ${pad(label, Math.min(14, cols - 6))} ${style.grey(meaning)}`);
    }
    body.push('');
  }
  body.push(
    style.bold('While editing a task prompt'),
    ...TASK_EDITOR_KEYS.map(({ keys, meaning }) => `  ${pad(keys, Math.min(14, cols - 6))} ${style.grey(meaning)}`),
  );
  return body;
}

function commandSheetBody(cols: number): string[] {
  const body: string[] = [];
  for (const [category, title] of Object.entries(CATEGORY_TITLE) as [SlashCategory, string][]) {
    const commands = SLASH_COMMANDS.filter((c) => c.category === category);
    if (commands.length === 0) continue;
    body.push(style.bold(title));
    for (const command of commands) {
      body.push(`  ${pad(command.usage, Math.min(38, cols - 6))} ${style.grey(command.description)}`);
    }
    body.push('');
  }
  body.push(
    style.grey('tab switches panes · pgup/pgdn scroll · ctrl-o toggles full detail · esc takes back a queued prompt, otherwise esc twice stops · ctrl-l clears · ctrl-c quits'),
    style.grey('alt-enter inserts a newline · ? lists the plan pane\'s keys, once tab has put you there'),
  );
  // One line each: the sheet clips every line to the frame, and the task
  // view's keys run far past any width on a single one.
  body.push(
    '',
    style.bold('In a task view (enter on a task)'),
    style.grey('  ctrl-s sends now: interrupts the running step, then delivers the composer text — or, with it empty, the selected queued message'),
    style.grey('  ctrl-n/ctrl-p select a queued message · ctrl-r removes it · ctrl-x interrupts'),
    style.grey('  ctrl-y allows a tool request (its keys sit under it) · ctrl-t allows it for the task · ctrl-g denies it, with the composer text as the note'),
    style.grey('  at a checkpoint, ctrl-y approves and ctrl-g rejects, with the composer text as the reason · /checkpoint <id> approve|reject [reason] from anywhere'),
    style.grey('  alt←/→ changes attempt · esc returns'),
  );
  return body;
}

export function helpLayout(rows: number, cols: number, sheet: HelpSheet = 'commands'): HelpLayout {
  const body = sheet === 'keys' ? keySheetBody(cols) : commandSheetBody(cols);

  // The sheet is a table: clip long descriptions to one row each rather than
  // wrapping them, which would break the two-column alignment.
  const lines = body.map((line) => truncate(line, Math.max(1, cols - 2)));
  // One row for the frame's title, one for the sheet's own footer.
  const room = Math.max(1, rows - 2);
  return { lines, room, maxScroll: Math.max(0, lines.length - room) };
}

/** How far the help sheet can scroll at the size it is about to be painted. */
export function helpScrollMax(state: TuiState): number {
  const sheet = state.overlay?.kind === 'help' ? state.overlay.sheet : undefined;
  return helpLayout(bodyRows(state), state.cols, sheet).maxScroll;
}
