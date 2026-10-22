import { describe, it, expect, afterEach, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { TaskOrchestrator } from '../TaskOrchestrator';
import { createTask, type Task } from '../../models/Task';
import { BufferedTaskOutputSource } from '../BufferedTaskOutputSource';
import { StructuredRunner } from '../StructuredRunner';
import { RunnerRegistry } from '../../plugins/RunnerRegistry';
import { OrdewellMcpServer, type McpClientConfig } from '../mcp';
import { fakeConfig } from '../../testing';
import { fakeNotification } from './sessionTestKit';
import type { AgentEvent, AgentStartOptions, TaskModeAgentAdapter } from '../harness/AgentAdapter';
import type { ApprovalDecision } from '../../interfaces/IApproval';

/**
 * A task run end to end over the real transport: the orchestrator spawns a
 * structured session, the runner is handed a token, and the "model" is an MCP
 * client calling the tools over HTTP with it (ADR-0022).
 */

class IdleAdapter implements TaskModeAgentAdapter {
  async mcpAttached(): Promise<boolean> { return true; }
  readonly agentId = 'claude-code';
  readonly exited = false;
  start_: AgentStartOptions | undefined;
  readonly prompts: string[] = [];
  private onEvent: ((event: AgentEvent) => void) | undefined;
  private exit: Array<(code: number) => void> = [];

  async start(opts: AgentStartOptions): Promise<void> { this.start_ = opts; }
  send(message: string, onEvent: (event: AgentEvent) => void): Promise<void> {
    this.prompts.push(message);
    this.onEvent = onEvent;
    return new Promise<void>(() => undefined);
  }
  say(text: string): void { this.onEvent?.({ type: 'assistant_text_delta', runId: 'r1', text }); }
  async interrupt(): Promise<boolean> { return false; }
  onProcessExit(listener: (code: number) => void): void { this.exit.push(listener); }
  answerPermission(_id: string, _decision: ApprovalDecision): boolean { return true; }
  nativeSessionId(): string | null { return null; }
  dispose(): void {}

  get config(): McpClientConfig {
    const opts = this.start_;
    if (opts?.kind !== 'task' || !opts.mcp) throw new Error('the runner was not given the server');
    return opts.mcp;
  }
}

const servers: OrdewellMcpServer[] = [];
const clients: Client[] = [];

afterEach(async () => {
  await Promise.all(clients.splice(0).map((c) => c.close().catch(() => undefined)));
  await Promise.all(servers.splice(0).map((s) => s.dispose()));
});

function rig() {
  const server = new OrdewellMcpServer({ heartbeatMs: 50 });
  servers.push(server);
  const adapters: IdleAdapter[] = [];
  const runner = new StructuredRunner({
    createAdapter: () => {
      const adapter = new IdleAdapter();
      adapters.push(adapter);
      return adapter;
    },
    interruptGraceMs: 20,
    mcp: server,
  });
  const orchestrator = TaskOrchestrator.compose({
    config: fakeConfig(),
    notifications: fakeNotification(),
    runner,
    output: new BufferedTaskOutputSource(),
    registry: new RunnerRegistry(),
    workspaceRoot: () => '/repo',
    workspaceEnv: async () => ({ env: {}, blockedEnvrc: null, refused: [], trackedEnvFile: null }),
  });
  const get = (id: string): Task => orchestrator.storeInstance.get(id)!;
  return { orchestrator, adapters, server, get };
}

async function connect(config: McpClientConfig): Promise<Client> {
  const client = new Client({ name: 'test', version: '0.0.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(config.url), { requestInit: { headers: config.headers } }));
  clients.push(client);
  return client;
}

/** A tool result's text, as the runner reads it. */
function text(result: Awaited<ReturnType<Client['callTool']>>): string {
  return (result.content as { type: string; text: string }[]).map((c) => c.text).join('\n');
}

const task = (id: string, order: number, extra: Partial<Task> = {}) =>
  createTask({ id, order, title: `Task ${id}`, prompt: `do ${id}`, ...extra });

describe('task_complete over HTTP, through the orchestrator', () => {
  it.each([
    ['done', 'completed'],
    ['blocked', 'failed'],
    ['failed', 'failed'],
  ] as const)('%s ends the attempt as %s, with the reason on the verdict', async (status, final) => {
    const { orchestrator, adapters, get } = rig();
    orchestrator.loadPlan([task('t1', 1)]);
    await orchestrator.forceStartTask('t1');

    const client = await connect(adapters[0].config);
    const reason = status === 'done' ? undefined : 'the schema file is missing';
    const result = await client.callTool({ name: 'task_complete', arguments: { status, summary: 'What happened.', ...(reason ? { reason } : {}) } });

    expect(result.isError).toBe(false);
    await vi.waitFor(() => expect(get('t1').status).toBe(final));
    if (reason) expect(get('t1').verdict?.reason).toContain(reason);
    else expect(get('t1').verdict?.checks[0].name).toBe('task_complete');
  });

  it('gives one verdict when more output arrives after the completion call', async () => {
    const { orchestrator, adapters, get } = rig();
    const settled: string[] = [];
    orchestrator.loadPlan([task('t1', 1)]);
    orchestrator.subscribe({ onTaskSettled: ({ taskId }) => settled.push(taskId) });
    await orchestrator.forceStartTask('t1');

    const client = await connect(adapters[0].config);
    await client.callTool({ name: 'task_complete', arguments: { status: 'done', summary: 'Built it.' } });
    adapters[0].say('Done.');
    await vi.waitFor(() => expect(get('t1').status).toBe('completed'));
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(settled).toEqual(['t1']);
    expect(get('t1').verdict?.checks[0].name).toBe('task_complete');
  });

  it('rejects a stale attempt\'s token once the task is retried, and accepts the new attempt\'s', async () => {
    const { orchestrator, adapters, get } = rig();
    orchestrator.loadPlan([task('t1', 1)]);
    await orchestrator.forceStartTask('t1');
    const stale = adapters[0].config;

    await orchestrator.retryTask('t1');
    await orchestrator.forceStartTask('t1');
    await vi.waitFor(() => expect(adapters).toHaveLength(2));

    await expect(connect(stale)).rejects.toThrow();
    expect(get('t1').status).not.toBe('completed');

    const client = await connect(adapters[1].config);
    await client.callTool({ name: 'task_complete', arguments: { status: 'done', summary: 'Second try.' } });
    await vi.waitFor(() => expect(get('t1').status).toBe('completed'));
  });

  it('keeps one task\'s token to that task: it completes its own and cannot reach another', async () => {
    const { orchestrator, adapters, get, server } = rig();
    orchestrator.loadPlan([task('t1', 1), task('t2', 2)]);
    await orchestrator.forceStartTask('t1');
    await orchestrator.forceStartTask('t2');
    const [first, second] = adapters.map((a) => a.config);
    expect(first.headers).not.toEqual(second.headers);

    const client = await connect(first);
    await client.callTool({ name: 'task_complete', arguments: { status: 'done', summary: 'One is done.' } });
    await vi.waitFor(() => expect(get('t1').status).toBe('completed'));

    expect(get('t2').status).toBe('in_progress');
    // The finished task's token is revoked with it; the other's is untouched.
    await expect(connect(first)).rejects.toThrow();
    await expect(connect(second)).resolves.toBeDefined();
    await server.dispose();
  });

  it('keeps the token out of every prompt, the dependent\'s included, and hands the summary on', async () => {
    const { orchestrator, adapters, get } = rig();
    orchestrator.loadPlan([task('t1', 1), task('t2', 2, { dependencies: ['t1'] })]);
    await orchestrator.approveReview();
    await vi.waitFor(() => expect(adapters).toHaveLength(1));
    await vi.waitFor(() => expect(adapters[0].start_).toBeDefined());
    const first = adapters[0].config;
    const client = await connect(first);

    await client.callTool({
      name: 'task_complete',
      arguments: { status: 'done', summary: 'Wrote the parser.' },
    });
    await vi.waitFor(() => expect(get('t1').status).toBe('completed'));
    await vi.waitFor(() => expect(adapters).toHaveLength(2));
    await vi.waitFor(() => expect(adapters[1].prompts).toHaveLength(1));

    const authorization = Object.values(first.headers).join(' ');
    const token = authorization.replace(/^Bearer\s+/i, '').trim();
    expect(token.length).toBeGreaterThan(20);
    for (const adapter of adapters) {
      for (const prompt of adapter.prompts) expect(prompt).not.toContain(token);
    }
    const dependentPrompt = adapters[1].prompts[0];
    expect(dependentPrompt).toContain('Wrote the parser.');
  });
});

describe('checkpoint over HTTP, through the orchestrator', () => {
  const hitl = () => [task('t1', 1, { autonomy: 'HITL' })];

  async function asking() {
    const rigged = rig();
    rigged.orchestrator.loadPlan(hitl());
    await rigged.orchestrator.forceStartTask('t1');
    const client = await connect(rigged.adapters[0].config);
    return { ...rigged, client };
  }

  it('waits until the user approves, then answers the call', async () => {
    const { orchestrator, client, get } = await asking();
    let settled = false;
    const call = client.callTool({ name: 'checkpoint', arguments: { question: 'Drop the table?' } }).then((r) => { settled = true; return r; });

    await vi.waitFor(() => expect(get('t1').status).toBe('awaiting_user'));
    await new Promise((resolve) => setTimeout(resolve, 120));
    expect(settled).toBe(false);

    orchestrator.approveCheckpoint('t1');
    const result = await call;

    expect(result.isError).toBe(false);
    expect(get('t1').status).toBe('in_progress');
  });

  it('waits until the user rejects, then answers the call with the reason', async () => {
    const { orchestrator, client, get } = await asking();
    const call = client.callTool({ name: 'checkpoint', arguments: { question: 'Drop the table?' } });
    await vi.waitFor(() => expect(get('t1').status).toBe('awaiting_user'));

    orchestrator.rejectCheckpoint('t1', 'not on production');

    expect(await call).toMatchObject({ content: [{ type: 'text', text: expect.stringContaining('not on production') }] });
  });

  it('is withdrawn, not left hanging, when the task is retried', async () => {
    const { orchestrator, client, get } = await asking();
    const call = client.callTool({ name: 'checkpoint', arguments: { question: 'Drop the table?' } });
    await vi.waitFor(() => expect(get('t1').status).toBe('awaiting_user'));

    await orchestrator.retryTask('t1');

    expect(await call).toMatchObject({ isError: true });
  });
});

describe('the handoff a task_complete call carries (ADR-0047)', () => {
  async function completing(plan: Task[] = [task('t1', 1)], taskId = 't1') {
    const rigged = rig();
    rigged.orchestrator.loadPlan(plan);
    await rigged.orchestrator.forceStartTask(taskId);
    const client = await connect(rigged.adapters.at(-1)!.config);
    const complete = (args: Record<string, unknown>) => client.callTool({ name: 'task_complete', arguments: { status: 'done', ...args } });
    return { ...rigged, client, complete };
  }

  it('keeps a call that sends only a summary as a handoff with no findings', async () => {
    const { complete, get } = await completing();

    const result = await complete({ summary: 'Added the cache; eviction is still missing.' });

    expect(result.isError).toBe(false);
    await vi.waitFor(() => expect(get('t1').status).toBe('completed'));
    expect(get('t1').handoff).toEqual({ summary: 'Added the cache; eviction is still missing.', findings: [], findingCount: 0 });
  });

  it('numbers the findings F1 to Fn in the order the author gave them, and keeps the artifacts', async () => {
    const { complete, get } = await completing();

    const result = await complete({
      summary: 'Reviewed the cache.',
      findings: [
        { severity: 'blocker', title: 'Entries never expire', detail: 'get() ignores the TTL.', evidence: [{ kind: 'file', path: 'src/cache.ts', line: 12 }] },
        { severity: 'info', title: 'The README still says v1' },
        { severity: 'minor', title: 'A stale comment', evidence: [{ kind: 'commit', sha: 'a1b2c3d' }, { kind: 'url', url: 'https://example.com/ttl' }] },
      ],
      artifacts: [{ kind: 'file', path: 'docs/cache-review.md' }],
    });

    expect(result.isError).toBe(false);
    await vi.waitFor(() => expect(get('t1').status).toBe('completed'));
    expect(get('t1').handoff).toEqual({
      summary: 'Reviewed the cache.',
      findings: [
        { id: 'F1', severity: 'blocker', title: 'Entries never expire', detail: 'get() ignores the TTL.', evidence: [{ kind: 'file', path: 'src/cache.ts', line: 12 }] },
        { id: 'F2', severity: 'info', title: 'The README still says v1' },
        { id: 'F3', severity: 'minor', title: 'A stale comment', evidence: [{ kind: 'commit', sha: 'a1b2c3d' }, { kind: 'url', url: 'https://example.com/ttl' }] },
      ],
      findingCount: 3,
      artifacts: [{ kind: 'file', path: 'docs/cache-review.md' }],
    });
  });

  it('refuses a summary past its limit, naming the field and where the rest goes, and keeps the attempt open for a resend', async () => {
    const { complete, get } = await completing();

    const refused = await complete({ summary: 'x'.repeat(1_501) });

    expect(refused.isError).toBe(true);
    expect(text(refused)).toMatch(/summary/);
    expect(text(refused)).toMatch(/1500 characters: put the long form in report/);
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(get('t1').status).toBe('in_progress');

    expect((await complete({ summary: 'Short.', report: 'x'.repeat(1_501) })).isError).toBe(false);
    await vi.waitFor(() => expect(get('t1').status).toBe('completed'));
    expect(get('t1').handoff?.summary).toBe('Short.');
  });

  it('refuses a URL that is not http or https, naming the field, the value and what is accepted, and records nothing', async () => {
    const { complete, get } = await completing();

    const refused = await complete({
      summary: 'Reviewed.',
      findings: [{ severity: 'major', title: 'XSS', evidence: [{ kind: 'file', path: 'a.ts' }, { kind: 'url', url: 'javascript:alert(1)' }] }],
    });

    expect(refused.isError).toBe(true);
    expect(text(refused)).toContain('findings[0].evidence[1].url');
    expect(text(refused)).toContain('"javascript:alert(1)"');
    expect(text(refused)).toMatch(/only an http or https URL/);
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(get('t1').status).toBe('in_progress');
    expect(get('t1').handoff).toBeUndefined();
  });

  it('names a cited task by its id, and refuses a task this one may not read, one not in the plan, or a finding it never had', async () => {
    const done = task('t1', 1, { status: 'completed', handoff: { summary: 'Wrote it.', findings: [], findingCount: 2 } });
    const { complete, get } = await completing([done, task('t2', 2, { dependencies: ['t1'] }), task('t3', 3)], 't2');

    const refused = await complete({
      summary: 'Checked.',
      findings: [{ severity: 'major', title: 'Still broken', evidence: [{ kind: 'task', task: '#3' }, { kind: 'task', task: '#9' }, { kind: 'task', task: '#1', finding: 'F3' }] }],
    });

    expect(refused.isError).toBe(true);
    expect(text(refused)).toContain('findings[0].evidence[0].task: "#3" is #3 Task t3, which this task may not read: only itself, a task it depends on, or its loop\'s other end.');
    expect(text(refused)).toContain('findings[0].evidence[1].task: "#9" names no task in the plan');
    expect(text(refused)).toContain('findings[0].evidence[2].finding: "F3" is not a finding of #1 Task t1: its latest handoff has F1 to F2.');
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(get('t2').status).toBe('in_progress');

    const accepted = await complete({
      summary: 'Checked.',
      findings: [{ severity: 'major', title: 'Still broken', evidence: [{ kind: 'task', task: '#1', finding: 'F2' }] }],
      artifacts: [{ kind: 'task', task: 't2' }],
    });
    expect(accepted.isError).toBe(false);
    await vi.waitFor(() => expect(get('t2').status).toBe('completed'));
    expect(get('t2').handoff?.findings[0].evidence).toEqual([{ kind: 'task', task: 't1', finding: 'F2' }]);
    expect(get('t2').handoff?.artifacts).toEqual([{ kind: 'task', task: 't2' }]);
  });

  it('lets a loop\'s check cite its body, and a body task cite its check', async () => {
    const check = task('c', 1, { loop: { body: ['b'], maxRounds: 2 } });
    const body = task('b', 2, { dependencies: ['c'], status: 'completed', handoff: { summary: 'Fixed F1.', findings: [], findingCount: 0 } });
    const { complete, get } = await completing([check, body], 'c');

    const result = await complete({ summary: 'The fix holds.', findings: [{ severity: 'info', title: 'Verified', evidence: [{ kind: 'task', task: '#2' }] }] });

    expect(result.isError).toBe(false);
    await vi.waitFor(() => expect(get('c').status).toBe('completed'));
    expect(get('c').handoff?.findings[0].evidence).toEqual([{ kind: 'task', task: 'b' }]);
  });

  it('keeps the first 25 findings and no report on the plan, counting every finding', async () => {
    const { complete, get } = await completing();
    const findings = Array.from({ length: 30 }, (_, i) => ({ severity: 'minor', title: `Finding ${i + 1}` }));

    expect((await complete({ summary: 'Thirty things.', findings, report: 'The long form.' })).isError).toBe(false);

    await vi.waitFor(() => expect(get('t1').status).toBe('completed'));
    const { handoff } = get('t1');
    expect(handoff?.findingCount).toBe(30);
    expect(handoff?.findings.map((f) => f.id)).toEqual(Array.from({ length: 25 }, (_, i) => `F${i + 1}`));
    expect(handoff).not.toHaveProperty('report');
  });

  it('gives a reader of the output summary the whole handoff as the report, task references named as the plan names them', async () => {
    const done = task('t1', 1, { status: 'completed' });
    const { complete, get } = await completing([done, task('t2', 2, { dependencies: ['t1'] })], 't2');

    await complete({
      summary: 'Reviewed the cache.',
      findings: [
        { severity: 'blocker', title: 'Entries never expire', detail: 'get() ignores the TTL.\nset() too.', evidence: [{ kind: 'file', path: 'src/cache.ts', line: 12 }, { kind: 'task', task: 't1' }] },
        { severity: 'info', title: 'The README still says v1', evidence: [{ kind: 'commit', sha: 'a1b2c3d', repo: 'api' }, { kind: 'url', url: 'https://example.com/ttl' }] },
      ],
      artifacts: [{ kind: 'file', path: 'docs/review.md' }],
      report: 'The long form.',
    });

    await vi.waitFor(() => expect(get('t2').status).toBe('completed'));
    expect(get('t2').outputSummary?.report).toBe([
      'Reviewed the cache.',
      '',
      'Findings:',
      '- F1 [blocker] Entries never expire',
      '  get() ignores the TTL.',
      '  set() too.',
      '  Evidence: src/cache.ts:12; task #1',
      '- F2 [info] The README still says v1',
      '  Evidence: commit a1b2c3d in api; https://example.com/ttl',
      '',
      'Artifacts: docs/review.md',
      '',
      'Report:',
      'The long form.',
    ].join('\n'));
  });

  it('starts a retry without the handoff of the attempt before it', async () => {
    const { orchestrator, complete, get } = await completing();
    await complete({ status: 'failed', summary: 'The schema is missing.' });
    await vi.waitFor(() => expect(get('t1').status).toBe('failed'));
    expect(get('t1').handoff?.summary).toBe('The schema is missing.');

    await orchestrator.retryTask('t1');

    expect(get('t1').handoff).toBeUndefined();
  });
});
