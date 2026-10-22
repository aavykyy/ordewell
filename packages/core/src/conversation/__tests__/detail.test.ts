import { describe, it, expect } from 'vitest';
import { hasHiddenDetail } from '../detail';
import { play } from './helpers';

describe('hidden detail', () => {
  it('is nothing while the conversation holds only messages and its token line', () => {
    const view = play([
      { type: 'local_entry', role: 'user', text: 'add a parser' },
      { type: 'planner_message', content: 'Which format?', timestamp: '' },
      { type: 'planner_usage', totals: { inputTokens: 10, outputTokens: 2 } },
    ]);

    expect(hasHiddenDetail(view.blocks)).toBe(false);
  });

  it.each([
    ['a command row', { type: 'research_step', tool: 'read_file', args: '{"path":"a.ts"}' }],
    ['thinking', { type: 'planner_thinking_delta', text: 'hmm' }],
    ['a subagent', { type: 'subagent_started', subagentId: 'sa-1', brief: 'look around' }],
  ] as const)('is there once the conversation holds %s', (_name, input) => {
    expect(hasHiddenDetail(play([input]).blocks)).toBe(true);
  });
});

describe('hidden detail in a task log', () => {
  it('is there once the runner said what it loaded, which is listed only in detail (#66)', () => {
    expect(hasHiddenDetail([{ type: 'runner_loaded', id: 'b1', commands: [], mcpServers: [] }])).toBe(true);
    expect(hasHiddenDetail([{ type: 'compaction', id: 'b1', trigger: 'manual' }])).toBe(false);
  });

  it('is there when a handoff carries a report longer than the folded preview (ADR-0047)', () => {
    const handoff = (report: string) => ({
      type: 'handoff' as const, id: 'b1',
      handoff: { summary: 'Done.', findings: [], findingCount: 0, report },
    });
    const lines = (n: number) => Array.from({ length: n }, (_, i) => `line ${i + 1}`).join('\n');

    expect(hasHiddenDetail([handoff(lines(8))])).toBe(false);
    expect(hasHiddenDetail([handoff(lines(9))])).toBe(true);
    expect(hasHiddenDetail([{ type: 'handoff', id: 'b1', handoff: { summary: 'Done.', findings: [], findingCount: 0 } }])).toBe(false);
  });
});
