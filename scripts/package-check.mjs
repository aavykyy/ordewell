#!/usr/bin/env node
// What a user actually installs: the four npm tarballs and the VSIX. Nothing
// else in CI looks inside them, so a missing main/exports/bin target, a LICENSE
// or NOTICE npm left out of the allowlist, or a bundle that dies before --help
// is otherwise first found by `npm publish` or by a user. The CLI's CJS bundle
// once required ESM-only string-width at load and failed exactly that way on
// the Node versions its engines allow.
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = process.cwd();
let failures = 0;
const ok = (message) => console.log(`  ok  ${message}`);
const fail = (message) => {
  failures += 1;
  console.error(`FAIL  ${message}`);
};

const PACKAGES = [
  { dir: 'packages/core', notices: ['LICENSE', 'NOTICE', 'AUTHORS.md'] },
  { dir: 'packages/web', notices: ['LICENSE', 'NOTICE', 'AUTHORS.md'] },
  { dir: 'packages/cli', notices: ['LICENSE', 'NOTICE', 'AUTHORS.md', 'THIRD-PARTY-NOTICES.md'] },
  { dir: 'packages/cli-alias', notices: ['LICENSE', 'NOTICE', 'AUTHORS.md'] },
];

/**
 * Every path a consumer can reach: main/module/types, each exports leaf and
 * each bin. All must be inside the tarball, or `npm install` produces a package
 * whose entry point does not exist.
 */
function entryTargets(pkg) {
  const targets = new Set();
  const add = (value) => {
    if (typeof value === 'string' && value.startsWith('./')) targets.add(value.slice(2));
  };
  for (const field of ['main', 'module', 'types', 'browser']) add(pkg[field]);
  if (typeof pkg.bin === 'string') add(pkg.bin);
  for (const value of Object.values(pkg.bin ?? {})) add(value);
  const walk = (value) => {
    if (typeof value === 'string') add(value);
    else if (value && typeof value === 'object') for (const nested of Object.values(value)) walk(nested);
  };
  walk(pkg.exports);
  return [...targets].sort();
}

const packDir = mkdtempSync(join(tmpdir(), 'ordewell-pack-'));
const tarballs = [];
try {
  for (const { dir, notices } of PACKAGES) {
    const cwd = join(root, dir);
    const pkg = JSON.parse(readFileSync(join(cwd, 'package.json'), 'utf8'));
    console.log(`\n${pkg.name}@${pkg.version}`);
    const before = failures;
    const dryRun = JSON.parse(execFileSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], { cwd, encoding: 'utf8' }));
    const files = new Set(dryRun[0].files.map((file) => file.path));
    for (const target of entryTargets(pkg)) {
      if (!files.has(target)) fail(`${dir}: entry target ${target} is not in the tarball`);
    }
    for (const notice of notices) {
      if (!files.has(notice)) fail(`${dir}: ${notice} is not in the tarball (list it in "files")`);
    }
    if (failures === before) ok(`${files.size} files, every entry target and notice present`);
    const packed = execFileSync('npm', ['pack', '--pack-destination', packDir, '--ignore-scripts'], { cwd, encoding: 'utf8' })
      .trim()
      .split('\n')
      .pop();
    tarballs.push({ name: pkg.name, path: join(packDir, packed) });
  }

  // Install the tarballs together, as `npm i ordewell` would resolve them, and
  // start the CLI with require(esm) off: the oldest Node the engines field
  // promises behaves that way even when the local Node does not.
  console.log('\ninstall the tarballs and start the CLI');
  const consumer = join(packDir, 'consumer');
  mkdirSync(consumer);
  writeFileSync(
    join(consumer, 'package.json'),
    JSON.stringify({ name: 'ordewell-pack-smoke', private: true, dependencies: Object.fromEntries(tarballs.map((t) => [t.name, `file:${t.path}`])) }, null, 2),
  );
  // An empty user config keeps a developer's ~/.npmrc (an allow-scripts list
  // makes npm refuse a project-scoped install) out of the smoke install. `npm
  // run` re-exports that list as npm_config_allow_scripts, so drop it from the
  // environment too.
  const userconfig = join(packDir, 'empty.npmrc');
  writeFileSync(userconfig, '');
  const installEnv = Object.fromEntries(Object.entries(process.env).filter(([k]) => k.toLowerCase().replace(/-/g, '_') !== 'npm_config_allow_scripts'));
  const installed = spawnSync('npm', ['install', '--ignore-scripts', '--no-audit', '--no-fund', `--userconfig=${userconfig}`], { cwd: consumer, stdio: 'inherit', env: installEnv });
  if (installed.status !== 0) {
    fail('npm install of the packed tarballs failed');
  } else {
    const cliVersion = JSON.parse(readFileSync(join(root, 'packages/cli/package.json'), 'utf8')).version;
    const runs = [
      ['@ordewell/cli dist/main.js --help', join(consumer, 'node_modules/@ordewell/cli/dist/main.js'), ['--help']],
      ['packed ordewell bin --help', join(consumer, 'node_modules/ordewell/bin/ordewell.js'), ['--help']],
      ['@ordewell/cli dist/main.js --version', join(consumer, 'node_modules/@ordewell/cli/dist/main.js'), ['--version']],
    ];
    for (const [label, entry, args] of runs) {
      const run = spawnSync(process.execPath, ['--no-experimental-require-module', entry, ...args], { encoding: 'utf8' });
      if (run.status !== 0) {
        fail(`${label} exited ${run.status}: ${(run.stderr || run.stdout).trim().split('\n').slice(-3).join(' | ')}`);
      } else if (args.includes('--version') && !run.stdout.includes(cliVersion)) {
        fail(`${label} printed ${JSON.stringify(run.stdout.trim())}, expected ${cliVersion}`);
      } else {
        ok(label);
      }
    }
  }

  // The VSIX, after "Package VS Code Extension". vsce renames LICENSE to
  // LICENSE.txt, so match the extension's basename with any suffix.
  console.log('\nVS Code extension');
  const vscodeDir = join(root, 'packages/vscode');
  const before = failures;
  // Name the current version: earlier releases' .vsix files linger in the
  // directory, and sorting the names puts 0.10.8 after 0.10.12.
  const extension = JSON.parse(readFileSync(join(vscodeDir, 'package.json'), 'utf8'));
  const vsix = readdirSync(vscodeDir).find((file) => file === `${extension.name}-${extension.version}.vsix`);
  if (!vsix) {
    fail(`no ${extension.name}-${extension.version}.vsix in packages/vscode; run "npm run package -w packages/vscode" first`);
  } else {
    const listed = execFileSync('unzip', ['-Z1', join(vscodeDir, vsix)], { encoding: 'utf8' }).split('\n');
    const has = (pattern) => listed.some((entry) => pattern.test(entry));
    for (const [label, pattern] of [
      ['dist/extension.js', /^extension\/dist\/extension\.js$/],
      ['package.json', /^extension\/package\.json$/],
      ['LICENSE', /^extension\/LICENSE(\.[a-z]+)?$/],
      ['NOTICE', /^extension\/NOTICE$/],
      ['AUTHORS.md', /^extension\/AUTHORS\.md$/],
      ['THIRD-PARTY-NOTICES.md', /^extension\/THIRD-PARTY-NOTICES\.md$/],
    ]) {
      if (!has(pattern)) fail(`${vsix}: ${label} is not in the VSIX (check .vscodeignore)`);
    }
    if (failures === before) ok(`${vsix} carries the bundle, LICENSE, NOTICE and third-party notices`);
  }
} finally {
  rmSync(packDir, { recursive: true, force: true });
}

if (failures > 0) {
  console.error(`\npackage-check: ${failures} check(s) failed`);
  process.exit(1);
}
console.log('\npackage-check: all packaged artifacts are complete and the CLI starts');
