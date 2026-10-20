import { execFile } from 'child_process';
import * as path from 'path';

/**
 * The one seam an OS sandbox sits behind (ADR-0011 B6). A backend turns "run
 * this POSIX shell" into "run this launcher, which runs the shell under a
 * policy": the launcher and its policy become the `file` and the leading
 * `args`, and the caller appends the command string last, exactly as it would
 * to the bare shell. The string the classifier read is the string that runs.
 *
 * A sandbox shares nothing with another: no daemon, no image, no state beyond
 * what its profile names. A container, microVM or hosted backend for an
 * execution lease (#97) is another implementation of this interface, and its
 * callers do not change.
 */

/** What one command may touch. Every path is absolute and canonical (symlinks resolved), as the kernel will see it. */
export interface SandboxProfile {
  /** Directories the command may write, recursively. Nothing else can be written. */
  write: readonly string[];
  /**
   * What the command may read besides `write`. `'host'` is the whole
   * filesystem: the planner's reads are confined by ADR-0008's path check,
   * not here (ADR-0011 B2). A list confines reads to those paths, for a
   * profile that must not see the user's files (ADR-0036 S1).
   */
  read: 'host' | readonly string[];
  /** Directories the command cannot see into although `read` covers them: where local services listen that would write on its behalf. */
  masked?: readonly string[];
  network: boolean;
  /** A fresh, empty `/tmp` of the command's own instead of the host's. */
  privateTmp?: boolean;
  /** Set over the environment the command inherits. */
  env: Readonly<Record<string, string>>;
  limits?: SandboxLimits;
}

export interface SandboxLimits {
  /** Processes the command may have at once. */
  processes?: number;
  /** Bytes of memory any one of its processes may map. */
  memoryBytes?: number;
  /** Milliseconds before the whole command is killed. */
  wallTimeMs?: number;
}

/** The unsandboxed shell: a POSIX shell that takes the command string after `shellArgs`. */
export interface SandboxInvocation {
  shell: string;
  shellArgs: readonly string[];
  /** The environment the shell would have run with. */
  env: NodeJS.ProcessEnv;
}

/** What to spawn instead. The command string is appended after `args`. */
export interface SandboxLaunch {
  file: string;
  args: string[];
  env: NodeJS.ProcessEnv;
}

export type SandboxProbe = { ok: true } | { ok: false; detail: string };

export interface SandboxBackend {
  /** How the notice and a skipped test name it. */
  readonly name: string;
  /** Start a trivial command under `profile`: whether this host can run the sandbox at all (ADR-0011 B5). */
  probe(profile: SandboxProfile): Promise<SandboxProbe>;
  /** Builds the launch without starting anything, and throws {@link SandboxUnsupportedError} for a profile it cannot enforce. */
  wrap(invocation: SandboxInvocation, profile: SandboxProfile): SandboxLaunch;
}

/**
 * A profile asks for something this backend cannot hold the command to. A
 * backend refuses rather than run the command under less than it was asked
 * for, so a caller can never mistake a weaker sandbox for the one it built.
 */
export class SandboxUnsupportedError extends Error {
  constructor(backend: string, what: string) {
    super(`${backend} cannot enforce ${what}`);
    this.name = 'SandboxUnsupportedError';
  }
}

/**
 * Paths reach a backend as argv entries and never as policy text, so a quote,
 * newline or parenthesis in one cannot become syntax. What is left to check
 * is that each is absolute: a relative path would resolve against whatever
 * directory the launcher starts in, and one starting with `-` would read as
 * an option.
 */
export function assertProfilePaths(backend: string, profile: SandboxProfile): void {
  const paths = [...profile.write, ...(profile.read === 'host' ? [] : profile.read), ...(profile.masked ?? [])];
  for (const p of paths) {
    if (!path.posix.isAbsolute(p) || p.includes('\0')) throw new SandboxUnsupportedError(backend, `the path ${JSON.stringify(p)}`);
  }
}

export type ProbeExec = (file: string, args: string[], env: NodeJS.ProcessEnv) => Promise<{ code: number | null; output: string }>;

/** A probe that hangs must not hold up the first command for long; no answer means no sandbox. */
const PROBE_TIMEOUT_MS = 10_000;

export const execProbe: ProbeExec = (file, args, env) => new Promise((resolve) => {
  try {
    execFile(file, args, { env, timeout: PROBE_TIMEOUT_MS, encoding: 'utf8' }, (err, stdout, stderr) => {
      const code = !err ? 0 : typeof (err as { code?: unknown }).code === 'number' ? (err as { code: number }).code : null;
      resolve({ code, output: `${stdout ?? ''}${stderr ?? ''}`.trim() || (err?.message ?? '') });
    });
  } catch (err) {
    resolve({ code: null, output: err instanceof Error ? err.message : String(err) });
  }
});

/** The probe both local backends run: `/bin/sh -c true`, wrapped as a real command would be. */
export async function probeByRunning(backend: SandboxBackend, profile: SandboxProfile, exec: ProbeExec): Promise<SandboxProbe> {
  let launch: SandboxLaunch;
  try {
    launch = backend.wrap({ shell: '/bin/sh', shellArgs: ['-c'], env: process.env }, profile);
  } catch (err) {
    return { ok: false, detail: err instanceof Error ? err.message : String(err) };
  }
  const { code, output } = await exec(launch.file, [...launch.args, 'true'], launch.env);
  return code === 0 ? { ok: true } : { ok: false, detail: output || (code === null ? 'it did not finish' : `it exited ${code}`) };
}
