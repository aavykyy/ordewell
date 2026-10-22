import { execFile, spawnSync } from 'node:child_process';
import { existsSync, lstatSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:net';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { PlannerShellSandbox, resolvePlannerSandbox, TASK_SEALED_LIMITS } from '../plannerSandbox';
import { BaseFileSystem } from '../../BaseFileSystem';
import { ApprovalPolicy } from '../../ApprovalPolicy';
import { ranSealed } from '../../researchStepSummary';
import type { ResearchShell, ShellLaunch } from '../../researchShell';
import type { ToolOutcome } from '../../../interfaces/IFileSystem';

/**
 * Sealed runs on this host (ADR-0036 S1): Seatbelt on macOS, bubblewrap on
 * Linux. Where the probe fails (no sandbox, or one that cannot start a sealed
 * run) the whole file skips and its title says why, so a green run never
 * claims a sealed run it did not exercise.
 */

const POSIX: ResearchShell = { file: null, args: [], dialect: 'posix', utilsDir: null };

function run(launch: ShellLaunch, command: string, cwd: string): Promise<{ code: number; out: string; ms: number }> {
  const started = Date.now();
  return new Promise((resolve) => {
    execFile(launch.file ?? '/bin/sh', [...launch.args, command], {
      cwd, env: launch.env, timeout: launch.wallTimeMs ?? 60_000, killSignal: 'SIGKILL', encoding: 'utf8',
    }, (err, stdout, stderr) => {
      const code = !err ? 0 : typeof (err as { code?: unknown }).code === 'number' ? (err as { code: number }).code : 1;
      resolve({ code, out: `${stdout}${stderr}`, ms: Date.now() - started });
    });
  });
}

function works(command: string, args: string[]): boolean {
  return spawnSync(command, args, { stdio: 'ignore' }).status === 0;
}

/** The planner's shell as the adapters run it, against a real workspace. */
class HostFileSystem extends BaseFileSystem {
  runs = 0;

  constructor(private readonly root: string, sandbox: PlannerShellSandbox) {
    super(undefined, sandbox);
  }

  getWorkspaceRoot(): string { return this.root; }
  protected async readFileImpl(): Promise<ToolOutcome> { throw new Error('not used'); }
  protected async globImpl(): Promise<ToolOutcome> { throw new Error('not used'); }
  protected async grepImpl(): Promise<ToolOutcome> { throw new Error('not used'); }
  protected async listDirImpl(): Promise<ToolOutcome> { throw new Error('not used'); }

  protected async execBashImpl(command: string, shell: ShellLaunch, _signal: AbortSignal | undefined, cwd: string): Promise<ToolOutcome> {
    this.runs += 1;
    const { code, out } = await run(shell, command, cwd);
    return { success: code === 0, output: code === 0 ? out : `Command exited ${code}:\n${out}`, truncated: false };
  }
}

/**
 * CI sets this on a host that is meant to run the sandbox, so a probe that
 * fails there fails the suite: a green run must mean the real sealed run
 * happened, not that every test skipped again.
 */
const REQUIRE_SANDBOX = process.env.ORDEWELL_REQUIRE_SANDBOX === '1';

// The probe is asynchronous and the skip is decided when the suite is collected, so the outer suite awaits it.
describe('sealed runs', async () => {
  const availability = await resolvePlannerSandbox();
  const reason = !availability.available ? availability.notice : !availability.sealed.available ? availability.sealed.notice : undefined;
  const title = !reason && availability.available
    ? `on this host (${availability.backend.name})`
    : `${REQUIRE_SANDBOX ? 'required' : 'skipped'}: ${(reason ?? '').split('\n')[0]}`;

  describe.skipIf(reason !== undefined && !REQUIRE_SANDBOX)(title, () => {
    if (reason !== undefined) {
      it('has a sealed run on this host (ORDEWELL_REQUIRE_SANDBOX=1)', () => {
        throw new Error(reason);
      });
      return;
    }

    let workspace: string;
    let elsewhere: string;
    const sandbox = new PlannerShellSandbox();

    const sealed = async (command: string) => run(await sandbox.launchSealed(POSIX, { workspace }), command, workspace);

    beforeAll(() => {
      workspace = realpathSync(mkdtempSync(join(tmpdir(), 'ordewell-sealed-ws-')));
      writeFileSync(join(workspace, 'a.md'), 'one\ntwo\n');
      writeFileSync(join(workspace, 'b.md'), 'three\n');
      // Another repository on the same disk, which a sealed run must not see.
      elsewhere = realpathSync(mkdtempSync(join(tmpdir(), 'ordewell-sealed-other-')));
      writeFileSync(join(elsewhere, 'secret.txt'), 'other-repo-secret\n');
      spawnSync('git', ['init', '-q'], { cwd: elsewhere });
    });

    afterAll(() => {
      sandbox.end();
      rmSync(workspace, { recursive: true, force: true });
      rmSync(elsewhere, { recursive: true, force: true });
    });

    it('runs a for loop, a here-document and a pipeline over the workspace', async () => {
      const loop = await sealed('for f in *.md; do printf "%s %s\\n" "$f" "$(wc -l < "$f" | tr -d " ")"; done');
      expect(loop).toMatchObject({ code: 0, out: 'a.md 2\nb.md 1\n' });
      const heredoc = await sealed('cat <<EOF\nheredoc-ok\nEOF');
      expect(heredoc).toMatchObject({ code: 0, out: 'heredoc-ok\n' });
      expect((await sealed('cat a.md b.md | sort | head -1')).out).toBe('one\n');
    });

    it.skipIf(!works('python3', ['-c', 'pass']))('runs inline code for an interpreter', async () => {
      const result = await sealed('python3 -c "import sys; print(sum(range(10)), sys.prefix != \'\')"');
      expect(result.out).toContain('45 True');
      expect(result.code).toBe(0);
    });

    it('keeps an intermediate file in $TMPDIR, which is also $HOME, for a later run of the session', async () => {
      expect((await sealed('ls | sort > "$TMPDIR/files" && [ "$HOME" = "$TMPDIR" ] && echo same')).out).toBe('same\n');
      expect((await sealed('cat "$HOME/files"')).out).toBe('a.md\nb.md\n');
    });

    it('cannot change the workspace', async () => {
      const result = await sealed('echo written > a.md; touch new.md; ls new.md');
      // A throwaway overlay takes the write and drops it when the run ends; read-only refuses it.
      const overlaid = availability.available && availability.sealed.available && (availability.sealed.profile({ workspace }).throwaway?.length ?? 0) > 0;
      if (!overlaid) expect(result.code).not.toBe(0);
      expect(existsSync(join(workspace, 'new.md'))).toBe(false);
      expect((await sealed('cat a.md')).out).toBe('one\ntwo\n');
    });

    it("cannot read a file in the user's home directory", async () => {
      // A name of its own, so the check never touches a file the user has there.
      const inHome = join(homedir(), `.ordewell-sealed-check-${process.pid}`);
      writeFileSync(inHome, 'home-secret\n');
      try {
        const result = await sealed(`cat '${inHome}'; ls -a '${homedir()}'`);
        expect(result.out).not.toContain('home-secret');
        // Named in the errors, never listed.
        expect(result.out.split('\n')).not.toContain(`.ordewell-sealed-check-${process.pid}`);
        expect(result.code).not.toBe(0);
      } finally {
        rmSync(inHome, { force: true });
      }
    });

    it('cannot read another repository', async () => {
      const result = await sealed(`cat '${join(elsewhere, 'secret.txt')}'; ls '${elsewhere}'; git -C '${elsewhere}' status`);
      expect(result.out).not.toContain('other-repo-secret');
      expect(result.out.split('\n')).not.toContain('secret.txt');
      expect(result.code).not.toBe(0);
    });

    it('keeps none of the credentials in the environment it was started from', async () => {
      process.env.ORDEWELL_SEALED_CHECK_TOKEN = 'token-value';
      try {
        expect((await sealed('env')).out).not.toContain('token-value');
      } finally {
        delete process.env.ORDEWELL_SEALED_CHECK_TOKEN;
      }
    });

    describe('the network', () => {
      let server: Server;
      let port: number;

      beforeAll(async () => {
        server = createServer((socket) => socket.end());
        await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
        port = (server.address() as { port: number }).port;
        writeFileSync(join(workspace, 'connect.js'),
          "const s = require('net').connect(Number(process.argv[2]), '127.0.0.1');\n"
          + "s.on('connect', () => process.exit(0)); s.on('error', () => process.exit(3));\n"
          + 'setTimeout(() => process.exit(4), 5000);\n');
      });

      afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

      it('is out of reach, even on the loopback', async () => {
        // The test's own Node may live in the user's home, which a sealed run cannot read, so its exit is all that matters.
        expect((await sealed(`'${process.execPath}' connect.js ${port}`)).code).not.toBe(0);
        if (works('python3', ['-c', 'pass'])) {
          const python = await sealed(`python3 -c "import socket; socket.create_connection(('127.0.0.1', ${port}), 3)"`);
          expect(python.code).not.toBe(0);
        }
      });
    });

    it('stops a fork bomb at its process limit, and leaves none of it behind', async () => {
      const marker = `ordewell_bomb_${process.pid}`;
      const result = await sealed(`echo "group=$$"; ${marker}() { ${marker} | ${marker} & }; ${marker}; sleep 2; echo survived`);
      expect(result.out).toMatch(/fork|Resource temporarily unavailable|Cannot fork/i);
      expect(result.out).toContain('survived');
      expect(result.ms).toBeLessThan(30_000);
      // Its processes went with the run, once a loaded machine has finished
      // tearing them down. Counted by process group: a bomb's forks are named
      // `(bash)` or `<defunct>` while they come and go, never by the marker.
      const group = /group=\s*(\d+)/.exec(result.out)?.[1];
      expect(group).toBeDefined();
      const left = () => spawnSync('ps', ['-A', '-o', 'pgid='], { encoding: 'utf8' }).stdout.split('\n').filter((line) => line.trim() === group);
      await vi.waitFor(() => expect(left()).toEqual([]), { timeout: 20_000, interval: 500 });
    });

    it('backgrounds a job without a stray "Killed" line, keeping the foreground exit code', async () => {
      // The process-group reaper must not let monitor mode print its own kill
      // into the command's output, which reads as a crash (fail-visibly).
      const result = await sealed('sleep 0.1 & echo hi');
      expect(result.out).toContain('hi');
      expect(result.out).not.toMatch(/Killed/);
      expect(result.code).toBe(0);
    });

    it.skipIf(process.platform !== 'darwin')('cannot load a launchd job through the inherited bootstrap port', async () => {
      // launchd would run the job outside the sandbox, as the user; (deny
      // job-creation) refuses it. A read-only probe, cleaned up either way.
      const label = `com.ordewell.sealed-test.${process.pid}`;
      try {
        const result = await sealed(`launchctl submit -l '${label}' -- /usr/bin/true`);
        expect(result.code).not.toBe(0);
        // Nothing loaded: printing the job from outside fails too.
        expect(spawnSync('launchctl', ['print', `gui/${process.getuid?.() ?? 0}/${label}`]).status).not.toBe(0);
      } finally {
        spawnSync('launchctl', ['remove', label]);
      }
    });

    describe('through the planner shell', () => {
      it('runs a refused loop sealed, and says so first', async () => {
        const fs = new HostFileSystem(workspace, sandbox);
        const outcome = await fs.bash('for f in *.md; do echo "$f"; done');
        expect(outcome.output).toMatch(/^\[Ran sealed instead of being refused: /);
        expect(outcome.output).toContain('a.md\nb.md');
      });

      it('still refuses a command an exclusion names', async () => {
        const fs = new HostFileSystem(workspace, sandbox);
        fs.setApproval(new ApprovalPolicy({ mode: 'deny', preApproved: ['!python3'] }));
        const outcome = await fs.bash('for f in *.md; do python3 -c "print(1)"; done');
        expect(outcome.output).toMatch(/^Command refused: the planner allowlist excludes it \("!python3"\)/);
        expect(fs.runs).toBe(0);
      });

      it('never runs sealed a command the user denied', async () => {
        const fs = new HostFileSystem(workspace, sandbox);
        fs.setApproval(new ApprovalPolicy({ ask: async () => false }));
        expect((await fs.bash('npm test')).output).toContain('Command not approved: npm test');
        expect((await fs.bash('npm test', undefined, { sealed: true })).output).toContain('The user denied it this session');
        expect(fs.runs).toBe(0);
        expect(readdirSync(workspace)).not.toContain('node_modules');
      });

      it('still refuses a denied command when a loop wraps it (S3)', async () => {
        const fs = new HostFileSystem(workspace, sandbox);
        let asks = 0;
        fs.setApproval(new ApprovalPolicy({ ask: async () => { asks += 1; return false; } }));
        expect((await fs.bash('npm test')).output).toContain('Command not approved: npm test');
        // The classifier refuses the loop unread; without the inner-scope check
        // it would run `npm test` sealed, routing around the denial.
        const wrapped = await fs.bash('for f in *.md; do npm test; done');
        expect(wrapped.output).toContain('The user denied "npm test" this session');
        expect(fs.runs).toBe(0);
        expect(asks).toBe(1);
      });
    });

    describe("through a read-only task's shell (ADR-0046)", () => {
      let repo: string;
      let worktree: string;
      const git = (cwd: string, ...args: string[]) => spawnSync('git', args, { cwd, encoding: 'utf8' });

      beforeAll(() => {
        repo = realpathSync(mkdtempSync(join(tmpdir(), 'ordewell-sealed-repo-')));
        writeFileSync(join(repo, 'a.md'), 'one\n');
        git(repo, 'init', '-q');
        git(repo, 'add', 'a.md');
        git(repo, '-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', 'commit', '-qm', 'base');
        worktree = join(repo, '.ordewell', 'worktrees', 'run', '1-review');
        git(repo, 'worktree', 'add', '-q', '-b', 'ordewell/run/1-review', worktree);
      });

      afterAll(() => {
        rmSync(repo, { recursive: true, force: true });
      });

      it('takes the task-sized time limit a read-only task gives its sealed runs', async () => {
        const launch = await sandbox.launchSealed(POSIX, { workspace: repo, limits: TASK_SEALED_LIMITS });
        expect(launch.wallTimeMs).toBe(TASK_SEALED_LIMITS.wallTimeMs);
      });

      it('writes its own worktree, sealed, and nothing of the checkout it was cut from', async () => {
        const fs = new HostFileSystem(repo, sandbox);
        const shell = fs.taskShell({ cwd: worktree, writable: worktree });
        try {
          const tried = await shell.run('echo fixed > a.md && printf "test\\n" > added.test && cat a.md added.test');
          expect(tried.output).toMatch(/^\[Ran sealed instead of being refused: /);
          expect(tried.output).toContain('fixed\ntest');
          expect(existsSync(join(worktree, 'added.test'))).toBe(true);

          const escaped = await shell.run(`echo changed > '${join(repo, 'a.md')}'`);
          expect(escaped.success).toBe(false);
          expect(readFileSync(join(repo, 'a.md'), 'utf8')).toBe('one\n');
        } finally {
          shell.end();
        }
      });

      it('leaves no link out of its worktree for a later command, or a native read tool, to follow', async () => {
        const fs = new HostFileSystem(repo, sandbox);
        const shell = fs.taskShell({ cwd: worktree, writable: worktree });
        try {
          await shell.run(`ln -s '${elsewhere}' leak`);
          const read = await shell.run('cat leak/secret.txt');
          expect(read.output).not.toContain('other-repo-secret');
          expect(() => lstatSync(join(worktree, 'leak'))).toThrow();

          // Seatbelt refuses a link made or moved into the worktree, but not a
          // directory moved in that holds one, so the walk runs on macOS too.
          await shell.run(`mkdir "$TMPDIR/d" && ln -s '${elsewhere}' "$TMPDIR/d/leak" && mv "$TMPDIR/d" moved`);
          expect(existsSync(join(worktree, 'moved'))).toBe(true);
          expect(() => lstatSync(join(worktree, 'moved', 'leak'))).toThrow();
        } finally {
          shell.end();
          rmSync(join(worktree, 'leak'), { force: true });
          rmSync(join(worktree, 'moved'), { recursive: true, force: true });
        }
      });

      it('runs an allowlisted command sealed once a sealed run may have rewritten what it runs', async () => {
        // A file outside the workspace that the planner's sandbox, which reads the whole host, can read.
        const canaryDir = realpathSync(mkdtempSync(join(tmpdir(), 'ordewell-sealed-canary-')));
        const canary = join(canaryDir, 'canary.txt');
        writeFileSync(canary, `canary-${process.pid}\n`);
        const fs = new HostFileSystem(repo, sandbox);
        fs.setApproval(new ApprovalPolicy({ preApproved: ['sh check.sh'] }));
        const shell = fs.taskShell({ cwd: worktree, writable: worktree });
        const fresh = fs.taskShell({ cwd: worktree, writable: worktree });
        try {
          writeFileSync(join(worktree, 'check.sh'), 'echo checked\n');
          const before = await shell.run('sh check.sh');
          expect(ranSealed(before.output)).toBe(false);
          expect(before.output).toContain('checked');

          const rewrite = await shell.run(`echo "cat '${canary}'" > check.sh`);
          expect(ranSealed(rewrite.output)).toBe(true);
          expect(readFileSync(join(worktree, 'check.sh'), 'utf8')).toContain(canary);

          const after = await shell.run('sh check.sh');
          expect(ranSealed(after.output)).toBe(true);
          expect(after.output).not.toContain(`canary-${process.pid}`);

          // What the rewritten script would have read outside the sealed profile, in an attempt's shell that never ran one sealed.
          expect((await fresh.run('sh check.sh')).output).toContain(`canary-${process.pid}`);
        } finally {
          shell.end();
          fresh.end();
          rmSync(join(worktree, 'check.sh'), { force: true });
          rmSync(canaryDir, { recursive: true, force: true });
        }
      });

      it('reads the repository through git, and cannot record anything in it', async () => {
        const fs = new HostFileSystem(repo, sandbox);
        const shell = fs.taskShell({ cwd: worktree, writable: worktree });
        const head = git(repo, 'rev-parse', 'ordewell/run/1-review').stdout;
        try {
          const log = await shell.run('git log --oneline -1 | cat');
          expect(log.output).toContain('base');

          const commit = await shell.run('git add -A && git -c user.name=t -c user.email=t@t commit -qm task');
          // A throwaway overlay takes the commit and drops it with the run (S1);
          // without one the repository is read-only and refuses it outright.
          const overlaid = availability.available && availability.sealed.available
            && (availability.sealed.profile({ workspace: repo }).throwaway?.length ?? 0) > 0;
          if (commit.success) expect(overlaid).toBe(true);
          else expect(commit.output).toContain('git can read the repository but not record anything in it');
          expect(git(repo, 'rev-parse', 'ordewell/run/1-review').stdout).toBe(head);
        } finally {
          shell.end();
        }
      });

      it("cannot write, replace, rename or remove its worktree's .git, so git outside loads no planted repository (ADR-0046)", async () => {
        const original = readFileSync(join(worktree, '.git'), 'utf8');
        const launch = await sandbox.launchSealed(POSIX, { workspace: repo, writable: worktree, worktrees: [worktree], limits: TASK_SEALED_LIMITS });
        const inWorktree = (command: string) => run(launch, command, worktree);
        try {
          // git still reads the repository inside the sealed run.
          expect((await inWorktree('git log --oneline -1 | cat')).out).toContain('base');

          for (const command of ['rm -f .git', 'mv .git moved-git', 'rm -f .git && mkdir .git', 'echo planted >> .git', 'printf "gitdir: planted\\n" > .git']) {
            expect((await inWorktree(command)).code).not.toBe(0);
          }
          // Untouched: still the repository's gitdir pointer, never removed or moved.
          expect(readFileSync(join(worktree, '.git'), 'utf8')).toBe(original);
          expect(existsSync(join(worktree, 'moved-git'))).toBe(false);

          // Creating a `.git` beneath the worktree: refused on macOS; a residual bubblewrap cannot close on Linux.
          const beneath = await inWorktree('mkdir -p sub && mkdir sub/.git');
          if (process.platform === 'darwin') {
            expect(beneath.code).not.toBe(0);
            expect(existsSync(join(worktree, 'sub', '.git'))).toBe(false);
          }
        } finally {
          rmSync(join(worktree, 'sub'), { recursive: true, force: true });
          rmSync(join(worktree, 'moved-git'), { recursive: true, force: true });
        }
      });
    });
  });
});
