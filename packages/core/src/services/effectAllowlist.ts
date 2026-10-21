import * as os from 'os';
import * as path from 'path';
import type { ScriptBody } from '../models/ScriptTask';
import { MUTATING_VERB, commandExcluded, parseAllowlist, ruleWord, scopeExcluded, type PlannerAllowlist, type RuleWord } from './plannerAllowlist';

/**
 * The effect allowlist (ADR-0035): the user's standing approval for named
 * effects, beside the planner allowlist, which names reads. It pre-approves a
 * script task whose `commands` are all covered; it never covers a `script`
 * body, whose shell text no rule can be matched against.
 *
 * A rule is matched against the whole command, every word in order and flags
 * included, because an effect's flags change what it does: `git push origin
 * feature/*` covers `git push origin feature/login`, never the same push with
 * `--force`. `*` stands for one word, or inside a word for any run of
 * characters, as in the planner allowlist, except that it never stands for
 * what changes the effect: a flag (`--force`, and `/force` on Windows), a
 * refspec's force or delete (`+main`, `:main`), or a `:` outside a URL
 * (`feature/x:main`, which pushes to `main`). The rule writes any of those
 * itself. A rule spells out its operation before any `*`, so
 * `az webapp config * set` is no rule at all.
 *
 * Exclusions are the planner allowlist's `!` entries, with any `!` entry
 * written here; an exclusion wins. A command exclusion is matched as the
 * planner allowlist matches it; a path or URL exclusion holds for an argument
 * that names an absolute path or URL it covers, whole or after a `=`, `@`,
 * `:` or `,` or a short flag (`--url=…`, `-d @…`). A relative path is not
 * resolved, since the body does not say where it runs. A program named by its
 * path is a file the repository ships (ADR-0026), so it is never covered.
 * There are no built-in rules: a default would pre-approve an effect the user
 * never chose.
 */

interface EffectRule {
  text: string;
  binary: string;
  words: RuleWord[];
}

export interface EffectRules {
  rules: EffectRule[];
  exclusions: PlannerAllowlist;
  platform: NodeJS.Platform;
  /** The entries that are no rule, each with the warning that says why it is ignored. */
  ignored: { rule: string; warning: string }[];
}

/**
 * Operation verbs beyond the reads' mutating ones, which name a write the
 * planner allowlist had no reason to list because it never covers one.
 */
const EFFECT_VERB = /^(annotate|autoscale|build|comment|cordon|dispatch|expose|link|mark|post|ready|rerun|retry|review|toggle|trigger|uncordon|unlink)([-_:.].*)?$/i;

/** `deploy`, `set-iam-policy`, and the `topic:verb` form of `config:set` or `apps:destroy`. */
function isVerb(word: string): boolean {
  if (word.startsWith('-')) return false;
  const verb = word.slice(word.lastIndexOf(':') + 1);
  return [word, verb].some((w) => MUTATING_VERB.test(w) || EFFECT_VERB.test(w));
}

function isPath(program: string): boolean {
  return /[\\/]/.test(program);
}

/** Why an entry is no rule, or undefined when it is one. */
function invalidity(binary: string, words: readonly string[]): string | undefined {
  if (isPath(binary)) return 'a program named by its path is never covered, since it is a file the repository ships';
  if (binary.includes('*')) return 'it names no program';
  const firstWildcard = words.findIndex((w) => w.includes('*'));
  if (firstWildcard >= 0 && !words.slice(0, firstWildcard).some(isVerb)) {
    return 'a rule spells out its operation, up to and including the verb, before any *';
  }
  return undefined;
}

/** `scheme://`, checked before a `*` may run over the `:` of a port or a path. */
function isUrl(word: string): boolean {
  if (!/^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(word)) return false;
  try {
    new URL(word);
    return true;
  } catch {
    return false;
  }
}

function colonFree(glob: string): RegExp {
  return new RegExp(`^${glob.split('*').map((part) => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('[^:]*')}$`);
}

/**
 * A rule word. A `*` never stands for a word that starts as a flag does, or as
 * a refspec's force (`+`) or delete (`:`), unless the pattern starts so itself:
 * each changes what the effect does, so the rule has to write it. Nor does it
 * run over a `:` outside a URL, so `feature/*` cannot name `feature/x:main`
 * and a whole-word `*` cannot name `feature:main`; both push to `main`. A
 * `scheme://` URL is the exception, since it is a value an effect takes
 * (`curl -X POST *`) and no refspec. On Windows a `/` starts a flag too;
 * elsewhere it starts a path, which is a value.
 */
function effectWord(pattern: string, platform: NodeJS.Platform): RuleWord {
  const word = ruleWord(pattern);
  if (!word.wildcard) return word;
  const effectStart = platform === 'win32' ? /^[-+:/]/ : /^[-+:]/;
  const inWord = colonFree(pattern);
  return {
    matches: (w) => !(effectStart.test(w) && w[0] !== pattern[0]) && (isUrl(w) ? word.matches(w) : inWord.test(w)),
    wildcard: true,
  };
}

/**
 * `entries` are the effect allowlist's; `plannerEntries` the planner allowlist
 * in force, whose `!` entries hold here too; `platform` the one the commands
 * run on, which decides how a flag is spelled and how a path resolves.
 */
export function parseEffectAllowlist(
  entries: readonly string[],
  plannerEntries: readonly string[] = [],
  platform: NodeJS.Platform = process.platform,
): EffectRules {
  const exclusionEntries = [...plannerEntries, ...entries].filter((e) => e.trim().startsWith('!'));
  const list: EffectRules = { rules: [], exclusions: parseAllowlist(exclusionEntries), platform, ignored: [] };
  for (const raw of entries) {
    const text = raw.trim();
    if (!text || text.startsWith('!')) continue;
    const [binary, ...words] = text.split(/\s+/);
    const reason = invalidity(binary, words);
    if (reason) list.ignored.push({ rule: text, warning: `Ignored the effect allowlist rule "${text}": ${reason}.` });
    else list.rules.push({ text, binary, words: words.map((w) => effectWord(w, platform)) });
  }
  return list;
}

/**
 * The spellings an argument's absolute paths and URLs take that a path or URL
 * exclusion may be written for. A path also stands as a directory, so
 * `!/home/me/.ssh/*` holds for `/home/me/.ssh` itself; a URL also as its origin,
 * the form the planner allowlist matches a web read's scope in.
 */
function targetSpellings(arg: string, platform: NodeJS.Platform): string[] {
  const paths = platform === 'win32' ? path.win32 : path.posix;
  const starts = [0, ...(/^-[A-Za-z][^-]/.test(arg) ? [2] : []), ...[...arg.matchAll(/[=@:,]/g)].map((m) => m.index + 1)];
  return starts.flatMap((start) => {
    const target = arg.slice(start);
    if (isUrl(target)) {
      const url = new URL(target);
      return [target, url.href, `${url.origin}/*`];
    }
    const home = target === '~' || /^~[\\/]/.test(target) ? paths.join(os.homedir(), target.slice(1)) : target;
    if (!paths.isAbsolute(home)) return [];
    const abs = paths.normalize(home);
    return [target, abs, paths.join(abs, '*')];
  });
}

function scopeExclusionHolds(list: EffectRules, args: readonly string[]): boolean {
  return args.some((arg) => targetSpellings(arg, list.platform).some((target) => scopeExcluded(list.exclusions, target)));
}

function covers(rule: EffectRule, argv: readonly string[]): boolean {
  const [binary, ...args] = argv;
  return rule.binary === binary && rule.words.length === args.length && rule.words.every((word, i) => word.matches(args[i]));
}

/**
 * The rules, by name, that cover every command of a `commands` body, or null
 * when one command is not covered, an exclusion holds for one, or the body is
 * a `script`.
 */
export function effectRuleFor(list: EffectRules, body: ScriptBody): string | null {
  if (!('commands' in body) || body.commands.length === 0) return null;
  const used: string[] = [];
  for (const argv of body.commands) {
    const [binary, ...args] = argv;
    if (!binary || isPath(binary) || commandExcluded(list.exclusions, { binary, args }) || scopeExclusionHolds(list, args)) return null;
    const rule = list.rules.find((r) => covers(r, argv));
    if (!rule) return null;
    used.push(rule.text);
  }
  return [...new Set(used)].join(' + ');
}
