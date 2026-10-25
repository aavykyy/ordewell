import type { SessionMessage } from '@ordewell/core';
import type { TuiState } from '../state';
import { hear } from '../transcript';
import { drainQueue } from './turnQueue';
import { step, type Step } from './shared';

type CompactionMessage = Extract<SessionMessage, { type: 'planner_compaction' }>;

export const running = (state: TuiState): boolean => state.conversation.blocks.some((b) => b.type === 'compaction' && b.status === 'running');

/**
 * A compaction event: folded into the view by core, and, for a compaction this
 * surface did not call for, into the planner's status too. `/compact` here has
 * its own call to settle it (see `compacted`); one the planner started on its
 * own, another surface asked for, or the session was adopted in the middle of
 * has none, so its start marks the planner busy — prompts typed meanwhile are
 * held, never sent into the summary — and its end releases them.
 *
 * The status follows the view, not the event: a start the view will not draw
 * (a repeat of one already over) must not leave the planner busy for good.
 */
export function followCompaction(state: TuiState, message: CompactionMessage): Step {
  const heard = hear(state, message);
  if (message.compaction.phase === 'started') {
    return step(state.planner === 'idle' && running(heard) ? { ...heard, planner: 'compacting' } : heard);
  }
  if (state.planner !== 'compacting' || running(heard)) return step(heard);
  return drainQueue(state, { ...heard, planner: 'idle' });
}

/**
 * A compaction the daemon reports as running when this surface reads the
 * session back — adopted into, or reconnected during. Folded like its start
 * event would have been; the planner is busy with it whether a call here was
 * waiting on something else or on nothing.
 */
export function adoptCompaction(state: TuiState, message: CompactionMessage): TuiState {
  const heard = hear(state, message);
  return running(heard) ? { ...heard, planner: 'compacting' } : heard;
}
