import * as fsSync from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { ResearchShell, ShellLaunch } from '../researchShell';
import { BubblewrapBackend, findBubblewrap } from './bubblewrap';
import { SANDBOX_EXEC, SeatbeltBackend } from './seatbelt';
import { execProbe, type ProbeExec, type SandboxBackend, type SandboxProfile } from './SandboxBackend';

/**
 * The planner's shell inside an OS sandbox (ADR-0011): every command the
 * planner's `bash` tool, its research subagents and a harness planner's
 * `run_command` start runs where nothing outside one scratch directory per
 * session can be written. It sits underneath the classifier and changes
 * nothing about which commands are `auto`, `ask` or `refuse` (B1, B7).
 */

export const PLANNER_SANDBOX_DOCS = 'https://github.com/ordewell/ordewell/blob/main/docs/troubleshooting.md#planner-shell-not-sandboxed';

export type PlannerSandboxAvailability =
  | {
    available: true;
    backend: SandboxBackend;
    /** The planner's profile on this host; without a scratch directory, nothing is writable. */
    profile: (opts: { scratch?: string; network: boolean }) => SandboxProfile;
  }
  /** The one notice the planner surface shows a session (B5). */
  | { available: false; notice: string };

export interface PlannerSandboxDeps {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  exists?: (file: string) => boolean;
  /** An existing path's canonical form and whether it is a directory, or null. */
  stat?: (p: string) => { canonical: string; directory: boolean } | null;
  uid?: number;
  exec?: ProbeExec;
}

function defaultExists(file: string): boolean {
  try {
    return fsSync.statSync(file).isFile();
  } catch {
    return false;
  }
}

function defaultStat(p: string): { canonical: string; directory: boolean } | null {
  try {
    const canonical = fsSync.realpathSync(p);
    return { canonical, directory: fsSync.statSync(canonical).isDirectory() };
  } catch {
    return null;
  }
}

/**
 * What the commands the planner commonly reads with write as a side effect,
 * pointed at the scratch directory or told not to (B2). Each is a cache or a
 * log, so a fresh one per session costs time, never correctness.
 */
function scratchEnv(scratch: string, platform: NodeJS.Platform): Record<string, string> {
  return {
    TMPDIR: scratch,
    // `git status` and `git diff` take the index lock to refresh stat data.
    GIT_OPTIONAL_LOCKS: '0',
    // npm writes a debug log under its cache for every command, `npm ls` too,
    // and records its update check there.
    npm_config_cache: path.join(scratch, 'npm'),
    npm_config_update_notifier: 'false',
    // `go list` opens the build cache.
    GOCACHE: path.join(scratch, 'go-build'),
    // Where Linux tools that follow the XDG layout (pip among them) keep caches.
    XDG_CACHE_HOME: path.join(scratch, 'cache'),
    // Python otherwise writes bytecode beside the sources, in the workspace.
    PYTHONPYCACHEPREFIX: path.join(scratch, 'pycache'),
    // The `/usr/bin` shims of Apple's command-line tools (`git` among them)
    // cache lookups in the user's temporary directory, ignoring TMPDIR, and
    // print an error on every call when they cannot.
    ...(platform === 'darwin' ? { xcrun_db: path.join(scratch, 'xcrun_db') } : {}),
  };
}

/**
 * Where Linux's local services listen, hidden from a command without the
 * network (B3). `--unshare-net` cuts every socket reached by address, but a
 * socket that is a file stays reachable through the read-only root, and these
 * act on the caller's behalf: the session bus starts programs through
 * `systemd-run --user`, the system bus reaches logind and PackageKit, an X
 * server takes typed keystrokes, and the Docker daemon mounts anything. An
 * approved command keeps them, since its credentials may live behind the
 * session bus (git's libsecret helper, `gh`'s keyring). macOS needs no list:
 * its profile denies unix sockets with the rest of the network.
 */
function localServices(env: NodeJS.ProcessEnv, stat: NonNullable<PlannerSandboxDeps['stat']>, uid: number | undefined): string[] {
  const runtimeDir = env.XDG_RUNTIME_DIR && path.posix.isAbsolute(env.XDG_RUNTIME_DIR) ? env.XDG_RUNTIME_DIR : undefined;
  const candidates = [runtimeDir, uid === undefined ? undefined : `/run/user/${uid}`, '/run/dbus', '/tmp/.X11-unix', '/run/docker.sock'];
  const found = candidates.flatMap((p) => (p ? [stat(p)?.canonical] : [])).filter((p): p is string => !!p && p !== '/');
  return [...new Set(found)];
}

/** The planner's profile (B2, B3): the host readable, scratch writable, the network only for an approved command. */
export function plannerShellProfile(
  host: { platform: NodeJS.Platform; services: readonly string[] },
  opts: { scratch?: string; network: boolean },
): SandboxProfile {
  return {
    write: opts.scratch ? [opts.scratch] : [],
    read: 'host',
    masked: opts.network ? [] : host.services,
    network: opts.network,
    env: opts.scratch ? scratchEnv(opts.scratch, host.platform) : {},
  };
}

const LEAD = "The planner's shell runs without an OS sandbox on this machine";
const STILL = "Its commands are still held to Ordewell's command rules, as everywhere, but nothing at the OS level stops one that gets past them from writing.";
const RESTART = 'then restart Ordewell: the sandbox is checked once per process.';

function unavailable(cause: string, fix?: string): PlannerSandboxAvailability {
  return { available: false, notice: [`${LEAD}: ${cause}. ${STILL}`, ...(fix ? [fix] : []), PLANNER_SANDBOX_DOCS].join('\n\n') };
}

/** Bubblewrap's own words when the kernel will not give it a user namespace. */
const USERNS_FAILURE = /uid map|user namespace|RTM_NEWADDR|Operation not permitted|Permission denied/i;

function firstLine(text: string): string {
  return text.split('\n').find((line) => line.trim())?.trim().slice(0, 200) ?? text;
}

async function detect(deps: PlannerSandboxDeps): Promise<PlannerSandboxAvailability> {
  const platform = deps.platform ?? process.platform;
  const env = deps.env ?? process.env;
  const exists = deps.exists ?? defaultExists;
  const exec = deps.exec ?? execProbe;

  let backend: SandboxBackend;
  let services: string[] = [];
  if (platform === 'darwin') {
    if (!exists(SANDBOX_EXEC)) return unavailable(`${SANDBOX_EXEC} is missing`);
    backend = new SeatbeltBackend(exec);
  } else if (platform === 'linux') {
    const bwrap = findBubblewrap(env, exists);
    if (!bwrap) return unavailable('bubblewrap (bwrap) is not installed', `Install it (for example \`sudo apt install bubblewrap\`), ${RESTART}`);
    const stat = deps.stat ?? defaultStat;
    backend = new BubblewrapBackend(bwrap, { exec, isDirectory: (p) => stat(p)?.directory ?? false });
    services = localServices(env, stat, 'uid' in deps ? deps.uid : process.getuid?.());
  } else {
    return unavailable(`${platform === 'win32' ? 'Windows' : platform} has no sandbox Ordewell can put around it`);
  }

  const profile = (opts: { scratch?: string; network: boolean }) => plannerShellProfile({ platform, services }, opts);
  // The stricter of the two profiles, so a host that can start one can start both.
  const probe = await backend.probe(profile({ network: false }));
  if (probe.ok) return { available: true, backend, profile };

  const detail = firstLine(probe.detail);
  if (platform === 'linux' && USERNS_FAILURE.test(probe.detail)) {
    return unavailable(
      `bubblewrap could not start (${detail})`,
      `Ubuntu 24.04 and later restrict the user namespaces it needs. Install an AppArmor profile for bwrap, or run \`sudo sysctl -w kernel.apparmor_restrict_unprivileged_userns=0\`, ${RESTART}`,
    );
  }
  return unavailable(`${backend.name} could not start (${detail})`);
}

let cached: Promise<PlannerSandboxAvailability> | null = null;

/**
 * Whether this host can sandbox the planner's shell, and how. Probed once per
 * process with a trivial command (B5): the answer cannot change while
 * Ordewell runs, and concurrent first commands share one probe. Injected
 * dependencies bypass the cache, as {@link resolveResearchShell}'s do.
 */
export function resolvePlannerSandbox(deps: PlannerSandboxDeps = {}): Promise<PlannerSandboxAvailability> {
  if (Object.keys(deps).length > 0) return detect(deps);
  cached ??= detect(deps);
  return cached;
}

/** Test seam: drop the per-process probe so the next call probes again. */
export function clearPlannerSandboxCache(): void {
  cached = null;
}

/** Scratch directories still on disk, removed when the process exits if their session never ended. */
const liveScratch = new Set<string>();
let firstScratch = true;

function removeScratch(dir: string): void {
  liveScratch.delete(dir);
  try {
    fsSync.rmSync(dir, { recursive: true, force: true });
  } catch {
    // The OS temporary directory is cleaned eventually; a failed removal must not fail the session.
  }
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * Remove what a process left behind that died without exiting: killed, or a
 * test worker torn down mid-run, where no exit hook runs. Each directory names
 * the process that made it, so only one whose process is gone is removed, and
 * only one this user owns.
 */
export function sweepOrphanScratch(root: string): void {
  let names: string[];
  try {
    names = fsSync.readdirSync(root);
  } catch {
    return;
  }
  for (const name of names) {
    const pid = Number(/^ordewell-planner-(\d+)-/.exec(name)?.[1]);
    if (!pid || pid === process.pid || processAlive(pid)) continue;
    const dir = path.join(root, name);
    try {
      const stat = fsSync.lstatSync(dir);
      if (stat.isDirectory() && stat.uid === process.getuid?.()) fsSync.rmSync(dir, { recursive: true, force: true });
    } catch {
      // Another process's sweep got there first, or it is not ours to remove.
    }
  }
}

function createScratch(): string {
  if (firstScratch) {
    firstScratch = false;
    process.once('exit', () => { for (const dir of [...liveScratch]) removeScratch(dir); });
    sweepOrphanScratch(os.tmpdir());
  }
  // `mkdtemp` creates it 0700. Canonical, because Seatbelt matches the path
  // the kernel resolves (`/private/var/...`, not `/var/...`).
  const dir = fsSync.realpathSync(fsSync.mkdtempSync(path.join(os.tmpdir(), `ordewell-planner-${process.pid}-`)));
  liveScratch.add(dir);
  return dir;
}

/** The research shell as one command should start, and whether that is inside the sandbox. */
export interface PlannerShellLaunch {
  launch: ShellLaunch;
  sandboxed: boolean;
}

/**
 * One session's view of the sandbox: its scratch directory, made on the first
 * command and removed when the session ends, and its one notice when the
 * sandbox cannot run here.
 */
export class PlannerShellSandbox {
  private scratch: string | null = null;
  private noticed = false;
  private notice: (message: string) => void = () => {};

  constructor(private readonly resolve: () => Promise<PlannerSandboxAvailability> = () => resolvePlannerSandbox()) {}

  setNotice(notice: (message: string) => void): void {
    this.notice = notice;
  }

  /**
   * The launch for one command (B6): the research shell wrapped in the
   * sandbox, with the network as the caller's tier allows (B3), or the shell
   * itself where no sandbox runs, after saying so once (B5). Throws when the
   * sandbox runs here but this command cannot be put in it, so a command is
   * never run outside a sandbox that exists.
   */
  async launch(shell: ResearchShell, opts: { network: boolean }): Promise<PlannerShellLaunch> {
    const availability = await this.resolve();
    if (!availability.available) {
      if (!this.noticed) {
        this.noticed = true;
        this.notice(availability.notice);
      }
      return { launch: shell, sandboxed: false };
    }
    // Wrapping puts the command in a POSIX shell, and a command classified as cmd.exe must never run in one.
    if (shell.dialect !== 'posix') throw new Error(`the sandbox runs a POSIX shell, and this one is ${shell.dialect}`);
    const launch = availability.backend.wrap(
      // `file: null` is Node's `shell: true`, which on POSIX is `/bin/sh -c`.
      { shell: shell.file ?? '/bin/sh', shellArgs: shell.file === null ? ['-c'] : shell.args, env: process.env },
      availability.profile({ scratch: this.scratchDir(), network: opts.network }),
    );
    return { launch, sandboxed: true };
  }

  /** The session ended: its scratch directory goes, and a next session starts with a fresh one and its own notice. */
  end(): void {
    if (this.scratch) removeScratch(this.scratch);
    this.scratch = null;
    this.noticed = false;
  }

  private scratchDir(): string {
    // Made again if something removed it meanwhile, as a temporary-file cleaner may.
    if (!this.scratch || !fsSync.existsSync(this.scratch)) this.scratch = createScratch();
    return this.scratch;
  }
}

/** The sandbox's own signatures in a failed command's output: a write it refused, or a network it withheld. */
const SANDBOX_DENIAL = /Operation not permitted|Read-only file system|Could not resolve host|Temporary failure in name resolution|Network is unreachable|nodename nor servname|ENOTFOUND|EAI_AGAIN/;

/**
 * A line appended to a sandboxed command's failure that looks like the
 * sandbox's doing, so the planner reads "the sandbox stopped this" rather
 * than "the repository is broken", and does not retry it.
 */
export function sandboxedFailureNote(output: string, network: boolean): string | null {
  if (!SANDBOX_DENIAL.test(output)) return null;
  return `The planner's shell is sandboxed: it cannot write outside its scratch directory ($TMPDIR)${network ? '' : ', and a command that runs without asking has no network'}. A change belongs in the plan as a task.`;
}
