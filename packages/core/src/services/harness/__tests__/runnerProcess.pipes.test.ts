import { describe, it, expect, afterEach } from 'vitest';
import { spawn, type ChildProcess } from 'child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { RunnerProcess } from '../runnerProcess';

/**
 * A runner's pipes, held by what it started, against real processes: a
 * descendant that inherits the runner's stdout and stderr keeps them open past
 * the runner's own death, and one that left the runner's process group is out
 * of Stop's reach. Neither may keep the host that drove the runner alive.
 */

const posixIt = process.platform === 'win32' ? it.skip : it;

/** A holder that does nothing but outlive the test's interest in it. */
const IDLE_HOLDER = 'setTimeout(() => {}, 20000)';

/**
 * A runner that starts `holder` holding its stdout and stderr, prints the
 * holder's pid and then `last`, and exits. `detached` puts the holder in a
 * group of its own, where the runner's group signal cannot reach it.
 */
function runnerScript(detached: boolean, { holder = IDLE_HOLDER, last = '' } = {}): string {
  return [
    `const { spawn } = require('node:child_process');`,
    `const holder = spawn(process.execPath, ['-e', ${JSON.stringify(holder)}], { detached: ${detached}, stdio: ['ignore', 1, 2] });`,
    `holder.unref();`,
    `process.stdout.write(holder.pid + '\\n' + ${JSON.stringify(last)}, () => process.exit(0));`,
  ].join('\n');
}

/**
 * A host with nothing of its own to keep it alive: it runs the runner through
 * {@link RunnerProcess}, waits for its end, disposes it, and says so. Loads
 * the TypeScript source through a CommonJS transpiling hook, because the
 * module graph uses what type stripping alone cannot run, and the module
 * hooks API is newer than the Node versions this package supports.
 */
function writeHost(dir: string, detached: boolean): string {
  const host = join(dir, 'host.cjs');
  writeFileSync(host, [
    `const Module = require('node:module');`,
    `const { readFileSync } = require('node:fs');`,
    `const { spawn } = require('node:child_process');`,
    `const source = ${JSON.stringify(join(__dirname, '..', 'runnerProcess.ts'))};`,
    `const ts = Module.createRequire(source)('typescript');`,
    `Module._extensions['.ts'] = (module, filename) => {`,
    `  const { outputText } = ts.transpileModule(readFileSync(filename, 'utf8'), { fileName: filename, compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } });`,
    // A CommonJS module cannot name import.meta; the build points it at the file, as tsup.config.ts says.
    `  module._compile(outputText.replace(/import\\.meta/g, '({ url: require("node:url").pathToFileURL(__filename).href })'), filename);`,
    `};`,
    `(async () => {`,
    `  const { RunnerProcess } = require(source);`,
    `  const runner = new RunnerProcess({`,
    `    spawn: (_command, _args, options) => spawn(process.execPath, ['-e', ${JSON.stringify(runnerScript(detached))}], options),`,
    `    resolvePath: async () => process.env.PATH ?? '/usr/bin',`,
    `    workspaceEnv: async () => ({}),`,
    `    exists: () => true,`,
    `  });`,
    `  await runner.start(process.cwd(), () => ({ command: process.execPath, args: [] }), async () => {`,
    `    runner.readStdout((text) => process.stdout.write('holder ' + text));`,
    `  });`,
    `  await runner.ended;`,
    `  runner.dispose();`,
    `  process.stdout.write('disposed\\n');`,
    `})();`,
  ].join('\n'));
  return host;
}

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

/** Resolves with `proc`'s exit code, or null if it is still running after `ms`. */
function exitWithin(proc: ChildProcess, ms: number): Promise<number | null> {
  if (proc.exitCode !== null) return Promise.resolve(proc.exitCode);
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), ms);
    proc.once('exit', (code) => { clearTimeout(timer); resolve(code); });
  });
}

describe('a host whose runner left its pipes held', () => {
  const cleanups: Array<() => void> = [];
  afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup(); });

  function startHost(detached: boolean): { host: ChildProcess; output: () => string; holder: () => number } {
    const dir = mkdtempSync(join(tmpdir(), 'ordewell-pipes-'));
    const host = spawn(process.execPath, ['--no-warnings', writeHost(dir, detached)], { cwd: dir, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    host.stdout!.on('data', (chunk: Buffer) => { out += chunk.toString(); });
    let err = '';
    host.stderr!.on('data', (chunk: Buffer) => { err += chunk.toString(); });
    const holder = () => Number(/holder (\d+)/.exec(out)?.[1] ?? 0);
    cleanups.push(() => {
      if (holder()) try { process.kill(holder(), 'SIGKILL'); } catch { /* gone */ }
      host.kill('SIGKILL');
      rmSync(dir, { recursive: true, force: true });
    });
    return { host, output: () => `${out}${err}`, holder };
  }

  posixIt('exits on its own, leaving a holder outside the runner\'s group running', async () => {
    const { host, output, holder } = startHost(true);

    expect(await exitWithin(host, 10_000), output()).toBe(0);
    expect(output()).toContain('disposed');
    expect(alive(holder())).toBe(true);
  });

  posixIt('exits on its own once dispose has stopped a holder inside the runner\'s group', async () => {
    const { host, output, holder } = startHost(false);

    expect(await exitWithin(host, 10_000), output()).toBe(0);
    expect(output()).toContain('disposed');
    await expect.poll(() => alive(holder())).toBe(false);
  });
});

describe('a runner\'s output, through its real pipes', () => {
  const cleanups: Array<() => void> = [];
  afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup(); });

  /** Runs `script` as the runner, reading its stdout, with a pid the script prints first treated as a holder to clean up. */
  async function run(script: string): Promise<{ runner: RunnerProcess; child: ChildProcess; text: () => string; ends: () => number; closed: () => boolean }> {
    let child!: ChildProcess;
    const runner = new RunnerProcess({
      spawn: (_command, _args, options) => { child = spawn(process.execPath, ['-e', script], options); return child; },
      fetch: globalThis.fetch,
      resolvePath: async () => process.env.PATH ?? '/usr/bin',
      workspaceEnv: async () => ({}),
      exists: () => true,
    });
    let text = '';
    let ends = 0;
    let closed = false;
    cleanups.push(() => {
      const holder = Number(/^(\d+)\n/.exec(text)?.[1] ?? 0);
      if (holder) try { process.kill(holder, 'SIGKILL'); } catch { /* gone */ }
      runner.dispose();
    });
    await runner.start(tmpdir(), () => ({ command: process.execPath, args: [] }), async (started) => {
      started.on('close', () => { closed = true; });
      runner.readStdout((chunk) => { text += chunk; }, () => { ends++; });
    });
    return { runner, child, text: () => text, ends: () => ends, closed: () => closed };
  }

  it('delivers everything a runner wrote before it exited, ended by the pipes\' own close', async () => {
    const { runner, text, ends, closed } = await run(`process.stdout.write('x'.repeat(1 << 20) + 'last line, unterminated', () => process.exit(0));`);

    await runner.ended;

    expect(closed()).toBe(true);
    expect(text()).toBe(`${'x'.repeat(1 << 20)}last line, unterminated`);
    expect(ends()).toBe(1);
    expect(runner.exit).toEqual({ code: 0, signal: null });
  });

  posixIt('delivers a runner\'s last unterminated line when a holder keeps its pipes from closing', async () => {
    const { runner, text, ends, closed } = await run(runnerScript(true, { last: 'last line, unterminated' }));

    await runner.ended;

    expect(closed()).toBe(false);
    expect(text()).toMatch(/^\d+\nlast line, unterminated$/);
    expect(ends()).toBe(1);
    expect(runner.exitCode).toBe(0);
  });

  // What a holder writes once the runner has ended is not the runner's, but
  // the holder is not the host's to stop: its write must not meet a pipe the
  // host has closed under it.
  posixIt('leaves a holder that writes after the runner ended running, without handing its output on', async () => {
    // Ready on stderr, so nothing but the runner's pid reaches stdout before the signal.
    const holder = `process.on('SIGUSR2', () => process.stdout.write('holder line\\n', () => process.stdout.write('done\\n'))); process.stderr.write('ready\\n'); ${IDLE_HOLDER}`;
    const { runner, child, text } = await run(runnerScript(true, { holder }));
    let stdout = '';
    let stderr = '';
    child.stdout!.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
    child.stderr!.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
    await runner.ended;
    await expect.poll(() => stderr).toContain('ready');
    const holderPid = Number(text().trim());

    process.kill(holderPid, 'SIGUSR2');
    await expect.poll(() => stdout).toContain('done');

    expect(text()).not.toContain('holder line');
    expect(alive(holderPid)).toBe(true);
  });
});
