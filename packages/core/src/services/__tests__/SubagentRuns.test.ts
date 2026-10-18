import { describe, it, expect } from 'vitest';
import { SubagentRuns } from '../SubagentRuns';
import type { ResearchStep } from '../../models/Task';

function step(id: string, subagentId?: string): ResearchStep {
  return { id, tool: 'grep', args: 'x', result: '', success: true, outcome: 'success', timestamp: '2026-01-01T00:00:00Z', ...(subagentId ? { subagentId } : {}) };
}

describe('SubagentRuns', () => {
  it('folds each subagent\'s run into the research log as one group, however the stream interleaved', () => {
    const runs = new SubagentRuns();

    runs.observe({ type: 'subagent_started', subagentId: 'A', brief: 'look at A' });
    runs.observe({ type: 'subagent_started', subagentId: 'B', brief: 'look at B' });
    runs.observe({ type: 'tool_result', step: step('b1', 'B') });
    runs.observe({ type: 'tool_result', step: step('a1', 'A') });
    runs.observe({ type: 'subagent_finished', subagentId: 'A', outcome: 'done', digest: 'A done' });
    const log = runs.foldInto([step('p1'), step('a1', 'A')]);

    expect(log.map((e) => e.id)).toEqual(['p1', 'sa-A', 'a1', 'sa-B', 'b1']);
    expect(log[1]).toMatchObject({ brief: 'look at A', outcome: 'done', digest: 'A done' });
  });

  it('leaves the log as it was when no subagent ran', () => {
    const runs = new SubagentRuns();

    runs.observe({ type: 'tool_result', step: step('p1') });

    expect(runs.foldInto([step('p1')]).map((e) => e.id)).toEqual(['p1']);
  });
});
