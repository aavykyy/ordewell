import * as path from 'path';
import { runTests } from '@vscode/test-electron';

async function main(): Promise<void> {
  const workspace = process.env.ORDEWELL_TEST_WORKSPACE;
  if (!workspace) throw new Error('ORDEWELL_TEST_WORKSPACE must point at a scratch directory');

  // Run from a VS Code terminal, the editor's own ELECTRON_RUN_AS_NODE and
  // VSCODE_* variables reach the test instance, which then starts as plain
  // Node (or as an extension host) instead of as VS Code.
  for (const key of Object.keys(process.env)) {
    if (key === 'ELECTRON_RUN_AS_NODE' || key.startsWith('VSCODE_')) delete process.env[key];
  }

  await runTests({
    extensionDevelopmentPath: path.resolve(__dirname, '..'),
    extensionTestsPath: path.resolve(__dirname, './index.js'),
    launchArgs: [workspace, '--disable-workspace-trust', '--skip-welcome', '--skip-release-notes'],
    extensionTestsEnv: {
      ORDEWELL_TEST_WORKSPACE: workspace,
      // Desktop shell resolution would overwrite the synthetic runner's PATH.
      VSCODE_CLI: '1',
      // In the host's environment from launch: the PATH Ordewell spawns runners
      // under is resolved once per process, so setting it later can be too late.
      PATH: [path.resolve(__dirname, '../../../bench/pipeline/fake-claude'), process.env.PATH].filter(Boolean).join(path.delimiter),
      ORDEWELL_TEST_MODEL: process.env.ORDEWELL_TEST_MODEL,
      OPENROUTER_API_KEY: process.env.OPENROUTER_API_KEY,
    },
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
