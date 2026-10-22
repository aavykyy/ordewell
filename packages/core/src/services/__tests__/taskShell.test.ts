import { existsSync, lstatSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BaseFileSystem } from '../BaseFileSystem';
import { ApprovalPolicy } from '../ApprovalPolicy';
import { ranSealed } from '../researchStepSummary';
import type { ShellLaunch } from '../researchShell';
import {
  PlannerShellSandbox, plannerShellProfile, sealedShellProfile, type PlannerSandboxAvailability,
} from '../sandbox/plannerSandbox';
import type { SandboxBackend, SandboxLaunch, SandboxProfile } from '../sandbox/SandboxBackend';
import type { ToolOutcome } from '../../interfaces/IFileSystem';

/**
 * A read-only task's `run_command` (ADR-0046): the planner's command rules at
 * the task's working directory, nobody asked, and what would ask or be
 * refused run sealed with the task's worktree writable.
 */

/** Hands back a launch that names the profile it was built from, so a test reads which profile each command ran under. */
class RecordingBackend implements SandboxBackend {
  readonly name = 'recording';
  readonly profiles: SandboxProfile[] = [];

  async probe(): Promise<{ ok: true }> {
    return { ok: true };
  }

  wrap(_invocation: unknown, profile: SandboxProfile): SandboxLaunch {
    this.profiles.push(profile);
    const sealed = profile.limits !== undefined;
    return { file: sealed ? '/sealed' : '/sandboxed', args: [String(this.profiles.length - 1)], env: {}, ...(sealed ? { wallTimeMs: profile.limits!.wallTimeMs } : {}) };
  }
}

function available(backend: SandboxBackend): PlannerSandboxAvailability {
  return {
    available: true,
    backend,
    profile: (opts) => plannerShellProfile({ platform: 'darwin', services: [] }, opts),
    sealed: { available: true, profile: (opts) => sealedShellProfile({ platform: 'darwin', reads: ['/usr'], masked: [], overlay: false }, opts) },
  };
}

interface Ran {
  command: string;
  cwd: string;
  sealed: boolean;
  /** The profile it ran under; absent where no sandbox ran it. */
  profile?: SandboxProfile;
}

class WorkspaceFileSystem extends BaseFileSystem {
  readonly ran: Ran[] = [];
  /** What a command does to the disk as it runs, for one that must leave something behind. */
  effect?: (ran: Ran) => Promise<void> | void;

  constructor(private readonly root: string, private readonly backend: RecordingBackend | null) {
    super(undefined, new PlannerShellSandbox(async () => (backend ? available(backend) : { available: false, notice: 'no sandbox in this test' })));
  }

  getWorkspaceRoot(): string { return this.root; }
  protected async readFileImpl(): Promise<ToolOutcome> { throw new Error('not used'); }
  protected async globImpl(): Promise<ToolOutcome> { throw new Error('not used'); }
  protected async grepImpl(): Promise<ToolOutcome> { throw new Error('not used'); }
  protected async listDirImpl(): Promise<ToolOutcome> { throw new Error('not used'); }

  protected async execBashImpl(command: string, shell: ShellLaunch, _signal: AbortSignal | undefined, cwd: string): Promise<ToolOutcome> {
    const profile = shell.file === null ? undefined : this.backend?.profiles[Number(shell.args[0])];
    const ran = { command, cwd, sealed: shell.file === '/sealed', ...(profile ? { profile } : {}) };
    this.ran.push(ran);
    await this.effect?.(ran);
    return { success: true, output: 'ran', truncated: false };
  }
}

describe("a read-only task's shell (ADR-0046)", () => {
  let workspace: string;
  let worktree: string;
  let asked: string[];

  /** The session's approvals under Guarded, whose card says no unless `yes` names the command. */
  function guarded(opts: { preApproved?: string[]; yes?: string[] } = {}): ApprovalPolicy {
    return new ApprovalPolicy({
      mode: 'ask',
      preApproved: opts.preApproved ?? [],
      ask: async (req) => {
        asked.push(req.subject);
        return opts.yes?.includes(req.subject) ?? false;
      },
    });
  }

  function session(backend: RecordingBackend | null = new RecordingBackend(), approval = guarded()): WorkspaceFileSystem {
    const fs = new WorkspaceFileSystem(workspace, backend);
    fs.setApproval(approval);
    return fs;
  }

  beforeEach(() => {
    asked = [];
    workspace = realpathSync(mkdtempSync(join(tmpdir(), 'ordewell-task-shell-')));
    writeFileSync(join(workspace, 'a.md'), 'one\n');
    worktree = join(workspace, '.ordewell', 'worktrees', 'run', '1-review');
    mkdirSync(worktree, { recursive: true });
  });

  afterEach(() => {
    rmSync(workspace, { recursive: true, force: true });
  });

  it('runs what would ask or be refused sealed, from its worktree, which is writable there, and asks nobody', async () => {
    const fs = session();
    const shell = fs.taskShell({ cwd: worktree, writable: worktree });

    const tests = await shell.run('npm test');
    const write = await shell.run('echo draft > notes.txt');
    const loop = await shell.run('for f in *.md; do wc -l "$f"; done');

    expect(asked).toEqual([]);
    expect(fs.ran.map(({ command, cwd, sealed }) => ({ command, cwd, sealed }))).toEqual([
      { command: 'npm test', cwd: worktree, sealed: true },
      { command: 'echo draft > notes.txt', cwd: worktree, sealed: true },
      { command: 'for f in *.md; do wc -l "$f"; done', cwd: worktree, sealed: true },
    ]);
    const profile = fs.ran[0].profile!;
    expect(profile.write).toContain(worktree);
    expect(profile.read).toContain(workspace);
    expect(profile.network).toBe(false);
    for (const outcome of [tests, write, loop]) {
      expect(ranSealed(outcome.output)).toBe(true);
      expect(outcome.output).toContain("This task's worktree is writable and is thrown away when the task ends.");
      expect(outcome.output).toContain('git can read the repository but not record anything in it');
    }
  });

  it('runs what the classifier reads as read-only as the planner would, from the worktree, without the network', async () => {
    const fs = session();
    const shell = fs.taskShell({ cwd: worktree, writable: worktree });

    await shell.run('git status');

    expect(fs.ran).toHaveLength(1);
    expect(fs.ran[0]).toMatchObject({ command: 'git status', cwd: worktree, sealed: false });
    // The planner's profile: nothing of the worktree writable, nothing approved, so no network.
    expect(fs.ran[0].profile).toMatchObject({ read: 'host', network: false });
    expect(fs.ran[0].profile!.write).not.toContain(worktree);
  });

  it('confines paths to its worktree: a read of the main checkout runs sealed, where the workspace is readable', async () => {
    const fs = session();
    const shell = fs.taskShell({ cwd: worktree, writable: worktree });

    await shell.run(`cat ${join(workspace, 'a.md')}`);

    expect(asked).toEqual([]);
    expect(fs.ran[0]).toMatchObject({ sealed: true, cwd: worktree });
  });

  it("runs what the user's allowlist covers as the planner's command would, with the network the allowlist grants", async () => {
    const fs = session(new RecordingBackend(), guarded({ preApproved: ['gh issue list'] }));

    const outcome = await fs.taskShell({ cwd: worktree, writable: worktree }).run('gh issue list');

    expect(asked).toEqual([]);
    expect(fs.ran[0]).toMatchObject({ command: 'gh issue list', sealed: false });
    expect(fs.ran[0].profile?.network).toBe(true);
    expect(ranSealed(outcome.output)).toBe(false);
  });

  it('runs sealed what the user let the planner run on the card: that grant was the planner\'s', async () => {
    const fs = session(new RecordingBackend(), guarded({ yes: ['npm ls --all'] }));
    await fs.bash('npm ls --all');
    expect(fs.ran[0]).toMatchObject({ sealed: false, cwd: workspace });

    await fs.taskShell({ cwd: worktree, writable: worktree }).run('npm ls --all');

    expect(asked).toEqual(['npm ls --all']);
    expect(fs.ran[1]).toMatchObject({ sealed: true, cwd: worktree });
  });

  it('refuses what an allowlist exclusion names and what the user denied on the card, sealed or not (ADR-0036 S3)', async () => {
    const fs = session(new RecordingBackend(), guarded({ preApproved: ['!kubectl *secret*'] }));
    await fs.bash('npm test');
    expect(asked).toEqual(['npm test']);
    const shell = fs.taskShell({ cwd: worktree, writable: worktree });

    const excluded = await shell.run('kubectl get secrets');
    const denied = await shell.run('npm test');
    const wrapped = await shell.run('for i in 1 2; do npm test; done');

    expect(excluded.output).toContain('the planner allowlist excludes it ("!kubectl *secret*")');
    expect(denied.output).toContain('The user denied it this session');
    expect(wrapped.output).toContain('The user denied "npm test" this session');
    expect(fs.ran).toEqual([]);
    expect(asked).toEqual(['npm test']);
  });

  it('without a worktree of its own, runs sealed with the workspace read-only and nothing writable but scratch', async () => {
    const fs = session();

    const outcome = await fs.taskShell({ cwd: workspace }).run('npm test');

    expect(fs.ran[0]).toMatchObject({ sealed: true, cwd: workspace });
    expect(fs.ran[0].profile!.write).toHaveLength(1);
    expect(fs.ran[0].profile!.write[0]).not.toContain(workspace);
    expect(outcome.output).toContain('The workspace is read-only: this task has no worktree of its own.');
  });

  it('has a scratch directory of its own, which goes when the attempt ends', async () => {
    const fs = session();
    await fs.bash('git status');
    const shell = fs.taskShell({ cwd: worktree, writable: worktree });
    await shell.run('npm test');

    const plannerScratch = fs.ran[0].profile!.env.TMPDIR;
    const taskScratch = fs.ran[1].profile!.env.TMPDIR;
    expect(taskScratch).toBeDefined();
    expect(taskScratch).not.toBe(plannerScratch);
    expect(existsSync(taskScratch)).toBe(true);

    shell.end();

    expect(existsSync(taskScratch)).toBe(false);
    expect(existsSync(plannerScratch)).toBe(true);
    fs.endSession();
  });

  it('removes a link a sealed run left leading out of the worktree and the workspace, and says so', async () => {
    const outside = realpathSync(mkdtempSync(join(tmpdir(), 'ordewell-task-shell-outside-')));
    try {
      writeFileSync(join(outside, 'secret.txt'), 'outside\n');
      mkdirSync(join(worktree, 'src'));
      const fs = session();
      fs.effect = ({ command, sealed }) => {
        if (!sealed || !command.startsWith('ln ')) return;
        symlinkSync(outside, join(worktree, 'leak'));
        symlinkSync(join(outside, 'secret.txt'), join(worktree, 'src', 'deep'));
        symlinkSync(join(outside, 'missing'), join(worktree, 'dangling'));
        symlinkSync('../a.md', join(worktree, 'src', 'local'));
        symlinkSync(join(workspace, 'a.md'), join(worktree, 'workspace-file'));
      };
      const shell = fs.taskShell({ cwd: worktree, writable: worktree });

      const linked = await shell.run(`ln -s '${outside}' leak`);
      await shell.run('cat leak/secret.txt');

      expect(fs.ran.map((r) => r.sealed)).toEqual([true, false]);
      expect(linked.output).toContain('may leave no link leading out of its worktree');
      for (const gone of ['leak', 'src/deep', 'dangling']) {
        expect(linked.output).toContain(gone);
        expect(() => lstatSync(join(worktree, gone))).toThrow();
      }
      expect(lstatSync(join(worktree, 'src', 'local')).isSymbolicLink()).toBe(true);
      expect(lstatSync(join(worktree, 'workspace-file')).isSymbolicLink()).toBe(true);
      expect(existsSync(join(outside, 'secret.txt'))).toBe(true);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it('runs one command at a time, so none reads the worktree while a sealed run still writes it', async () => {
    const fs = session();
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    fs.effect = ({ sealed }) => (sealed ? held : undefined);
    const shell = fs.taskShell({ cwd: worktree, writable: worktree });

    const writing = shell.run('npm test');
    const reading = shell.run('cat a.md');
    await new Promise((resolve) => setImmediate(resolve));
    expect(fs.ran.map((r) => r.command)).toEqual(['npm test']);

    release();
    await Promise.all([writing, reading]);
    expect(fs.ran.map((r) => r.command)).toEqual(['npm test', 'cat a.md']);
  });

  it('asks the sandbox to refuse links in its worktree where it can, and only there (macOS)', async () => {
    const backend = new RecordingBackend();
    const fs = session(backend);
    await fs.taskShell({ cwd: worktree, writable: worktree }).run('npm test');
    await fs.taskShell({ cwd: workspace }).run('npm test');
    await fs.bash('for f in *.md; do wc -l "$f"; done');

    const sealedProfiles = fs.ran.filter((r) => r.sealed).map((r) => r.profile);
    expect(sealedProfiles.map((p) => p?.linkless)).toEqual([[worktree], undefined, undefined]);
  });

  it('where no sandbox runs, runs what the classifier reads as read-only and refuses the rest, asking nobody', async () => {
    const fs = session(null);
    const shell = fs.taskShell({ cwd: worktree, writable: worktree });

    const status = await shell.run('git status');
    const tests = await shell.run('npm test');
    const loop = await shell.run('for f in *.md; do wc -l "$f"; done');
    const outside = await shell.run(`cat ${join(workspace, 'a.md')}`);

    expect(status.success).toBe(true);
    expect(fs.ran).toEqual([{ command: 'git status', cwd: worktree, sealed: false }]);
    expect(tests.output).toMatch(/^Command not run: npm test\nA read-only task asks nobody, so this command could only run sealed, and this machine has no sandbox to seal it in\./);
    expect(loop.output).toMatch(/^Command refused: /);
    expect(loop.output).toContain('this machine has no sandbox to seal it in');
    expect(outside.output).toContain('this machine has no sandbox to seal it in');
    expect(asked).toEqual([]);
  });
});
