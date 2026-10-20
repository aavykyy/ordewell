import type { ScriptBody } from '../models/ScriptTask';
import { MUTATING_VERB, commandExcluded, parseAllowlist, ruleWord, type PlannerAllowlist, type RuleWord } from './plannerAllowlist';

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
 * characters, as in the planner allowlist. A rule spells out its operation
 * before any `*`, so `az webapp config * set` is no rule at all.
 *
 * Exclusions are the planner allowlist's `!` entries, with any `!` entry
 * written here, matched as the planner allowlist matches them; an exclusion
 * wins. A program named by its path is a file the repository ships (ADR-0026),
 * so it is never covered. There are no built-in rules: a default would
 * pre-approve an effect the user never chose.
 */

interface EffectRule {
  text: string;
  binary: string;
  words: RuleWord[];
}

export interface EffectRules {
  rules: EffectRule[];
  exclusions: PlannerAllowlist;
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

/**
 * A rule word. A `*` that does not itself start with `-` never stands for a
 * flag: flags change what an effect does, so the rule has to write each one.
 */
function effectWord(pattern: string): RuleWord {
  const word = ruleWord(pattern);
  if (!word.wildcard || pattern.startsWith('-')) return word;
  return { matches: (w) => !w.startsWith('-') && word.matches(w), wildcard: true };
}

/** `entries` are the effect allowlist's; `plannerEntries` the planner allowlist in force, whose `!` entries hold here too. */
export function parseEffectAllowlist(entries: readonly string[], plannerEntries: readonly string[] = []): EffectRules {
  const exclusionEntries = [...plannerEntries, ...entries].filter((e) => e.trim().startsWith('!'));
  const list: EffectRules = { rules: [], exclusions: parseAllowlist(exclusionEntries), ignored: [] };
  for (const raw of entries) {
    const text = raw.trim();
    if (!text || text.startsWith('!')) continue;
    const [binary, ...words] = text.split(/\s+/);
    const reason = invalidity(binary, words);
    if (reason) list.ignored.push({ rule: text, warning: `Ignored the effect allowlist rule "${text}": ${reason}.` });
    else list.rules.push({ text, binary, words: words.map(effectWord) });
  }
  return list;
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
    if (!binary || isPath(binary) || commandExcluded(list.exclusions, { binary, args })) return null;
    const rule = list.rules.find((r) => covers(r, argv));
    if (!rule) return null;
    used.push(rule.text);
  }
  return [...new Set(used)].join(' + ');
}
