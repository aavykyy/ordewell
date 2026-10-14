#!/usr/bin/env node
// Fast local loop: run only the tests affected by uncommitted changes.
// Dependents import core through packages/core/dist, so vitest's module graph
// cannot see a core change from inside cli/vscode/web. When core changed we
// rebuild its dist and run the dependents' quick suites in full instead.
import { execFileSync, spawnSync } from 'node:child_process';

const sh = (cmd, args) => spawnSync(cmd, args, { stdio: 'inherit' }).status ?? 1;
const changed = execFileSync('git', ['status', '--porcelain', '--', 'packages'], { encoding: 'utf8' })
  .split('\n')
  .map((l) => l.slice(3).trim())
  .filter(Boolean);

const touched = (pkg) => changed.some((f) => f.startsWith(`packages/${pkg}/`));
const coreChanged = touched('core');
let failed = false;

if (coreChanged && sh('npm', ['run', 'build', '-w', 'packages/core']) !== 0) process.exit(1);

for (const pkg of ['core', 'cli', 'vscode', 'web']) {
  if (!touched(pkg) && !(coreChanged && pkg !== 'core')) continue;
  const script = pkg !== 'core' && coreChanged ? 'test:quick' : 'test:changed';
  if (sh('npm', ['run', script, '-w', `packages/${pkg}`]) !== 0) failed = true;
}
process.exit(failed ? 1 : 0);
