import { describe, it, expect, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createTask } from '../../models/Task';
import type { IRunner } from '../../interfaces/IRunner';
import { openTaskLog } from '../../utils/taskLogStore';
import { makeSession, FakeRunnerSession, taskOf } from './sessionTestKit';

describe('a loop handoff through Session and the attempt logs (ADR-0047)', () => {
  it('reads its own last attempt in full before opening the next attempt log', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ordewell-loop-handoff-'));
    const agents: FakeRunnerSession[] = [];
    const spawn = vi.fn(async (opts: Parameters<IRunner['spawn']>[0]) => {
      const agent = new FakeRunnerSession(`s${agents.length + 1}`, opts.taskId);
      agents.push(agent);
      return agent;
    });
    const session = makeSession({ workspaceRoot: () => root, openTaskLog, runner: { spawn, stop: vi.fn(), stopAll: vi.fn(), activeCount: 0 } });
    try {
      session.loadPlan({
        tasks: [
          createTask({ id: 'check', order: 1, title: 'Check', prompt: 'Review.', loop: { body: ['fix'], maxRounds: 3 } }),
          createTask({ id: 'fix', order: 2, title: 'Fix', prompt: 'Fix.', dependencies: ['check'] }),
        ],
        generatedAt: '2026-10-22T00:00:00Z', lastUpdated: '2026-10-22T00:00:00Z', status: 'approved', runners: ['claude-code'],
      }, 'Review and fix', root);
      await session.execute({ command: 'run_plan' }, { kind: 'user' });
      await vi.waitFor(() => expect(agents).toHaveLength(1));
      agents[0].reportComplete({ status: 'failed', summary: 'Many holes.', findings: Array.from({ length: 26 }, (_, i) => ({ severity: 'major', title: `Hole ${i + 1}` })), report: 'The long report stays out.' });
      await vi.waitFor(() => expect(agents).toHaveLength(2));
      expect(taskOf(session, 'check')?.handoff?.findings).toHaveLength(25);
      agents[1].reportComplete({ status: 'done', summary: 'Closed all holes.' });
      await vi.waitFor(() => expect(agents).toHaveLength(3));

      const prompt = spawn.mock.calls[2][0].prompt!;
      expect(prompt).toContain('F26 [major] Hole 26');
      expect(prompt).toContain('Closed all holes.');
      expect(prompt).not.toContain('The long report stays out.');
      agents[2].reportComplete({ status: 'done', summary: 'Verified.' });
      await vi.waitFor(() => expect(taskOf(session, 'check')?.status).toBe('completed'));
    } finally {
      session.destroy();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
