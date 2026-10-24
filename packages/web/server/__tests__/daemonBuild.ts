import { createRequire } from 'module';
import { dirname, join, resolve } from 'path';

/** The process that rebuilds the daemon the startup tests spawn. */
export interface DaemonBuild {
  file: string;
  args: string[];
  cwd: string;
}

/**
 * The web package root. Every path here is resolved from it rather than from
 * the caller's cwd, so the build runs against `packages/web` wherever vitest was
 * started.
 */
const webRoot = resolve(__dirname, '..', '..');

/**
 * The arguments of `build:server`, after the `tsup` executable. Kept as a whole
 * command line: tsup loads `tsup.config.ts` from `cwd`, and that config — not
 * these flags — is what sets `outDir` and the sourcemap.
 *
 * `daemonBuild.test.ts` checks these against `package.json`, so an edit to the
 * script that is not mirrored here fails the suite instead of quietly building
 * something else.
 */
const BUILD_ARGS = [
  'server/main.ts',
  '--format', 'cjs',
  '--clean',
  '--external', 'hono',
  '--external', 'ws',
  '--external', '@ordewell/core',
  '--tsconfig', 'tsconfig.json',
];

/**
 * How to rebuild the daemon the startup tests spawn.
 *
 * Node runs tsup's own CLI here instead of `npm run build:server`. npm on Windows
 * is `npm.cmd`, a batch file CreateProcess cannot start and Node refuses to
 * spawn without a shell (CVE-2024-27980), so `execFileSync('npm.cmd', …)`
 * throws EINVAL there — before a single test runs, with nothing tested. Node is
 * a real executable on every platform, so this route needs no platform branch,
 * and no shell stands between the literals above and tsup.
 */
export function daemonBuild(): DaemonBuild {
  const requireFromWeb = createRequire(join(webRoot, 'package.json'));
  const tsupDir = dirname(requireFromWeb.resolve('tsup/package.json'));
  // `require.resolve('tsup')` is the library entry; the CLI is what `bin` names.
  const { bin } = requireFromWeb('tsup/package.json') as { bin: Record<string, string> };
  return {
    file: process.execPath,
    args: [join(tsupDir, bin.tsup), ...BUILD_ARGS],
    cwd: webRoot,
  };
}

/**
 * Turns a failed build into an error that carries tsup's own stderr.
 *
 * `execFileSync`'s message alone is `Command failed: <path>`, which names the
 * command and withholds the reason the build stopped.
 */
export function daemonBuildFailure(error: unknown): Error {
  const stderr = typeof error === 'object' && error !== null && 'stderr' in error
    ? String((error as { stderr?: unknown }).stderr ?? '').trim()
    : '';
  const reason = stderr || (error instanceof Error ? error.message : String(error));
  return new Error(`Building the daemon failed: ${reason}`);
}
