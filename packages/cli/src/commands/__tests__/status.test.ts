import { describe, it, expect, vi } from 'vitest';
import http from 'http';
import { readFileSync, mkdtempSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { ApiClient } from '../../apiClient';
import { stripAnsi } from '../../tui/ansi';

vi.mock('../../utils', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../utils')>()),
  readLastSession: () => null,
}));

function startServer(handler: (req: http.IncomingMessage, res: http.ServerResponse) => void): Promise<{ port: number; close: () => void }> {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      resolve({ port, close: () => server.close() });
    });
  });
}

async function capture(fn: () => Promise<void>): Promise<{ stdout: string }> {
  const logs: string[] = [];
  const logSpy = vi.spyOn(console, 'log').mockImplementation((m: string) => { logs.push(m); });
  await fn();
  logSpy.mockRestore();
  return { stdout: logs.join('\n') };
}

const SESSION = {
  meta: { id: 'session-1', goal: 'export me', runners: ['claude-code'], taskCount: 1, status: 'completed', createdAt: '', updatedAt: '' },
  plan: { pendingTasks: [{ id: 't1', order: 1, title: 'One', status: 'completed' }] },
};

const SESSION_WITH_SUBTASKS = {
  meta: { id: 'session-1', goal: 'export me', runners: ['claude-code'], taskCount: 1, status: 'completed', createdAt: '', updatedAt: '' },
  plan: {
    pendingTasks: [{
      id: 't1', order: 1, title: 'One', status: 'completed',
      subtasks: [
        { id: 't1a', order: 1, title: 'Nested', status: 'completed' },
        { id: 't1b', order: 2, title: 'Second nested', status: 'pending' },
      ],
    }],
  },
};

describe('handleStatus --output', () => {
  it('writes the session JSON to a file and implies --json', async () => {
    const srv = await startServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(SESSION));
    });
    const out = join(mkdtempSync(join(tmpdir(), 'ordewell-status-')), 'plan.json');
    const { handleStatus } = await import('../status');
    const { stdout } = await capture(() =>
      handleStatus(['--session-id', 'session-1', '--output', out], new ApiClient(srv.port)),
    );

    expect(stdout).toContain(`Wrote ${out}`);
    expect(JSON.parse(readFileSync(out, 'utf8'))).toEqual(SESSION);
    srv.close();
  });

  it('still prints JSON to stdout without --output', async () => {
    const srv = await startServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(SESSION));
    });
    const { handleStatus } = await import('../status');
    const { stdout } = await capture(() =>
      handleStatus(['--session-id', 'session-1', '--json'], new ApiClient(srv.port)),
    );
    expect(JSON.parse(stdout)).toEqual(SESSION);
    srv.close();
  });

  it('reads a task\'s usage as its whole spend across attempts, with no wall time', async () => {
    const attempt = (n: number, over: Record<string, unknown>) => ({ attempt: n, runner: 'claude-code', startedAt: '', wallTimeMs: 65_000, totals: {}, ...over });
    const plan = { pendingTasks: [{
      id: 't1', order: 1, type: 'ai', title: 'One', status: 'completed',
      attemptUsage: [
        attempt(1, { totals: { inputTokens: 1000, outputTokens: 100, reportedCost: { USD: 0.5 } }, lastPromptTokens: 90, contextWindow: 100 }),
        attempt(2, { totals: { inputTokens: 500, outputTokens: 50, cachedInputTokens: 200 }, lastPromptTokens: 50, contextWindow: 200 }),
      ],
    }] };
    const srv = await startServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ...SESSION, plan }));
    });
    const { handleStatus } = await import('../status');
    const { stdout } = await capture(() => handleStatus(['--session-id', 'session-1'], new ApiClient(srv.port)));
    const lines = stripAnsi(stdout).split('\n').map((l) => l.trim());
    expect(lines).toContain('Tasks total: 1.5k in · 150 out · 200 cached · $0.50');
    expect(lines).toContain('1.5k in · 150 out · 200 cached · $0.50 · ctx 25%');
    expect(stdout).not.toMatch(/\d+s\b|time unknown/);
    srv.close();
  });

  it('renders subtasks as indented dotted-label lines', async () => {
    const srv = await startServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(SESSION_WITH_SUBTASKS));
    });
    const { handleStatus } = await import('../status');
    const { stdout } = await capture(() =>
      handleStatus(['--session-id', 'session-1'], new ApiClient(srv.port)),
    );
    expect(stdout).toContain('    1.1. ');
    expect(stdout).toContain('Nested');
    expect(stdout).toContain('    1.2. ');
    expect(stdout).toContain('Second nested');
    srv.close();
  });

  // A running session's finished tasks come back in a flat execution log, a
  // finished subtask both on its own and inside its parent.
  it('lists each task once, at its own depth, when finished ones come from the execution log', async () => {
    const fn = { id: 'mul-fn', order: 1, title: 'Add and export mul', status: 'completed' };
    const test = { id: 'mul-test', order: 2, title: 'Test mul', status: 'completed' };
    const executing = {
      meta: SESSION.meta,
      plan: {
        phase: 'executing',
        executionLog: [{ id: 'mul', order: 1, title: 'Add mul', status: 'completed', subtasks: [fn, test] }, fn, { id: 'readme', order: 2, title: 'README check', status: 'completed' }, test],
        pendingTasks: [{ id: 'status', order: 3, title: 'Run git status', status: 'pending' }],
      },
    };
    const srv = await startServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(executing));
    });
    const { handleStatus } = await import('../status');
    const { stdout } = await capture(() =>
      handleStatus(['--session-id', 'session-1'], new ApiClient(srv.port)),
    );
    const rows = stdout.split('\n').filter((line) => /^\s+[\d.]+\. /.test(line)).map((line) => stripAnsi(line).replace(/\[[^\]]*\] /, '').replace(/[✓○✗⟳⊘]/g, '').replace(/\s+/g, ' ').trim());

    expect(rows).toEqual(['1. Add mul', '1.1. Add and export mul', '1.2. Test mul', '2. README check', '3. Run git status']);
    expect(stdout).toContain('Tasks:    5 total  |  4 done');
    srv.close();
  });

  describe('the base branch of an isolated run', () => {
    const isolated = (repos: Array<Record<string, unknown>>) => ({
      meta: SESSION.meta,
      plan: {
        pendingTasks: SESSION.plan.pendingTasks,
        isolation: { resolvers: {}, run: { id: 'r1', workspaceRoot: '/ws', repos, shared: [], sharedRepos: [], tasks: {} } },
      },
    });
    const statusOf = async (session: unknown) => {
      const srv = await startServer((_req, res) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(session));
      });
      const { handleStatus } = await import('../status');
      const { stdout } = await capture(() => handleStatus(['--session-id', 'session-1'], new ApiClient(srv.port)));
      srv.close();
      return stripAnsi(stdout);
    };
    const repo = (path: string, baseRef: string, baseBranch?: string, startedDetached = baseBranch === undefined) => (
      { path, root: `/ws/${path}`, baseRef, integrationBranch: 'ordewell/r1/integration', ...(baseBranch ? { baseBranch } : {}), ...(startedDetached ? { startedDetached: true } : {}) }
    );

    it('names the branch the run started on, and the commit', async () => {
      expect(await statusOf(isolated([repo('.', 'abcdef1234567890', 'main')]))).toContain('Base:     main @ abcdef12\n');
    });

    it('names a record that never noted its branch by the commit alone', async () => {
      expect(await statusOf(isolated([repo('.', 'abcdef1234567890', undefined, false)]))).toContain('Base:     base abcdef12\n');
    });

    it('names each repo of a group, a detached HEAD as that', async () => {
      const out = await statusOf(isolated([repo('api', 'aaaa1111bbbb', 'main'), repo('web', 'cccc2222dddd')]));

      expect(out).toContain('Base:     api: main @ aaaa1111, web: detached at cccc2222\n');
    });

    it('says nothing for a session with no isolation record', async () => {
      expect(await statusOf(SESSION)).not.toContain('Base:');
    });
  });

  it('counts and names the tasks a failure blocks (ADR-0034)', async () => {
    const session = {
      meta: { ...SESSION.meta, status: 'approved' },
      plan: {
        pendingTasks: [
          { id: 't1', order: 1, title: 'One', status: 'failed', dependencies: [] },
          { id: 't2', order: 2, title: 'Two', status: 'pending', dependencies: ['t1'] },
          { id: 't3', order: 3, title: 'Three', status: 'pending', dependencies: ['t2'] },
        ],
      },
    };
    const srv = await startServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(session));
    });
    const { handleStatus } = await import('../status');
    const { stdout } = await capture(() => handleStatus(['--session-id', 'session-1'], new ApiClient(srv.port)));

    expect(stdout).toContain('1 failed  |  0 running  |  2 blocked');
    expect(stripAnsi(stdout).match(/Blocked by #1/g)).toHaveLength(2);
    srv.close();
  });

  it('names a task added after the user approved the plan as waiting for them, from the plan\'s approval record (ADR-0035)', async () => {
    const session = {
      meta: { ...SESSION.meta, status: 'approved' },
      plan: {
        approved: true,
        approvedTasks: ['t1'],
        pendingTasks: [
          { id: 't1', order: 1, title: 'One', type: 'ai', status: 'in_progress', dependencies: [] },
          { id: 't2', order: 2, title: 'Two', type: 'ai', status: 'pending', dependencies: [] },
        ],
      },
    };
    const srv = await startServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(session));
    });
    const { handleStatus } = await import('../status');
    const { stdout } = await capture(() => handleStatus(['--session-id', 'session-1'], new ApiClient(srv.port)));

    const lines = stripAnsi(stdout).split('\n');
    const waiting = lines.filter((l) => l.includes('Waits for your approval'));
    expect(waiting).toEqual(['      Waits for your approval: `ordewell force-start 2` approves it, `ordewell run` approves all']);
    expect(lines[lines.indexOf(waiting[0]) - 1]).toContain('Two');
    srv.close();
  });

  // The flag every surface shows for a task outside the user's scope (ADR-0043).
  it('flags a task on a runner switched off or a model off its allowlist, subtasks too, and never a finished one', async () => {
    const session = {
      meta: { ...SESSION.meta, status: 'approved' },
      plan: {
        pendingTasks: [
          { id: 't1', order: 1, title: 'On codex', type: 'ai', status: 'pending', assignedRunner: 'codex', dependencies: [] },
          { id: 't2', order: 2, title: 'On opus', type: 'ai', status: 'pending', assignedRunner: 'claude-code', assignedModel: { modelId: 'claude-opus-4', modelLabel: 'Opus 4' }, dependencies: [] },
          { id: 't3', order: 3, title: 'Done on codex', type: 'ai', status: 'completed', assignedRunner: 'codex', dependencies: [] },
          {
            id: 't4', order: 4, title: 'Parent', type: 'ai', status: 'pending', assignedRunner: 'claude-code', dependencies: [],
            subtasks: [{ id: 't4a', order: 1, title: 'Child on codex', type: 'ai', status: 'pending', assignedRunner: 'codex', dependencies: [] }],
          },
        ],
      },
    };
    const sonnet = { modelId: 'claude-sonnet-4-5', modelLabel: 'Sonnet 4.5', variants: [] };
    const opus = { modelId: 'claude-opus-4', modelLabel: 'Opus 4', variants: [] };
    const srv = await startServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      const url = req.url ?? '';
      if (url.startsWith('/api/runners')) {
        res.end(JSON.stringify({ runners: [{ id: 'claude-code', name: 'Claude Code', enabled: true }, { id: 'codex', name: 'Codex', enabled: false }], orchestratorModel: '' }));
      } else if (url.startsWith('/api/settings')) {
        res.end(JSON.stringify({ modelAllowlist: { 'claude-code': ['claude-sonnet-4-5'] } }));
      } else if (url.startsWith('/api/models')) {
        res.end(JSON.stringify({ models: [sonnet, opus], modelsByRunner: { 'claude-code': [sonnet, opus] } }));
      } else {
        res.end(JSON.stringify(session));
      }
    });
    const { handleStatus } = await import('../status');
    const { stdout } = await capture(() => handleStatus(['--session-id', 'session-1'], new ApiClient(srv.port)));

    const flags = stripAnsi(stdout).split('\n').filter((l) => l.includes('⚠'));
    expect(flags).toEqual([
      '      ⚠ codex is switched off; it still runs unless moved',
      '      ⚠ Opus 4 is not in the allowlist; it still runs unless moved',
      '        ⚠ codex is switched off; it still runs unless moved',
    ]);
    srv.close();
  });
});
