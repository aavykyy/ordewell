import { describe, it, expect } from 'vitest';
import { checkpointReply } from '../tools';

/**
 * What a runner reads back from `checkpoint` (ADR-0022, V5). A checkpoint is
 * usually a yes/no question ("May I …?"), and a live Haiku task read a bare
 * "continue" as no answer to it and asked again.
 */
describe('checkpointReply', () => {
  it('says an approved checkpoint was approved, not only that the task may go on', () => {
    expect(checkpointReply({ kind: 'continue' })).toEqual({ text: 'approved: the user said yes — continue' });
  });

  it('says a rejected checkpoint was rejected, with the reason', () => {
    expect(checkpointReply({ kind: 'rejected', reason: 'keep the data' })).toEqual({ text: 'rejected: keep the data' });
  });
});
