import { describe, it, expect, vi } from 'vitest';
import type { DiscoveredModel, RunnerId, Task } from '../../models/Task';
import type { RunnerModeInfo } from '../ModeResolver';
import type { ConversationRequest, ConversationTurn } from '../AiService';
import type { Session } from '../createSession';
import type { SessionMessage } from '../SessionMessage';
import type { McpToolContext, PlannerToolHandler, SubmitPlanArgs } from '../mcp/tools';
import { classifyPlannerReply } from '../PlanRepair';
import { validatePlanTasks } from '../PlanValidator';
import { makeSession } from './sessionTestKit';

const RUNNERS = ['claude-code'];
/** What the MCP layer hands a planner tool call; these handlers ignore it. */
const TOOL_CALL: McpToolContext = { signal: new AbortController().signal };

const PLAN = {
  tasks: [
    { id: 'a', order: 1, title: 'Schema', description: 'Add the table', type: 'ai', prompt: 'add the table', dependencies: [], subtasks: [],
      sliceType: 'AFK', autonomy: 'AFK', assignedRunner: 'claude-code', assignedModel: { modelId: 'claude-sonnet-4', modelLabel: 'Sonnet' } },
    // Off the allowlist: both channels must coerce it the same way (ADR-0003).
    { id: 'b', order: 2, title: 'Endpoint', description: 'Serve it', type: 'ai', prompt: 'serve it', dependencies: ['a'], subtasks: [],
      sliceType: 'AFK', autonomy: 'AFK', assignedRunner: 'claude-code', assignedModel: { modelId: 'claude-opus-4', modelLabel: 'Opus', thinkingEffort: 'high' } },
  ],
};

const discovered: DiscoveredModel[] = [
  { modelId: 'claude-sonnet-4', modelLabel: 'Claude Sonnet 4', variants: [] },
  { modelId: 'claude-opus-4', modelLabel: 'Claude Opus 4', variants: [{ id: 'high', label: 'High' }] },
];

/** What the harness backend hands back for a reply: its text, classified the way settleReply does, with the modes the session's catalog offers. */
function replyTurn(text: string, runnerModes?: Record<RunnerId, RunnerModeInfo[]>): ConversationTurn {
  const reply = classifyPlannerReply(text, { runners: RUNNERS, runnerModes, autonomousDefault: true });
  if (reply.kind === 'plan') return { kind: 'plan', tasks: reply.tasks, text, researchLog: [] };
  if (reply.kind === 'task_ops') return { kind: 'task_ops', ops: reply.ops, text, researchLog: [] };
  return { kind: 'message', text, researchLog: [] };
}

function validTasks(obj: unknown): Task[] {
  // The session fixture plans in Full, so both channels must resolve the level the same way.
  const result = validatePlanTasks(obj, RUNNERS, undefined, true);
  if (!result.ok) throw new Error(result.errors.map((e) => e.message).join('; '));
  return result.tasks;
}

/** The plan as the tool schema reads it: the harness sends raw JSON, so the loose shape is a cast here. */
const planArgs = (tasks: Task[]): SubmitPlanArgs => ({ tasks: tasks as unknown as SubmitPlanArgs['tasks'] });

/**
 * A session one clarifying turn into planning, whose next planner reply is
 * `answer` — run while the turn is open, so it can hand something in first
 * through the planner's own tools, as the harness backend does.
 */
async function sessionAnswering(answer: (session: Session, tools: PlannerToolHandler, reply: (text: string) => Promise<ConversationTurn>) => ConversationTurn | Promise<ConversationTurn>) {
  const broadcast = vi.fn<(msg: SessionMessage) => void>();
  let tools: PlannerToolHandler | undefined;
  const reply = async (text: string): Promise<ConversationTurn> => replyTurn(text, (await session.liveCatalog()).modes);
  const session: Session = makeSession({
    aiService: {
      startConversation: vi.fn(async (req: ConversationRequest) => {
        tools = req.plannerTools?.handler;
        return reply('What should the endpoint return?');
      }),
      continueConversation: vi.fn(async () => answer(session, tools!, reply)),
      hasActiveConversation: () => true,
    },
    modelResolver: { modelsForRunners: vi.fn().mockResolvedValue({ 'claude-code': discovered }) },
    settings: () => ({ modelAllowlist: { 'claude-code': ['claude-sonnet-4'] } }),
    broadcast,
  });
  await session.startPlanning('add an endpoint', RUNNERS);
  broadcast.mockClear();
  await session.continueConversation('JSON, please');
  return { session, broadcast, tools: tools! };
}

/**
 * The committed outcome with the per-turn noise (ids, clocks) taken out, and
 * without the reply a submission's turn says beside it: an envelope reply has
 * no prose to keep.
 */
function committed(session: Session, broadcast: ReturnType<typeof vi.fn<(msg: SessionMessage) => void>>, said?: string) {
  const outcome = session.planState?.conversationHistory?.filter((m) => m.content !== said).at(-1);
  return {
    tasks: session.planTasks,
    runners: session.planState?.runners,
    lastMessage: { role: outcome?.role, content: outcome?.content, kind: outcome?.kind },
    broadcasts: broadcast.mock.calls.filter(([msg]) => !(msg.type === 'planner_message' && msg.content === said)).map(([msg]) => msg.type),
  };
}

/**
 * The reply prose the turn kept: in the transcript just after the outcome the
 * tool committed as it answered (ADR-0022 P2), and broadcast as a planner
 * message.
 */
function kept(session: Session, broadcast: ReturnType<typeof vi.fn<(msg: SessionMessage) => void>>, said: string) {
  return {
    transcript: session.planState?.conversationHistory?.at(-1)?.content,
    broadcast: broadcast.mock.calls.some(([msg]) => msg.type === 'planner_message' && msg.content === said),
  };
}

describe('a plan handed in during a planner turn', () => {
  it('commits exactly as the same plan sent as the JSON envelope, and keeps the reply beside it', async () => {
    const viaJson = await sessionAnswering((_session, _tools, reply) => reply(JSON.stringify(PLAN)));
    const viaSubmit = await sessionAnswering(async (_session, tools, reply) => {
      expect((await tools.submitPlan!(planArgs(validTasks(PLAN)), TOOL_CALL)).isError).toBeFalsy();
      return reply('Submitted the plan.');
    });

    expect(committed(viaSubmit.session, viaSubmit.broadcast, 'Submitted the plan.')).toEqual(committed(viaJson.session, viaJson.broadcast));
    expect(kept(viaSubmit.session, viaSubmit.broadcast, 'Submitted the plan.')).toEqual({ transcript: 'Submitted the plan.', broadcast: true });
    expect(viaSubmit.session.planTasks.map((t) => t.assignedModel?.modelId)).toEqual(['claude-sonnet-4', 'claude-sonnet-4']);
  });
});

describe('what a submission wins over', () => {
  it('a JSON plan in the same turn: the submitted one stands', async () => {
    const other = { tasks: [{ ...PLAN.tasks[0], id: 'json-only', title: 'From the reply' }] };
    const { session } = await sessionAnswering(async (_s, tools, reply) => {
      await tools.submitPlan!(planArgs(validTasks(PLAN)), TOOL_CALL);
      return reply(JSON.stringify(other));
    });

    expect(session.planTasks.map((t) => t.id)).toEqual(['a', 'b']);
  });

  it('nothing once the turn has settled: it commits nothing', async () => {
    const { session, tools } = await sessionAnswering((_s, _t, reply) => reply('Sure.'));

    const refused = await tools.submitPlan!(planArgs(validTasks(PLAN)), TOOL_CALL);
    expect(refused.isError).toBe(true);
    expect(refused.text).toContain('No planning turn is open to take the plan.');
    expect(session.planTasks).toEqual([]);
  });
});

describe('task ops handed in during a planner turn', () => {
  it('apply exactly as the same taskOps sent as the JSON envelope, and keep the reply beside them', async () => {
    const ops = { taskOps: [{ op: 'update', taskId: '#1', changes: { title: 'Schema and migration' } }] };
    const run = async (answer: (s: Session, tools: PlannerToolHandler, reply: (text: string) => Promise<ConversationTurn>) => ConversationTurn | Promise<ConversationTurn>) => {
      const { session, broadcast } = await sessionAnswering(async (s, tools, reply) => {
        if (!s.planTasks.length) {
          await tools.submitPlan!(planArgs(validTasks(PLAN)), TOOL_CALL);
          return reply('Planned.');
        }
        return answer(s, tools, reply);
      });
      broadcast.mockClear();
      await session.continueConversation('rename the first task');
      return { session, broadcast };
    };

    const viaJson = await run((_s, _t, reply) => reply(JSON.stringify(ops)));
    const viaSubmit = await run(async (_s, tools, reply) => {
      const parsed = await reply(JSON.stringify(ops));
      if (parsed.kind !== 'task_ops') throw new Error('fixture is not ops');
      const outcome = await tools.editPlan!({ ops: parsed.ops }, TOOL_CALL);
      expect(outcome.isError).toBeFalsy();
      return reply('Renamed it.');
    });

    expect(committed(viaSubmit.session, viaSubmit.broadcast, 'Renamed it.')).toEqual(committed(viaJson.session, viaJson.broadcast));
    expect(kept(viaSubmit.session, viaSubmit.broadcast, 'Renamed it.')).toEqual({ transcript: 'Renamed it.', broadcast: true });
    expect(viaSubmit.session.planTasks[0].title).toBe('Schema and migration');
  });
});
