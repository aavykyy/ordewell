import { describe, it, expect } from 'vitest';
import { renderTaskLog } from '../taskLogRead';
import type { TaskLogEvent } from '../../models/TaskLog';

describe('compact saved log reads', () => {
  it('preserves the captured skill instructions instead of rereading the current skill file', () => {
    const text = renderTaskLog([{ type: 'task_skills', skills: [{ name: 'review', source: 'workspace', path: '/workspace/.ordewell/skills/review/SKILL.md', content: 'Instructions at spawn time.' }] }]);
    expect(text).toContain('review (workspace)\nInstructions at spawn time.');
    expect(text).not.toContain('/workspace');
  });

  it('reads a runner command\'s turn, what it printed, a compaction and what the runner loaded (#66)', () => {
    const text = renderTaskLog([
      { type: 'runner_loaded', commands: [{ name: 'pingskill', description: 'Reply', kind: 'skill' }, { name: 'compact', description: 'Free up context', kind: 'builtin' }], mcpServers: [{ name: 'docs-server', status: 'pending' }] },
      { type: 'command', name: 'compact', args: 'keep the API notes', messageId: 'msg-2' },
      { type: 'compaction', trigger: 'manual', preTokens: 24939, postTokens: 3615 },
      { type: 'command_output', text: 'Compacted' },
    ]);
    expect(text).toBe([
      '[1 runner_loaded] commands: /pingskill (skill), /compact (builtin); MCP servers: docs-server (pending)',
      '[2 command] msg-2 /compact keep the API notes',
      '[3 compaction] manual, 24939 → 3615 tokens',
      '[4 command_output] Compacted',
      '',
    ].join('\n'));
  });

  it('reads a model switch saved before the plan\'s side was recorded', () => {
    const saved = JSON.parse('{"type":"model_switched","from":{"model":"sonnet"},"to":{"model":"opus"},"effort":"high"}') as TaskLogEvent;
    expect(renderTaskLog([saved])).toBe('[1 model_switched] sonnet → opus\n');
  });

  it('says which messages Ordewell sent rather than the user', () => {
    const text = renderTaskLog([
      { type: 'turn_start', message: 'Call task_complete.', from: 'ordewell' },
      { type: 'message_delivered', messageId: 'msg-2', text: 'Call it now.', from: 'ordewell' },
    ]);
    expect(text).toContain('(from Ordewell) Call task_complete.');
    expect(text).toContain('msg-2 (from Ordewell): Call it now.');
  });

  it('retains message and approval correlation while filtering out unrelated events', () => {
    const events: TaskLogEvent[] = [
      { type: 'message_queued', messageId: 'message1', text: 'Check it again.', forced: true },
      { type: 'turn_start', messageId: 'message1', message: 'Check it again.', forced: true },
      { type: 'text', text: 'Working.' },
      { type: 'approval_requested', approvalId: 'approval1', toolCallId: 'call1', tool: 'Bash', args: '{"command":"npm test"}', allowForTask: true },
      { type: 'approval_decided', approvalId: 'approval1', decision: 'deny', note: 'Use the offline suite.' },
    ];
    const text = renderTaskLog(events, ['message_queued', 'turn_start', 'approval_requested', 'approval_decided']);
    expect(text).toContain('message1 (forced): Check it again.');
    expect(text).toContain('message1 (forced) Check it again.');
    expect(text).toContain('approval1 Bash (call call1) (task grant offered)');
    expect(text).toContain('approval1 deny: Use the offline suite.');
    expect(text).not.toContain('Working.');
  });

  it('says a request was already decided, so the read is not mistaken for an open wait', () => {
    const text = renderTaskLog([
      { type: 'approval_requested', approvalId: 'approval1', tool: 'mcp__ordewell__task_complete', args: '{}', allowForTask: false, decided: 'allow' },
    ]);
    expect(text).toContain('approval1 mcp__ordewell__task_complete (decided allow)');
  });

  it('skips future event kinds saved by a newer runner without blocking the rest of an attempt', () => {
    const events = [{ type: 'future_event', data: 'ignored' }, { type: 'error', message: 'Known error.' }] as unknown as TaskLogEvent[];
    expect(renderTaskLog(events)).toBe('[2 error] Known error.\n');
  });
});
