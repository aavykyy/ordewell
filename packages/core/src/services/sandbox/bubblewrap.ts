import * as fsSync from 'fs';
import * as path from 'path';
import {
  assertLimits,
  assertProfilePaths,
  execProbe,
  launchEnv,
  probeByRunning,
  SandboxUnsupportedError,
  type ProbeExec,
  type SandboxBackend,
  type SandboxInvocation,
  type SandboxLaunch,
  type SandboxLimits,
  type SandboxProbe,
  type SandboxProfile,
} from './SandboxBackend';

/**
 * Where distributions install `bwrap`, tried before PATH. A `bwrap` that
 * PATH finds first could be any program at all, and a sandbox that silently
 * is not one is the failure this module exists to prevent.
 */
const SYSTEM_BWRAP = ['/usr/bin/bwrap', '/bin/bwrap', '/usr/local/bin/bwrap', '/run/current-system/sw/bin/bwrap'];

/** The `bwrap` to launch, or null when none is installed. Only absolute PATH entries count: a relative one resolves against the workspace. */
export function findBubblewrap(env: NodeJS.ProcessEnv, exists: (file: string) => boolean): string | null {
  const onPath = (env.PATH ?? '').split(path.posix.delimiter)
    .filter((dir) => path.posix.isAbsolute(dir))
    .map((dir) => path.posix.join(dir, 'bwrap'));
  return [...new Set([...SYSTEM_BWRAP, ...onPath])].find(exists) ?? null;
}

function defaultIsDirectory(p: string): boolean {
  try {
    return fsSync.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/** Parents before children, so a deeper mount is never covered by one made after it. */
function shallowFirst(paths: readonly string[]): string[] {
  return [...new Set(paths)].sort((a, b) => a.split('/').length - b.split('/').length);
}

/**
 * Runs before bubblewrap, outside it, then becomes it, so the caller's kill
 * at the wall-time limit and `--die-with-parent` reach the sandbox's PID
 * namespace, and every process in it, unchanged (ADR-0036 S1). Older kernels
 * count the process limit against all of the user's processes and newer ones
 * against the sandbox's own, so it is set above every process the host runs
 * now: never already spent, and still a bound. Dash names that limit `-p`
 * where bash names it `-u`. Only numbers from
 * {@link SandboxLimits} enter the text, and the command reaches it as the
 * last of its arguments.
 */
function limitsPrelude(limits: SandboxLimits): string {
  const processes = `$(($(set -- /proc/[0-9]*; echo $#) + ${limits.processes}))`;
  return `{ ulimit -u ${processes} 2>/dev/null || ulimit -p ${processes}; } && ulimit -v ${Math.ceil(limits.memoryBytes / 1024)} \\
  || { echo 'The sealed run could not be held to its limits, so it did not run.' >&2; exit 125; }
exec "$@"`;
}

/**
 * Linux's bubblewrap (ADR-0011 B4). Every path is its own argv entry, so none
 * is ever parsed as an option or a list.
 *
 * Three flags beyond the read-only root carry the guarantee:
 * - `--unshare-pid`, without which an unprivileged `--proc` cannot mount at
 *   all, and which keeps the host's processes out of the fresh `/proc`: their
 *   `/proc/<pid>/root` links lead into a mount namespace where the
 *   filesystem is writable.
 * - `--new-session`, so the command has no controlling terminal to type into
 *   with TIOCSTI.
 * - `--unshare-ipc`, so the host's System V shared memory is out of reach.
 *
 * A throwaway directory is an overlay whose upper layer is a tmpfs
 * (`--overlay-src`, `--tmp-overlay`, bubblewrap 0.10 and later on a kernel
 * that lets a user namespace mount one); an older one fails the probe, and the
 * caller asks again with the directory read-only.
 */
export class BubblewrapBackend implements SandboxBackend {
  readonly name = 'bubblewrap';
  private readonly exec: ProbeExec;
  private readonly isDirectory: (p: string) => boolean;

  constructor(private readonly bwrap: string, deps: { exec?: ProbeExec; isDirectory?: (p: string) => boolean } = {}) {
    this.exec = deps.exec ?? execProbe;
    this.isDirectory = deps.isDirectory ?? defaultIsDirectory;
  }

  probe(profile: SandboxProfile): Promise<SandboxProbe> {
    return probeByRunning(this, profile, this.exec);
  }

  wrap(invocation: SandboxInvocation, profile: SandboxProfile): SandboxLaunch {
    // A mount grants a directory whole; refusing one kind of file in it would take a seccomp filter.
    if (profile.linkless?.length) throw new SandboxUnsupportedError(this.name, 'a writable directory without links');
    assertProfilePaths(this.name, profile);
    if (profile.limits) assertLimits(this.name, profile.limits);

    const args = ['--new-session', '--die-with-parent', '--unshare-pid', '--unshare-ipc'];
    if (!profile.network) args.push('--unshare-net');
    if (profile.read === 'host') args.push('--ro-bind', '/', '/');
    args.push('--dev', '/dev', '--proc', '/proc');
    // Before the read list and the writable directories, which may live under /tmp.
    if (profile.privateTmp) args.push('--tmpfs', '/tmp');
    const throwaway = new Set(profile.throwaway);
    const readOnly = profile.read === 'host' ? [] : profile.read.filter((p) => !throwaway.has(p));
    for (const p of shallowFirst([...readOnly, ...throwaway])) args.push(...(throwaway.has(p) ? ['--overlay-src', p, '--tmp-overlay', p] : ['--ro-bind', p, p]));
    // An empty directory over a directory, /dev/null over anything else: a socket that is a file can only be covered by another file.
    for (const p of shallowFirst(profile.masked ?? [])) args.push(...(this.isDirectory(p) ? ['--tmpfs', p] : ['--ro-bind', '/dev/null', p]));
    for (const p of shallowFirst(profile.write)) args.push('--bind', p, p);
    args.push('--', invocation.shell, ...invocation.shellArgs);

    const env = launchEnv(invocation, profile);
    if (!profile.limits) return { file: this.bwrap, args, env };
    return { file: '/bin/sh', args: ['-c', limitsPrelude(profile.limits), 'ordewell-sealed', this.bwrap, ...args], env, wallTimeMs: profile.limits.wallTimeMs };
  }
}
