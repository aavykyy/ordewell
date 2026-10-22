import { describe, it, expect, vi, afterEach } from 'vitest';
import type { ApiClient } from '../../apiClient';
import { handleApprove } from '../approve';
import { handleRun } from '../run';
import { handleStop } from '../stop';

/**
 * Stop, Execute and Approve say what the daemon's command seam said of them
 * (ADR-0029), so the CLI words a control as the TUI and VS Code do.
 */

type Event = Parameters<Parameters<ApiClient['streamExecution']>[1]>[0];

const complete: Event = { type: 'execution_complete', summary: { total: 1, completed: 1, failed: 0, blocked: 0, skipped: 0 } };

function streaming(extra: Partial<ApiClient>): ApiClient {
  return {
    getSession: vi.fn().mockResolvedValue({ meta: {}, plan: { pendingTasks: [] } }),
    streamExecution: vi.fn((_id: string, onEvent: (e: Event) => void, onReady?: (error?: Error) => void) => new Promise<void>((resolve) => {
      setTimeout(() => onReady?.(), 0);
      setTimeout(() => { onEvent(complete); resolve(); }, 5);
    })),
    ...extra,
  } as unknown as ApiClient;
}

function capture() {
  const out: string[] = [];
  const err: string[] = [];
  vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => { out.push(args.join(' ')); });
  vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => { err.push(args.join(' ')); });
  vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  return { out, err };
}

afterEach(() => { vi.restoreAllMocks(); });

describe('the CLI words Stop, Execute and Approve as the seam does', () => {
  it('prints the line the daemon answered a Stop with, and its own only for a daemon that sent none', async () => {
    const said = capture();
    const stopExecution = vi.fn()
      .mockResolvedValueOnce({ status: 'stopped', message: 'Nothing is running: there is nothing to stop.' })
      .mockResolvedValueOnce({ status: 'stopped' });
    const api = { stopExecution } as unknown as ApiClient;

    await handleStop(['--session-id', 's1'], api);
    await handleStop(['--session-id', 's1'], api);

    expect(said.out).toEqual(['Nothing is running: there is nothing to stop.', 'Execution stopped.']);
  });

  it('says what the seam said of the plan it started', async () => {
    const said = capture();
    const api = streaming({ executePlan: vi.fn().mockResolvedValue({ status: 'running', message: 'The plan is running: #1 "Build" started.' }) });

    await handleRun(['--session-id', 's1'], api);

    expect(said.err).toContain('The plan is running: #1 "Build" started.');
  });

  it('says what the seam said of the review it approved', async () => {
    const said = capture();
    const api = streaming({ approveReview: vi.fn().mockResolvedValue({ plan: {}, message: 'Approved the plan: it runs, each task starting once its dependencies finish.' }) });

    await handleApprove(['--session-id', 's1'], api);

    expect(said.err).toContain('Approved the plan: it runs, each task starting once its dependencies finish.');
    expect(said.err).not.toContain('Plan approved: continuing execution.');
  });
});
