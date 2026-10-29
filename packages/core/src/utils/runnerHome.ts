import * as os from 'os';
import type { RunnerEnv } from '../plugins/types';

/**
 * The directory `~` names for a runner launched with `env`. Claude Code finds
 * `~/.claude` through Node's `os.homedir()`, which reads HOME on POSIX and
 * USERPROFILE on Windows before asking the system, so a workspace environment
 * that sets one moves the runner's settings and login with it. A variable
 * set empty is still the one read: the runner's home is then empty, not this
 * process's.
 */
export function runnerHomeDir(env: RunnerEnv, platform: NodeJS.Platform = process.platform): string {
  const name = platform === 'win32' ? 'USERPROFILE' : 'HOME';
  // Windows names are case-insensitive, and a merged environment is a plain
  // object: the last spelling is the one a later source set.
  const key = platform === 'win32' ? Object.keys(env).filter((k) => k.toUpperCase() === name).pop() : name;
  const home = key === undefined ? undefined : env[key];
  return home ?? os.homedir();
}

/**
 * `filePath` with a leading `~` resolved as a runner launched with `env`
 * resolves it, or null when that runner has no home to resolve it against:
 * reading this process's home in its place would hand it another account's
 * files.
 */
export function expandRunnerHome(filePath: string, env: RunnerEnv = process.env): string | null {
  if (!filePath.startsWith('~')) return filePath;
  const home = runnerHomeDir(env);
  return home ? home + filePath.slice(1) : null;
}
