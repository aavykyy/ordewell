import type { RunnerManifest } from '../types';
import { parseOpenCodeModels, parseOpenCodeModelsApi, parseOpenCodeModelsVerbose } from './openCodeModels';

export const OPENCODE_MANIFEST: RunnerManifest = {
  name: 'opencode',
  displayName: 'OpenCode',

  runner: { command: 'opencode' },

  features: {
    modeSettings: {
      approvals: { build: 'auto' },
    },
  },

  modelDiscovery: {
    method: 'command',
    discoveryCommands: [
      // v1 prints per-model variants under --verbose; v2 rejects the flag (a
      // fast non-zero exit) and serves the same catalog, variants included, over
      // `api model.list`. v1 is asked first so it never reaches the `api` form.
      { command: 'opencode', args: ['models', '--verbose'], parser: parseOpenCodeModelsVerbose },
      { command: 'opencode', args: ['api', 'model.list'], parser: parseOpenCodeModelsApi },
      { command: 'opencode', args: ['models'], parser: parseOpenCodeModels },
    ],
    // No fallbackModels: the list must always reflect what `opencode models`
    // actually reports for THIS user (their configured providers only). A
    // hardcoded fallback previously leaked models the user didn't have.
    // No static variants — per-model variants come from the first two commands above
    providerQualifiedIds: true,
  },

  contextFile: 'AGENTS.md',
  contextFileAltPath: '.opencode/AGENTS.md',

  modes: [
    { id: 'build', label: 'Build', description: 'Full access agent for development work', cliValue: 'build', autonomous: true, safe: true },
    { id: 'plan', label: 'Plan', description: 'Read-only agent for analysis and exploration', cliValue: 'plan', readOnly: true },
  ],
};
