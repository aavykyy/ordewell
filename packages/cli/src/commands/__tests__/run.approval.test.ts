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
    expect(out).toContain('#0002 pending: waits for your approval: `ordewell force-start <id>` approves it, `ordewell run` approves all');
    expect(out).not.toMatch(/#0001 [^\n]*approval/);
  });

  it('tags a script task\'s line [SCR] once it starts (ADR-0035)', async () => {
    const script: Event[] = [
      { type: 'task_started', taskId: 'task-0002', order: 2, title: 'Push the tag', runner: 'script' },
      { type: 'status_update', tasks: [
        { id: 'task-0001', status: 'completed', verdict: null },
        { id: 'task-0002', status: 'in_progress', verdict: null },
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
    expect(out).toMatch(/#0002 \[SCR\] in_progress/);
    expect(out).not.toMatch(/#0001 \[SCR\]/);
  });
});

describe('ordewell run on a loop (ADR-0045)', () => {
  const found = { outcome: 'fail' as const, reason: 'two tests fail', checks: [], reported: 'failed' as const };
  const loop = { body: ['task-0002'], maxRounds: 3 };

  async function follow(script: Event[]): Promise<string> {
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
    return written.join('');
  }

  it('says the check\'s round while it runs, and its body\'s check before it does', async () => {
    const out = await follow([
      { type: 'status_update', tasks: [
        { id: 'task-0001', status: 'in_progress', verdict: null, loop, loopRound: 2 },
        { id: 'task-0002', status: 'pending', verdict: null },
      ] },
      { type: 'execution_complete', summary: { total: 2, completed: 0, failed: 0, blocked: 0, skipped: 0 } },
    ]);

    expect(out).toContain('#0001 in_progress · ↻ round 2 of 3');
    expect(out).toContain('#0002 pending · ↻ runs if #0001 fails');
  });

  it('shows a check between rounds as fixing, not as failed, with the round its body fixes', async () => {
    const out = await follow([
      { type: 'status_update', tasks: [
        { id: 'task-0001', status: 'failed', verdict: found, loop },
        { id: 'task-0002', status: 'in_progress', verdict: null },
      ] },
      { type: 'execution_complete', summary: { total: 2, completed: 0, failed: 0, blocked: 0, skipped: 0 } },
    ]);

    expect(out).toContain('#0001 failed: FAIL: two tests fail · ↻ round 1 of 3: fixing');
    expect(out).toContain('#0002 in_progress · ↻ runs if #0001 fails (round 1 of 3)');
    expect(out).not.toContain('\x1b[31m');
  });

  it('says how many rounds a check failed after, once its loop ran out', async () => {
    const out = await follow([
      { type: 'status_update', tasks: [
        { id: 'task-0001', status: 'failed', verdict: found, loop, loopRound: 3 },
        { id: 'task-0002', status: 'skipped', verdict: null },
      ] },
      { type: 'execution_complete', summary: { total: 2, completed: 0, failed: 1, blocked: 0, skipped: 1 } },
    ]);

    expect(out).toContain('#0001 failed: FAIL: two tests fail · ↻ failed after 3 rounds');
  });
});

