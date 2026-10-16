import { describe, it, expect, vi } from 'vitest';
import type { ApiClient } from '../../apiClient';
import { handleRun } from '../run';

type Event = Parameters<Parameters<ApiClient['streamExecution']>[1]>[0];

describe('ordewell run while a task waits for the user\'s approval (ADR-0035)', () => {
  it('says so on the task\'s line, with the command that approves and starts it', async () => {
    const script: Event[] = [
      { type: 'status_update', tasks: [
        { id: 'task-0001', status: 'in_progress', verdict: null },
        { id: 'task-0002', status: 'pending', verdict: null, waitsForApproval: true },
      ] },
      { type: 'execution_complete', summary: { total: 2, completed: 1, failed: 0, blocked: 0, skipped: 0 } },
    ];
    const api = {
      streamExecution: vi.fn((_id: string, onEvent: (e: Event) => void, onReady?: (error?: Error) => void) => new Promise<void>((resolve) => {
        setTimeout(() => onReady?.(), 0);
        setTimeout(() => { script.forEach(onEvent); resolve(); }, 5);
      })),
      executePlan: vi.fn().mockResolvedValue({ status: 'running' }),
    } as unknown as ApiClient;
    const written: string[] = [];
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation((chunk: string | Uint8Array) => { written.push(String(chunk)); return true; });
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});

    try {
      await handleRun(['--session-id', 's1'], api);
    } finally {
      stderr.mockRestore();
      log.mockRestore();
    }

    const out = written.join('');
    expect(out).toContain('#0002 pending: waiting for your approval to start: `ordewell run-task <id>` starts it');
    expect(out).not.toMatch(/#0001 [^\n]*approval/);
  });
});
