import { betweenRounds, loopRoundOf, outOfRounds, type LoopSubject, type TaskLoop } from '../models/Loop';

/**
 * Where a loop's check stands, for the words a surface puts on its row
 * (ADR-0045): derived from the check's status, verdict and round, as a block
 * is, never stored.
 */
export type LoopCheckState =
  /** Not run yet. */
  | 'waiting'
  /** In a round: under way, or queued to start as the next one. */
  | 'running'
  /** Failed with rounds left, and its body is fixing what it found. */
  | 'repeating'
  /** Failed with rounds left, but a body task did not pass: the loop is stopped until it is retried. */
  | 'stopped'
  | 'passed'
  | 'out-of-rounds'
  /** Failed without finding anything for a fix to answer (L2). */
  | 'failed'
  /** Skipped: the loop is over. */
  | 'ended';

/** What the loop words read of a check; structural, so the stream's status shape answers them too. */
export type LoopCheckFacts = LoopSubject & { loop: TaskLoop };

/**
 * `goesOn` is whether its loop can still go on, which only the plan can say
 * (see `planBlocks`): a body task that failed, was skipped or is blocked
 * stops it.
 */
export function loopCheckState(check: LoopCheckFacts, goesOn: boolean): LoopCheckState {
  switch (check.status) {
    case 'completed': return 'passed';
    case 'in_progress':
    case 'running':
    case 'awaiting_user': return 'running';
    case 'failed':
      if (betweenRounds(check)) return goesOn ? 'repeating' : 'stopped';
      return outOfRounds(check) ? 'out-of-rounds' : 'failed';
    case 'pending':
    case 'approved':
    case 'blocked': return loopRoundOf(check) > 1 ? 'running' : 'waiting';
    default: return 'ended';
  }
}

const roundsOf = (count: number): string => `${count} round${count === 1 ? '' : 's'}`;

/** "Round 2 of 3", "Passed in round 2 of 3", "Failed after 3 rounds": the check's row, in sentence case. */
export function loopCheckLabel(check: LoopCheckFacts, state: LoopCheckState): string {
  const round = loopRoundOf(check);
  const of = `round ${round} of ${check.loop.maxRounds}`;
  switch (state) {
    case 'waiting':
    case 'ended': return `Loop of up to ${roundsOf(check.loop.maxRounds)}`;
    case 'running': return `Round ${round} of ${check.loop.maxRounds}`;
    case 'repeating': return `Round ${round} of ${check.loop.maxRounds}: fixing`;
    case 'stopped': return `Stopped in ${of}`;
    case 'failed': return `Failed in ${of}`;
    case 'passed': return `${check.verdict?.outcome === 'pass' ? 'Passed' : 'Completed'} in ${of}`;
    case 'out-of-rounds': return `Failed after ${roundsOf(round)}`;
  }
}

/**
 * The round a body task ran in, or null while it has not run. The check
 * stays failed while its body fixes round *r*, and is queued for round
 * *r* + 1 once the body landed, so what the body fixed is read off the check.
 */
export function loopBodyRound(check: Pick<LoopSubject, 'status' | 'loopRound'>, bodyStatus: string): number | null {
  if (!['in_progress', 'running', 'awaiting_user', 'completed', 'failed'].includes(bodyStatus)) return null;
  return check.status === 'failed' ? loopRoundOf(check) : Math.max(1, loopRoundOf(check) - 1);
}

/** "Runs if #1 fails", and the round it runs in once it does: a body task's row. `checkRef` is how the surface names the check. */
export function loopBodyLabel(checkRef: string, round: number | null, maxRounds: number): string {
  return `Runs if ${checkRef} fails${round === null ? '' : ` (round ${round} of ${maxRounds})`}`;
}
