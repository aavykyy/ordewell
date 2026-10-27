/**
 * The scripted `SessionMessage` sequences the webview harness plays through a
 * real `ConversationViewHost` (see host-driver.mjs). Shaped like core's own
 * conversation fixtures (packages/core/src/conversation/__tests__/fixtures/turns.ts)
 * so the states here are ones the reducer is already proven against — this
 * file adapts them into a single guided tour, plus the handful of top-level
 * `HostToWebview` messages (setRunners, planUpdated, …) a real host sends that
 * never pass through the conversation.
 *
 * Each step is one of:
 *   { post: HostToWebviewMessage }        — sent to the page as-is
 *   { drive: (host) => void }             — mutates the ConversationViewHost;
 *                                            its output is flushed and sent
 *   { mark: string }                      — a named checkpoint the driving
 *                                            script can screenshot/assert at
 *
 * It also holds GOAL_SCENARIOS, the five kinds of goal the planner's strategy
 * step teaches (#108). Unlike the tour above, those are driven against the real
 * planner loop by drive-conversation.mjs: the mock's `mock/goal-*` persona
 * produces each kind's plumbing, and the driver asserts the session accepts
 * it; `--real` replays the same five goals and reports what strategy was
 * observed. The table stays here so a new kind of goal is added in one place.
 */

const step = (id, tool, args, result, outcome, extra = {}) => ({
  id, tool, args: JSON.stringify(args), result, success: outcome === 'success', outcome, timestamp: '2026-09-27T10:02:00.000Z', ...extra,
});

const SETUP = [
  { post: { type: 'setConfiguredProviders', providers: ['openrouter'] } },
  {
    post: {
      type: 'setPlannerBackends',
      backends: [
        { id: 'openrouter', label: 'OpenRouter', kind: 'vendor', usable: true },
        { id: 'claude-code', label: 'Claude Code', kind: 'harness', runner: 'claude-code', usable: true },
      ],
      provider: 'openrouter',
    },
  },
  { post: { type: 'setModelConfig', modelConfig: { orchestrator: 'deepseek/deepseek-v4-flash' } } },
  {
    post: {
      type: 'setRunners',
      runners: [
        { id: 'claude-code', displayName: 'Claude Code', enabled: true },
        { id: 'codex', displayName: 'Codex', enabled: true },
      ],
    },
  },
  { mark: 'empty' },
];

/**
 * The first screen before a word is typed: the hero, the autorun note and the
 * repositories card. It needs no session — the empty state is what the host
 * draws before a turn — so the posts are the whole fixture. The workspace is
 * one repository on a branch with a commit, and a path tasks share live, so
 * every part of the card has something real to render.
 */
const FIRST_SCREEN_RUN = {
  autonomous: false,
  run: {
    supervisorLevel: 'watch',
    mergeAtGatesAutomatically: false,
    plannedWithTrailer: true,
    autorun: true,
    supervisorRetryLimit: 2,
    wakeUpReadBudget: 12,
  },
};

export const FIRST_SCREEN = [
  { post: { type: 'setConfiguredProviders', providers: ['openrouter'] } },
  {
    post: {
      type: 'setPlannerBackends',
      backends: [
        { id: 'openrouter', label: 'OpenRouter', kind: 'vendor', usable: true },
        { id: 'claude-code', label: 'Claude Code', kind: 'harness', runner: 'claude-code', usable: true },
      ],
      provider: 'claude-code',
      runner: 'claude-code',
    },
  },
  { post: { type: 'setModelConfig', modelConfig: { orchestrator: 'deepseek/deepseek-v4-flash' } } },
  {
    post: {
      type: 'setRunners',
      runners: [
        { id: 'claude-code', displayName: 'Claude Code', enabled: true },
        { id: 'codex', displayName: 'Codex', enabled: true },
      ],
    },
  },
  { post: { type: 'setRunSettings', ...FIRST_SCREEN_RUN } },
  {
    post: {
      type: 'isolationPreview',
      preview: {
        status: 'ready',
        repos: [{ path: '.', head: { kind: 'branch', branch: 'feat/runners_login', commit: '3a775192' }, dirty: false }],
        shared: ['vendor/wasm', 'bench/live/screenshots'],
      },
    },
  },
];

/** The same screen with autorun off: the note's other state, which must read as one quiet row. */
export const FIRST_SCREEN_AUTORUN_OFF = { post: { type: 'setRunSettings', ...FIRST_SCREEN_RUN, run: { ...FIRST_SCREEN_RUN.run, autorun: false } } };

/** A group of repositories with long paths and a long branch, for the card's wrapping. */
export const FIRST_SCREEN_LONG_PATHS = {
  post: {
    type: 'isolationPreview',
    preview: {
      status: 'dirty',
      repos: [
        { path: 'packages/some-rather-long-package-name', head: { kind: 'branch', branch: 'feature/a-branch-name-long-enough-to-need-wrapping', commit: 'deadbeef123' }, dirty: true },
        { path: 'services/billing-and-invoicing-web', head: { kind: 'branch', branch: 'main', commit: 'c7c8d96' }, dirty: false },
      ],
      shared: [],
    },
  },
};

/**
 * The first screen with a signed-out coding agent: the planner pill carries the
 * dot, and the empty state carries the sentence and the one login action.
 * `signedIn` is the same pair after a login, for the state that must redraw.
 */
const signedOut = { state: 'signed-out', loginCommand: ['claude', 'auth', 'login'], detail: 'not logged in' };
const signedIn = { state: 'signed-in', loginCommand: ['claude', 'auth', 'login'] };
export const SIGNED_OUT_PLANNERS = {
  signedOut: {
    type: 'setPlannerBackends',
    backends: [
      { id: 'claude-code', label: 'Claude Code', kind: 'harness', runner: 'claude-code', usable: true, reason: 'not logged in', auth: signedOut },
      { id: 'codex', label: 'Codex', kind: 'harness', runner: 'codex', usable: true, auth: { ...signedOut, loginCommand: ['codex', 'login'] } },
    ],
    provider: 'claude-code',
    runner: 'claude-code',
  },
  signedIn: {
    type: 'setPlannerBackends',
    backends: [
      { id: 'claude-code', label: 'Claude Code', kind: 'harness', runner: 'claude-code', usable: true, reason: 'coding agent · no API key needed', auth: signedIn },
      { id: 'codex', label: 'Codex', kind: 'harness', runner: 'codex', usable: true, auth: { ...signedIn, loginCommand: ['codex', 'login'] } },
    ],
    provider: 'claude-code',
    runner: 'claude-code',
  },
};

export const SIGNED_OUT_SETUP = [
  { post: { type: 'setConfiguredProviders', providers: [] } },
  { post: SIGNED_OUT_PLANNERS.signedOut },
  { post: { type: 'setModelConfig', modelConfig: { orchestrator: 'deepseek/deepseek-v4-flash' } } },
  {
    post: {
      type: 'setRunners',
      // One signed-out runner on and one off, beside an agent with no login:
      // the three capsule shapes the baseline and auth composition must align.
      runners: [
        { id: 'claude-code', displayName: 'Claude Code', enabled: true },
        { id: 'codex', displayName: 'Codex', enabled: false },
        { id: 'opencode', displayName: 'OpenCode', enabled: true },
      ],
    },
  },
];

/** A prose reply streamed in one segment, then settled — screenshot mid-stream and after. */
const STREAMED_REPLY = [
  { drive: (h) => h.note('user', 'add persistence') },
  { drive: (h) => h.receive({ type: 'planner_turn_started', turnId: 't1', prompt: 'add persistence' }) },
  { drive: (h) => h.receive({ type: 'planner_text_delta', turnId: 't1', segmentId: 's1', text: 'Which ' }) },
  { mark: 'reply-streaming' },
  { drive: (h) => h.receive({ type: 'planner_text_delta', turnId: 't1', segmentId: 's1', text: 'store — SQLite ' }) },
  { drive: (h) => h.receive({ type: 'planner_text_delta', turnId: 't1', segmentId: 's1', text: 'or Postgres?' }) },
  { drive: (h) => h.receive({ type: 'planner_message', content: 'Which store: SQLite or Postgres?', timestamp: '2026-09-27T10:00:05.000Z', turnId: 't1' }) },
  { drive: (h) => h.receive({ type: 'planner_turn_ended', turnId: 't1', outcome: 'message' }) },
  { mark: 'reply-settled' },
  { drive: (h) => h.note('user', 'use SQLite') },
];

/** Building plan → plan marker, with a command row long enough to need its 3-line preview. */
const PLAN_TURN = [
  { drive: (h) => h.receive({ type: 'planner_turn_started', turnId: 't6', prompt: 'use SQLite' }) },
  { drive: (h) => h.receive({ type: 'planner_thinking_delta', turnId: 't6', text: 'The repo already lists its source under src, so start there.' }) },
  { mark: 'thinking-collapsed' },
  { drive: (h) => h.receive({ type: 'research_step', tool: 'list_dir', args: '{"path":"src"}', toolCallId: 'call_l', turnId: 't6' }) },
  {
    drive: (h) => h.receive({
      type: 'research_step_done',
      step: step('rs-l', 'list_dir', { path: 'src' }, 'index.ts\nstore/\nstore/sqlite.ts\nstore/postgres.ts\nutils.ts\ntypes.ts', 'success', { toolCallId: 'call_l' }),
      turnId: 't6',
    }),
  },
  { mark: 'command-row' },
  { drive: (h) => h.receive({ type: 'plan_token', token: '```json\n{"tasks": [{"title": "Add the SQLite ', turnId: 't6', segmentId: 's1' }) },
  { mark: 'building-plan' },
  { drive: (h) => h.receive({ type: 'plan_token', token: 'store"}, {"title": "Migrate"}]}\n```', turnId: 't6', segmentId: 's1' }) },
  {
    // The reducer's syncTranscript only reads plan.conversationHistory (the
    // marker text and its position) — the tasks themselves arrive separately
    // as the `planUpdated` broadcast below, the plan dock's own copy.
    drive: (h) => h.receive({
      type: 'plan_generated',
      turnId: 't6',
      plan: {
        conversationHistory: [
          { role: 'user', content: 'add persistence', timestamp: '2026-09-27T10:00:00.000Z' },
          { role: 'assistant', content: 'Which store: SQLite or Postgres?', timestamp: '2026-09-27T10:00:05.000Z' },
          { role: 'user', content: 'use SQLite', timestamp: '2026-09-27T10:03:00.000Z' },
          { role: 'assistant', content: 'Plan generated with 2 tasks.', timestamp: '2026-09-27T10:03:20.000Z', kind: 'plan_generated' },
        ],
      },
    }),
  },
  {
    // The plan dock's own copy of the plan — a separate broadcast from the
    // conversation marker (Session emits both; see ChatViewProvider.sendPlanUpdated).
    post: {
      type: 'planUpdated',
      plan: {
        tasks: [
          { id: 'task-1', order: 1, title: 'Add the SQLite store', description: 'Wire up better-sqlite3 and a migrations table', type: 'ai', status: 'pending', dependencies: [], subtasks: [], assignedRunner: 'claude-code', taskMode: 'acceptEdits', assignedModel: { modelId: 'deepseek/deepseek-v4-flash', modelLabel: 'DeepSeek V4 Flash' } },
          { id: 'task-2', order: 2, title: 'Migrate', description: 'Write the migration runner', type: 'ai', status: 'pending', dependencies: ['task-1'], subtasks: [], assignedRunner: 'claude-code', taskMode: 'acceptEdits' },
        ],
        generatedAt: '2026-09-27T10:03:20.000Z',
        status: 'draft',
        runners: ['claude-code'],
        lastUpdated: '2026-09-27T10:03:20.000Z',
      },
    },
  },
  { mark: 'plan-marker' },
  { drive: (h) => h.receive({ type: 'planner_turn_ended', turnId: 't6', outcome: 'plan' }) },
];

/** Two ADR-0005 research agents working at once, interleaved. */
const SUBAGENTS = [
  { drive: (h) => h.receive({ type: 'planner_turn_started', turnId: 't4', prompt: 'survey auth and billing' }) },
  { drive: (h) => h.receive({ type: 'research_step', tool: 'spawn_research_agent', args: '{"prompt":"Survey auth"}', subagentId: 'sa-1', toolCallId: 'call_s1', turnId: 't4' }) },
  { drive: (h) => h.receive({ type: 'subagent_started', turnId: 't4', subagentId: 'sa-1', brief: 'Survey auth', model: 'gpt-5-mini' }) },
  { drive: (h) => h.receive({ type: 'research_step', tool: 'spawn_research_agent', args: '{"prompt":"Survey billing"}', subagentId: 'sa-2', toolCallId: 'call_s2', turnId: 't4' }) },
  { drive: (h) => h.receive({ type: 'subagent_started', turnId: 't4', subagentId: 'sa-2', brief: 'Survey billing', model: 'gpt-5-mini' }) },
  { drive: (h) => h.receive({ type: 'planner_thinking_delta', turnId: 't4', subagentId: 'sa-1', text: 'Auth lives under src/auth.' }) },
  { drive: (h) => h.receive({ type: 'research_step', tool: 'grep', args: '{"pattern":"login"}', subagentId: 'sa-1', toolCallId: 'call_0', turnId: 't4' }) },
  {
    drive: (h) => h.receive({
      type: 'research_step_done',
      step: step('subrs-sa-1-1', 'grep', { pattern: 'login' }, 'src/auth/login.ts:9', 'success', { toolCallId: 'call_0', subagentId: 'sa-1' }),
      subagentId: 'sa-1', turnId: 't4',
    }),
  },
  { drive: (h) => h.receive({ type: 'subagent_finished', turnId: 't4', subagentId: 'sa-2', outcome: 'done', digest: 'Billing: src/billing/invoice.ts', usage: { inputTokens: 900, outputTokens: 80 } }) },
  { drive: (h) => h.receive({ type: 'subagent_finished', turnId: 't4', subagentId: 'sa-1', outcome: 'done', digest: 'Auth: src/auth/login.ts' }) },
  { mark: 'subagent-collapsed' },
  { drive: (h) => h.receive({ type: 'planner_message', content: 'Auth is in src/auth, billing in src/billing.', timestamp: '2026-09-27T10:05:00.000Z', turnId: 't4' }) },
  { drive: (h) => h.receive({ type: 'planner_turn_ended', turnId: 't4', outcome: 'message' }) },
];

/** Research reaching outside its envelope (ADR-0008): granted, then denied. */
const APPROVALS = [
  { drive: (h) => h.receive({ type: 'planner_turn_started', turnId: 't10', prompt: 'run the tests and check external config' }) },
  { drive: (h) => h.receive({ type: 'research_step', tool: 'bash', args: '{"command":"npm test"}', toolCallId: 'call_n', turnId: 't10' }) },
  { drive: (h) => h.receive({ type: 'approval_request', id: 'ap-1', kind: 'shell_command', subject: 'npm test', scope: 'npm test', detail: "Runs the project's tests", turnId: 't10' }) },
  { mark: 'approval-pending' },
  { drive: (h) => h.receive({ type: 'approval_settled', id: 'ap-1', granted: true }) },
  { mark: 'approval-settled' },
  { drive: (h) => h.receive({ type: 'approval_decided', kind: 'external_path', subject: '/etc/hosts', scope: '/etc', granted: false, source: 'mode' }) },
  { drive: (h) => h.receive({ type: 'planner_message', content: 'Tests pass. The external config read was denied by policy.', timestamp: '2026-09-27T10:06:00.000Z', turnId: 't10' }) },
  { drive: (h) => h.receive({ type: 'planner_turn_ended', turnId: 't10', outcome: 'message' }) },
];

/** The token line through a turn: a first report, a line added meanwhile, then totals with a subagent. */
const USAGE = [
  { drive: (h) => h.receive({ type: 'planner_usage', turnId: 't11', totals: {} }) },
  { drive: (h) => h.receive({ type: 'planner_usage', turnId: 't11', totals: { inputTokens: 1000, outputTokens: 50 }, contextFill: { usedTokens: 1000, windowTokens: 200000 } }) },
  { drive: (h) => h.note('system', 'Planner model: gpt-5') },
  {
    drive: (h) => h.receive({
      type: 'planner_usage', turnId: 't11',
      totals: { inputTokens: 2500, outputTokens: 120, reportedCost: { USD: 0.01 } },
      bySubagent: { 'sa-1': { inputTokens: 900, outputTokens: 30 } },
      contextFill: { usedTokens: 1600, windowTokens: 200000 },
    }),
  },
  { mark: 'usage-line' },
];

/** A turn whose first attempt is discarded for a corrective retry: the retracted text must never reach the screen. */
const RETRACTED_ATTEMPT = [
  { drive: (h) => h.receive({ type: 'planner_turn_started', turnId: 't2', prompt: 'split task 3' }) },
  { drive: (h) => h.receive({ type: 'planner_text_delta', turnId: 't2', segmentId: 's1', text: 'Checking the task first.' }) },
  { drive: (h) => h.receive({ type: 'research_step', tool: 'read_file', args: '{"path":"PLAN.md"}', toolCallId: 'c1', turnId: 't2' }) },
  { drive: (h) => h.receive({ type: 'research_step_done', step: step('rs-1', 'read_file', { path: 'PLAN.md' }, '# Plan', 'success', { toolCallId: 'c1' }), turnId: 't2' }) },
  { drive: (h) => h.receive({ type: 'planner_text_delta', turnId: 't2', segmentId: 's2', text: '{"taskOps": [ {"op": "spl' }) },
  { drive: (h) => h.receive({ type: 'planner_text_retracted', turnId: 't2', segmentId: 's2' }) },
  { drive: (h) => h.receive({ type: 'planner_text_delta', turnId: 't2', segmentId: 's3', text: 'Split it ' }) },
  { drive: (h) => h.receive({ type: 'planner_text_retracted', turnId: 't2' }) },
  { drive: (h) => h.receive({ type: 'planner_text_delta', turnId: 't2', segmentId: 's4', text: 'Task 3 splits cleanly ' }) },
  { drive: (h) => h.receive({ type: 'planner_text_delta', turnId: 't2', segmentId: 's4', text: 'into 3a and 3b.' }) },
  { drive: (h) => h.receive({ type: 'planner_message', content: 'Task 3 splits cleanly into 3a and 3b.', timestamp: '2026-09-27T10:01:09.000Z', turnId: 't2' }) },
  { drive: (h) => h.receive({ type: 'planner_turn_ended', turnId: 't2', outcome: 'message' }) },
  { mark: 'retracted-attempt' },
];

/** A turn left open so the page's own queued-prompt / Esc handling can be driven live. */
const OPEN_TURN = [
  { drive: (h) => h.receive({ type: 'planner_turn_started', turnId: 't12', prompt: 'anything else?' }) },
  { drive: (h) => h.receive({ type: 'planner_text_delta', turnId: 't12', segmentId: 's1', text: 'Thinking about what else the store needs.' }) },
  { mark: 'turn-open' },
];

export const MAIN_SCENARIO = [
  ...SETUP,
  ...STREAMED_REPLY,
  ...PLAN_TURN,
  ...SUBAGENTS,
  ...APPROVALS,
  ...USAGE,
  ...RETRACTED_ATTEMPT,
  ...OPEN_TURN,
];

/** What `fromTranscript` (R1) rebuilds a reopened session from: no thinking, everything else. */
export const RELOAD_FIXTURE = {
  conversationHistory: [
    { role: 'user', content: 'add a parser', timestamp: '2026-01-01T00:00:00.000Z' },
    { role: 'assistant', content: 'Which formats do you need?', timestamp: '2026-01-01T00:00:01.000Z' },
    { role: 'user', content: 'JSON please', timestamp: '2026-01-01T00:00:02.000Z' },
    { role: 'assistant', content: 'Plan generated with 1 task.', timestamp: '2026-01-01T00:00:03.000Z', kind: 'plan_generated' },
    { role: 'assistant', content: 'Anything else you want tweaked?', timestamp: '2026-01-01T00:00:04.000Z' },
  ],
  researchLog: [
    step('rl-1', 'read_file', { path: 'package.json' }, '{"name":"demo"}', 'success', { toolCallId: 'call_1' }),
    { id: 'rl-2', type: 'subagent', subagentId: 'sa-1', brief: 'Survey existing parsers', outcome: 'done', digest: 'No parser exists yet.', timestamp: '2026-01-01T00:00:02.500Z' },
  ],
  plannerUsage: { totals: { inputTokens: 4200, outputTokens: 310 }, lastPromptTokens: 4200, contextWindow: 200000 },
};

export const RELOAD_PLAN = {
  tasks: [
    { id: 't1', order: 1, title: 'Restored Task', description: 'd', type: 'ai', status: 'pending', dependencies: [], subtasks: [], assignedRunner: 'claude-code', taskMode: 'build', prompt: 'p' },
  ],
  generatedAt: '2026-01-01T00:00:03.000Z', status: 'draft', runners: ['claude-code'], lastUpdated: '2026-01-01T00:00:03.000Z',
};

/**
 * A task's log (ADR-0018, V1) mid-turn with one pending message in each state:
 * force sent, already handed over to the runner, and still in Ordewell's queue.
 */
export const TASK_LOG_PENDING = [
  { type: 'turn_start', message: 'Add a JSON parser' },
  { type: 'text_delta', text: 'Reading the parser module first, then running the suite.' },
  { type: 'tool_call', id: 'c1', name: 'Bash', args: '{"command":"npm test"}' },
  { type: 'message_queued', messageId: 'm1', text: 'use the streaming API' },
  { type: 'message_handed_over', messageId: 'm1' },
  { type: 'message_queued', messageId: 'm2', text: 'then add tests for empty input' },
  { type: 'message_queued', messageId: 'm3', text: 'stop — the schema is in docs/schema.json', forced: true },
];

/**
 * A script task's log (ADR-0035) mid-run: a step that passed, one that failed
 * with more output than a preview holds, and one still printing. It runs no
 * model, so nothing in it folds.
 */
export const SCRIPT_TASK_LOG = [
  { type: 'script_run', argv: ['npm', 'ci'] },
  { type: 'script_output', text: 'added 412 packages in 9s\n' },
  { type: 'script_exit', code: 0, signal: null, durationMs: 9100 },
  { type: 'script_run', argv: ['npm', 'test'] },
  { type: 'script_output', text: ' RUN  v2.1.9\n ✓ src/parse/tokens.test.ts (12 tests)\n ✓ src/parse/errors.test.ts (4 tests)\n × src/parse/index.test.ts > parses a nested array\n   → expected [ 1, [ 2 ] ] to deeply equal [ 1, [ 2, 3 ] ]\n Tests  1 failed | 16 passed (17)\n' },
  { type: 'script_exit', code: 1, signal: null, durationMs: 4200 },
  { type: 'script_run', argv: ['npm', 'run', 'lint'] },
  { type: 'script_output', text: 'eslint src --max-warnings 0\n' },
];

/**
 * A runner's command the user denied (ADR-0017, X1): its result comes back
 * failed, but it never ran, and the denial is told once, on the call.
 */
export const TASK_LOG_DENIED = [
  { type: 'turn_start', message: 'Clean the build' },
  { type: 'tool_call', id: 'd1', name: 'Bash', args: '{"command":"rm -rf dist"}' },
  { type: 'approval_requested', approvalId: 'ap-d1', tool: 'Bash', args: '{"command":"rm -rf dist"}', allowForTask: true, toolCallId: 'd1' },
  { type: 'approval_decided', approvalId: 'ap-d1', decision: 'deny', note: 'keep dist for now' },
  { type: 'tool_result', id: 'd1', output: 'The user denied this call: keep dist for now', success: false },
  { type: 'text', text: 'Leaving dist in place.' },
];

/**
 * A task's log (ADR-0018, V1) mid-turn, for its folded activity (ADR-0017,
 * X1): a run of thinking and calls, one failed; a subagent with its own steps;
 * the agent's words between; and a write still waiting on the user.
 */
export const TASK_LOG_ACTIVITY = [
  { type: 'turn_start', message: 'Add a JSON parser' },
  { type: 'thinking', text: 'Find the existing parser, then check the spec it has to follow.\nThe tests will say which edge cases matter.' },
  { type: 'tool_call', id: 'c1', name: 'Bash', args: '{"command":"git ls-files src | grep -i parse"}' },
  { type: 'tool_result', id: 'c1', output: 'src/parse/index.ts\nsrc/parse/tokens.ts\nsrc/parse/errors.ts\nsrc/parse/__tests__/index.test.ts\nsrc/parse/__tests__/tokens.test.ts', success: true },
  { type: 'tool_call', id: 'c2', name: 'Read', args: '{"file_path":"/home/dev/app/.ordewell/worktrees/3c3de77a/2-add-a-json-parser/src/parse/index.ts"}' },
  { type: 'tool_result', id: 'c2', output: 'export function parse(text: string) {\n  return JSON.parse(text);\n}', success: true },
  { type: 'tool_call', id: 'c3', name: 'WebFetch', args: '{"url":"https://www.rfc-editor.org/rfc/rfc8259"}' },
  { type: 'tool_result', id: 'c3', output: 'Request failed: 403 Forbidden', success: false },
  { type: 'tool_call', id: 'c4', name: 'Task', args: '{"description":"Survey error handling","prompt":"How do the parsers report errors?"}' },
  { type: 'subagent_started', subagentId: 'c4', brief: 'Survey error handling', model: 'claude-haiku-5-5' },
  { type: 'tool_call', id: 'c5', name: 'Grep', args: '{"pattern":"throw new ParseError","path":"src"}', subagentId: 'c4' },
  { type: 'tool_result', id: 'c5', output: 'src/parse/errors.ts:4\nsrc/parse/tokens.ts:31\nsrc/parse/tokens.ts:58', success: true, subagentId: 'c4' },
  { type: 'tool_call', id: 'c6', name: 'Read', args: '{"file_path":"src/parse/errors.ts"}', subagentId: 'c4' },
  { type: 'tool_result', id: 'c6', output: 'export class ParseError extends Error {\n  constructor(readonly at: number, message: string) { super(message); }\n}', success: true, subagentId: 'c4' },
  { type: 'subagent_finished', subagentId: 'c4', outcome: 'done', digest: 'Every parser throws ParseError with the offset it stopped at.' },
  { type: 'text', text: 'The parser is a thin wrapper today. I will add a streaming tokenizer that throws `ParseError` with offsets.' },
  { type: 'tool_call', id: 'c7', name: 'Write', args: '{"file_path":"src/parse/stream.ts","content":"export {}"}' },
  { type: 'approval_requested', approvalId: 'ap-1', tool: 'Write', args: '{"file_path":"src/parse/stream.ts","content":"export {}"}', allowForTask: true },
];

const sub = (id, order, title, status) => ({
  id, order, title, description: title, type: 'ai', status, dependencies: [], subtasks: [], assignedRunner: 'claude-code', taskMode: 'acceptEdits', prompt: `${title}.`,
});

/** A plan mid-run with a card in each state and subtasks under the first, which the tour expands. */
export const TASK_CARDS_PLAN = {
  tasks: [
    {
      id: 'task-1', order: 1, title: 'Add the SQLite store', description: 'Wire up better-sqlite3 and a migrations table', type: 'ai', status: 'in_progress', dependencies: [], assignedRunner: 'claude-code', taskMode: 'acceptEdits', prompt: 'Add a SQLite-backed store behind the Store interface.',
      subtasks: [sub('task-1a', 1, 'Open the database', 'completed'), sub('task-1b', 2, 'Create the migrations table', 'in_progress')],
    },
    { id: 'task-2', order: 2, title: 'Migrate existing data', description: 'Write the migration runner', type: 'ai', status: 'pending', dependencies: ['task-1'], subtasks: [], assignedRunner: 'claude-code', taskMode: 'acceptEdits' },
    { id: 'task-3', order: 3, title: 'Document the store', description: 'Update the README', type: 'ai', status: 'completed', dependencies: [], subtasks: [], assignedRunner: 'codex', taskMode: 'acceptEdits' },
    { id: 'task-4', order: 4, title: 'Check the backup path', description: 'Confirm backups still restore', type: 'user', status: 'failed', dependencies: [], subtasks: [], assignedRunner: 'claude-code', taskMode: 'acceptEdits' },
  ],
  generatedAt: '2026-09-27T10:03:20.000Z',
  status: 'executing',
  runners: ['claude-code', 'codex'],
  lastUpdated: '2026-09-27T10:03:20.000Z',
};

/**
 * The kinds of goal the planner's strategy step teaches (#108), one scenario
 * each. `persona` is the mock model that replies with that kind's plumbing
 * (mock-provider.mjs); `expect` is what the live driver asserts the session
 * accepted. `realReplies` is what a real run answers if the planner asks a
 * question — a nudge, never a scripted answer, since the report is about the
 * planner's own choice.
 */
const REAL_NUDGE = 'Please use your judgement and continue with the strategy this goal calls for.';

export const GOAL_SCENARIOS = [
  {
    kind: 'question',
    persona: 'mock/goal-question',
    goal: 'What does this demo project do, and does it have a test suite?',
    // No nudge: an answer is the observed outcome; a clarifying question is too.
    realReplies: [],
    // A question is answered in the reply: no plan, no tasks, conversation open.
    expect: { noPlan: true },
  },
  {
    kind: 'small effect',
    persona: 'mock/goal-effect',
    goal: 'Emit a completion marker from one exact command.',
    realReplies: [REAL_NUDGE, REAL_NUDGE],
    // run_script adds a script task and starts it; its exit status is the verdict.
    expect: { script: { title: 'Emit the completion marker', output: 'effect-ok' } },
  },
  {
    kind: 'build',
    persona: 'mock/goal-build',
    goal: 'Add a --verbose flag that prints each file the demo CLI reads, with a test for it.',
    realReplies: [REAL_NUDGE, REAL_NUDGE],
    // A build: vertical slices, no research tasks, no script, no loop.
    expect: { tasks: 3, ai: 3, research: 0, scripts: 0, loops: 0, chained: true },
  },
  {
    kind: 'failure to explain',
    persona: 'mock/goal-failure',
    goal: 'The parser test fails with "unexpected token" on nested arrays. Find the cause and fix it.',
    realReplies: [REAL_NUDGE, REAL_NUDGE],
    // A reproduction (script check) with the fix in a loop's body, and two
    // hypotheses as research tasks that start in parallel.
    expect: { tasks: 4, ai: 3, research: 2, scripts: 1, loops: 1, reproductionCheck: true },
  },
  {
    kind: 'open problem',
    persona: 'mock/goal-open',
    goal: 'We do not know yet how to make sync fast enough. Explore the options for a first round.',
    realReplies: [REAL_NUDGE, REAL_NUDGE],
    // An open problem: only the first round, as research tasks, no build yet.
    expect: { tasks: 2, ai: 2, research: 2, scripts: 0, loops: 0 },
  },
];
