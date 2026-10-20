import { describe, it, expect, vi, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { TaskLogRecorder } from '../TaskLogRecorder';
import { ScriptRunner } from '../ScriptRunner';
import { renderTaskLog, TASK_LOG_KINDS } from '../taskLogRead';
import { EMPTY_TASK_LOG, reduceTaskLog } from '../../conversation/taskLog';
import { coalesceTaskLog, digestTaskLog, type TaskLogEvent } from '../../models/TaskLog';
import type { TaskLogFile } from '../../utils/taskLogStore';
import type { SessionMessage } from '../SessionMessage';

/**
 * A script task's log (ADR-0035): each command as it ran, what it printed and
 * how it ended, saved as any attempt's is and read back the way `task_output`
 * reads it.
 */

const node = process.execPath;
const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

async function recorded(commands: string[][]): Promise<{ saved: TaskLogEvent[]; sent: SessionMessage[] }> {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'ordewell-script-log-'));
  dirs.push(cwd);
  const saved: TaskLogEvent[] = [];
  const file: TaskLogFile = { attempt: 1, append: (events) => { saved.push(...events); } };
  const sent: SessionMessage[] = [];
  const recorder = new TaskLogRecorder({ broadcast: (m) => sent.push(m), location: () => ({ baseDir: cwd, sessionId: 'sess' }), open: () => file });
  await recorder.wrap(new ScriptRunner()).spawn({ taskId: 't1', runner: 'script', prompt: '', cwd, attempt: 1, script: { commands, timeoutMs: 60_000 } });
  await vi.waitFor(() => expect(saved.at(-1)).toEqual({ type: 'runner_ended' }));
  return { saved, sent };
}

describe('a script task\'s log', () => {
  it('records each command as it ran, its output and its exit status, saved as it streamed', async () => {
    const { saved, sent } = await recorded([
      [node, '-e', "console.log('pushed')"],
      [node, '-e', "console.error('rejected'); process.exit(3)"],
    ]);

    expect(saved.map((e) => e.type)).toEqual(['script_run', 'script_output', 'script_exit', 'script_run', 'script_output', 'script_exit', 'runner_ended']);
    expect(saved[0]).toEqual({ type: 'script_run', argv: [node, '-e', "console.log('pushed')"] });
    expect(saved[1]).toEqual({ type: 'script_output', text: 'pushed\n' });
    expect(saved[2]).toMatchObject({ type: 'script_exit', code: 0, signal: null, durationMs: expect.any(Number) });
    expect(saved[5]).toMatchObject({ type: 'script_exit', code: 3, signal: null });
    expect(sent.flatMap((m) => (m.type === 'task_log' ? m.events : []))).toEqual(saved);
  });

  it('reads back through task_output\'s reader, whole or by kind', async () => {
    const { saved } = await recorded([[node, '-e', "console.log('pushed')"]]);

    const text = renderTaskLog(saved);
    expect(text).toContain(`[1 script_run] $ ${node} -e 'console.log('\\''pushed'\\'')'\n`);
    expect(text).toContain('[2 script_output] pushed\n');
    expect(text).toMatch(/\[3 script_exit\] exited 0 after \d+(\.\d)? s\n/);
    expect(renderTaskLog(saved, ['script_exit'])).toMatch(/^\[3 script_exit\] exited 0 after/);
    expect(TASK_LOG_KINDS).toEqual(expect.arrayContaining(['script_run', 'script_output', 'script_exit']));
  });

  it('says what ended a step, and what left its output out', () => {
    const events: TaskLogEvent[] = [
      { type: 'script_run', script: 'deploy.sh --prod\nwait' },
      { type: 'script_output', text: 'tail of it', omittedChars: 1200 },
      { type: 'script_exit', code: null, signal: 'SIGTERM', durationMs: 600_000, timedOut: true },
    ];

    expect(renderTaskLog(events)).toBe([
      '[1 script_run] script:\ndeploy.sh --prod\nwait\n',
      '[2 script_output] … 1200 characters omitted …\ntail of it\n',
      '[3 script_exit] ended by SIGTERM after 600 s: the time limit ran out\n',
    ].join(''));
    expect(digestTaskLog(events, 10)).toBe('- deploy.sh --prod … (2 lines) → ended by SIGTERM after 600 s: the time limit ran out');
  });

  it('draws each step as a row its output fills and its exit settles', () => {
    const events: TaskLogEvent[] = [
      { type: 'script_run', argv: ['git', 'push', 'origin', 'main'] },
      { type: 'script_output', text: 'Everything up-to-date\n' },
      { type: 'script_exit', code: 0, signal: null, durationMs: 1200 },
      { type: 'script_run', argv: ['git', 'push', '--tags'] },
      { type: 'script_output', text: 'denied\n' },
      { type: 'script_exit', code: 128, signal: null, durationMs: 300 },
      { type: 'runner_ended' },
    ];

    const view = events.reduce(reduceTaskLog, EMPTY_TASK_LOG);

    expect(view.working).toBe(false);
    expect(view.blocks).toEqual([
      expect.objectContaining({ type: 'tool', headline: { name: 'Run', keyArg: 'git push origin main' }, status: 'ok', output: 'Everything up-to-date\nexited 0 after 1.2 s' }),
      expect.objectContaining({ type: 'tool', headline: { name: 'Run', keyArg: 'git push --tags' }, status: 'error', output: 'denied\nexited 128 after 0.3 s' }),
    ]);
  });

  it('merges a step\'s output into one entry per batch, as text deltas are', () => {
    expect(coalesceTaskLog([
      { type: 'script_output', text: 'a' },
      { type: 'script_output', text: 'b' },
      { type: 'script_exit', code: 0, signal: null, durationMs: 1 },
    ])).toEqual([{ type: 'script_output', text: 'ab' }, { type: 'script_exit', code: 0, signal: null, durationMs: 1 }]);
  });
});
