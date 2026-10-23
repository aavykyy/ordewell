import type { DiscoveredModel, RunnerId, Task } from '../models/Task';
import { extractObjectsWithKey, stripTrailingCommas, escapeControlCharsInStrings, PlanParseError, TASK_QUERY_ENVELOPE_KEY } from './JsonExtractor';
import { readOnlyMode, type RunnerModeInfo } from './ModeResolver';
import type { LiveTail, LiveTailOptions } from '../interfaces/TaskOutputSource';
import { resolveTaskRef, taskRefOf } from './TaskRefs';
import { commandLine, scriptBodyOf } from '../models/ScriptTask';
import { betweenRounds, checkOf, loopRoundOf } from '../models/Loop';
import { handoffLines, type HandoffDigest } from '../models/Handoff';

/**
 * The planner's read channel: a `{"taskQuery":{...}}` reply asking Ordewell to
 * show it what the plan block deliberately leaves out.
 *
 * The plan block carries only short fields, so a planner asked to "add a line
 * to task 3's prompt" would be rewriting text it has never read. Inlining every
 * body on every turn was rejected — a twenty-task plan re-sends thousands of
 * tokens per message — so the planner asks instead, and pays for the detail
 * only on the turns it uses it.
 *
 * This module owns the wire shape and the rendering of the answer; the loop,
 * the budgets and the injection live in the Session, and the classification
 * lives in PlanRepair alongside the plan and task-ops envelopes.
 */

/** The long fields a query may ask for. Everything else is already in the plan block. */
export const TASK_QUERY_FIELDS = [
  'description', 'prompt', 'userSteps', 'verdict', 'outputSummary', 'handoff', 'userStoriesCovered', 'skills', 'output',
] as const;

export type TaskQueryField = typeof TASK_QUERY_FIELDS[number];

/** What `task_query` reads: every field but `output`, which has its own tool (ADR-0022). */
export const TASK_QUERY_TASK_FIELDS = TASK_QUERY_FIELDS.filter((f): f is Exclude<TaskQueryField, 'output'> => f !== 'output');

/** Where a handoff's digest sends a planner for what it leaves out (ADR-0047): the attempt's log, read with `task_output`. */
export function handoffRest(handoff: HandoffDigest): string {
  const shown = handoff.findings.length;
  return handoff.findingCount > shown
    ? `Findings F${shown + 1} to F${handoff.findingCount} and the report are in the attempt's log: read them with task_output.`
    : 'The report, if the task wrote one, is in the attempt\'s log: read it with task_output.';
}

/** Lines a `output` read returns when the query sets no count. */
export const OUTPUT_LINES_DEFAULT = 80;
/** Hard cap on `outputLines` — the tail read is bounded however the planner asks. */
export const OUTPUT_LINES_MAX = 400;

/**
 * Character budget the rendered answer converges to. A running output tail is
 * the only part with no natural bound — a runner may print for minutes — so
 * the tail absorbs the clamp; everything else (task bodies, the catalog cap)
 * is bounded upstream.
 */
export const TASK_QUERY_ANSWER_MAX_CHARS = 20_000;
/** Room for the closing instruction and whatever follows a task's tail. */
const ANSWER_TAIL_RESERVE = 4_000;
/** The most an output read returns; what a read of one task's tail gets when nothing else is in the answer. */
export const OUTPUT_TAIL_MAX_CHARS = TASK_QUERY_ANSWER_MAX_CHARS - ANSWER_TAIL_RESERVE;

export interface TaskQuery {
  /** Task references to read in full, as {@link resolveTaskRef} reads them. */
  tasks: string[];
  /** Narrows what comes back. Omitted means every field in {@link TASK_QUERY_FIELDS}. */
  fields?: TaskQueryField[];
  /** Also return the full runner/model catalog with labels, variants and mode descriptions. */
  catalog: boolean;
  /** Line count for `output` reads. Clamped at render to [1, {@link OUTPUT_LINES_MAX}]. */
  outputLines?: number;
  /** A previous answer's next offset: the output tail then covers only what came after it. */
  outputSince?: number;
}

export function textHasTaskQuery(text: string): boolean {
  return text.includes(`"${TASK_QUERY_ENVELOPE_KEY}"`);
}

/** Parse a `{"taskQuery":...}` reply. Throws PlanParseError when the JSON is unusable. */
export function parseTaskQueryJson(text: string): TaskQuery {
  const { matches, fallback } = extractObjectsWithKey(text, TASK_QUERY_ENVELOPE_KEY);
  const candidates = matches.length > 0 ? [...matches].reverse() : [fallback.json];

  let lastError: PlanParseError | null = null;
  for (const json of candidates) {
    try {
      return parseTaskQueryObject(json, text);
    } catch (err) {
      if (!(err instanceof PlanParseError)) throw err;
      if (!lastError) lastError = err;
    }
  }
  throw lastError ?? new PlanParseError('No JSON object found in task-query reply', text);
}

function parseTaskQueryObject(json: string, text: string): TaskQuery {
  let parsed: unknown;
  try {
    parsed = JSON.parse(escapeControlCharsInStrings(stripTrailingCommas(json)));
  } catch (err) {
    throw new PlanParseError(`Task-query JSON is invalid: ${err instanceof Error ? err.message : String(err)}`, text);
  }
  const raw = (parsed as { taskQuery?: unknown }).taskQuery;
  // A bare array is the shorthand models reach for; it means "read these tasks".
  const body = Array.isArray(raw) ? { tasks: raw } : raw;
  if (typeof body !== 'object' || body === null) {
    throw new PlanParseError('"taskQuery" must be an object (or an array of task references)', text);
  }

  const { tasks: rawTasks, fields: rawFields, catalog: rawCatalog, outputLines: rawLines, outputSince: rawSince } = body as Record<string, unknown>;

  const tasks: string[] = [];
  if (rawTasks !== undefined) {
    if (!Array.isArray(rawTasks)) throw new PlanParseError('"tasks" in a taskQuery must be an array of task references', text);
    for (const ref of rawTasks) {
      if (typeof ref !== 'string' && typeof ref !== 'number') {
        throw new PlanParseError(`Invalid task reference "${String(ref)}" in taskQuery`, text);
      }
      tasks.push(String(ref).trim());
    }
  }

  let fields: TaskQueryField[] | undefined;
  if (rawFields !== undefined) {
    if (!Array.isArray(rawFields)) throw new PlanParseError('"fields" in a taskQuery must be an array of field names', text);
    fields = [];
    for (const f of rawFields) {
      if (typeof f !== 'string' || !(TASK_QUERY_FIELDS as readonly string[]).includes(f)) {
        throw new PlanParseError(`Unknown taskQuery field "${String(f)}" — choose from ${TASK_QUERY_FIELDS.join(', ')}`, text);
      }
      fields.push(f as TaskQueryField);
    }
  }

  const catalog = rawCatalog === true;

  let outputLines: number | undefined;
  if (rawLines !== undefined) {
    if (typeof rawLines !== 'number' || !Number.isFinite(rawLines) || rawLines < 1) {
      throw new PlanParseError('"outputLines" in a taskQuery must be a positive number of lines', text);
    }
    outputLines = rawLines;
  }

  let outputSince: number | undefined;
  if (rawSince !== undefined) {
    if (typeof rawSince !== 'number' || !Number.isFinite(rawSince) || rawSince < 0) {
      throw new PlanParseError('"outputSince" in a taskQuery must be the non-negative offset a previous answer reported', text);
    }
    outputSince = rawSince;
  }

  if (tasks.length === 0 && !catalog) {
    throw new PlanParseError('A taskQuery must name at least one task or set "catalog": true', text);
  }
  return { tasks, fields, catalog, outputLines, outputSince };
}

/** Stable identity of a query, so a turn can recognise the planner asking the same thing twice. */
export function taskQuerySignature(query: TaskQuery): string {
  return JSON.stringify([query.tasks, query.fields ?? null, query.catalog, query.outputLines ?? null, query.outputSince ?? null]);
}

// ---------------------------------------------------------------------------
// The answer — the block Ordewell injects in reply to a read.
// ---------------------------------------------------------------------------

/** What a full-catalog read is answered from. Models arrive already allowlist-filtered. */
export interface TaskQueryCatalog {
  runners: RunnerId[];
  models: Partial<Record<RunnerId, DiscoveredModel[]>>;
  modes: Record<RunnerId, RunnerModeInfo[]>;
  autonomousDefault: boolean;
}

/**
 * Appended when the planner has spent its read budget, or asked the identical
 * question twice. The detail still comes back — refusing it would leave the
 * planner editing text it has not read, which is the whole failure this
 * channel exists to prevent — but the turn is told to land.
 */
export const TASK_QUERY_ANSWER_OR_OPS =
  'You have now read everything you asked for. Do not send another taskQuery this turn: ' +
  'answer the user in prose, or emit the taskOps JSON for the change you came to make.';

/** {@link TASK_QUERY_ANSWER_OR_OPS} for a planner that reads and edits through tools. */
export const TASK_READ_ANSWER_OR_EDIT =
  'You have now read everything you asked for. Do not read again this turn: ' +
  'answer the user in prose, or call edit_plan for the change you came to make.';

/**
 * The protocol as the planner is taught it, owned here beside the parser so the
 * two cannot drift. Both planner backends get these lines verbatim (ADR-0009):
 * a harness planner has no tool loop to reach, so the envelope is the channel.
 */
export const TASK_QUERY_PROTOCOL: string[] = [
  'READING A TASK BEFORE YOU EDIT IT:',
  'The plan block you are shown (whole once per live context, then what changed) carries only short fields — it never contains a task\'s prompt, its user steps, or a completed task\'s verdict. Never rewrite a field you have not read. To read one, reply with ONLY this JSON object:',
  `  {"${TASK_QUERY_ENVELOPE_KEY}":{"tasks":["<id or #order>", "..."],"fields":[${TASK_QUERY_FIELDS.map((f) => `"${f}"`).join(', ')}],"catalog":true}}`,
  '- "tasks": one or more task references. Ask for everything you need in ONE query — each query costs a round-trip.',
  '- "fields": optional. Omit it to get every field above.',
  '- "fields" may include "output": the recent clean output of a task that is running right now — the way to diagnose a task that looks stuck mid-execution. "outputLines" (default 80, at most 400) sets how many lines; "outputSince" resumes a previous read at the offset its answer reported. A task that is not running answers with a pointer to its outputSummary, handoff and verdict instead.',
  '- "catalog": optional. Set it to true for the full runner and model catalog — every model id with its label and thinking-effort variants, and whether each runner takes read-only tasks. It works before any task exists, and may be used on its own.',
  'Ordewell answers immediately with the detail and changes nothing. Then reply again with your taskOps JSON, or with prose for the user.',
  'Three queries per user message; after that every answer also tells you to land the turn. Do not ask the same question twice.',
];

/**
 * {@link TASK_QUERY_PROTOCOL} for a planner that has Ordewell's tools (ADR-0022):
 * the same reads, as calls, with the same budget.
 */
export const TASK_READ_TOOLS_PROTOCOL: string[] = [
  'READING A TASK BEFORE YOU EDIT IT:',
  'The plan block you are shown (whole once per live context, then what changed) carries only short fields — it never contains a task\'s prompt, its user steps, or a completed task\'s verdict. Never rewrite a field you have not read. Read with these tools; they change nothing:',
  '- task_query: "tasks" are one or more task references ("<id or #order>"). Ask for everything you need in ONE call. "fields" is optional (omit it to get description, prompt, userSteps, verdict, outputSummary, handoff, userStoriesCovered and skills). A handoff is what a task told the tasks after it: a summary, findings F1, F2, … and artifacts. "catalog": true also returns every runner with its models, thinking-effort variants and modes.',
  '- task_output: the recent output of a task that is running right now — the way to diagnose a task that looks stuck mid-execution. "lines" (default 80, at most 400) sets how many; pass an answer\'s "nextOffset" back as "since" to read only what follows. A task that is not running answers with its verdict, output summary, its whole handoff, its findings and report, and a digest of its last attempt. Supply "attempt" (a saved attempt number) or "kinds" (TaskLogEvent types such as tool_call, tool_result, error, text, approval_requested, approval_decided, usage) to read its structured log; attempt defaults to latest. Continue truncated entries with since/nextOffset.',
  '- task_diff: changes since a task started, with repo paths and file stats. Pass "path" for one file patch and "repo" to select a repository. Page with since/nextOffset. Shared runs without task-specific records report not available.',
  'Three reads per user message; after that every answer also tells you to land the turn, and after six they are refused. Do not ask the same question twice.',
  'Once a plan exists, change it with edit_plan — the last whole plan block shows you its operations; later turns only say what changed. Never reply with taskOps or taskQuery JSON.',
];

/** The one-line reminder the whole plan block carries, so the protocol has a single owner. */
export const TASK_QUERY_REMINDER =
  `- To READ a task in full (prompt, user steps, verdict, output, handoff, user stories) or the whole model/mode catalog before editing, reply with ONLY {"${TASK_QUERY_ENVELOPE_KEY}":{"tasks":["<id or #order>"],"catalog":true}} — it changes nothing, and you then reply again with your ops.`;

/** {@link TASK_QUERY_REMINDER} for a planner that has Ordewell's tools. */
export const TASK_READ_TOOLS_REMINDER =
  '- To READ a task in full (prompt, user steps, verdict, handoff, user stories), a running task\'s output, or the whole model/mode catalog before editing, call task_query, task_output or task_diff — they change nothing — and then call edit_plan with your ops.';

/**
 * Where an `output` read is answered from: the orchestrator's live capture of
 * the task's latest attempt. Injected so this module stays planner-side and
 * never imports the orchestrator.
 */
export type LiveOutputLookup = (taskId: string, opts: LiveTailOptions) => LiveTail | null;

interface OutputRenderContext {
  liveOutput?: LiveOutputLookup;
  outputLines: number;
  outputSince?: number;
  /** Chars committed to the answer so far, so a tail is clamped against what remains. */
  used: number;
}

/** Keep the newest of an over-long tail, dropping whole lines from the front. */
export function fitTail(text: string, budget: number): { text: string; trimmed: boolean } {
  if (text.length <= budget) return { text, trimmed: false };
  if (budget <= 0) return { text: '', trimmed: true };
  const lines = text.split('\n');
  const kept: string[] = [];
  let total = 0;
  for (let i = lines.length - 1; i >= 0; i--) {
    const cost = lines[i].length + (kept.length > 0 ? 1 : 0);
    if (total + cost > budget) break;
    kept.unshift(lines[i]);
    total += cost;
  }
  if (kept.length === 0) return { text: text.slice(text.length - budget), trimmed: true };
  return { text: kept.join('\n'), trimmed: true };
}

function renderLiveOutput(taskId: string, ctx: OutputRenderContext): string[] {
  const tail = ctx.liveOutput?.(taskId, { maxLines: ctx.outputLines, sinceOffset: ctx.outputSince }) ?? null;
  if (!tail) return ['output: (no captured output — the task has not run in this session)'];
  if (!tail.running) return ['output: (not running — read "outputSummary", "handoff" and "verdict" for how it ended)'];
  if (!tail.text) return [`output: (running; nothing new past offset ${tail.nextOffset})`];
  const budget = Math.max(0, TASK_QUERY_ANSWER_MAX_CHARS - ctx.used - ANSWER_TAIL_RESERVE);
  const fitted = fitTail(tail.text, budget);
  const trimmed = fitted.trimmed ? 'earliest output trimmed to fit the answer budget; ' : '';
  return [
    `output: (running; ${trimmed}pass offset ${tail.nextOffset} back as "outputSince" to read only what follows)`,
    ...fitted.text.split('\n'),
  ];
}

function renderField(task: Task, field: TaskQueryField, ctx: OutputRenderContext, tasks: readonly Task[]): string[] {
  switch (field) {
    case 'description':
      return [`description: ${task.description || '(none)'}`];
    case 'prompt':
      if (task.type === 'script') return scriptBodyLines(task);
      return task.prompt ? ['prompt:', task.prompt] : ['prompt: (none)'];
    case 'userSteps': {
      const steps = task.userSteps ?? [];
      if (steps.length === 0) return ['userSteps: (none)'];
      return ['userSteps:', ...steps.map((s) => `  ${s.order}. [${s.completed ? 'x' : ' '}] ${s.instruction}`)];
    }
    case 'verdict': {
      const v = task.verdict;
      if (!v) return ['verdict: (none)'];
      const checks = v.checks.map((c) => `${c.name}=${c.skipped ? 'skipped' : c.passed ? 'pass' : 'fail'}`).join(', ');
      return [`verdict: ${v.outcome.toUpperCase()} — ${v.reason}${checks ? ` [${checks}]` : ''}`];
    }
    case 'outputSummary': {
      const o = task.outputSummary;
      if (!o) return ['outputSummary: (none)'];
      // A task with a handoff carries its report there.
      const report = task.handoff ? undefined : o.report;
      return [`outputSummary: ${o.reviewReason}`, ...(report ? ['report:', report] : []), ...(o.logTail ? ['log tail:', o.logTail] : [])];
    }
    case 'handoff': {
      const h = task.handoff;
      if (!h) return ['handoff: (none)'];
      return ['handoff:', ...handoffLines(h, (id) => taskRefOf(tasks, id)), '(The whole handoff, report and all, is in the attempt\'s log.)'];
    }
    case 'userStoriesCovered': {
      const stories = task.userStoriesCovered ?? [];
      if (stories.length === 0) return ['userStoriesCovered: (none)'];
      return ['userStoriesCovered:', ...stories.map((s) => `  - ${s}`)];
    }
    case 'skills':
      return [`skills: ${task.skills?.length ? task.skills.join(', ') : '(none)'}`];
    case 'output':
      return renderLiveOutput(task.id, ctx);
  }
}

const TYPE_LABELS: Record<Task['type'], string> = { ai: 'AI', user: 'MAN', script: 'SCRIPT' };

/** A script task's body in place of a prompt (ADR-0035): each command as typed, or the script, and its time limit. */
function scriptBodyLines(task: Task): string[] {
  const body = scriptBodyOf(task);
  if (!body) return ['body: (none)'];
  const limit = `timeoutMs: ${body.timeoutMs}`;
  return 'commands' in body ? ['commands:', ...body.commands.map((argv) => `  $ ${commandLine(argv)}`), limit] : ['script:', body.script, limit];
}

/** Where a task stands in a loop (ADR-0045): a check's body and round, or the check a body task runs for. */
function loopLines(task: Task, tasks: readonly Task[]): string[] {
  const named = (id: string) => `${taskRefOf(tasks, id) ?? id}`;
  if (task.loop) {
    const between = betweenRounds(task) ? `; failed round ${loopRoundOf(task)}, so its body is fixing what it found and it runs again after` : `; round ${loopRoundOf(task)}`;
    return [`loop: body ${task.loop.body.map(named).join(', ')}; at most ${task.loop.maxRounds} rounds${between}`];
  }
  const check = checkOf(tasks, task.id);
  return check ? [`loop: in the body of ${named(check.id)} "${check.title}", so it runs only when that check fails`] : [];
}

function renderTask(task: Task, ref: string, fields: readonly TaskQueryField[], ctx: OutputRenderContext, tasks: readonly Task[]): string[] {
  // The tail renders after the task's other fields and before the closing
  // blank, so its budget is computed against everything already committed —
  // including this task's own bounded fields.
  const lines = [
    `${ref} id=${task.id} "${task.title}" [${task.status}] type:${TYPE_LABELS[task.type]}`,
    ...loopLines(task, tasks),
    ...fields.filter((f) => f !== 'output').flatMap((f) => renderField(task, f, ctx, tasks)),
    ...(fields.includes('output') ? renderLiveOutput(task.id, ctx) : []),
    '',
  ];
  ctx.used += lines.reduce((n, l) => n + l.length + 1, 0);
  return lines;
}

function renderCatalog(catalog: TaskQueryCatalog): string[] {
  const lines: string[] = [];
  for (const runner of catalog.runners) {
    const models = catalog.models[runner] ?? [];
    lines.push(`${runner} models:`);
    if (models.length === 0) lines.push('  (none discovered)');
    for (const m of models) {
      const variants = m.variants?.length
        ? ` variants: ${m.variants.map((v) => `${v.id}${v.label && v.label !== v.id ? ` (${v.label})` : ''}`).join(', ')}`
        : ' variants: none';
      lines.push(`  - ${m.modelId} — ${m.modelLabel}${variants}`);
    }
    lines.push(`${runner} takes read-only tasks: ${readOnlyMode(catalog.modes[runner]) ? 'yes' : 'no'}`);
  }
  return lines;
}

/**
 * Render the injected answer to one read. Never persisted — it is context for
 * the planner's next reply and nothing else — so it is built fresh from live
 * state on every query rather than cached. `liveOutput` backs the `output`
 * field; omitting it reads as "nothing captured".
 */
export function renderTaskQueryAnswer(
  query: TaskQuery,
  tasks: readonly Task[],
  catalog: TaskQueryCatalog,
  liveOutput?: LiveOutputLookup,
): string {
  const fields = query.fields ?? TASK_QUERY_FIELDS;
  const ctx: OutputRenderContext = {
    liveOutput,
    outputLines: Math.min(Math.max(1, Math.round(query.outputLines ?? OUTPUT_LINES_DEFAULT)), OUTPUT_LINES_MAX),
    outputSince: query.outputSince,
    used: 0,
  };
  const blocks: string[] = [];

  if (query.tasks.length > 0) {
    const body: string[] = [];
    for (const ref of query.tasks) {
      const task = resolveTaskRef(tasks, ref);
      // A miss is answered, not swallowed: silence reads to the planner as a
      // transport failure and it asks again, burning the same budget twice.
      if (!task) {
        body.push(`${ref}: no task matches this reference in the current plan.`, '');
        continue;
      }
      body.push(...renderTask(task, taskRefOf(tasks, task.id) ?? `#${task.order}`, fields, ctx, tasks));
    }
    blocks.push(['<task_detail>', ...body, '</task_detail>'].join('\n'));
  }

  if (query.catalog) {
    blocks.push(['<runner_catalog>', ...renderCatalog(catalog), '</runner_catalog>'].join('\n'));
  }

  blocks.push(
    'That is everything you asked for. Nothing has changed. Reply now with the taskOps JSON for the edit you intended, or answer the user in prose.',
  );
  return blocks.join('\n\n');
}
