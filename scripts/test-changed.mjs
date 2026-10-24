#!/usr/bin/env node
// Fast local loop: run only the tests affected by uncommitted changes.
// Dependents import core through packages/core/dist, so vitest's module graph
// cannot see a core change from inside cli/vscode/web. When core changed we
// rebuild its dist and run the dependents' quick suites in full instead.
import { execFileSync, spawnSync } from 'node:child_process';

// Root files every workspace's tests and build share. A change to one can
// break any package, so it runs every workspace's quick suite; watching only
// `packages` made such a change run nothing and exit 0.
const SHARED = ['vitest.setup.ts', 'vitest.shared.ts', 'tsconfig.json', 'package.json', 'package-lock.json'];

const sh = (cmd, args) => spawnSync(cmd, args, { stdio: 'inherit' }).status ?? 1;
const changed = execFileSync('git', ['status', '--porcelain', '--', 'packages', ...SHARED], { encoding: 'utf8' })
  .split('\n')
  .map((l) => l.slice(3).trim())
  .filter(Boolean);

const touched = (pkg) => changed.some((f) => f.startsWith(`packages/${pkg}/`));
const coreChanged = touched('core');
const sharedChanged = changed.some((f) => !f.startsWith('packages/'));
let failed = false;

if (sharedChanged) {
  const files = [...new Set(changed.filter((f) => !f.startsWith('packages/')))];
  console.log(`Shared build/test configuration changed (${files.join(', ')}): running every workspace's quick suite.`);
}
if ((coreChanged || sharedChanged) && sh('npm', ['run', 'build', '-w', 'packages/core']) !== 0) process.exit(1);

for (const pkg of ['core', 'cli', 'vscode', 'web']) {
  const runAll = sharedChanged || (coreChanged && pkg !== 'core');
  if (!touched(pkg) && !runAll) continue;
  const script = runAll ? 'test:quick' : 'test:changed';
  if (sh('npm', ['run', script, '-w', `packages/${pkg}`]) !== 0) failed = true;
}
process.exit(failed ? 1 : 0);
