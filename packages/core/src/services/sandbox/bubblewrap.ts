import * as fsSync from 'fs';
import * as path from 'path';
import {
  assertProfilePaths,
  execProbe,
  probeByRunning,
  SandboxUnsupportedError,
  type ProbeExec,
  type SandboxBackend,
  type SandboxInvocation,
  type SandboxLaunch,
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
    if (profile.limits) throw new SandboxUnsupportedError(this.name, 'resource limits');
    assertProfilePaths(this.name, profile);

    const args = ['--new-session', '--die-with-parent', '--unshare-pid', '--unshare-ipc'];
    if (!profile.network) args.push('--unshare-net');
    if (profile.read === 'host') args.push('--ro-bind', '/', '/');
    args.push('--dev', '/dev', '--proc', '/proc');
    // Before the read list and the writable directories, which may live under /tmp.
    if (profile.privateTmp) args.push('--tmpfs', '/tmp');
    if (profile.read !== 'host') for (const p of shallowFirst(profile.read)) args.push('--ro-bind', p, p);
    // An empty directory over a directory, /dev/null over anything else: a socket that is a file can only be covered by another file.
    for (const p of shallowFirst(profile.masked ?? [])) args.push(...(this.isDirectory(p) ? ['--tmpfs', p] : ['--ro-bind', '/dev/null', p]));
    for (const p of shallowFirst(profile.write)) args.push('--bind', p, p);
    args.push('--', invocation.shell, ...invocation.shellArgs);

    return { file: this.bwrap, args, env: { ...invocation.env, ...profile.env } };
  }
}
