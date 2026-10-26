import { execFile } from 'child_process';
import type { RunnerManifest, RunnerAuthSpec } from '../plugins/types';
import { augmentedPath, withPath } from '../utils/shellPath';

/**
 * What a runner's own status command answered (ADR-0009). A surface flags a
 * planner on `signed-out` and never on `unknown`: only the runner can say its
 * user is signed out, and an unparseable or missing answer must not.
 */
export interface RunnerAuth {
  state: 'signed-in' | 'signed-out' | 'unknown';
  /** The runner command plus its login args, so a surface runs the same login the CLI would. */
  loginCommand?: string[];
  /** A short, credential-free reason — the status command's own wording, never its output. */
  detail?: string;
}

/** A status command's answer. Unlike `exec`, a non-zero exit is data, not a rejection. */
export interface RunnerAuthExecResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface RunnerAuthExecOptions {
  timeout: number;
  env: NodeJS.ProcessEnv;
}

export type RunnerAuthExec = (
  command: string,
  args: string[],
  options: RunnerAuthExecOptions,
) => Promise<RunnerAuthExecResult>;

export interface ReadRunnerAuthOptions {
  exec?: RunnerAuthExec;
  /** The workspace's own variables (ADR-0016), merged over the daemon's for the probe. */
  env?: Record<string, string>;
  timeoutMs?: number;
}

const AUTH_TIMEOUT_MS = 8000;

const defaultExec: RunnerAuthExec = (command, args, options) =>
  new Promise((resolve) => {
    execFile(command, args, { timeout: options.timeout, env: options.env, encoding: 'utf8' }, (err, stdout, stderr) => {
      const raw = (err as { code?: unknown } | null)?.code;
      // A signal or a spawn failure has no numeric code; either way nothing
      // trustworthy came back, so it is not an exit status to read.
      const code = err ? (typeof raw === 'number' ? raw : -1) : 0;
      resolve({ code, stdout: String(stdout ?? ''), stderr: String(stderr ?? '') });
    });
  });

/**
 * Ask one runner whether its user is signed in. Never throws and never reads a
 * credential: it runs the manifest's status args with the same augmented PATH
 * and workspace environment a planner would use, and judges only that answer.
 */
export async function readRunnerAuth(manifest: RunnerManifest, options: ReadRunnerAuthOptions = {}): Promise<RunnerAuth> {
  const spec = manifest.auth;
  if (!spec) return { state: 'unknown' };
  const command = manifest.runner.command;
  const loginCommand = [command, ...spec.loginArgs];

  let answer: RunnerAuthExecResult;
  try {
    const env = withPath(process.env, await augmentedPath(), options.env ?? {});
    answer = await (options.exec ?? defaultExec)(command, spec.statusArgs, {
      timeout: options.timeoutMs ?? AUTH_TIMEOUT_MS,
      env,
    });
  } catch {
    return { state: 'unknown', loginCommand };
  }

  const output = `${answer.stdout}\n${answer.stderr}`;
  let state: 'signed-in' | 'signed-out' | null;
  try {
    state = verdictOf(spec, output, answer.code);
  } catch {
    // A reader that cannot make sense of the output answered nothing.
    return { state: 'unknown', loginCommand };
  }
  if (state === 'signed-in') return { state, loginCommand };
  if (state === 'signed-out') return { state, loginCommand, detail: 'not logged in' };
  return { state: 'unknown', loginCommand };
}

/** A signed-out verdict always carries the command that fixes it; a failure fallback leans on that. */
export type SignedOutAuth = RunnerAuth & { state: 'signed-out'; loginCommand: string[] };

/**
 * A failed turn's own words as the runner's signed-out verdict. Only a phrase
 * the manifest declares — its `signedOut` line, or a reader that can judge the
 * message — so an unrelated failure is never turned into a login wall. It asks
 * nothing: the turn has already told us.
 */
export function signedOutFromFailure(manifest: RunnerManifest, message: string): SignedOutAuth | undefined {
  const spec = manifest.auth;
  if (!spec) return undefined;
  let state: 'signed-in' | 'signed-out' | null;
  try {
    state = spec.signedOut?.test(message) ? 'signed-out' : verdictOf(spec, message, 1);
  } catch {
    return undefined;
  }
  if (state !== 'signed-out') return undefined;
  return {
    state,
    loginCommand: [manifest.runner.command, ...spec.loginArgs],
    detail: 'not logged in',
  };
}

function verdictOf(spec: RunnerAuthSpec, output: string, code: number): 'signed-in' | 'signed-out' | null {
  if (spec.read) return spec.read(output, code);
  return verdictFromExit(spec, output, code);
}

function verdictFromExit(spec: RunnerAuthSpec, output: string, code: number): 'signed-in' | 'signed-out' | null {
  if (code === 0) return 'signed-in';
  return spec.signedOut?.test(output) ? 'signed-out' : null;
}

/**
 * The latest verdict per runner, process-wide because a planner readiness check
 * is synchronous and cannot await a probe. Follows
 * `services/InstalledPlanner.ts`: a host probes when it builds or refreshes its
 * runner list, and every later sync check reads the answer here.
 */
const recorded = new Map<string, RunnerAuth>();

export function recordRunnerAuth(runner: string, auth: RunnerAuth): void {
  recorded.set(runner, auth);
}

export function recordedRunnerAuth(runner: string): RunnerAuth | undefined {
  return recorded.get(runner);
}

/** For tests: the record is process-wide, so one case's verdict must not decide the next's. */
export function resetRunnerAuth(): void {
  recorded.clear();
}
