/**
 * What a stopped runner says about why it stopped, and what ending an attempt
 * does to the runner it leaves behind. TaskOrchestrator acts on the answers.
 */

import { connectorFor } from './harness/connectors';

/**
 * Why a runner stopped, as far as the tail of its own output says. `usage-limit`
 * is the account, not the task, running out; anything else is `stopped`.
 */
export type RunnerStop = 'usage-limit' | 'stopped';

/**
 * What a runner says when its account, not the task, ran out. A stop with no
 * `task_complete` call that names a limit is retryable once the limit resets, so it pauses the
 * task instead of failing it. Deliberately narrow: a false positive would leave
 * a genuinely broken task waiting on the user forever, and the words below are
 * the ones the runners print for this and nothing else.
 */
const USAGE_LIMIT_RE = /\b(?:usage|session|weekly|daily|monthly) limit\b|\brate limit (?:exceeded|reached)\b|\brate[- ]limited\b|\blimit (?:will )?reset\b|\bquota (?:exceeded|reached)\b|\btoo many requests\b/i;

/** How much of a stopped runner's tail is read for the limit signature: the error is the last thing it prints. */
const USAGE_LIMIT_TAIL = 4096;

/** Classify a stopped runner from the tail of its own output. */
export function classifyRunnerStop(output: string): RunnerStop {
  return USAGE_LIMIT_RE.test(output.slice(-USAGE_LIMIT_TAIL)) ? 'usage-limit' : 'stopped';
}

/** Every way an attempt ends: a verdict, a usage limit, cancel, release, Mark complete, retry, a failed spawn, stop, plan load. */
export type AttemptEnd = 'verdict' | 'usage-limit' | 'cancel' | 'release' | 'complete' | 'skip' | 'retry' | 'spawn-failed' | 'stop' | 'load';

/**
 * Whether ending an attempt with this reason has to stop its own runner now.
 * A verdict and a usage limit end it too (ADR-0018, L1): its log lives in Ordewell, and
 * whatever it did after the verdict would go unverified. Stop and load reset
 * every runner at once instead.
 */
export function stopsRunner(reason: AttemptEnd): boolean {
  return reason !== 'stop' && reason !== 'load';
}

/**
 * When a runner's usage limit resets, read from the limit message it printed,
 * or null when that runner's wording carries no time Ordewell can read — the
 * task then waits for a manual retry. Each runner words it its own way, so
 * its connector reads it (`usageLimitReset`); a runner without a reader gets
 * none.
 */
export function readUsageLimitReset(runner: string, output: string, now: Date = new Date()): Date | null {
  const read = connectorFor(runner)?.usageLimitReset;
  if (!read) return null;
  let reset: Date | null;
  try {
    reset = read(output.slice(-USAGE_LIMIT_TAIL), now);
  } catch {
    // An unknown time zone name: the time cannot be placed, so it is not guessed.
    return null;
  }
  // A reset long past is not this stop's: the words were left over, and acting on them would retry at once.
  if (!reset || reset.getTime() < now.getTime() - DAY_MS) return null;
  return reset;
}

const DAY_MS = 24 * 60 * 60_000;
