import { flattenTasks, type Task } from './Task';

/*
 * A script task (ADR-0035): an ops task whose body is a literal script
 * Ordewell runs with no model. What it runs is the body as the plan holds it,
 * and that body is what the user consents to.
 */

/** A script task's time limit when it sets none. */
export const DEFAULT_SCRIPT_TIMEOUT_MS = 10 * 60_000;

/**
 * The longest limit a script task may set. A timer past about 24.8 days fires
 * at once, and a day is already far past any exact effect.
 */
export const MAX_SCRIPT_TIMEOUT_MS = 24 * 60 * 60_000;

/** What a script task runs, its time limit filled in. */
export type ScriptBody =
  /** Argument vectors run in order with no shell, stopping at the first that fails. */
  | { commands: string[][]; timeoutMs: number }
  /** One script, run by the research shell's interpreter. */
  | { script: string; timeoutMs: number };

/** The fields that make up a script task's body: what consent is given to. */
export const SCRIPT_BODY_FIELDS = ['commands', 'script', 'timeoutMs'] as const satisfies readonly (keyof Task)[];

/**
 * What a script task does not have: it runs no model, so it has no runner,
 * model, mode or prompt, no skills or steps, and it is an ops task by nature.
 */
export const NOT_A_SCRIPTS_FIELDS = ['assignedModel', 'taskMode', 'prompt', 'skills', 'userSteps', 'ops'] as const satisfies readonly (keyof Task)[];

type BodyFields = Pick<Task, 'type' | 'commands' | 'script' | 'timeoutMs'>;

/** The body a script task runs; null for any other task, or one whose body the plan's rules refuse. */
export function scriptBodyOf(task: BodyFields): ScriptBody | null {
  if (task.type !== 'script' || scriptBodyErrors(task).length > 0) return null;
  const timeoutMs = task.timeoutMs ?? DEFAULT_SCRIPT_TIMEOUT_MS;
  return task.commands ? { commands: task.commands.map((argv) => [...argv]), timeoutMs } : { script: task.script ?? '', timeoutMs };
}

/** Whether two versions of a task run the same body under the same limit; a task that is no script task has none. */
export function sameScriptBody(a: BodyFields, b: BodyFields): boolean {
  return JSON.stringify(bodyKey(a)) === JSON.stringify(bodyKey(b));
}

/**
 * The script tasks an edit gave another body or limit. Consent is to a body,
 * so each leaves the approved set; a task new to the plan was never in it.
 */
export function rewrittenScripts(before: readonly Task[], after: readonly Task[]): string[] {
  const prior = new Map(flattenTasks(before).map((t) => [t.id, t]));
  return flattenTasks(after).filter((t) => {
    const was = prior.get(t.id);
    return t.type === 'script' && was !== undefined && !sameScriptBody(was, t);
  }).map((t) => t.id);
}

function bodyKey(task: BodyFields): unknown {
  return task.type === 'script' ? [task.commands ?? null, task.script ?? null, task.timeoutMs ?? DEFAULT_SCRIPT_TIMEOUT_MS] : null;
}

/**
 * Why a task's body fields break the plan's rules, as values the planner's
 * JSON may have put there: a script task runs exactly one of `commands` or
 * `script`, every argument vector names a program, and the limit is a whole
 * number of milliseconds in range. A task of another type has none of them.
 * Read defensively, since an edit's fields arrive untyped.
 */
export function scriptBodyErrors(task: { type: unknown; commands?: unknown; script?: unknown; timeoutMs?: unknown }): { field: string; message: string }[] {
  if (task.type !== 'script') {
    return SCRIPT_BODY_FIELDS.filter((f) => task[f] !== undefined)
      .map((field) => ({ field, message: `has "${field}", which only a script task has: set "type": "script", or leave it out` }));
  }
  const errors: { field: string; message: string }[] = [];
  const { commands, script, timeoutMs } = task;
  if (commands !== undefined && script !== undefined) {
    errors.push({ field: 'commands', message: 'has both "commands" and "script": a script task runs exactly one of them' });
  } else if (commands === undefined && script === undefined) {
    errors.push({ field: 'commands', message: 'is a script task with neither "commands" nor "script": give it the argument vectors to run, or the script' });
  }
  if (commands !== undefined) errors.push(...commandsErrors(commands));
  if (script !== undefined && (typeof script !== 'string' || !script.trim())) {
    errors.push({ field: 'script', message: 'has an empty "script": write the script it runs' });
  }
  if (timeoutMs !== undefined && !(typeof timeoutMs === 'number' && Number.isInteger(timeoutMs) && timeoutMs > 0 && timeoutMs <= MAX_SCRIPT_TIMEOUT_MS)) {
    errors.push({ field: 'timeoutMs', message: `has "timeoutMs" ${JSON.stringify(timeoutMs)}: the time limit is a whole number of milliseconds from 1 to ${MAX_SCRIPT_TIMEOUT_MS}, or left out for ten minutes` });
  }
  return errors;
}

function commandsErrors(commands: unknown): { field: string; message: string }[] {
  const shape = 'a list of argument vectors, each a list of strings, like [["git", "push", "origin", "main"]]';
  if (!Array.isArray(commands) || commands.length === 0) return [{ field: 'commands', message: `has "commands" that is not ${shape}` }];
  for (const [i, argv] of commands.entries()) {
    const n = i + 1;
    if (!Array.isArray(argv) || !argv.every((word) => typeof word === 'string')) {
      return [{ field: 'commands', message: `has command ${n} that is not an argument vector: "commands" is ${shape}` }];
    }
    if (argv.length === 0) return [{ field: 'commands', message: `has command ${n} as an empty argument vector: name the program it runs` }];
    if (!argv[0].trim()) return [{ field: 'commands', message: `has command ${n} naming no program: its first word is the program it runs` }];
  }
  return [];
}

/** The fields a script task has that it must not, by name. */
export function notAScriptsFields(task: Partial<Record<(typeof NOT_A_SCRIPTS_FIELDS)[number], unknown>>): string[] {
  return NOT_A_SCRIPTS_FIELDS.filter((f) => {
    const value = task[f];
    return value !== undefined && value !== false && !(Array.isArray(value) && value.length === 0);
  });
}

/** An edit's body fields, with a `null` the planner's JSON wrote to drop one read as leaving it out. */
export function clearedBodyFields(changes: Partial<Task>): Partial<Task> {
  for (const field of SCRIPT_BODY_FIELDS) if ((changes[field] as unknown) === null) changes[field] = undefined;
  return changes;
}

const PLAIN_WORD = /^[A-Za-z0-9_@%+=:,./-]+$/;

/**
 * A character a reader cannot see for what it is: a control or format
 * character (a bidirectional override among them), or a line or paragraph
 * separator. Shown as itself, it could make the text read as something other
 * than what runs.
 */
const UNSEEN = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u;

/**
 * An argument vector as a reader would type it in a shell: a word is quoted
 * only where it needs to be, and one holding a character a reader cannot see
 * is written with escapes (`$'…'`), so a command is always one line and reads
 * as what runs. For reading only; nothing runs it.
 */
export function commandLine(argv: readonly string[]): string {
  return argv.map(quotedWord).join(' ');
}

function quotedWord(word: string): string {
  if (PLAIN_WORD.test(word)) return word;
  if (!UNSEEN.test(word)) return `'${word.replace(/'/g, `'\\''`)}'`;
  return `$'${[...word].map(escaped).join('')}'`;
}

const ESCAPES: Record<string, string> = { '\\': '\\\\', "'": "\\'", '\n': '\\n', '\r': '\\r', '\t': '\\t' };

function escaped(char: string): string {
  return ESCAPES[char] ?? (UNSEEN.test(char) ? codeOf(char) : char);
}

function codeOf(char: string): string {
  const code = char.codePointAt(0) ?? 0;
  const hex = code.toString(16).toUpperCase();
  return code <= 0xff ? `\\x${hex.padStart(2, '0')}` : code <= 0xffff ? `\\u${hex.padStart(4, '0')}` : `\\U${hex.padStart(8, '0')}`;
}

/**
 * A script task's body as the approval card shows it (ADR-0035), so the
 * consent is to what will run: each command on a line of its own, or the
 * script as written, then the time limit. A character a reader cannot see in
 * a script, but for its line breaks and tabs, is shown as its code.
 */
export function scriptBodyText(body: ScriptBody): string {
  const shown = 'commands' in body
    ? body.commands.map(commandLine)
    : [body.script.replace(/\r\n|[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, (char) => (char === '\r\n' || char === '\n' || char === '\t'
      ? char
      : `<U+${(char.codePointAt(0) ?? 0).toString(16).toUpperCase().padStart(4, '0')}>`))];
  return [...shown, '', `Time limit: ${timeLimitText(body.timeoutMs)}.`].join('\n');
}

/** A time limit in the largest units it is a whole number of: "10 minutes", "90 seconds". */
export function timeLimitText(ms: number): string {
  const units: [number, string][] = [[3_600_000, 'hour'], [60_000, 'minute'], [1_000, 'second'], [1, 'millisecond']];
  const [size, name] = units.find(([unit]) => ms % unit === 0) ?? units[units.length - 1];
  const n = ms / size;
  return `${n} ${name}${n === 1 ? '' : 's'}`;
}
