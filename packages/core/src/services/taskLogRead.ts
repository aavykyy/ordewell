import type { TaskLogEvent } from '../models/TaskLog';

const LOG_KINDS = {
  task_skills: true,
  turn_start: true,
  turn_end: true,
  text_delta: true,
  text: true,
  thinking_delta: true,
  thinking: true,
  tool_call: true,
  tool_result: true,
  subagent_started: true,
  subagent_finished: true,
  usage: true,
  message_queued: true,
  message_removed: true,
  message_undelivered: true,
  message_handed_over: true,
  message_delivered: true,
  error: true,
  approval_requested: true,
  approval_decided: true,
  approval_withdrawn: true,
} satisfies Record<TaskLogEvent['type'], true>;

export const TASK_LOG_KINDS = Object.keys(LOG_KINDS) as [TaskLogEvent['type'], ...TaskLogEvent['type'][]];

function eventText(event: TaskLogEvent): string {
  switch (event.type) {
    case 'task_skills': return event.skills.map((s) => `${s.name} (${s.source})${'content' in s ? `\n${s.content}` : ''}`).join('\n');
    case 'turn_start': return `${event.messageId ? `${event.messageId} ` : ''}${event.forced ? '(forced) ' : ''}${event.from ? '(from Ordewell) ' : ''}${event.message}`;
    case 'turn_end': return event.reason;
    case 'text_delta':
    case 'text':
    case 'thinking_delta':
    case 'thinking': return event.text;
    case 'message_queued': return `${event.messageId}${event.forced ? ' (forced)' : ''}${event.from ? ' (from Ordewell)' : ''}: ${event.text}`;
    case 'message_undelivered':
    case 'message_delivered': return `${event.messageId}${event.from ? ' (from Ordewell)' : ''}: ${event.text}`;
    case 'tool_call': return `${event.id} ${event.name} ${event.args}`;
    case 'tool_result': return `${event.id} ${event.success ? 'ok' : 'failed'}${event.omittedLines ? ` (${event.omittedLines} saved lines omitted)` : ''}\n${event.output}`;
    case 'subagent_started': return `${event.subagentId}${event.model ? ` (${event.model})` : ''}: ${event.brief}`;
    case 'subagent_finished': return `${event.subagentId} ${event.outcome}: ${event.digest}`;
    case 'usage': {
      const r = event.record;
      return [r.source, r.model, r.subagentId,
        ...Object.entries(r).filter(([k, v]) => typeof v === 'number' && k !== 'reportedCost').map(([k, v]) => `${k}=${v}`),
        ...(r.reportedCost ? [`cost=${r.reportedCost.amount} ${r.reportedCost.currency}`] : []),
      ].filter(Boolean).join(' ');
    }
    case 'message_removed':
    case 'message_handed_over': return event.messageId;
    case 'error': return event.message;
    case 'approval_requested': return `${event.approvalId} ${event.tool}${event.toolCallId ? ` (call ${event.toolCallId})` : ''}${event.decided ? ` (decided ${event.decided})` : ''}${event.allowForTask ? ' (task grant offered)' : ''} ${event.args}`;
    case 'approval_decided': return `${event.approvalId} ${event.decision}${event.note ? `: ${event.note}` : ''}`;
    case 'approval_withdrawn': return event.approvalId;
  }
}

export function renderTaskLog(events: readonly TaskLogEvent[], kinds?: readonly TaskLogEvent['type'][]): string {
  return events.flatMap((event, index) => {
    if (!(event.type in LOG_KINDS) || (kinds && !kinds.includes(event.type))) return [];
    const subagent = 'subagentId' in event && event.subagentId ? ` (${event.subagentId})` : '';
    return [`[${index + 1} ${event.type}${subagent}] ${eventText(event)}\n`];
  }).join('');
}
