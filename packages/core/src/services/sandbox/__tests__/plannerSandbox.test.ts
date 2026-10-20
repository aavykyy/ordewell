import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect, afterEach } from 'vitest';
import {
  PlannerShellSandbox,
  clearPlannerSandboxCache,
  plannerShellProfile,
  resolvePlannerSandbox,
  sandboxedFailureNote,
  sweepOrphanScratch,
  PLANNER_SANDBOX_DOCS,
  type PlannerSandboxAvailability,
} from '../plannerSandbox';
import type { ProbeExec, SandboxBackend, SandboxProfile } from '../SandboxBackend';
import { classifyOutcome } from '../../researchStepSummary';
import type { ResearchShell } from '../../researchShell';

const POSIX: ResearchShell = { file: null, args: [], dialect: 'posix', utilsDir: null };

function recordingExec(result: { code: number | null; output: string }): { exec: ProbeExec; calls: Array<{ file: string; args: string[] }> } {
  const calls: Array<{ file: string; args: string[] }> = [];
  return { calls, exec: async (file, args) => { calls.push({ file, args }); return result; } };
}

function linux(files: string[], exec: ProbeExec, extra: { env?: NodeJS.ProcessEnv; dirs?: string[] } = {}) {
  const present = new Set(files);
  const dirs = new Set(extra.dirs ?? []);
  return {
    platform: 'linux' as NodeJS.Platform,
    env: extra.env ?? { PATH: '/usr/bin:/bin' },
    exists: (f: string) => present.has(f),
    stat: (p: string) => (dirs.has(p) ? { canonical: p, directory: true } : null),
    uid: 1000,
    exec,
  };
}

function unavailableNotice(availability: PlannerSandboxAvailability): string {
  if (availability.available) throw new Error('expected no sandbox');
  return availability.notice;
}

describe('resolvePlannerSandbox', () => {
  afterEach(() => clearPlannerSandboxCache());

  it('has no sandbox on Windows, and says so without probing anything', async () => {
    const { exec, calls } = recordingExec({ code: 0, output: '' });
    const notice = unavailableNotice(await resolvePlannerSandbox({ platform: 'win32', exec }));
    expect(notice).toContain("The planner's shell runs without an OS sandbox on this machine: Windows has no sandbox");
    expect(notice).toContain("Ordewell's command rules");
    expect(notice).toContain(PLANNER_SANDBOX_DOCS);
    expect(calls).toEqual([]);
  });

  it('names bubblewrap and how to install it when Linux has none', async () => {
    const { exec, calls } = recordingExec({ code: 0, output: '' });
    const notice = unavailableNotice(await resolvePlannerSandbox(linux([], exec)));
    expect(notice).toContain('bubblewrap (bwrap) is not installed');
    expect(notice).toContain('sudo apt install bubblewrap');
    expect(calls).toEqual([]);
  });

  it("names Ubuntu's user-namespace restriction and both fixes when bubblewrap cannot start", async () => {
    const { exec } = recordingExec({ code: 1, output: 'bwrap: loopback: Failed RTM_NEWADDR: Operation not permitted\n' });
    const notice = unavailableNotice(await resolvePlannerSandbox(linux(['/usr/bin/bwrap'], exec)));
    expect(notice).toContain('bubblewrap could not start (bwrap: loopback: Failed RTM_NEWADDR: Operation not permitted)');
    expect(notice).toContain('AppArmor profile for bwrap');
    expect(notice).toContain('kernel.apparmor_restrict_unprivileged_userns=0');
  });

  it('probes bubblewrap once with the stricter profile: no network, and the local services masked', async () => {
    const { exec, calls } = recordingExec({ code: 0, output: '' });
    const availability = await resolvePlannerSandbox(linux(['/usr/bin/bwrap'], exec, {
      env: { PATH: '/usr/bin', XDG_RUNTIME_DIR: '/run/user/1000' },
      dirs: ['/run/user/1000', '/tmp/.X11-unix'],
    }));
    expect(availability.available).toBe(true);
    expect(calls).toHaveLength(1);
    const args = calls[0].args.join(' ');
    expect(calls[0].file).toBe('/usr/bin/bwrap');
    expect(args).toContain('--unshare-net');
    expect(args).toContain('--tmpfs /run/user/1000');
    expect(args).toContain('--tmpfs /tmp/.X11-unix');
    expect(args).not.toContain('--bind ');
    expect(args.endsWith('-- /bin/sh -c true')).toBe(true);
  });

  it('probes Seatbelt by running sandbox-exec, and reports one that cannot start', async () => {
    const ok = recordingExec({ code: 0, output: '' });
    expect((await resolvePlannerSandbox({ platform: 'darwin', exists: () => true, exec: ok.exec })).available).toBe(true);
    expect(ok.calls[0].file).toBe('/usr/bin/sandbox-exec');

    const failing = recordingExec({ code: 71, output: 'sandbox-exec: sandbox_apply: Operation not permitted' });
    const notice = unavailableNotice(await resolvePlannerSandbox({ platform: 'darwin', exists: () => true, exec: failing.exec }));
    expect(notice).toContain('Seatbelt could not start (sandbox-exec: sandbox_apply: Operation not permitted)');
    expect(notice).not.toContain('AppArmor');
  });

  it('probes once per process: later callers share the first answer', () => {
    const first = resolvePlannerSandbox();
    expect(resolvePlannerSandbox()).toBe(first);
    clearPlannerSandboxCache();
    expect(resolvePlannerSandbox()).not.toBe(first);
  });
});

describe('plannerShellProfile', () => {
  const host = { platform: 'linux' as NodeJS.Platform, services: ['/run/user/1000'] };

  it('reads the host, writes only scratch, and points the read commands that write caches at it (B2)', () => {
    const profile = plannerShellProfile(host, { scratch: '/tmp/s', network: false });
    expect(profile.read).toBe('host');
    expect(profile.write).toEqual(['/tmp/s']);
    expect(profile.env).toEqual({
      TMPDIR: '/tmp/s',
      GIT_OPTIONAL_LOCKS: '0',
      npm_config_cache: '/tmp/s/npm',
      npm_config_update_notifier: 'false',
      GOCACHE: '/tmp/s/go-build',
      XDG_CACHE_HOME: '/tmp/s/cache',
      PYTHONPYCACHEPREFIX: '/tmp/s/pycache',
    });
    expect(plannerShellProfile({ ...host, platform: 'darwin' }, { scratch: '/tmp/s', network: false }).env.xcrun_db).toBe('/tmp/s/xcrun_db');
  });

  it('withholds the network and the local services only from a command that ran without asking (B3)', () => {
    expect(plannerShellProfile(host, { scratch: '/tmp/s', network: false })).toMatchObject({ network: false, masked: ['/run/user/1000'] });
    expect(plannerShellProfile(host, { scratch: '/tmp/s', network: true })).toMatchObject({ network: true, masked: [] });
  });
});

/** A backend that records the profile of every command it wraps. */
function fakeBackend(): SandboxBackend & { profiles: SandboxProfile[] } {
  const profiles: SandboxProfile[] = [];
  return {
    name: 'fake',
    profiles,
    probe: async () => ({ ok: true }),
    wrap: (invocation, profile) => {
      profiles.push(profile);
      return { file: '/sandbox', args: ['--policy', invocation.shell, ...invocation.shellArgs], env: { ...invocation.env, ...profile.env } };
    },
  };
}

function availableWith(backend: SandboxBackend): () => Promise<PlannerSandboxAvailability> {
  return async () => ({
    available: true,
    backend,
    profile: (opts) => plannerShellProfile({ platform: 'linux', services: [] }, opts),
  });
}

describe('PlannerShellSandbox', () => {
  it('runs the shell as before and says so once per session where no sandbox runs (B5)', async () => {
    const notices: string[] = [];
    const sandbox = new PlannerShellSandbox(async () => ({ available: false, notice: 'no sandbox' }));
    sandbox.setNotice((m) => notices.push(m));

    const launches = await Promise.all([1, 2, 3].map(() => sandbox.launch(POSIX, { network: false })));
    await sandbox.launch(POSIX, { network: true });
    expect(launches.every((l) => l.launch === POSIX && !l.sandboxed)).toBe(true);
    expect(notices).toEqual(['no sandbox']);

    sandbox.end();
    await sandbox.launch(POSIX, { network: false });
    expect(notices).toEqual(['no sandbox', 'no sandbox']);
  });

  it('wraps the POSIX shell `shell: true` would have used, with the command left to the caller (B6)', async () => {
    const backend = fakeBackend();
    const sandbox = new PlannerShellSandbox(availableWith(backend));
    const { launch, sandboxed } = await sandbox.launch(POSIX, { network: false });
    expect(sandboxed).toBe(true);
    expect(launch.file).toBe('/sandbox');
    expect(launch.args).toEqual(['--policy', '/bin/sh', '-c']);
    sandbox.end();
  });

  it('wraps a resolved shell with its own arguments', async () => {
    const backend = fakeBackend();
    const sandbox = new PlannerShellSandbox(availableWith(backend));
    const { launch } = await sandbox.launch({ file: '/usr/local/bin/bash', args: ['-c'], dialect: 'posix', utilsDir: null }, { network: false });
    expect(launch.args).toEqual(['--policy', '/usr/local/bin/bash', '-c']);
    sandbox.end();
  });

  it('gives a session one private scratch directory under the OS temporary directory, and removes it when the session ends', async () => {
    const backend = fakeBackend();
    const sandbox = new PlannerShellSandbox(availableWith(backend));
    const first = await sandbox.launch(POSIX, { network: false });
    await sandbox.launch(POSIX, { network: true });
    const [a, b] = backend.profiles;
    expect(a.write).toEqual(b.write);
    const scratch = a.write[0];
    expect(scratch.startsWith(realpathSync(tmpdir()))).toBe(true);
    expect(statSync(scratch).mode & 0o777).toBe(0o700);
    expect(first.launch.env?.TMPDIR).toBe(scratch);
    expect([a.network, b.network]).toEqual([false, true]);

    sandbox.end();
    expect(existsSync(scratch)).toBe(false);
    await sandbox.launch(POSIX, { network: false });
    expect(backend.profiles[2].write[0]).not.toBe(scratch);
    sandbox.end();
  });

  it('never runs a cmd.exe command in the POSIX shell it would wrap', async () => {
    const sandbox = new PlannerShellSandbox(availableWith(fakeBackend()));
    await expect(sandbox.launch({ ...POSIX, dialect: 'cmd' }, { network: false })).rejects.toThrow('POSIX shell');
  });
});

describe('sandboxedFailureNote', () => {
  it('explains a denied write, and a missing network only where the command had none', () => {
    expect(sandboxedFailureNote('touch: x: Operation not permitted', true)).toContain('cannot write outside its scratch directory');
    expect(sandboxedFailureNote('touch: x: Operation not permitted', true)).not.toContain('network');
    expect(sandboxedFailureNote('curl: (6) Could not resolve host: example.com', false)).toContain('has no network');
    expect(sandboxedFailureNote('fatal: bad revision', false)).toBeNull();
  });

  it('never reads as a refusal or a denial to the surfaces', () => {
    const output = `Command exited 1:\ntouch: x: Read-only file system\n\n[${sandboxedFailureNote('Read-only file system', false)}]`;
    expect(classifyOutcome(false, output)).toBe('failure');
  });
});

describe('sweepOrphanScratch', () => {
  it("removes the scratch directories of processes that are gone, and nothing else", () => {
    const root = mkdtempSync(join(tmpdir(), 'ordewell-sweep-'));
    try {
      const gone = spawnSync(process.execPath, ['-e', '']).pid;
      for (const name of [`ordewell-planner-${gone}-abc`, `ordewell-planner-${process.pid}-abc`, `ordewell-planner-${process.ppid}-abc`, 'ordewell-planner-abc', 'unrelated']) {
        mkdirSync(join(root, name));
      }
      sweepOrphanScratch(root);
      expect(existsSync(join(root, `ordewell-planner-${gone}-abc`))).toBe(false);
      for (const kept of [`ordewell-planner-${process.pid}-abc`, `ordewell-planner-${process.ppid}-abc`, 'ordewell-planner-abc', 'unrelated']) {
        expect(existsSync(join(root, kept))).toBe(true);
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('names a scratch directory after the process that made it', async () => {
    const backend = fakeBackend();
    const sandbox = new PlannerShellSandbox(availableWith(backend));
    await sandbox.launch(POSIX, { network: false });
    expect(backend.profiles[0].write[0]).toMatch(new RegExp(`/ordewell-planner-${process.pid}-[^/]+$`));
    sandbox.end();
  });
});
