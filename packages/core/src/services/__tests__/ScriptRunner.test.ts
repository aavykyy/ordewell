import { describe, it, expect, afterEach, vi } from 'vitest';
import { EventEmitter } from 'events';
import type { ChildProcess } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ScriptRunner, type ScriptRunnerDeps, type ScriptSpawnFn } from '../ScriptRunner';
import type { ScriptExit, StructuredEvent } from '../../interfaces/IRunner';
import { DEFAULT_SCRIPT_TIMEOUT_MS, type ScriptBody } from '../../models/ScriptTask';

/**
 * A script task's body as it really runs (ADR-0035): real processes, at a real
 * workspace root, with nothing between the body and its exit status.
 */

const node = process.execPath;
const js = (code: string, ...args: string[]): string[] => [node, '-e', code, ...args];

const workspaces: string[] = [];
afterEach(() => {
  for (const dir of workspaces.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function workspace(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ordewell-script-'));
  workspaces.push(dir);
  return dir;
}

async function start(body: Partial<ScriptBody> & ({ commands: string[][] } | { script: string }), opts: { env?: Record<string, string>; deps?: ScriptRunnerDeps; cwd?: string } = {}) {
  const cwd = opts.cwd ?? workspace();
  const runner = new ScriptRunner(opts.deps);
  const session = await runner.spawn({ taskId: 't1', runner: 'script', prompt: '', cwd, env: opts.env, script: { timeoutMs: DEFAULT_SCRIPT_TIMEOUT_MS, ...body } as ScriptBody });
  const events: StructuredEvent[] = [];
  let output = '';
  session.onEvent((event) => events.push(event));
  session.onOutput((text) => { output += text; });
  const exit = new Promise<ScriptExit>((resolve) => session.onScriptExit(resolve));
  const exited = new Promise<number>((resolve) => session.onExit(resolve));
  return { runner, session, cwd, events, exit, exited, output: () => output };
}

const ofType = <T extends StructuredEvent['type']>(events: StructuredEvent[], type: T) =>
  events.filter((e): e is Extract<StructuredEvent, { type: T }> => e.type === type);

describe('ScriptRunner: commands', () => {
  it('runs every command in order, each as its own argument vector with no shell, and passes when each exits 0', async () => {
    const run = await start({ commands: [js("console.log('one')"), js('console.log(process.argv[1])', '$(echo injected); echo two')] });

    expect(await run.exit).toEqual({ outcome: 'passed' });
    expect(await run.exited).toBe(0);
    // The metacharacters reached the program as one word: nothing joined the vector into a shell line.
    expect(run.output()).toBe('one\n$(echo injected); echo two\n');
    expect(ofType(run.events, 'script_run').map((e) => 'argv' in e && e.argv.slice(1))).toEqual([
      ['-e', "console.log('one')"],
      ['-e', 'console.log(process.argv[1])', '$(echo injected); echo two'],
    ]);
    expect(ofType(run.events, 'script_exit').map((e) => [e.code, e.signal])).toEqual([[0, null], [0, null]]);
  });

  it('stops at the first command that fails, with its status and the end of its error output', async () => {
    const run = await start({
      commands: [
        js("console.log('ok')"),
        js("process.stderr.write('disk full\\n'); process.exit(3)"),
        js("require('fs').writeFileSync('third', 'ran')"),
      ],
    });

    const exit = await run.exit;
    expect(exit).toMatchObject({ outcome: 'failed', status: { code: 3, signal: null }, errorTail: 'disk full\n' });
    expect(exit.outcome === 'failed' && exit.command).toContain("process.exit(3)");
    expect(await run.exited).toBe(1);
    expect(ofType(run.events, 'script_run')).toHaveLength(2);
    expect(fs.existsSync(path.join(run.cwd, 'third'))).toBe(false);
  });

  it('fails a command that cannot start, saying why', async () => {
    const run = await start({ commands: [['ordewell-no-such-program-anywhere', '--version']] });

    const exit = await run.exit;
    expect(exit).toMatchObject({ outcome: 'failed', status: { code: null, signal: null } });
    expect(exit.outcome === 'failed' && exit.status.error).toMatch(/ENOENT/);
  });

  it('runs at the workspace root, with the workspace\'s variables over the host\'s', async () => {
    const run = await start({ commands: [js('console.log(process.cwd()); console.log(process.env.ORDEWELL_TEST_VAR)')] }, { env: { ORDEWELL_TEST_VAR: 'from the workspace' } });

    expect(await run.exit).toEqual({ outcome: 'passed' });
    expect(run.output()).toBe(`${fs.realpathSync(run.cwd)}\nfrom the workspace\n`);
  });

  it('keeps the head and the tail of a long output in its log, and all of it in its output', async () => {
    const run = await start({ commands: [js("process.stdout.write('x'.repeat(100000) + 'END')")] });

    expect(await run.exit).toEqual({ outcome: 'passed' });
    const logged = ofType(run.events, 'script_output');
    const kept = logged.map((e) => e.text).join('');
    expect(kept.length).toBeLessThan(60_000);
    expect(kept.endsWith('END')).toBe(true);
    expect(logged.at(-1)!.omittedChars).toBe(100_003 - kept.length);
    expect(run.output().length).toBe(100_003);
  });
});

describe('ScriptRunner: a script', () => {
  it('runs one script in the research shell and passes when it exits 0', async () => {
    const run = await start({ script: 'echo hello\necho "$ORDEWELL_TEST_VAR"' }, { env: { ORDEWELL_TEST_VAR: 'set' } });

    expect(await run.exit).toEqual({ outcome: 'passed' });
    expect(run.output()).toBe('hello\nset\n');
    expect(ofType(run.events, 'script_run')).toEqual([{ type: 'script_run', script: 'echo hello\necho "$ORDEWELL_TEST_VAR"' }]);
  });

  it('fails when the script exits otherwise, with its status and the end of its error output', async () => {
    const run = await start({ script: 'echo started\necho "no such resource group" >&2\nexit 4' });

    const exit = await run.exit;
    expect(exit).toEqual({ outcome: 'failed', status: { code: 4, signal: null }, errorTail: 'no such resource group\n' });
    expect(ofType(run.events, 'script_exit')).toEqual([expect.objectContaining({ code: 4, signal: null })]);
  });
});

describe('ScriptRunner: ending early', () => {
  it('kills the process tree when the time limit runs out, and fails saying so', async () => {
    const run = await start({ commands: [js('setTimeout(() => {}, 60_000)'), js("require('fs').writeFileSync('after', '')")], timeoutMs: 300 });

    const exit = await run.exit;
    expect(exit).toMatchObject({ outcome: 'timed-out', timeoutMs: 300 });
    expect(ofType(run.events, 'script_exit')).toEqual([expect.objectContaining({ timedOut: true, signal: 'SIGTERM' })]);
    expect(fs.existsSync(path.join(run.cwd, 'after'))).toBe(false);
  }, 15_000);

  it('ends the running command on Stop, runs none after it, and resolves once the session has exited', async () => {
    const run = await start({ commands: [js("console.log('up'); setTimeout(() => {}, 60_000)"), js("require('fs').writeFileSync('after', '')")] });
    await vi.waitFor(() => expect(run.output()).toBe('up\n'));

    await run.runner.stop(run.session.id);

    expect(await run.exit).toMatchObject({ outcome: 'stopped' });
    expect(await run.exited).toBe(1);
    expect(run.runner.activeCount).toBe(0);
    expect(fs.existsSync(path.join(run.cwd, 'after'))).toBe(false);
  }, 15_000);

  it('runs nothing at all when stopped before its first command', async () => {
    const run = await start({ commands: [js("require('fs').writeFileSync('first', '')")] });

    await run.session.stop();

    expect(await run.exit).toMatchObject({ outcome: 'stopped' });
    expect(ofType(run.events, 'script_run')).toEqual([]);
    expect(fs.existsSync(path.join(run.cwd, 'first'))).toBe(false);
  });
});

describe('ScriptRunner: refusals', () => {
  it('runs nothing that is not a script task', async () => {
    await expect(new ScriptRunner().spawn({ taskId: 't1', runner: 'script', prompt: 'do it', cwd: workspace() })).rejects.toThrow(/no script body/);
  });

  it('takes no messages: there is no model to read them', async () => {
    const run = await start({ commands: [js('')] });

    expect(() => run.session.sendMessage('hello')).toThrow(/runs no model/);
    await run.exit;
  });
});

/** A child that exits 0 on the next turn, as a spawned program would. */
function exitingChild(): ChildProcess {
  const child = Object.assign(new EventEmitter(), { stdout: new EventEmitter(), stderr: new EventEmitter(), pid: 4242, exitCode: null as number | null, signalCode: null, killed: false });
  setImmediate(() => {
    child.exitCode = 0;
    child.emit('exit', 0, null);
    child.emit('close', 0, null);
  });
  return child as unknown as ChildProcess;
}

describe('ScriptRunner: on Windows', () => {
  it('finds the program through the launch seam and still runs no shell (ADR-0010)', async () => {
    const spawn = vi.fn<ScriptSpawnFn>(() => exitingChild());
    const run = await start({ commands: [['gh', 'pr', 'list']] }, {
      deps: {
        spawn,
        platform: 'win32',
        resolvePath: async () => 'C:\\tools',
        launch: { exists: (candidate) => candidate === 'C:\\tools\\gh.exe', pathExt: () => '.COM;.EXE;.BAT;.CMD' },
      },
    });

    expect(await run.exit).toEqual({ outcome: 'passed' });
    expect(spawn).toHaveBeenCalledWith('C:\\tools\\gh.exe', ['pr', 'list'], expect.objectContaining({ shell: false, detached: false, cwd: run.cwd }));
  });
});
