import { readFileSync } from 'fs';
import { basename, join, resolve } from 'path';
import { describe, expect, it } from 'vitest';
import { daemonBuild, daemonBuildFailure } from './daemonBuild';

const webRoot = resolve(__dirname, '..', '..');

function buildScriptTokens(): string[] {
  const pkg: unknown = JSON.parse(readFileSync(join(webRoot, 'package.json'), 'utf8'));
  const scripts = (pkg as { scripts?: Record<string, string> }).scripts ?? {};
  return (scripts['build:server'] ?? '').trim().split(/\s+/);
}

describe('daemon build hook', () => {
  // What `npm` resolves to on each platform. On Windows it is a batch shim,
  // which CreateProcess cannot start and Node refuses to spawn without a shell,
  // so an execFileSync naming it throws EINVAL before any daemon test runs.
  const npmImage: Record<string, string> = { win32: 'npm.cmd', darwin: 'npm', linux: 'npm' };

  it.each(Object.entries(npmImage))('never starts %s\'s npm image (%s)', (_platform, shim) => {
    const build = daemonBuild();
    expect(basename(build.file)).not.toBe(shim);
    expect(build.file).toBe(process.execPath);
  });

  it('runs the build:server script\'s own arguments through tsup', () => {
    const build = daemonBuild();
    const [tsup, ...args] = buildScriptTokens();
    expect(tsup).toBe('tsup');
    expect(build.args.slice(1)).toEqual(args);
    expect(basename(build.args[0]).toLowerCase()).toContain('cli');
    expect(build.cwd).toBe(webRoot);
  });

  it('names the build\'s stderr when it fails', () => {
    const failure = Object.assign(new Error('Command failed: node tsup'), {
      stderr: 'error: Could not resolve "server/main.ts"\n',
    });
    expect(daemonBuildFailure(failure).message).toContain('Could not resolve "server/main.ts"');
  });
});
