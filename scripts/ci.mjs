#!/usr/bin/env node
// Run what .github/workflows/ci.yml runs, in its order, so a local pass means
// CI passes. `npm run lint && npm run typecheck && npm run test:coverage` left
// out the verify scripts, the planner e2e, the VS Code integration test and
// packaging, and each of those can fail a push on its own.
//
// Every named step of ci.yml must appear below, either run here or listed as
// CI-only with the reason: a step added to the workflow and not here fails
// this script before anything runs, so the two cannot drift apart unnoticed.
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const MOCK_PROVIDER_PORT = 3799;

const sh = (cmd, args, env) => spawnSync(cmd, args, { stdio: 'inherit', env: { ...process.env, ...env } }).status ?? 1;
const npm = (...args) => sh('npm', args);

function portOpen(port) {
  return new Promise((resolve) => {
    const socket = connect(port, '127.0.0.1');
    socket.on('connect', () => { socket.destroy(); resolve(true); });
    socket.on('error', () => resolve(false));
  });
}

async function plannerE2e() {
  // A mock left over from an aborted run holds the port, and the drive would
  // silently talk to it instead of the one started here.
  if (await portOpen(MOCK_PROVIDER_PORT)) {
    console.error(`Port ${MOCK_PROVIDER_PORT} is already taken; stop whatever holds it (an old mock-provider?) and rerun.`);
    return 1;
  }
  const mock = spawn('node', ['bench/live/mock-provider.mjs'], { stdio: 'inherit' });
  try {
    for (let i = 0; i < 50 && !(await portOpen(MOCK_PROVIDER_PORT)); i++) await new Promise((r) => setTimeout(r, 200));
    return sh('node', ['bench/live/drive-conversation.mjs']);
  } finally {
    mock.kill();
  }
}

function integrationTest() {
  const workspace = mkdtempSync(join(tmpdir(), 'ordewell-integration-workspace-'));
  const env = { ORDEWELL_TEST_WORKSPACE: workspace };
  // VS Code needs a display; a headless Linux box gets a virtual one, as CI does.
  const headlessLinux = process.platform === 'linux' && !process.env.DISPLAY;
  if (headlessLinux && sh('sh', ['-c', 'command -v xvfb-run >/dev/null']) !== 0) {
    console.error('No display and no xvfb-run: install xvfb to run the VS Code integration test.');
    return 1;
  }
  return headlessLinux
    ? sh('xvfb-run', ['-a', 'npm', 'run', 'test:integration', '-w', 'ordewell'], env)
    : sh('npm', ['run', 'test:integration', '-w', 'ordewell'], env);
}

/** Run here, keyed by the step's name in ci.yml. */
const STEPS = {
  'Build (core first — cli, web and vscode compile against its dist/)': () => npm('run', 'build:core'),
  'Verify scripts (offline, against the built core)': () => {
    for (const f of readdirSync('scripts').filter((f) => /^verify-.*\.mjs$/.test(f)).sort()) {
      if (sh('node', [join('scripts', f)]) !== 0) return 1;
    }
    return 0;
  },
  'Planner conversation loop — offline e2e (mock model, no API key)': plannerE2e,
  'Build (vscode, cli & web)': () => npm('run', 'build', '-w', 'packages/vscode', '-w', 'packages/cli', '-w', 'packages/web', '--if-present'),
  'VS Code integration test (synthetic runner — no API key)': integrationTest,
  'Typecheck': () => npm('run', 'typecheck'),
  'Test with coverage': () => npm('run', 'test:coverage'),
  'Lint': () => npm('run', 'lint'),
  'Package VS Code Extension': () => npm('run', 'package', '-w', 'packages/vscode'),
};

/** Named in ci.yml but not run here, and why. */
const CI_ONLY = {
  'Use Node.js 22.x': 'the local Node is what you have',
  // ci.yml explains why the lockfile does not install cleanly off Linux, and
  // `npm ci` would also wipe the node_modules you are working in.
  'Install dependencies': 'run `npm ci` yourself after a lockfile change',
  'Cache the VS Code download': 'packages/vscode/.vscode-test is already kept between runs',
  'Install xvfb if the image lacks it': 'the integration step checks for a display itself',
  'Append coverage summaries to the job summary': 'a GitHub job summary',
  'Upload coverage reports': 'reports stay in packages/*/coverage/',
  'Upload .vsix': 'the .vsix stays in packages/vscode/',
};

const workflow = readFileSync('.github/workflows/ci.yml', 'utf8');
const named = [...workflow.matchAll(/^\s+- name: (.+?)\s*$/gm)].map((m) => m[1].replace(/^(['"])(.*)\1$/, '$2'));
const unknown = named.filter((n) => !(n in STEPS) && !(n in CI_ONLY));
const stale = [...Object.keys(STEPS), ...Object.keys(CI_ONLY)].filter((n) => !named.includes(n));
if (unknown.length || stale.length) {
  for (const n of unknown) console.error(`ci.yml step not covered by scripts/ci.mjs: "${n}"`);
  for (const n of stale) console.error(`scripts/ci.mjs names a step ci.yml no longer has: "${n}"`);
  process.exit(1);
}

for (const name of named.filter((n) => n in STEPS)) {
  console.log(`\n=== ${name}`);
  if ((await STEPS[name]()) !== 0) {
    console.error(`\n✗ ${name} failed, as it would in CI.`);
    process.exit(1);
  }
}
console.log('\n✓ Every ci.yml step that runs locally passed.');
