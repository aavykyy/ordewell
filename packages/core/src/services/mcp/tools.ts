import { z } from 'zod/v4';
import { TASK_QUERY_TASK_FIELDS, OUTPUT_LINES_MAX } from '../TaskQuery';
import { TASK_LOG_KINDS } from '../taskLogRead';

/**
 * The tools of the Ordewell MCP server, per token role (ADR-0022), and the
 * handler interfaces the session side implements to answer them.
 *
 * Every handler method is optional so each tool can be wired on its own; one
 * left unset answers its call with a "not available" error rather than
 * disappearing from `tools/list`, so the list a runner sees never depends on
 * how far the wiring has got.
 */

const taskCompleteInput = z.object({
  status: z.enum(['done', 'blocked', 'failed'])
    .describe("'done' only when the task is fully complete. 'blocked' or 'failed' end the attempt without passing."),
  summary: z.string().describe('What was done, handed to the tasks that depend on this one.'),
  reason: z.string().optional().describe("Why the task is blocked or failed. Expected for anything but 'done'."),
});

const checkpointInput = z.object({
  question: z.string().min(1).describe('The question for the user. The call returns their answer.'),
});

const listRunnersInput = z.object({});

const listModelsInput = z.object({
  runner: z.string().min(1).describe('A runner id from list_runners.'),
});

const runCommandInput = z.object({
  command: z.string().min(1).describe('One shell command line, run from the workspace root.'),
});

const fetchInput = z.object({
  url: z.string().min(1).describe('The http or https URL to read.'),
});

const webSearchInput = z.object({
  query: z.string().trim().min(1).describe('What to search for.'),
});

const loadSkillInput = z.object({
  name: z.string().min(1).describe('The name of an Ordewell planner skill to load.'),
});

const taskRef = z.union([z.string().min(1), z.number().int().min(0)]).describe('A task id, "#order" ("#2.1" for a subtask), a bare order, or a title.');

const modelAssignment = z.looseObject({
  modelId: z.string(),
  modelLabel: z.string().optional(),
  thinkingEffort: z.string().optional().describe("A variant id from that model's variants list."),
});

// Loose on purpose: the plan goes through the same validation and repair as the
// plan envelope (ADR-0022, P2), and a schema stricter than that path would
// make the two routes disagree about the same tasks.
const planTask = z.looseObject({
  id: z.string().optional(),
  order: z.number().optional(),
  title: z.string(),
  description: z.string().optional(),
  type: z.enum(['ai', 'user']).optional(),
  dependencies: z.array(z.string()).optional(),
  prompt: z.string().optional(),
  userSteps: z.array(z.looseObject({ order: z.number().optional(), instruction: z.string() })).optional(),
  assignedRunner: z.string().optional(),
  assignedModel: modelAssignment.optional(),
  readOnly: z.boolean().optional().describe('True for a task that must not change any file. Ordewell picks every mode; there is no taskMode.'),
  autonomy: z.enum(['AFK', 'HITL']).optional(),
  sliceType: z.enum(['AFK', 'HITL']).optional(),
  ops: z.boolean().optional(),
  userStoriesCovered: z.array(z.string()).optional(),
  skills: z.array(z.string()).optional()
    .describe('Task skills (applies-to: task) by name; their bodies go in the runner\'s prompt. A subtask lists its own.'),
  subtasks: z.array(z.record(z.string(), z.unknown())).optional(),
});

const submitPlanInput = z.object({
  tasks: z.array(planTask).min(1).describe('The whole plan, in order.'),
});

const taskFields = z.record(z.string(), z.unknown());
const handle = z.string().optional();

const taskOp = z.discriminatedUnion('op', [
  z.object({ op: z.literal('update'), taskId: taskRef, changes: taskFields }),
  z.object({ op: z.literal('add'), task: taskFields, handle }),
  z.object({ op: z.literal('remove'), taskId: taskRef }),
  z.object({ op: z.literal('reorder'), taskIds: z.array(taskRef) }),
  z.object({ op: z.literal('merge'), taskIds: z.array(taskRef), merged: taskFields, handle }),
  z.object({ op: z.literal('split'), taskId: taskRef, parts: z.array(taskFields), handle }),
  z.object({ op: z.literal('rearm'), taskId: taskRef, changes: taskFields.optional() }),
]);

const editPlanInput = z.object({
  ops: z.array(taskOp).min(1).describe('Applied as one batch; every ref resolves against the plan before any op runs.'),
});

const taskQueryInput = z.object({
  tasks: z.array(taskRef).optional(),
  fields: z.array(z.enum(TASK_QUERY_TASK_FIELDS)).optional().describe('Omit to read every field. A task\'s output is read with task_output.'),
  catalog: z.boolean().optional().describe('Also return every runner with its models, thinking-effort variants and modes.'),
}).refine((q) => (q.tasks?.length ?? 0) > 0 || q.catalog === true, { message: 'Name at least one task, or set catalog: true.' });

const taskOutputInput = z.object({
  attempt: z.number().int().min(1).optional().describe('Read this saved attempt; omit for the latest. Supplying attempt or kinds selects the structured log.'),
  kinds: z.array(z.enum(TASK_LOG_KINDS)).optional().describe('Only these TaskLogEvent types. Commands appear in tool_call and tool_result; runner messages in text/text_delta.'),
  task: taskRef,
  lines: z.number().int().min(1).optional().describe(`How many lines to return; the default is 80 and anything over ${OUTPUT_LINES_MAX} is cut to ${OUTPUT_LINES_MAX}.`),
  since: z.number().int().min(0).optional().describe("A previous answer's nextOffset: return only what came after it."),
});

const taskDiffInput = z.object({
  task: taskRef,
  repo: z.string().min(1).optional().describe('A repository path from the file list; default is every repo.'),
  path: z.string().min(1).optional().describe('A literal repo-relative file path from the list. Omit for file change stats.'),
  lines: z.number().int().min(1).optional().describe('Maximum lines per page (default 80, cap 400).'),
  since: z.number().int().min(0).optional().describe('A previous nextOffset, in characters of this diff or file list.'),
});

const runPlanInput = z.object({});

const oneTaskInput = z.object({ task: taskRef });

const retryTaskInput = z.object({
  task: taskRef,
  from: z.enum(['fresh', 'session'])
    .describe('"fresh": a new attempt from the task\'s prompt as the plan holds it now (change the prompt with edit_plan first). "session": continue the runner\'s saved session with "message"; for a completed or failed task, or one paused on a usage limit.'),
  message: z.string().optional().describe('What the runner should do next. Required with "session", except to resume a task paused on a usage limit.'),
});

const skipTaskInput = z.object({
  task: taskRef,
  reason: z.string().describe('Why the run should go on without this task. Shown to the user, and told to the tasks that depend on it.'),
});

const messageTaskInput = z.object({
  task: taskRef,
  text: z.string().trim().min(1).describe('The message. A running task reads it at its next step; one waiting for input takes it as its answer.'),
});

const answerApprovalInput = z.object({
  task: taskRef,
  approval: z.string().optional().describe('Which request, when the task has more than one waiting; a refusal lists them.'),
  answer: z.string().min(1).describe('"deny" or "escalate". Never "allow": that would widen the mode the plan gave the task.'),
  note: z.string().optional().describe('With "deny": what the runner should do instead. It reads this.'),
});

export type TaskCompleteArgs = z.infer<typeof taskCompleteInput>;
export type CheckpointArgs = z.infer<typeof checkpointInput>;
export type ListRunnersArgs = z.infer<typeof listRunnersInput>;
export type ListModelsArgs = z.infer<typeof listModelsInput>;
export type LoadSkillArgs = z.infer<typeof loadSkillInput>;
export type RunCommandArgs = z.infer<typeof runCommandInput>;
export type FetchArgs = z.infer<typeof fetchInput>;
export type WebSearchArgs = z.infer<typeof webSearchInput>;
export type SubmitPlanArgs = z.infer<typeof submitPlanInput>;
export type EditPlanArgs = z.infer<typeof editPlanInput>;
export type TaskQueryArgs = z.infer<typeof taskQueryInput>;
export type TaskOutputArgs = z.infer<typeof taskOutputInput>;
export type TaskDiffArgs = z.infer<typeof taskDiffInput>;
export type RunPlanArgs = z.infer<typeof runPlanInput>;
export type OneTaskArgs = z.infer<typeof oneTaskInput>;
export type RetryTaskArgs = z.infer<typeof retryTaskInput>;
export type MessageTaskArgs = z.infer<typeof messageTaskInput>;
export type SkipTaskArgs = z.infer<typeof skipTaskInput>;
export type AnswerApprovalArgs = z.infer<typeof answerApprovalInput>;

/** What a handler answers with. `isError` marks a refusal the caller should act on. */
export interface McpToolReply {
  text: string;
  isError?: boolean;
}

/**
 * How a checkpoint call ended. `withdrawn` is the attempt going away under it
 * (verdict, cancel, retry, stop) or the call being refused, not a verdict on
 * the question.
 */
export type CheckpointAnswer =
  | { kind: 'continue' }
  | { kind: 'rejected'; reason: string }
  | { kind: 'withdrawn'; why: string };

/** The checkpoint call's result: the answer as the runner reads it (ADR-0022, V5). */
export function checkpointReply(answer: CheckpointAnswer): McpToolReply {
  switch (answer.kind) {
    case 'continue': return { text: 'continue' };
    case 'rejected': return { text: `rejected: ${answer.reason}` };
    case 'withdrawn': return { text: `The checkpoint was withdrawn: ${answer.why}`, isError: true };
  }
}

export interface McpToolContext {
  /** Aborts when the token is revoked or the caller cancels — a waiting handler must stop. */
  signal: AbortSignal;
}

type Run<A> = (args: A, context: McpToolContext) => Promise<McpToolReply>;

export interface TaskToolHandler {
  taskComplete?: Run<TaskCompleteArgs>;
  checkpoint?: Run<CheckpointArgs>;
}

export interface PlannerToolHandler {
  loadSkill?: Run<LoadSkillArgs>;
  runCommand?: Run<RunCommandArgs>;
  fetch?: Run<FetchArgs>;
  webSearch?: Run<WebSearchArgs>;
  listRunners?: Run<ListRunnersArgs>;
  listModels?: Run<ListModelsArgs>;
  submitPlan?: Run<SubmitPlanArgs>;
  editPlan?: Run<EditPlanArgs>;
  taskQuery?: Run<TaskQueryArgs>;
  taskOutput?: Run<TaskOutputArgs>;
  taskDiff?: Run<TaskDiffArgs>;
  runPlan?: Run<RunPlanArgs>;
  runTask?: Run<OneTaskArgs>;
  stopTask?: Run<OneTaskArgs>;
  stopRun?: Run<RunPlanArgs>;
  retryTask?: Run<RetryTaskArgs>;
  skipTask?: Run<SkipTaskArgs>;
  messageTask?: Run<MessageTaskArgs>;
  answerApproval?: Run<AnswerApprovalArgs>;
  mergeAll?: Run<RunPlanArgs>;
}

export interface McpTool<H> {
  name: string;
  description: string;
  inputSchema: { type: 'object'; [key: string]: unknown };
  annotations?: { readOnlyHint: boolean };
  /** Validate `args` and hand them to the handler's method for this tool. */
  call(handler: H, args: unknown, context: McpToolContext): Promise<McpToolReply>;
}

function tool<H, S extends z.ZodObject>(
  name: string,
  description: string,
  input: S,
  pick: (handler: H) => Run<z.infer<S>> | undefined,
  annotations?: McpTool<H>['annotations'],
): McpTool<H> {
  return {
    name,
    description,
    inputSchema: { ...z.toJSONSchema(input, { io: 'input' }), type: 'object' },
    ...(annotations ? { annotations } : {}),
    async call(handler, args, context) {
      const run = pick(handler);
      if (!run) return { text: `${name} is not available in this session.`, isError: true };
      const parsed = input.safeParse(args ?? {});
      if (!parsed.success) return { text: `Invalid ${name} arguments: ${z.prettifyError(parsed.error)}`, isError: true };
      return run(parsed.data, context);
    },
  };
}

/** The task tool whose call settles the attempt (ADR-0022, V1). */
export const TASK_COMPLETE_TOOL = 'task_complete';

/**
 * How a task is told to end. It rides in the runner's instructions rather than
 * in the first message: a runner compacts its own context and rewrites that
 * message into a summary, while its instructions are re-applied whole.
 */
export const TASK_COMPLETION_CONTRACT = [
  `When you have fully completed this task, call the \`${TASK_COMPLETE_TOOL}\` tool with status \`done\` and a summary of what you did. If you cannot complete it, call \`${TASK_COMPLETE_TOOL}\` with status \`blocked\` or \`failed\` and the reason instead.`,
  `The \`${TASK_COMPLETE_TOOL}\` summary is this task's report: the planner and the tasks that depend on this one read it, and nothing else you write reaches them. Put the full result there — findings, decisions, anything a reader needs to act on it. A review or other read-only task especially: its findings are its result, so put them all in the summary, and do not write the report to a file.`,
].join('\n\n');

export const TASK_TOOLS: readonly McpTool<TaskToolHandler>[] = [
  tool(TASK_COMPLETE_TOOL, 'Report that this task has ended, and how. Call it once, as your last action.',
    taskCompleteInput, (h) => h.taskComplete?.bind(h)),
  tool('checkpoint', "Ask the user a question and wait for the answer, which is this call's result.",
    checkpointInput, (h) => h.checkpoint?.bind(h)),
];

/**
 * A harness plan mode refuses an MCP tool that does not declare itself
 * read-only, pre-allowed or not. True of the workspace for every planner tool
 * but the execution tools: `submit_plan` and `edit_plan` write only Ordewell's plan, through the same
 * validation as the envelopes (ADR-0022, P1/P2), `run_command` refuses
 * every write the classifier sees (ADR-0026), and `fetch` and `web_search`
 * only send a GET (ADR-0027).
 */
const PLANNER_READ_ONLY = { readOnlyHint: true };

/**
 * The execution tools (ADR-0029) change what runs, so they say so. Every
 * harness planner is pre-authorized for the server by name, not by this hint,
 * and none runs in a plan mode that would refuse them for it.
 */
const PLANNER_EXECUTES = { readOnlyHint: false };

/**
 * The planner's execution tools (ADR-0029, #91): each call goes to the
 * session's command seam, which checks it, asks the user where consent needs
 * one, and records it. The API planner offers the same tools as its own.
 */
export const PLANNER_EXECUTION_TOOLS: readonly McpTool<PlannerToolHandler>[] = [
  tool('run_plan', 'Start the whole plan, as the user\'s Execute plan does. Only a plan the user has approved; in Guarded the user is asked first.',
    runPlanInput, (h) => h.runPlan?.bind(h), PLANNER_EXECUTES),
  tool('run_task', 'Start one task now. Refused, with the reason, for a task whose dependencies have not finished, one waiting for Merge all, or one the user has not approved; in Guarded the user is asked first.',
    oneTaskInput, (h) => h.runTask?.bind(h), PLANNER_EXECUTES),
  tool('stop_task', 'Stop one running task: it goes back to not started and is held until retried, and its open approvals are denied.',
    oneTaskInput, (h) => h.stopTask?.bind(h), PLANNER_EXECUTES),
  tool('stop_run', 'Stop every running task and the run. The plan is kept.',
    runPlanInput, (h) => h.stopRun?.bind(h), PLANNER_EXECUTES),
  tool('retry_task', 'Start a new attempt of a failed, stopped or waiting task: fresh from its prompt, or continuing its saved session with a message. To change what it is told, edit its prompt with edit_plan first. A task paused on a usage limit can be resumed early with from "session" once the user says the limit has been reset. In Guarded the user is asked first.',
    retryTaskInput, (h) => h.retryTask?.bind(h), PLANNER_EXECUTES),
  tool('skip_task', 'Give up waiting for a task that failed, is blocked or is waiting for input: it ends as skipped, none of its work lands, and the tasks that depend on it go ahead without it, told your reason. It never marks work complete. Only the supervisor at Act may, in a wake-up turn; a reason is required.',
    skipTaskInput, (h) => h.skipTask?.bind(h), PLANNER_EXECUTES),
  tool('message_task', 'Send a message to a running task, or answer one waiting for input. A message to a task paused on a usage limit resumes it in its saved session.',
    messageTaskInput, (h) => h.messageTask?.bind(h), PLANNER_EXECUTES),
  tool('answer_approval', 'Answer a request a task\'s runner is waiting on: deny it with a note, or escalate it to the user. It never allows.',
    answerApprovalInput, (h) => h.answerApproval?.bind(h), PLANNER_EXECUTES),
  tool('merge_all', 'Merge the run\'s landed work into the user\'s branch, as their Merge all does, opening the merge gates that wait on it. Only the supervisor at Act may, in a wake-up turn; otherwise the user presses Merge all.',
    runPlanInput, (h) => h.mergeAll?.bind(h), PLANNER_EXECUTES),
];

export const PLANNER_TOOLS: readonly McpTool<PlannerToolHandler>[] = [
  tool('list_runners', 'List the runners enabled right now, and whether each takes a read-only task. Call it just before submit_plan.',
    listRunnersInput, (h) => h.listRunners?.bind(h), PLANNER_READ_ONLY),
  tool('list_models', 'List the models a runner may use right now, with labels and thinking-effort variants.',
    listModelsInput, (h) => h.listModels?.bind(h), PLANNER_READ_ONLY),
  tool('submit_plan', 'Submit the whole plan. It is checked against the live runners and models; an error names the task, the field and what would be accepted.',
    submitPlanInput, (h) => h.submitPlan?.bind(h), PLANNER_READ_ONLY),
  tool('edit_plan', 'Change the current plan with task operations: update, add, remove, reorder, merge, split or rearm.',
    editPlanInput, (h) => h.editPlan?.bind(h), PLANNER_READ_ONLY),
  tool('task_query', 'Read the long fields of plan tasks that the plan summary leaves out (prompt, user steps, verdict, output summary, attached skills), and optionally the live runner catalog. Read a task before you rewrite it.',
    taskQueryInput, (h) => h.taskQuery?.bind(h), PLANNER_READ_ONLY),
  tool('task_output', "Read the recent output of a running task, to check what its runner is doing; paged by offset. A task that is not running answers with its verdict, output summary and a digest of its last attempt. Supply attempt or kinds to page a saved structured log, latest by default.",
    taskOutputInput, (h) => h.taskOutput?.bind(h), PLANNER_READ_ONLY),
  tool('task_diff', 'Read what a task changed since it started: file stats with repository paths, or a single file patch with path and repo. Paged by since/nextOffset. Shared runs without recorded changes report not available.',
    taskDiffInput, (h) => h.taskDiff?.bind(h), PLANNER_READ_ONLY),
  tool('run_command', 'Run a shell command for research: git, gh, az, kubectl, the project\'s own tooling, anything you need to look at. Read-only commands run at once; others ask the user, once per command family; commands that write files are refused. Use it instead of a shell of your own.',
    runCommandInput, (h) => h.runCommand?.bind(h), PLANNER_READ_ONLY),
  // Fallbacks (ADR-0027): a runner's own fetch or search, where it has one, is
  // decided by the same policy and carries the provider's own summaries, so
  // the descriptions send the model there first.
  tool('fetch', 'Read a web page over http or https: documentation, a changelog, an API reference. A fallback: if you have a built-in web fetch tool, use that instead. Whether a site may be read is up to the user\'s settings, and a refusal says why; private and local addresses and URLs that carry a credential are always refused, and each planning turn has a limited number of web reads.',
    fetchInput, (h) => h.fetch?.bind(h), PLANNER_READ_ONLY),
  tool('web_search', 'Search the web for result titles, URLs and snippets, then read the most promising result with a fetch. A fallback: if you have a built-in web search tool, use that instead. Whether a search may run is up to the user\'s settings, and a refusal says why; a query that carries a credential is refused, and searches count toward the turn\'s web reads.',
    webSearchInput, (h) => h.webSearch?.bind(h), PLANNER_READ_ONLY),
  tool('load_skill', 'Load an Ordewell planner skill by name. Returns its instructions; only model-invocable planner skills can be loaded.',
    loadSkillInput, (h) => h.loadSkill?.bind(h), PLANNER_READ_ONLY),
  ...PLANNER_EXECUTION_TOOLS,
];

export const PLANNER_TASK_READ_TOOLS = PLANNER_TOOLS.filter((t) => ['task_query', 'task_output', 'task_diff'].includes(t.name));
