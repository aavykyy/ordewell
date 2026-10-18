import type { StreamStamp } from '../daemonContract';
import type { TaskLogEvent } from '../models/TaskLog';
import { EMPTY_TASK_LOG, reduceTaskLog, replayTaskLog, type TaskLogView } from './taskLog';

export interface TaskLogBatch {
  attempt: number;
  events: TaskLogEvent[];
  position?: StreamStamp;
}

/** A saved attempt and the live batches that follow it (ADR-0018 P1). */
export interface TaskLogFollow {
  view: TaskLogView;
  attempts: number[];
  attempt: number;
  pending: TaskLogBatch[];
  loaded: boolean;
  followLatest: boolean;
  /** The outstanding pick; an older attempt read cannot replace it. */
  loadingAttempt?: number;
  /** The saved read's cutoff, also rejecting socket copies delivered after the read. */
  position?: StreamStamp;
}

export type TaskLogFollowInput =
  | { type: 'opened' }
  | ({ type: 'loaded'; attempts?: number[]; abandoned?: boolean } & TaskLogBatch)
  | ({ type: 'live' } & TaskLogBatch)
  | { type: 'picked'; attempt: number };

export const EMPTY_TASK_LOG_FOLLOW: TaskLogFollow = {
  view: EMPTY_TASK_LOG, attempts: [], attempt: 0, pending: [], loaded: false, followLatest: true,
};

function covered(position: StreamStamp | undefined, batch: TaskLogBatch): boolean {
  return !!position && !!batch.position && position.stream === batch.position.stream && batch.position.seq <= position.seq;
}

function live(state: TaskLogFollow, batch: TaskLogBatch): TaskLogFollow {
  if (batch.attempt <= 0 || batch.attempt < state.attempt) return state;
  const attempts = state.attempts.includes(batch.attempt) ? state.attempts : [...state.attempts, batch.attempt].sort((a, b) => a - b);
  if (batch.attempt > state.attempt) {
    if (!state.followLatest) return attempts === state.attempts ? state : { ...state, attempts };
    return { ...state, attempts, attempt: batch.attempt, position: undefined, view: batch.events.reduce(reduceTaskLog, EMPTY_TASK_LOG) };
  }
  if (covered(state.position, batch)) return state;
  return { ...state, attempts, view: batch.events.reduce(reduceTaskLog, state.view) };
}

/** Join by stream position, never by event content or socket arrival time. */
export function followTaskLog(state: TaskLogFollow, input: TaskLogFollowInput): TaskLogFollow {
  switch (input.type) {
    case 'opened': return EMPTY_TASK_LOG_FOLLOW;
    case 'picked': return { ...state, loaded: false, loadingAttempt: input.attempt, followLatest: input.attempt === state.attempts.at(-1) };
    case 'live':
      return state.loaded ? live(state, input) : { ...state, pending: [...state.pending, input] };
    case 'loaded': {
      if (state.loaded) return state;
      if (!input.abandoned && state.loadingAttempt !== undefined && input.attempt !== state.loadingAttempt) return state;
      const attempts = [...new Set([...(input.attempts ?? state.attempts), ...state.pending.map((batch) => batch.attempt)])].filter((attempt) => attempt > 0).sort((a, b) => a - b);
      let next: TaskLogFollow = {
        ...state, attempts, loaded: true, pending: [], loadingAttempt: undefined,
        ...(input.abandoned ? {} : { attempt: input.attempt, view: replayTaskLog(input.events), position: input.position }),
      };
      for (const batch of state.pending) {
        // A read of one attempt does not account for another attempt's file.
        if (!input.abandoned && batch.attempt === input.attempt) {
          if (covered(input.position, batch)) continue;
          // An older daemon supplies no position; preserve its replay behaviour.
          if (!input.position && !batch.position) continue;
        }
        next = live(next, batch);
      }
      return next;
    }
  }
}
