import { describe, it, expect } from 'vitest';
import { ChatHistory, COMPACTION_LIMITS, compactResearchResults, messageChars, type CompactableMessage } from '../contextCompaction';

const big = (label: string, chars = 5000) => `${label}: ${'x'.repeat(chars)}`;

const round = (calls: Array<[id: string, name: string]>, outputs: string[]): CompactableMessage[] => [
  { role: 'assistant', content: null, tool_calls: calls.map(([id, name]) => ({ id, function: { name, arguments: '{}' } })) },
  ...calls.map(([id], i) => ({ role: 'tool', tool_call_id: id, content: outputs[i] })),
];

/** One old round of every kind of output, then the two newest rounds. */
function history(): CompactableMessage[] {
  return [
    { role: 'system', content: 'You are a planner.' },
    { role: 'user', content: 'map the cache' },
    ...round(
      [['c1', 'read_file'], ['c2', 'spawn_research_agent'], ['c3', 'grep'], ['c4', 'bash'], ['c5', 'run_task'], ['c6', 'fetch']],
      [big('raw file'), big('digest'), 'short grep hit', big('build log'), big('task started'), big('web page')],
    ),
    ...round([['c7', 'read_file']], [big('newer file')]),
    ...round([['c8', 'glob']], [big('newest listing')]),
    { role: 'assistant', content: 'Findings so far…' },
  ];
}

const content = (h: ChatHistory<CompactableMessage>, id: string) => h.view().find((m) => m.tool_call_id === id)?.content as string;

describe('ChatHistory.prune', () => {
  it('prunes older workspace reads only, keeping digests, command, task and web output whole', () => {
    const h = new ChatHistory(history());
    const { removedChars, outputs } = h.prune(Infinity);

    expect(outputs).toBe(1);
    expect(removedChars).toBeGreaterThan(4000);
    expect(content(h, 'c1')).toContain('read_file output pruned (5010 chars) to free context: read it again if you need it');
    expect(content(h, 'c1').startsWith('raw file: ')).toBe(true);
    expect(content(h, 'c2')).toBe(big('digest'));
    expect(content(h, 'c4')).toBe(big('build log'));
    expect(content(h, 'c5')).toBe(big('task started'));
    expect(content(h, 'c6')).toBe(big('web page'));
    expect(content(h, 'c3')).toBe('short grep hit');
  });

  it('keeps the two newest rounds whole, and only those at or after where it is told to protect from', () => {
    const h = new ChatHistory(history());
    h.prune(Infinity);
    expect(content(h, 'c7')).toBe(big('newer file'));
    expect(content(h, 'c8')).toBe(big('newest listing'));

    // Past the end: no round is protected.
    h.prune(Infinity, h.length);
    expect(content(h, 'c7')).toContain('output pruned');
    expect(content(h, 'c8')).toContain('output pruned');
  });

  it('counts a round whose results are not in yet as none of the two it keeps', () => {
    const h = new ChatHistory([...history(), ...round([['c9', 'read_file']], [big('pending')]).slice(0, 1)]);
    h.prune(Infinity);
    expect(content(h, 'c7')).toBe(big('newer file'));
    expect(content(h, 'c8')).toBe(big('newest listing'));
    expect(content(h, 'c1')).toContain('output pruned');
  });

  it('prunes oldest first and stops once it has freed what it was asked to', () => {
    const h = new ChatHistory([...history(), { role: 'user', content: 'next' }]);
    const { outputs } = h.prune(100, h.length);
    expect(outputs).toBe(1);
    expect(content(h, 'c1')).toContain('output pruned');
    expect(content(h, 'c7')).toBe(big('newer file'));
  });

  it('keeps its size in step with what it holds, and replaces a pruned message rather than editing it', () => {
    const before = history();
    const h = new ChatHistory(before);
    const original = h.view().find((m) => m.tool_call_id === 'c1');
    const { removedChars } = h.prune(Infinity);

    expect(h.chars).toBe(h.view().reduce((n, m) => n + messageChars(m), 0));
    expect(h.chars).toBe(before.reduce((n, m) => n + messageChars(m), 0) - removedChars);
    expect(original?.content).toBe(big('raw file'));
  });

  it('is idempotent: a second pass removes nothing more', () => {
    const h = new ChatHistory(history());
    h.prune(Infinity);
    expect(h.prune(Infinity)).toEqual({ removedChars: 0, outputs: 0 });
  });
});

describe('ChatHistory.replace', () => {
  it('takes a valid history whole', () => {
    const h = new ChatHistory(history());
    const next = [{ role: 'system', content: 'You are a planner.' }, { role: 'user', content: 'summary' }, ...round([['c8', 'glob']], ['listing'])];
    h.replace(next);
    expect(h.view()).toEqual(next);
    expect(h.lastUserIndex).toBe(1);
  });

  it('refuses, changing nothing, a result that answers no call before it or answers one twice', () => {
    const h = new ChatHistory(history());
    const before = [...h.view()];
    expect(() => h.replace([{ role: 'user', content: 'x' }, { role: 'tool', tool_call_id: 'c1', content: 'orphan' }])).toThrow(/answers no call/);
    expect(() => h.replace([...round([['c1', 'grep']], ['a']), { role: 'tool', tool_call_id: 'c1', content: 'again' }])).toThrow(/second time/);
    expect(h.view()).toEqual(before);
  });
});

describe('compactResearchResults', () => {
  const block = (tool: string, args: string, output: string) => `\n[${tool}(${args})]\n${output}\n`;

  it('returns text under budget unchanged', () => {
    const text = block('grep', '{"pattern":"x"}', 'one hit');
    expect(compactResearchResults(text, 1000)).toBe(text);
  });

  it('prunes raw tool blocks before subagent digests', () => {
    const text =
      block('read_file', '{"path":"a.ts"}', big('file a')) +
      block('spawn_research_agent', '{"prompt":"map core"}', big('digest', 3000)) +
      block('grep', '{"pattern":"y"}', big('grep out'));
    const out = compactResearchResults(text, 6000);

    expect(out.length).toBeLessThanOrEqual(6000 + 200);
    expect(out).toContain(big('digest', 3000));
    expect(out).toContain('pruned');
    expect(out).toContain('[read_file({"path":"a.ts"})]');
  });

  it('only shrinks digests when raw blocks alone cannot meet the budget', () => {
    const text =
      block('spawn_research_agent', '{"prompt":"a"}', big('digest one')) +
      block('spawn_research_agent', '{"prompt":"b"}', big('digest two'));
    const out = compactResearchResults(text, 4000);

    expect(out.length).toBeLessThan(text.length);
    expect(out).toContain('digest one: ');
  });

  it('preserves the trailing [LLM response] synthesis over raw transcripts', () => {
    const text =
      block('bash', '{"command":"ls"}', big('listing')) +
      `\n[LLM response]\nFinal synthesis of the research.\n`;
    const out = compactResearchResults(text, 3000);

    expect(out).toContain('Final synthesis of the research.');
    expect(out).toContain('pruned');
  });

  it('does not treat output lines that mention tool names mid-line as headers', () => {
    // '[grep(' only opens a block at line start; mid-line mentions stay part
    // of the enclosing output and get pruned with it.
    const sneaky = 'the call [grep(pattern)] appears here\n' + 'y'.repeat(3000);
    const text = block('read_file', '{"path":"b.ts"}', sneaky) + block('grep', '{"pattern":"z"}', big('real grep'));
    const out = compactResearchResults(text, 4000);

    expect(out).not.toContain('y'.repeat(3000));
    expect(compactResearchResults(text, text.length)).toBe(text);
  });

  it('respects keepHeadChars on pruned blocks', () => {
    const text = block('bash', '{"command":"find"}', big('find out')) + block('grep', '{"p":"q"}', big('grep out'));
    const out = compactResearchResults(text, 1000);
    for (const piece of out.split('[... pruned')) {
      expect(piece.length).toBeLessThanOrEqual(COMPACTION_LIMITS.keepHeadChars + 100);
    }
  });
});
