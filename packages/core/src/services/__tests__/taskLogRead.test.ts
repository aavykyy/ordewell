import { describe, it, expect } from 'vitest';
import { renderTaskLog } from '../taskLogRead';
import type { TaskLogEvent } from '../../models/TaskLog';

describe('compact saved log reads', () => {
  it('preserves the captured skill instructions instead of rereading the current skill file', () => {
    const text = renderTaskLog([{ type: 'task_skills', skills: [{ name: 'review', source: 'workspace', path: '/workspace/.ordewell/skills/review/SKILL.md', content: 'Instructions at spawn time.' }] }]);
    expect(text).toContain('review (workspace)\nInstructions at spawn time.');
    expect(text).not.toContain('/workspace');
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

  it('skips future event kinds saved by a newer runner without blocking the rest of an attempt', () => {
    const events = [{ type: 'future_event', data: 'ignored' }, { type: 'error', message: 'Known error.' }] as unknown as TaskLogEvent[];
    expect(renderTaskLog(events)).toBe('[2 error] Known error.\n');
  });
});
