import type { TaskLogEvent } from '../models/TaskLog';

const LOG_KINDS = {
  task_skills: true,
  turn_start: true,
  command: true,
  command_output: true,
  model_switched: true,
  compaction: true,
  runner_loaded: true,
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
  runner_ended: true,
} satisfies Record<TaskLogEvent['type'], true>;

export const TASK_LOG_KINDS = Object.keys(LOG_KINDS) as [TaskLogEvent['type'], ...TaskLogEvent['type'][]];

function eventText(event: TaskLogEvent): string {
  switch (event.type) {
    case 'task_skills': return event.skills.map((s) => `${s.name} (${s.source})${'content' in s ? `\n${s.content}` : ''}`).join('\n');
    case 'turn_start': return `${event.messageId ? `${event.messageId} ` : ''}${event.forced ? '(forced) ' : ''}${event.from ? '(from Ordewell) ' : ''}${event.message}`;
    case 'command': return `${event.messageId ? `${event.messageId} ` : ''}/${event.name}${event.args ? ` ${event.args}` : ''}`;
    case 'command_output': return event.text;
    case 'model_switched': return `${event.from.model} → ${event.to.model}${event.effort ? ` (${event.effort})` : ''}`;
    case 'compaction': return `${event.trigger}${event.preTokens !== undefined && event.postTokens !== undefined ? `, ${event.preTokens} → ${event.postTokens} tokens` : ''}`;
    case 'runner_loaded': return [
      `commands: ${event.commands.map((c) => `/${c.name} (${c.kind})`).join(', ') || 'none'}`,
      `MCP servers: ${event.mcpServers.map((m) => `${m.name}${m.status ? ` (${m.status})` : ''}`).join(', ') || 'none'}`,
    ].join('; ');
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
    case 'runner_ended': return 'with calls still open';
  }
}

export function renderTaskLog(events: readonly TaskLogEvent[], kinds?: readonly TaskLogEvent['type'][]): string {
  return events.flatMap((event, index) => {
    if (!(event.type in LOG_KINDS) || (kinds && !kinds.includes(event.type))) return [];
    const subagent = 'subagentId' in event && event.subagentId ? ` (${event.subagentId})` : '';
    return [`[${index + 1} ${event.type}${subagent}] ${eventText(event)}\n`];
  }).join('');
}
