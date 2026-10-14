import { describe, it, expect, vi, afterEach } from 'vitest';
import { existsSync, readFileSync, statSync } from 'fs';
import { ClaudeCodeAdapter } from '../harness/ClaudeCodeAdapter';
import { CodexAdapter } from '../harness/CodexAdapter';
import { OpenCodeAdapter } from '../harness/OpenCodeAdapter';
import { TaskModeUnsupportedError, type AgentEvent, type AgentProcessDeps, type AgentStartOptions, type TaskStartOptions } from '../harness/AgentAdapter';
import { supportsTaskMode, createTaskAdapter } from '../harness/connectors';
import { resolveTaskRunnerFlags } from '../../plugins/resolveArgs';
import { CLAUDE_CODE_MANIFEST } from '../../plugins/builtin/claude-code.manifest';
import { mcpClientConfig } from '../mcp';
import { classifyRunnerStop, readUsageLimitReset } from '../runnerExit';
import { modeIds, fakeSpawn, fixture, claudeSteerRecording, type ScriptedReply } from './harnessTestKit';

/**
 * The adapter's task mode (ADR-0018, C1), against transcripts recorded from
 * `claude` 2.1.284 in `-p` stream-json mode. The planner's read-only start is
 * asserted here too, flag for flag: task mode must not have moved it.
 */

function deps(replies: ScriptedReply[]) {
  const spawned = fakeSpawn(replies);
  const processDeps: AgentProcessDeps = {
    spawn: spawned.spawn,
    fetch: (async () => { throw new Error('no HTTP in this test'); }) as unknown as typeof fetch,
    resolvePath: async () => '/usr/bin',
    platform: 'linux',
    isDirectory: () => true,
    exists: () => true,
    workspaceEnv: async () => ({}),
  };
  return { spawned, processDeps };
}

function taskStart(overrides: Partial<TaskStartOptions> = {}): TaskStartOptions {
  return {
    kind: 'task',
    cwd: '/repo',
    mode: 'acceptEdits',
    flags: { permissionMode: 'acceptEdits', modeSettings: {} },
    ...overrides,
  };
}

/** A task in the mode a fixture was recorded under: the adapter holds the CLI to the mode asked for. */
function taskIn(permissionMode: string, overrides: Partial<TaskStartOptions> = {}): TaskStartOptions {
  return taskStart({ mode: permissionMode, flags: { permissionMode, modeSettings: {} }, ...overrides });
}

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

/** What the adapter wrote to the CLI, past the `initialize` every task opens with. */
function sent(spawned: ReturnType<typeof deps>['spawned']): string[] {
  return spawned.processes[0].written.filter((w) => !w.includes('"subtype":"initialize"'));
}

async function until(condition: () => boolean): Promise<void> {
  for (let i = 0; i < 200 && !condition(); i++) await tick();
  if (!condition()) throw new Error('condition never held');
}

describe('ClaudeCodeAdapter start switch', () => {
  it('starts a planner without native plan mode or shell tools, its requests routed to Ordewell', async () => {
    const { spawned, processDeps } = deps([]);
    const adapter = new ClaudeCodeAdapter(processDeps);
    await adapter.start({ kind: 'planner', cwd: '/repo', systemPrompt: 'PLAN', model: 'sonnet', effort: 'high', resumeSessionId: 'sess-1' });
    expect(spawned.lastCommand()).toBe('claude');
    expect(spawned.lastArgs()).toEqual([
      '-p',
      '--input-format', 'stream-json',
      '--output-format', 'stream-json',
      '--verbose',
      '--include-partial-messages',
      '--permission-prompt-tool', 'stdio',
      '--permission-mode', 'default',
      '--disallowedTools', 'Edit,Write,MultiEdit,NotebookEdit,KillShell,Bash,PowerShell,EnterPlanMode,ExitPlanMode',
      '--setting-sources', 'user',
      '--settings', '{"disableAllHooks":true,"permissions":{"ask":["WebFetch","WebFetch(domain:*)","WebSearch","mcp__*","Read","Grep","Glob","LS"]}}',
      '--append-system-prompt', 'PLAN',
      '--model', 'sonnet',
      '--effort', 'high',
      '--resume', 'sess-1',
    ]);
    adapter.dispose();
  });

  it.each([
    ['nothing else', {}],
    ['a model, an effort and a resume', { model: 'opus', effort: 'max', resumeSessionId: 'sess-1' }],
    // Task fields smuggled onto a planner start: nothing on the planner path reads them.
    ['a task\'s bypass mode and flags', { mode: 'bypassPermissions', flags: { permissionMode: 'bypassPermissions', effort: 'max', modeSettings: {} } }],
    ['the legacy build alias a task resolves to acceptEdits', { mode: 'build', flags: { permissionMode: 'acceptEdits', modeSettings: {} } }],
    // Native plan mode lets Bash write its plan file outside the workspace.
    ['a task\'s native plan mode', { mode: 'plan', flags: { permissionMode: 'plan', modeSettings: {} } }],
  ])('starts a planner read-only whatever else its start carries: %s', async (_label, extra) => {
    const { spawned, processDeps } = deps([]);
    const adapter = new ClaudeCodeAdapter(processDeps);
    await adapter.start({ kind: 'planner', cwd: '/repo', systemPrompt: 'PLAN', ...extra } as unknown as AgentStartOptions);
    const args = spawned.lastArgs();

    expect(args.flatMap((arg, i) => (arg === '--permission-mode' ? [args[i + 1]] : []))).toEqual(['default']);
    expect(args[args.indexOf('--disallowedTools') + 1].split(',')).toEqual(['Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'KillShell', 'Bash', 'PowerShell', 'EnterPlanMode', 'ExitPlanMode']);
    expect(args[args.indexOf('--setting-sources') + 1]).toBe('user');
    expect(JSON.parse(args[args.indexOf('--settings') + 1])).toEqual({
      disableAllHooks: true,
      permissions: { ask: ['WebFetch', 'WebFetch(domain:*)', 'WebSearch', 'mcp__*', 'Read', 'Grep', 'Glob', 'LS'] },
    });
    for (const flag of ['--dangerously-skip-permissions', 'acceptEdits', 'bypassPermissions']) {
      expect(args).not.toContain(flag);
    }
    adapter.dispose();
  });

  it('starts a task with the protocol flags around the manifest-derived ones, and nothing of the planner', async () => {
    const { spawned, processDeps } = deps([]);
    const adapter = new ClaudeCodeAdapter(processDeps);
    await adapter.start(taskStart({
      model: 'opus',
      resumeSessionId: 'sess-9',
      flags: { permissionMode: 'default', effort: 'max', modeSettings: {} },
    }));
    expect(spawned.lastArgs()).toEqual([
      '-p',
      '--input-format', 'stream-json',
      '--output-format', 'stream-json',
      '--verbose',
      '--include-partial-messages',
      '--replay-user-messages',
      '--permission-prompt-tool', 'stdio',
      '--permission-mode', 'default',
      '--disallowedTools', 'AskUserQuestion',
      '--thinking', 'enabled', '--effort', 'max',
      '--model', 'opus',
      '--resume', 'sess-9',
    ]);
    adapter.dispose();
  });
});

/**
 * The adapter maps the task's raw effort itself now; the argv a Claude task
 * starts with, and its parity with the terminal command line, must not move.
 */
describe('ClaudeCodeAdapter task argv for every effort and mode', () => {
  const thinking: Array<[string, string[]]> = [
    ['adaptive', ['--thinking', 'adaptive']],
    ['low', ['--thinking', 'enabled', '--effort', 'low']],
    ['medium', ['--thinking', 'enabled', '--effort', 'medium']],
    ['high', ['--thinking', 'enabled', '--effort', 'high']],
    ['xhigh', ['--thinking', 'enabled', '--effort', 'xhigh']],
    ['max', ['--thinking', 'enabled', '--effort', 'max']],
    ['disabled', ['--thinking', 'disabled']],
    // A legacy variant id an old task may still carry.
    ['thinking-16k', ['--thinking', 'adaptive']],
  ];
  const modes: Array<[string, string]> = [
    ['default', 'default'],
    ['acceptEdits', 'acceptEdits'],
    ['plan', 'plan'],
    ['bypassPermissions', 'bypassPermissions'],
    ['build', 'acceptEdits'],
  ];
  const cases = modes.flatMap(([mode, permissionMode]) => [
    ...thinking.map(([effort, thinkingArgs]) => ({ mode, permissionMode, effort, model: 'sonnet' as string | undefined, thinkingArgs })),
    // Effort only rides with a model, on both transports.
    { mode, permissionMode, effort: 'max', model: undefined, thinkingArgs: [] },
  ]);

  async function taskArgs(mode: string, model: string | undefined, effort: string): Promise<string[]> {
    const { spawned, processDeps } = deps([]);
    const adapter = new ClaudeCodeAdapter(processDeps);
    await adapter.start(taskStart({ mode, model, flags: resolveTaskRunnerFlags(CLAUDE_CODE_MANIFEST, { mode, model, thinkingEffort: effort }) }));
    adapter.dispose();
    return spawned.lastArgs();
  }

  it.each(cases)('mode $mode, effort $effort, model $model', async ({ mode, permissionMode, effort, model, thinkingArgs }) => {
    expect(await taskArgs(mode, model, effort)).toEqual([
      '-p',
      '--input-format', 'stream-json',
      '--output-format', 'stream-json',
      '--verbose',
      '--include-partial-messages',
      '--replay-user-messages',
      '--permission-prompt-tool', 'stdio',
      '--permission-mode', permissionMode,
      '--disallowedTools', 'AskUserQuestion',
      ...thinkingArgs,
      ...(model ? ['--model', model] : []),
    ]);
  });


});

describe('task mode support', () => {
  it('is every built-in runner', () => {
    expect(supportsTaskMode('claude-code')).toBe(true);
    expect(supportsTaskMode('codex')).toBe(true);
    expect(supportsTaskMode('opencode')).toBe(true);
    expect(createTaskAdapter('codex', deps([]).processDeps)).toBeInstanceOf(CodexAdapter);
    expect(createTaskAdapter('opencode', deps([]).processDeps)).toBeInstanceOf(OpenCodeAdapter);
    expect(supportsTaskMode('toString')).toBe(false);
  });

  it('refuses a runner without a connector with a typed error', () => {
    expect(() => createTaskAdapter('my-plugin', deps([]).processDeps)).toThrow(TaskModeUnsupportedError);
    expect(() => createTaskAdapter('my-plugin', deps([]).processDeps)).toThrow('my-plugin has no structured task connector');
  });
});

describe('ClaudeCodeAdapter in task mode', () => {
  it('disables the question tool, so the agent asks in plain text and ends its turn (ADR-0018, M1)', async () => {
    const { spawned, processDeps } = deps([]);
    const adapter = new ClaudeCodeAdapter(processDeps);
    await adapter.start(taskStart());
    const args = spawned.lastArgs();
    expect(args.flatMap((arg, i) => (arg === '--disallowedTools' ? [args[i + 1]] : []))).toEqual(['AskUserQuestion']);
    adapter.dispose();
  });

  describe('background work', () => {
    afterEach(() => { vi.useRealTimers(); });

    // Recorded from `claude` 2.1.286: a background `sleep 20`, a `result` line while it
    // still runs, then — on its own — a second turn once it finishes.
    it('holds the turn open while a background task runs, so what the agent says after it is the same turn\'s', async () => {
      const { processDeps } = deps([fixture('claude-code', 'task-background')]);
      const adapter = new ClaudeCodeAdapter(processDeps);
      await adapter.start(taskStart());
      const events: AgentEvent[] = [];
      await adapter.send('wait for it', (e) => events.push(e));

      expect(events.filter((e) => e.type === 'turn_end')).toEqual([{ type: 'turn_end' }]);
      expect(events.at(-1)).toEqual({ type: 'turn_end' });
      const text = events.flatMap((e) => (e.type === 'assistant_text' ? [e.text] : [])).join('');
      expect(text).toContain('Waiting for the background command to complete');
      expect(text.trim().endsWith('FINISHED')).toBe(true);
      adapter.dispose();
    });

    it('ends the held turn once the work is done and the CLI starts no follow-on turn', async () => {
      vi.useFakeTimers();
      const { processDeps } = deps([fixture('claude-code', 'task-background-no-wake')]);
      const adapter = new ClaudeCodeAdapter(processDeps);
      await adapter.start(taskStart());
      const events: AgentEvent[] = [];
      let ended = false;
      void adapter.send('wait for it', (e) => events.push(e)).then(() => { ended = true; });

      await vi.advanceTimersByTimeAsync(1000);
      expect(events.some((e) => e.type === 'turn_end')).toBe(false);
      await vi.advanceTimersByTimeAsync(10_000);
      expect(ended).toBe(true);
      expect(events.at(-1)).toEqual({ type: 'turn_end' });
      adapter.dispose();
    });

    it('does not hold a planner\'s turn', async () => {
      const { processDeps } = deps([fixture('claude-code', 'task-background')]);
      const adapter = new ClaudeCodeAdapter(processDeps);
      await adapter.start({ kind: 'planner', cwd: '/repo', systemPrompt: 'PLAN' });
      const events: AgentEvent[] = [];
      await adapter.send('wait for it', (e) => events.push(e));
      expect(events.at(-1)).toEqual({ type: 'turn_end' });
      expect(events.some((e) => e.type === 'assistant_text' && e.text.trim() === 'FINISHED')).toBe(false);
      adapter.dispose();
    });
  });

  it('fails the turn in plain words when the CLI starts in another mode than the plan asked for', async () => {
    const { processDeps } = deps([
      // Recorded from `claude` 2.1.286 asked for `--permission-mode auto` on haiku: no refusal, no warning.
      JSON.stringify({ type: 'system', subtype: 'init', session_id: 'sess-1', cwd: '/repo', permissionMode: 'default', model: 'claude-haiku-4-5-20251001' }) + '\n',
    ]);
    const adapter = new ClaudeCodeAdapter(processDeps);
    await adapter.start(taskStart({ mode: 'auto', model: 'haiku', flags: { permissionMode: 'auto', modeSettings: {} } }));
    const events: AgentEvent[] = [];
    await adapter.send('go', (e) => events.push(e));

    expect(events).toEqual([{
      type: 'error',
      message: 'Claude Code started in "default" mode, not the "auto" mode the plan asked for. It does not report why; the model or the account may not offer it.',
    }]);
    adapter.dispose();
  });

  it('reports a usage limit as the turn\'s error, in words the reset time is read from (#84)', async () => {
    // Not recorded: the result line #79 describes, its text built from the
    // template in `claude` 2.1.296 ("You've hit your <limit> · resets <time> (<zone>)").
    const limit = "You've hit your session limit · resets 8:10pm (Europe/Rome)";
    const { processDeps } = deps([
      JSON.stringify({ type: 'system', subtype: 'init', session_id: 'sess-1', cwd: '/repo', permissionMode: 'acceptEdits' }) + '\n'
        + JSON.stringify({ type: 'result', subtype: 'success', is_error: true, result: limit, session_id: 'sess-1' }) + '\n',
    ]);
    const adapter = new ClaudeCodeAdapter(processDeps);
    await adapter.start(taskStart());
    const events: AgentEvent[] = [];
    await adapter.send('go', (e) => events.push(e));

    const error = events.find((e): e is Extract<AgentEvent, { type: 'error' }> => e.type === 'error');
    expect(error?.message).toBe(limit);
    expect(classifyRunnerStop(error!.message)).toBe('usage-limit');
    expect(readUsageLimitReset('claude-code', error!.message, new Date('2026-10-11T17:00:00Z'))?.toISOString()).toBe('2026-10-11T18:10:00.000Z');
    adapter.dispose();
  });

  it('reports a resume the CLI cannot find as a failed turn in its own words, and lets the process go (ADR-0018, K1)', async () => {
    const { spawned, processDeps } = deps([]);
    const adapter = new ClaudeCodeAdapter(processDeps);
    await adapter.start(taskStart({ resumeSessionId: '0d6c1a52-3b7e-4f7e-9d1a-5b0c2e4f8a11' }));
    const proc = spawned.processes[0];
    const events: AgentEvent[] = [];
    const turn = adapter.send('also handle arrays', (e) => events.push(e));
    // Recorded from `claude` 2.1.284: the refusal arrives on its own, before any `init`.
    proc.emitStdout(fixture('claude-code', 'task-resume-not-found'));
    await turn;

    expect(events).toEqual([{ type: 'error', message: 'No conversation found with session ID: 0d6c1a52-3b7e-4f7e-9d1a-5b0c2e4f8a11' }]);
    // The CLI waits on stdin after refusing; closing it is what lets it exit.
    expect(proc.stdinEnded).toBe(true);
    // No session was taken up, so none is announced for a later continue.
    expect(adapter.nativeSessionId()).toBeNull();
    adapter.dispose();
  });

  it('refused before any turn opens, the next turn reports the CLI\'s last words instead of hanging', async () => {
    const { spawned, processDeps } = deps([]);
    const adapter = new ClaudeCodeAdapter(processDeps);
    await adapter.start(taskStart({ resumeSessionId: '0d6c1a52-3b7e-4f7e-9d1a-5b0c2e4f8a11' }));
    const proc = spawned.processes[0];
    proc.emitStderr('No conversation found with session ID: 0d6c1a52-3b7e-4f7e-9d1a-5b0c2e4f8a11\n');
    proc.emitStdout(fixture('claude-code', 'task-resume-not-found'));
    expect(proc.stdinEnded).toBe(true);
    proc.exit(1);

    const events: AgentEvent[] = [];
    await adapter.send('also handle arrays', (e) => events.push(e));

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: 'error', message: expect.stringContaining('No conversation found with session ID') });
    expect(adapter.nativeSessionId()).toBeNull();
    adapter.dispose();
  });

  it('takes a resumed session up once the CLI announces it', async () => {
    const { spawned, processDeps } = deps([fixture('claude-code', 'task-marker')]);
    const adapter = new ClaudeCodeAdapter(processDeps);
    await adapter.start(taskStart({ resumeSessionId: 'sess-task-marker' }));
    const events: AgentEvent[] = [];
    await adapter.send('go on', (e) => events.push(e));

    expect(events.at(-1)).toEqual({ type: 'turn_end' });
    expect(spawned.processes[0].stdinEnded).toBe(false);
    expect(adapter.nativeSessionId()).toBe('sess-task-marker');
    adapter.dispose();
  });

  it('leaves a tool request open for someone to answer, and passes the whole request on', async () => {
    const { spawned, processDeps } = deps([fixture('claude-code', 'permission-task')]);
    const adapter = new ClaudeCodeAdapter(processDeps);
    await adapter.start(taskStart({ mode: 'default', flags: { permissionMode: 'default', modeSettings: {} } }));
    const events: AgentEvent[] = [];
    void adapter.send('Write a.txt', (e) => events.push(e));
    await until(() => events.some((e) => e.type === 'permission_request'));

    expect(events.find((e) => e.type === 'permission_request')).toEqual({
      type: 'permission_request',
      id: '9a948184-6792-4049-85b1-3e837387f618',
      name: 'Write',
      detail: JSON.stringify({ file_path: '/repo/a.txt', content: 'a' }),
      input: { file_path: '/repo/a.txt', content: 'a' },
      suggestions: [{ type: 'setMode', mode: 'acceptEdits', destination: 'session' }],
      toolUseId: 'toolu_01TxT55eyjF5qKKGmJHwiDbe',
    });
    await tick();
    expect(sent(spawned)).toHaveLength(1);
    expect(events.some((e) => e.type === 'turn_end')).toBe(false);
    adapter.dispose();
  });

  it('answers Allow with the call\'s own input, then Allow for this task with Claude\'s own suggestions', async () => {
    const { spawned, processDeps } = deps([
      fixture('claude-code', 'permission-task'),
      fixture('claude-code', 'permission-task-allowed'),
      fixture('claude-code', 'permission-task-allowed-for-task'),
    ]);
    const adapter = new ClaudeCodeAdapter(processDeps);
    await adapter.start(taskStart({ mode: 'default', flags: { permissionMode: 'default', modeSettings: {} } }));
    const events: AgentEvent[] = [];
    const turn = adapter.send('Write a.txt and b.txt', (e) => events.push(e));
    const requests = () => events.filter((e) => e.type === 'permission_request');

    await until(() => requests().length === 1);
    expect(adapter.answerPermission('9a948184-6792-4049-85b1-3e837387f618', { decision: 'allow' })).toBe(true);
    expect(JSON.parse(sent(spawned)[1])).toEqual({
      type: 'control_response',
      response: {
        subtype: 'success',
        request_id: '9a948184-6792-4049-85b1-3e837387f618',
        response: { behavior: 'allow', updatedInput: { file_path: '/repo/a.txt', content: 'a' } },
      },
    });

    await until(() => requests().length === 2);
    expect(adapter.answerPermission('5ab6f7de-9bb1-4e03-9e80-8c3aa64c0506', { decision: 'allowForTask' })).toBe(true);
    expect(JSON.parse(sent(spawned)[2])).toEqual({
      type: 'control_response',
      response: {
        subtype: 'success',
        request_id: '5ab6f7de-9bb1-4e03-9e80-8c3aa64c0506',
        response: {
          behavior: 'allow',
          updatedInput: { file_path: '/repo/b.txt', content: 'b' },
          updatedPermissions: [{ type: 'setMode', mode: 'acceptEdits', destination: 'session' }],
        },
      },
    });

    await turn;
    // The recorded run: both writes went through, and the third call ran
    // unasked under the session-scoped grant.
    expect(events.filter((e) => e.type === 'tool_result').map((e) => e.type === 'tool_result' && e.success)).toEqual([true, true, true]);
    expect(requests()).toHaveLength(2);
    expect(events.at(-1)).toEqual({ type: 'turn_end' });
    adapter.dispose();
  });

  it('reports a file edit\'s result as its diff, a created file as its added lines', async () => {
    const toolResult = (id: string, content: string, toolUseResult: Record<string, unknown>, isError = false) => JSON.stringify({
      type: 'user',
      message: { role: 'user', content: [{ tool_use_id: id, type: 'tool_result', content, ...(isError ? { is_error: true } : {}) }] },
      parent_tool_use_id: null, session_id: 'sess-edit', tool_use_result: toolUseResult,
    });
    const stream = [
      toolResult('toolu_e', 'The file /repo/sum.ts has been updated successfully.', {
        filePath: '/repo/sum.ts', oldString: 'a - b', newString: 'a + b',
        structuredPatch: [{ oldStart: 1, oldLines: 3, newStart: 1, newLines: 3, lines: [' export function sum(a, b) {', '-  return a - b;', '+  return a + b;', ' }'] }],
      }),
      toolResult('toolu_w', 'File created successfully at: /repo/a.txt', { type: 'create', filePath: '/repo/a.txt', content: 'a\nb\n', structuredPatch: [], originalFile: null }),
      toolResult('toolu_x', 'String to replace not found in file.', { filePath: '/repo/x.ts', structuredPatch: [] }, true),
      JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'done', session_id: 'sess-edit', stop_reason: 'end_turn' }),
    ].join('\n') + '\n';
    const { processDeps } = deps([stream]);
    const adapter = new ClaudeCodeAdapter(processDeps);
    await adapter.start(taskStart());
    const events: AgentEvent[] = [];
    await adapter.send('fix sum', (e) => events.push(e));

    expect(events.filter((e) => e.type === 'tool_result').map((e) => e.type === 'tool_result' && [e.id, e.output, e.success])).toEqual([
      ['toolu_e', '@@ -1,3 +1,3 @@\n export function sum(a, b) {\n-  return a - b;\n+  return a + b;\n }\n', true],
      ['toolu_w', '+a\n+b\n', true],
      ['toolu_x', 'String to replace not found in file.', false],
    ]);
    adapter.dispose();
  });

  it('answers Deny with the note as the message the agent reads', async () => {
    const { spawned, processDeps } = deps([fixture('claude-code', 'permission-task-deny'), fixture('claude-code', 'permission-task-denied')]);
    const adapter = new ClaudeCodeAdapter(processDeps);
    await adapter.start(taskStart({ mode: 'default', flags: { permissionMode: 'default', modeSettings: {} } }));
    const events: AgentEvent[] = [];
    void adapter.send('Write d.txt', (e) => events.push(e));
    await until(() => events.some((e) => e.type === 'permission_request'));

    expect(adapter.answerPermission('160adb6f-1e51-4d65-a12f-911f10dd46ae', { decision: 'deny', note: 'Not this one — write it to notes/c.txt instead.' })).toBe(true);
    expect(JSON.parse(sent(spawned)[1])).toEqual({
      type: 'control_response',
      response: {
        subtype: 'success',
        request_id: '160adb6f-1e51-4d65-a12f-911f10dd46ae',
        response: { behavior: 'deny', message: 'Not this one — write it to notes/c.txt instead.' },
      },
    });
    await until(() => events.filter((e) => e.type === 'permission_request').length === 2);
    expect(events.find((e) => e.type === 'tool_result')).toMatchObject({ success: false, output: 'Not this one — write it to notes/c.txt instead.' });
    adapter.dispose();
  });

  it('denies without a note in words of its own, since the CLI requires a message', async () => {
    const { spawned, processDeps } = deps([fixture('claude-code', 'permission-task-deny')]);
    const adapter = new ClaudeCodeAdapter(processDeps);
    await adapter.start(taskIn('default'));
    const events: AgentEvent[] = [];
    void adapter.send('Write d.txt', (e) => events.push(e));
    await until(() => events.some((e) => e.type === 'permission_request'));
    adapter.answerPermission('160adb6f-1e51-4d65-a12f-911f10dd46ae', { decision: 'deny', note: '   ' });
    const answer = JSON.parse(sent(spawned)[1]) as { response: { response: { behavior: string; message: string } } };
    expect(answer.response.response.behavior).toBe('deny');
    expect(answer.response.response.message).toMatch(/\S/);
    adapter.dispose();
  });

  it('answers Allow for this task as a plain allow when Claude suggested nothing', async () => {
    const noSuggestions = fixture('claude-code', 'permission-task').replace(/,"permission_suggestions":\[[^\]]*\]/, '');
    const { spawned, processDeps } = deps([noSuggestions]);
    const adapter = new ClaudeCodeAdapter(processDeps);
    await adapter.start(taskIn('default'));
    const events: AgentEvent[] = [];
    void adapter.send('Write a.txt', (e) => events.push(e));
    await until(() => events.some((e) => e.type === 'permission_request'));
    expect(events.find((e) => e.type === 'permission_request')).toMatchObject({ suggestions: [] });
    adapter.answerPermission('9a948184-6792-4049-85b1-3e837387f618', { decision: 'allowForTask' });
    const answer = JSON.parse(sent(spawned)[1]) as { response: { response: Record<string, unknown> } };
    expect(answer.response.response).toEqual({ behavior: 'allow', updatedInput: { file_path: '/repo/a.txt', content: 'a' } });
    adapter.dispose();
  });

  it('answers each request once, and nothing it never asked', async () => {
    const { spawned, processDeps } = deps([fixture('claude-code', 'permission-task')]);
    const adapter = new ClaudeCodeAdapter(processDeps);
    await adapter.start(taskIn('default'));
    const events: AgentEvent[] = [];
    void adapter.send('Write a.txt', (e) => events.push(e));
    await until(() => events.some((e) => e.type === 'permission_request'));
    expect(adapter.answerPermission('not-asked', { decision: 'allow' })).toBe(false);
    expect(adapter.answerPermission('9a948184-6792-4049-85b1-3e837387f618', { decision: 'allow' })).toBe(true);
    expect(adapter.answerPermission('9a948184-6792-4049-85b1-3e837387f618', { decision: 'deny' })).toBe(false);
    expect(sent(spawned)).toHaveLength(2);
    adapter.dispose();
  });

  it('reports a request Claude withdraws when the turn is interrupted, and takes no answer for it', async () => {
    const { spawned, processDeps } = deps([
      fixture('claude-code', 'permission-task-deny'),
      fixture('claude-code', 'permission-task-denied'),
      (written, proc) => {
        const request = JSON.parse(written) as { request_id: string };
        proc.emitStdout(fixture('claude-code', 'permission-task-cancelled', { REQUEST_ID: request.request_id }));
      },
    ]);
    const adapter = new ClaudeCodeAdapter(processDeps);
    await adapter.start(taskIn('default'));
    const events: AgentEvent[] = [];
    const turn = adapter.send('Write d.txt', (e) => events.push(e));
    await until(() => events.some((e) => e.type === 'permission_request'));
    adapter.answerPermission('160adb6f-1e51-4d65-a12f-911f10dd46ae', { decision: 'deny' });
    await until(() => events.filter((e) => e.type === 'permission_request').length === 2);

    await expect(adapter.interrupt(1000)).resolves.toBe(true);
    await turn;
    expect(events).toContainEqual({ type: 'permission_cancelled', id: '04436c5a-8682-477d-a23f-34bbb9f814f3' });
    expect(adapter.answerPermission('04436c5a-8682-477d-a23f-34bbb9f814f3', { decision: 'allow' })).toBe(false);
    expect(events.at(-1)).toEqual({ type: 'turn_end', interrupted: true });
    expect(sent(spawned)).toHaveLength(3);
    adapter.dispose();
  });

  it('leaves a planner\'s request open for Ordewell, without Claude\'s own grants', async () => {
    const { spawned, processDeps } = deps([fixture('claude-code', 'permission-task')]);
    const adapter = new ClaudeCodeAdapter(processDeps);
    await adapter.start({ kind: 'planner', cwd: '/repo', systemPrompt: 'PLAN' });
    const events: AgentEvent[] = [];
    void adapter.send('Plan it', (e) => events.push(e));
    await until(() => events.some((e) => e.type === 'permission_request'));
    expect(sent(spawned)).toHaveLength(1);
    expect(events.find((e) => e.type === 'permission_request')).toEqual({
      type: 'permission_request',
      id: '9a948184-6792-4049-85b1-3e837387f618',
      name: 'Write',
      detail: JSON.stringify({ file_path: '/repo/a.txt', content: 'a' }),
      input: { file_path: '/repo/a.txt', content: 'a' },
      toolUseId: expect.any(String),
      ask: { kind: 'other' },
    });
    expect(adapter.answerPermission('9a948184-6792-4049-85b1-3e837387f618', { decision: 'deny', note: 'no' })).toBe(true);
    const answer = JSON.parse(sent(spawned)[1]) as { response: { response: { behavior: string; message: string } } };
    expect(answer.response.response).toEqual({ behavior: 'deny', message: 'no' });
    adapter.dispose();
  });

  it('cancels a request still open when the turn ends, as every runner does', async () => {
    const result = { type: 'result', subtype: 'success', is_error: false, session_id: 'sess-1', result: 'Stopped.' };
    const { spawned, processDeps } = deps([fixture('claude-code', 'permission-task') + `${JSON.stringify(result)}\n`]);
    const adapter = new ClaudeCodeAdapter(processDeps);
    await adapter.start(taskIn('default'));
    const events: AgentEvent[] = [];
    await adapter.send('Write a.txt', (e) => events.push(e));

    expect(events.slice(-2)).toEqual([{ type: 'permission_cancelled', id: '9a948184-6792-4049-85b1-3e837387f618' }, { type: 'turn_end' }]);
    expect(adapter.answerPermission('9a948184-6792-4049-85b1-3e837387f618', { decision: 'allow' })).toBe(false);
    expect(sent(spawned)).toHaveLength(1);
    adapter.dispose();
  });

  it('keeps a planner\'s request open past a turn end while background work that may have raised it still runs', async () => {
    const background = { type: 'system', subtype: 'background_tasks_changed', session_id: 'sess-1', tasks: [{ id: 'bg-1' }] };
    const result = { type: 'result', subtype: 'success', is_error: false, session_id: 'sess-1', result: 'Researching in the background.' };
    const { processDeps } = deps([`${JSON.stringify(background)}\n` + fixture('claude-code', 'permission-task') + `${JSON.stringify(result)}\n`]);
    const adapter = new ClaudeCodeAdapter(processDeps);
    await adapter.start({ kind: 'planner', cwd: '/repo', systemPrompt: 'PLAN' });
    const events: AgentEvent[] = [];
    await adapter.send('Plan it', (e) => events.push(e));

    expect(events.at(-1)).toEqual({ type: 'turn_end' });
    expect(events.some((e) => e.type === 'permission_cancelled')).toBe(false);
    expect(adapter.answerPermission('9a948184-6792-4049-85b1-3e837387f618', { decision: 'deny' })).toBe(true);
    adapter.dispose();
  });

  it('interrupts with the control request the CLI acknowledges, and the turn ends interrupted', async () => {
    const { spawned, processDeps } = deps([
      fixture('claude-code', 'task-interrupt'),
      (written, proc) => {
        const request = JSON.parse(written) as { request_id: string };
        proc.emitStdout(fixture('claude-code', 'task-interrupt-ack', { REQUEST_ID: request.request_id }));
      },
    ]);
    const adapter = new ClaudeCodeAdapter(processDeps);
    await adapter.start(taskStart());
    const events: AgentEvent[] = [];
    const turn = adapter.send('sleep a while', (e) => events.push(e));
    await tick();

    await expect(adapter.interrupt(1000)).resolves.toBe(true);
    await turn;
    expect(JSON.parse(sent(spawned)[1])).toEqual({
      type: 'control_request',
      request_id: 'ordewell-interrupt-2',
      request: { subtype: 'interrupt' },
    });
    expect(events.some((e) => e.type === 'error')).toBe(false);
    expect(events.at(-1)).toEqual({ type: 'turn_end', interrupted: true });
    adapter.dispose();
  });

  it('reports an unanswered interrupt so the caller can fall back', async () => {
    const { processDeps } = deps([fixture('claude-code', 'task-interrupt')]);
    const adapter = new ClaudeCodeAdapter(processDeps);
    await adapter.start(taskStart());
    void adapter.send('sleep a while', () => {});
    await tick();
    await expect(adapter.interrupt(20)).resolves.toBe(false);
    adapter.dispose();
  });

  it('reports a process that ends, once', async () => {
    const { spawned, processDeps } = deps([]);
    const adapter = new ClaudeCodeAdapter(processDeps);
    await adapter.start(taskStart());
    const codes: number[] = [];
    adapter.onProcessExit((code) => codes.push(code));
    spawned.processes[0].exit(3);
    spawned.processes[0].exit(3);
    await tick();
    expect(codes).toEqual([3]);
  });
});

describe('ClaudeCodeAdapter with the Ordewell MCP server (ADR-0022)', () => {
  const mcp = mcpClientConfig({ url: 'http://127.0.0.1:4555/mcp', token: 'tok-secret' });

  function configPath(args: string[]): string {
    expect(args.filter((arg) => arg === '--mcp-config')).toHaveLength(1);
    return args[args.indexOf('--mcp-config') + 1];
  }

  it('hands the server to the CLI in an owner-only file, its tools loaded up front and pre-approved', async () => {
    const { spawned, processDeps } = deps([]);
    const adapter = new ClaudeCodeAdapter(processDeps);
    await adapter.start(taskStart({ mcp }));
    const args = spawned.lastArgs();

    const path = configPath(args);
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({
      mcpServers: { ordewell: { type: 'http', url: 'http://127.0.0.1:4555/mcp', headers: { Authorization: 'Bearer tok-secret' }, alwaysLoad: true } },
    });
    if (process.platform !== 'win32') expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(args.some((arg) => arg.includes('tok-secret'))).toBe(false);
    expect(args.flatMap((arg, i) => (arg === '--allowedTools' ? [args[i + 1]] : []))).toEqual(['mcp__ordewell__task_complete,mcp__ordewell__checkpoint']);
    adapter.dispose();
  });

  it.each(modeIds(CLAUDE_CODE_MANIFEST))('pre-approves the Ordewell tools and auto-allows their requests under %s', async (mode) => {
    const request = {
      type: 'control_request',
      request_id: 'req-m',
      request: { subtype: 'can_use_tool', tool_name: 'mcp__ordewell__checkpoint', input: { question: 'ok?' }, tool_use_id: 'tu-m' },
    };
    const { spawned, processDeps } = deps([`${JSON.stringify(request)}\n`]);
    const adapter = new ClaudeCodeAdapter(processDeps);
    await adapter.start(taskIn(mode, { mcp }));
    const events: AgentEvent[] = [];
    void adapter.send('Do it', (e) => events.push(e));
    await until(() => sent(spawned).length === 2);
    const args = spawned.lastArgs();

    expect(args.flatMap((arg, i) => (arg === '--allowedTools' ? [args[i + 1]] : []))).toEqual(['mcp__ordewell__task_complete,mcp__ordewell__checkpoint']);
    expect(args.some((arg) => arg.includes('tok-secret'))).toBe(false);
    expect(JSON.parse(sent(spawned)[1]).response.response.behavior).toBe('allow');
    expect(events.find((e) => e.type === 'permission_request')).toMatchObject({ decided: { decision: 'allow' } });
    adapter.dispose();
  });

  it('removes the file once the process is gone', async () => {
    const { spawned, processDeps } = deps([]);
    const adapter = new ClaudeCodeAdapter(processDeps);
    await adapter.start(taskStart({ mcp }));
    const path = configPath(spawned.lastArgs());

    spawned.processes[0].exit(0);

    await until(() => !existsSync(path));
    adapter.dispose();
  });

  it('removes the file when disposed', async () => {
    const { spawned, processDeps } = deps([]);
    const adapter = new ClaudeCodeAdapter(processDeps);
    await adapter.start(taskStart({ mcp }));
    const path = configPath(spawned.lastArgs());

    adapter.dispose();

    expect(existsSync(path)).toBe(false);
  });

  it('allows a request for an Ordewell tool itself, so it never waits on a person', async () => {
    const request = {
      type: 'control_request',
      request_id: 'req-1',
      request: { subtype: 'can_use_tool', tool_name: 'mcp__ordewell__task_complete', input: { status: 'done', summary: 'ok' }, tool_use_id: 'tu-1' },
    };
    const { spawned, processDeps } = deps([`${JSON.stringify(request)}\n`]);
    const adapter = new ClaudeCodeAdapter(processDeps);
    await adapter.start(taskStart({ mcp, flags: { permissionMode: 'default', modeSettings: {} }, mode: 'default' }));
    const events: AgentEvent[] = [];
    void adapter.send('Do it', (e) => events.push(e));
    await until(() => sent(spawned).length === 2);

    expect(JSON.parse(sent(spawned)[1])).toEqual({
      type: 'control_response',
      response: { subtype: 'success', request_id: 'req-1', response: { behavior: 'allow', updatedInput: { status: 'done', summary: 'ok' } } },
    });
    expect(events.find((e) => e.type === 'permission_request')).toEqual({
      type: 'permission_request',
      id: 'req-1',
      name: 'mcp__ordewell__task_complete',
      detail: JSON.stringify({ status: 'done', summary: 'ok' }),
      input: { status: 'done', summary: 'ok' },
      toolUseId: 'tu-1',
      decided: { decision: 'allow' },
    });
    expect(adapter.answerPermission('req-1', { decision: 'deny' })).toBe(false);
    adapter.dispose();
  });

  // `mcp__ordewell__x__task_complete` is the tool `task_complete` of a server named `ordewell__x`.
  it.each(['mcp__ordewellx__task_complete', 'mcp__ordewell__x__task_complete', 'mcp__ordewell__evil'])('still asks about another server\'s tool: %s', async (name) => {
    const request = {
      type: 'control_request',
      request_id: 'req-2',
      request: { subtype: 'can_use_tool', tool_name: name, input: {} },
    };
    const { spawned, processDeps } = deps([`${JSON.stringify(request)}\n`]);
    const adapter = new ClaudeCodeAdapter(processDeps);
    await adapter.start(taskStart({ mcp, flags: { permissionMode: 'default', modeSettings: {} }, mode: 'default' }));
    const events: AgentEvent[] = [];
    void adapter.send('Do it', (e) => events.push(e));
    await until(() => events.some((e) => e.type === 'permission_request'));

    expect(events.find((e) => e.type === 'permission_request')).not.toHaveProperty('decided');
    expect(sent(spawned)).toHaveLength(1);
    adapter.dispose();
  });
});

/**
 * Mid-turn delivery (ADR-0023), against transcripts recorded from `claude`
 * 2.1.291 under `--replay-user-messages`, on haiku: a steer written during a
 * `sleep`, and one written while the model was writing a text-only reply.
 */
describe('ClaudeCodeAdapter steer', () => {
  const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

  const midTurn = claudeSteerRecording('mid-turn');
  const afterResult = claudeSteerRecording('after-result');

  function steerLine(written: string): { type: string; uuid: string; message: { role: string; content: Array<{ type: string; text: string }> } } {
    return JSON.parse(written) as ReturnType<typeof steerLine>;
  }

  it('writes the message as a user line under a uuid of its own, and reports it delivered when the CLI echoes that uuid', async () => {
    const { spawned, processDeps } = deps([midTurn.before, midTurn.answer]);
    const adapter = new ClaudeCodeAdapter(processDeps);
    await adapter.start(taskIn('bypassPermissions'));
    const events: AgentEvent[] = [];
    const turn = adapter.send('Run the sleep', (e) => events.push(e));
    await until(() => events.some((e) => e.type === 'tool_call'));

    expect(await adapter.steer('msg-1', 'Also include the word PINEAPPLE in your final reply.')).toBe(true);
    const line = steerLine(sent(spawned)[1]);
    expect(line).toEqual({ type: 'user', uuid: expect.stringMatching(UUID), message: { role: 'user', content: [{ type: 'text', text: 'Also include the word PINEAPPLE in your final reply.' }] } });
    await turn;

    const at = (match: (e: AgentEvent) => boolean) => events.findIndex(match);
    const delivered = at((e) => e.type === 'message_delivered');
    // The first prompt is echoed too, and is no delivery.
    expect(events.filter((e) => e.type === 'message_delivered')).toEqual([{ type: 'message_delivered', id: 'msg-1' }]);
    expect(delivered).toBeGreaterThan(at((e) => e.type === 'tool_result'));
    expect(delivered).toBeLessThan(at((e) => e.type === 'assistant_text' && e.text.includes('PINEAPPLE')));
    expect(events.filter((e) => e.type === 'turn_end')).toEqual([{ type: 'turn_end' }]);
    expect(events.at(-1)).toEqual({ type: 'turn_end' });
    adapter.dispose();
  });

  it('a message the model did not read before the result opens the CLI\'s own turn, reported out of turn and written once', async () => {
    const { spawned, processDeps } = deps([afterResult.before, afterResult.answer]);
    const adapter = new ClaudeCodeAdapter(processDeps);
    await adapter.start(taskIn('bypassPermissions'));
    const outOfTurn: AgentEvent[] = [];
    adapter.onOutOfTurn((e) => outOfTurn.push(e));
    const events: AgentEvent[] = [];
    const turn = adapter.send('Say something about the sea', (e) => events.push(e));
    await until(() => events.some((e) => e.type === 'assistant_text_delta'));

    expect(await adapter.steer('msg-1', 'Now reply with only the word PINEAPPLE.')).toBe(true);
    await turn;
    expect(events.some((e) => e.type === 'message_delivered')).toBe(false);
    expect(events.at(-1)).toEqual({ type: 'turn_end' });

    await until(() => outOfTurn.some((e) => e.type === 'turn_end'));
    expect(outOfTurn[0]).toEqual({ type: 'message_delivered', id: 'msg-1' });
    // A turn of its own: its text opens no paragraph after the last turn's.
    expect(outOfTurn.filter((e) => e.type === 'assistant_text')).toEqual([{ type: 'assistant_text', text: 'PINEAPPLE' }]);
    expect(outOfTurn.filter((e) => e.type === 'message_delivered' || e.type === 'message_dropped')).toHaveLength(1);
    expect(sent(spawned).filter((w) => w.includes('PINEAPPLE'))).toHaveLength(1);
    adapter.dispose();
  });

  it('reports each message delivered once, by its own echo, whatever else the CLI echoes', async () => {
    const { spawned, processDeps } = deps([]);
    const adapter = new ClaudeCodeAdapter(processDeps);
    await adapter.start(taskStart());
    const events: AgentEvent[] = [];
    void adapter.send('Do it', (e) => events.push(e));
    await adapter.steer('msg-1', 'one');
    await adapter.steer('msg-2', 'two');
    const [, first, second] = sent(spawned).map(steerLine);
    // Accepted is not delivered: only the echo says the model has it.
    expect(events.some((e) => e.type === 'message_delivered')).toBe(false);
    const echo = (uuid: string) => `${JSON.stringify({ type: 'user', isReplay: true, uuid, session_id: 's', parent_tool_use_id: null, message: { role: 'user', content: [{ type: 'text', text: 'x' }] } })}\n`;

    // A steer of another process — a stale attempt's, or a killed one's — is not this one's to report.
    spawned.processes[0].emitStdout(echo('00000000-0000-4000-8000-000000000000') + echo(first.uuid) + echo(first.uuid) + echo(second.uuid));

    expect(first.uuid).not.toBe(second.uuid);
    expect(events.filter((e) => e.type === 'message_delivered')).toEqual([
      { type: 'message_delivered', id: 'msg-1' },
      { type: 'message_delivered', id: 'msg-2' },
    ]);
    adapter.dispose();
  });

  it('is refused, leaving the message for the turn\'s end, while an interrupt is in flight and before a resume is taken up', async () => {
    const { spawned, processDeps } = deps([]);
    const adapter = new ClaudeCodeAdapter(processDeps);
    await adapter.start(taskStart({ resumeSessionId: 'sess-task-marker' }));
    void adapter.send('go on', () => {});
    expect(await adapter.steer('msg-1', 'too early')).toBe(false);

    spawned.processes[0].emitStdout(`${JSON.stringify({ type: 'system', subtype: 'init', session_id: 'sess-task-marker', permissionMode: 'acceptEdits' })}\n`);
    void adapter.interrupt(50);
    expect(await adapter.steer('msg-2', 'mid-interrupt')).toBe(false);
    expect(sent(spawned).some((w) => w.includes('too early') || w.includes('mid-interrupt'))).toBe(false);
    adapter.dispose();
  });

  it('is refused by a planner, and once the process is gone', async () => {
    const planner = new ClaudeCodeAdapter(deps([]).processDeps);
    await planner.start({ kind: 'planner', cwd: '/repo', systemPrompt: 'PLAN' });
    expect(await planner.steer('msg-1', 'hi')).toBe(false);
    planner.dispose();

    const task = new ClaudeCodeAdapter(deps([]).processDeps);
    await task.start(taskStart());
    task.dispose();
    expect(await task.steer('msg-1', 'hi')).toBe(false);
  });
});

describe('ClaudeCodeAdapter: a read-only task on a model alias', () => {
  /** The control requests the adapter wrote, in order. */
  function controlRequests(written: string[]): unknown[] {
    return written.map((line) => JSON.parse(line) as { type?: string; request?: unknown })
      .filter((msg) => msg.type === 'control_request')
      .map((msg) => msg.request);
  }

  // Under `--permission-mode plan` the CLI runs Sonnet for the `haiku` alias,
  // and only for the alias: a full id is run as given.
  it('pins the id the CLI resolves the alias to, before its first turn', async () => {
    const { spawned, processDeps } = deps([]);
    const adapter = new ClaudeCodeAdapter(processDeps);
    await adapter.start(taskIn('plan', { model: 'haiku' }));

    expect(controlRequests(spawned.processes[0].written)).toEqual([{ subtype: 'initialize' }, { subtype: 'set_model', model: 'claude-haiku-5-5' }]);
    adapter.dispose();
  });

  it('switches no model for a task in another mode, or for one already on a full id', async () => {
    for (const start of [taskIn('acceptEdits', { model: 'haiku' }), taskIn('plan', { model: 'claude-haiku-5-5' })]) {
      const { spawned, processDeps } = deps([]);
      const adapter = new ClaudeCodeAdapter(processDeps);
      await adapter.start(start);

      expect(controlRequests(spawned.processes[0].written).filter((r) => (r as { subtype?: string }).subtype !== 'initialize')).toEqual([]);
      adapter.dispose();
    }
  });
});

/**
 * The runner's own commands in a task (#66), against `claude` 2.1.299 in a
 * repository with a project skill (`pingskill`) and a project command
 * (`hellocmd`): `initialize` lists every command, `init` says which are skills.
 */
describe('ClaudeCodeAdapter runner commands', () => {
  it('reports the commands the CLI offers, kinded by its own skill list, without the ones only its TUI runs', async () => {
    const { processDeps } = deps([fixture('claude-code', 'task-command-skill')]);
    const adapter = new ClaudeCodeAdapter(processDeps);
    await adapter.start(taskIn('default'));
    await adapter.send('/pingskill', () => {});

    expect(adapter.commands()).toEqual([
      { name: 'tdd', description: 'Test-driven development. (user)', kind: 'skill' },
      { name: 'pingskill', description: 'Reply with the word PONG-SKILL and nothing else. (project)', kind: 'skill' },
      { name: 'hellocmd', description: 'Say hello-command (project)', argumentHint: 'name', kind: 'command' },
      { name: 'clear', description: 'Start a new session with empty context; previous session stays on disk (resumable with /resume)', argumentHint: '[name]', kind: 'builtin', aliases: ['reset', 'new'] },
      { name: 'compact', description: 'Free up context by summarizing the conversation so far', argumentHint: '<optional custom summarization instructions>', kind: 'builtin' },
      { name: 'model', description: 'Set the AI model for Claude Code', argumentHint: '<model>', kind: 'builtin' },
      { name: 'docs', description: 'docs (editable docs people share and comment on). (claude.ai sync)', kind: 'skill', aliases: ['anthropic-skills:docs'] },
    ]);
    adapter.dispose();
  });

  it('says once what the process loaded — its commands and the MCP servers of the user\'s own setup — as its first turn starts', async () => {
    const { processDeps } = deps([fixture('claude-code', 'task-command-skill'), fixture('claude-code', 'task-command-skill')]);
    const adapter = new ClaudeCodeAdapter(processDeps);
    await adapter.start(taskIn('default'));
    const events: AgentEvent[] = [];
    await adapter.send('/pingskill', (e) => events.push(e));
    await adapter.send('/pingskill', (e) => events.push(e));

    const loaded = events.filter((e) => e.type === 'runner_loaded');
    expect(loaded).toEqual([{ type: 'runner_loaded', commands: adapter.commands(), mcpServers: [{ name: 'docs-server', status: 'pending' }] }]);
    expect(events.find((e) => e.type === 'assistant_text')).toEqual({ type: 'assistant_text', text: 'PONG-SKILL' });
    adapter.dispose();
  });

  // The CLI reads a slash command at the start of a user message, so that is
  // how one is invoked over the protocol; its echo comes back as `<command-name>`.
  it('invokes a command as a user message that starts with it, as a turn of its own', async () => {
    const { spawned, processDeps } = deps([fixture('claude-code', 'task-command-skill')]);
    const adapter = new ClaudeCodeAdapter(processDeps);
    await adapter.start(taskIn('default'));
    const events: AgentEvent[] = [];
    await adapter.invokeCommand('hellocmd', 'Bob', (e) => events.push(e));

    expect(JSON.parse(sent(spawned)[0])).toEqual({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: '/hellocmd Bob' }] } });
    expect(events.at(-1)).toEqual({ type: 'turn_end' });
    adapter.dispose();
  });

  it('reports /compact as the runner\'s own compaction, with what the command printed', async () => {
    const { spawned, processDeps } = deps([fixture('claude-code', 'task-compact')]);
    const adapter = new ClaudeCodeAdapter(processDeps);
    await adapter.start(taskIn('default'));
    const events: AgentEvent[] = [];
    await adapter.invokeCommand('compact', '', (e) => events.push(e));

    expect(JSON.parse(sent(spawned)[0]).message.content[0].text).toBe('/compact');
    expect(events.filter((e) => e.type !== 'usage' && e.type !== 'runner_loaded')).toEqual([
      { type: 'compaction', trigger: 'manual', preTokens: 24939, postTokens: 3615 },
      { type: 'command_output', text: 'Compacted' },
      { type: 'turn_end' },
    ]);
    adapter.dispose();
  });
});
