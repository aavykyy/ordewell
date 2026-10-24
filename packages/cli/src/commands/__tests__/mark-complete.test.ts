import { describe, it, expect, vi } from 'vitest';
import http from 'http';
import { ApiClient } from '../../apiClient';

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

async function capture(fn: () => Promise<void>): Promise<{ stdout: string; stderr: string; exitCode: number | null }> {
  const logs: string[] = [];
  const errs: string[] = [];
  const logSpy = vi.spyOn(console, 'log').mockImplementation((m: string) => { logs.push(m); });
  const errSpy = vi.spyOn(console, 'error').mockImplementation((m: string) => { errs.push(m); });
  const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((_code?: number) => { throw new Error(`exit:${_code}`); }) as never);
  let exitCode: number | null = null;
  try {
    await fn();
  } catch (e: unknown) {
    const m = (e as Error).message || '';
    const match = m.match(/^exit:(\d+)$/);
    if (match) exitCode = parseInt(match[1], 10);
    else throw e;
  }
  logSpy.mockRestore();
  errSpy.mockRestore();
  exitSpy.mockRestore();
  return { stdout: logs.join('\n'), stderr: errs.join('\n'), exitCode };
}

/** A daemon that records what it is asked and answers each control in the seam's words. */
async function daemon(answer: (command: { command: string }) => { status: number; body: unknown }, hits: string[] = []) {
  return startServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const sent = Buffer.concat(chunks).toString('utf8');
      hits.push(`${req.method} ${req.url} ${sent}`);
      const { status, body } = answer(sent ? JSON.parse(sent) : { command: '' });
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(body));
    });
  });
}

describe('handleMarkComplete', () => {
  it('sends the task as typed, for the seam to resolve, and prints the seam\'s line', async () => {
    const hits: string[] = [];
    const srv = await daemon(() => ({ status: 200, body: { ok: true, message: 'Marked task #2 "Second" complete.' } }), hits);
    const api = new ApiClient(srv.port);
    const { handleMarkComplete } = await import('../mark-complete');

    const { stdout } = await capture(() => handleMarkComplete(['--session-id', 'session-1', '2'], api));

    expect(hits).toEqual(['POST /api/plans/session-1/execute-command {"command":"mark_complete","task":"2"}']);
    expect(stdout).toBe('Marked task #2 "Second" complete.');
    srv.close();
  });

  it('keeps a title or an order with a hash intact in the command', async () => {
    const hits: string[] = [];
    const srv = await daemon(() => ({ status: 200, body: { ok: true, message: 'ok' } }), hits);
    const { handleMarkComplete } = await import('../mark-complete');

    await capture(() => handleMarkComplete(['--session-id', 'session-1', '#2.1'], new ApiClient(srv.port)));

    expect(hits).toEqual(['POST /api/plans/session-1/execute-command {"command":"mark_complete","task":"#2.1"}']);
    srv.close();
  });

  it('reports the seam\'s refusal when the task is not in the plan', async () => {
    const srv = await daemon(() => ({ status: 400, body: { error: 'There is no task "99" in this plan.', code: 'refused' } }));
    const { handleMarkComplete } = await import('../mark-complete');

    const { stderr, exitCode } = await capture(() => handleMarkComplete(['--session-id', 'session-1', '99'], new ApiClient(srv.port)));

    expect(stderr).toContain('Failed to mark task complete: There is no task "99" in this plan.');
    expect(exitCode).toBe(1);
    srv.close();
  });
});

describe('handleUncomplete and handleSkip', () => {
  it('print the seam\'s lines for Mark not done and Skip', async () => {
    const hits: string[] = [];
    const srv = await daemon(({ command }) => ({ status: 200, body: { ok: true, message: command === 'skip_task' ? 'Skipped task #2.' : 'Marked task #2 not done.' } }), hits);
    const mod = await import('../mark-complete');
    const api = new ApiClient(srv.port);

    const undone = await capture(() => mod.handleUncomplete(['--session-id', 'session-1', '2'], api));
    const skipped = await capture(() => mod.handleSkip(['--session-id', 'session-1', '2', '--reason', 'not needed'], api));

    expect(hits).toEqual([
      'POST /api/plans/session-1/execute-command {"command":"mark_not_done","task":"2"}',
      'POST /api/plans/session-1/execute-command {"command":"skip_task","task":"2","reason":"not needed"}',
    ]);
    expect(undone.stdout).toBe('Marked task #2 not done.');
    expect(skipped.stdout).toBe('Skipped task #2.');
    srv.close();
  });
});
