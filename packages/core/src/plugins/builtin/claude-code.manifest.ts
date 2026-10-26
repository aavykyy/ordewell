import type { RunnerManifest } from '../types';
import { parseAnthropicModels, parseClaudeHelp } from './claudeModels';

export const CLAUDE_CODE_MANIFEST: RunnerManifest = {
  name: 'claude-code',
  displayName: 'Claude Code',

  runner: { command: 'claude' },

  features: {
    permissionModeValues: {
      'default': 'default',
      'auto': 'auto',
      'acceptEdits': 'acceptEdits',
      'plan': 'default',
      'bypassPermissions': 'bypassPermissions',
      // Legacy aliases used by older tasks
      'build': 'acceptEdits',
    },
  },

  modelDiscovery: {
    method: 'command',
    // Claude Code has no `claude models` subcommand. Discovery tries three
    // sources in order, each falling through to the next on failure:
    //
    // 1. Anthropic Models API (apiDiscovery) — GET /v1/models returns the
    //    authoritative live list of models the user's account can access,
    //    including aliases the --help prose omits (e.g. haiku). Auth works for
    //    both API-key users (ANTHROPIC_API_KEY → X-Api-Key) and OAuth/claude.ai
    //    users (token from ~/.claude/.credentials.json → Authorization: Bearer).
    //    Short aliases (opus, sonnet, haiku, fable) are derived from the full
    //    model IDs, deduplicated by family keeping the latest.
    //
    // 2. `claude --help` prose (discoveryCommands) — the CLI's --model
    //    description lists example aliases. Fragile (uses "e.g.", not
    //    exhaustive) but works offline and needs no auth.
    //
    // 3. canonicalAliases — stable --model contracts (opus/sonnet/haiku/fable)
    //    merged into any successful result to fill gaps, and used as the full
    //    last-resort list when both API and CLI are unavailable.
    apiDiscovery: {
      url: 'https://api.anthropic.com/v1/models?limit=100',
      headers: { 'anthropic-version': '2023-06-01' },
      auth: [
        { type: 'env', varName: 'ANTHROPIC_API_KEY', header: 'X-Api-Key' },
        { type: 'file', path: '~/.claude/.credentials.json', jsonPath: 'claudeAiOauth.accessToken', header: 'Authorization', prefix: 'Bearer ' },
      ],
      parser: parseAnthropicModels,
    },
    discoveryCommands: [
      { command: 'claude', args: ['--help'], parser: parseClaudeHelp },
    ],
    canonicalAliases: [
      { modelId: 'opus', modelLabel: 'Opus' },
      { modelId: 'sonnet', modelLabel: 'Sonnet' },
      { modelId: 'haiku', modelLabel: 'Haiku' },
      { modelId: 'fable', modelLabel: 'Fable' },
    ],
    variants: [
      { id: 'adaptive', label: 'Adaptive' },
      { id: 'low', label: 'Low effort' },
      { id: 'medium', label: 'Medium effort' },
      { id: 'high', label: 'High effort' },
      { id: 'xhigh', label: 'Extra high effort' },
      { id: 'max', label: 'Max effort' },
    ],
  },

  auth: {
    statusArgs: ['auth', 'status'],
    loginArgs: ['auth', 'login'],
    // A turn on a signed-out account ends with this line, which the status
    // command's JSON reader cannot parse; the failure fallback matches it here.
    signedOut: /not logged in/i,
    // The status command prints JSON; an older CLI prints prose instead, which
    // must stay unknown rather than claiming the user is signed out.
    read: (output, code) => {
      if (code === 0) return 'signed-in';
      try {
        const parsed: unknown = JSON.parse(output.trim());
        if (parsed && typeof parsed === 'object' && (parsed as { authMethod?: unknown }).authMethod === 'none') return 'signed-out';
      } catch {
        // Not JSON: nothing here says why the command failed.
      }
      return null;
    },
  },

  contextFile: 'CLAUDE.md',
  contextFileAltPath: '.claude/CLAUDE.md',

  modes: [
    { id: 'default', label: 'Ask before edits', description: 'Standard mode: asks permission before editing files', cliValue: 'default' },
    { id: 'auto', label: 'Auto', description: 'Claude\'s classifier approves or blocks each action, so routine work proceeds without prompts', cliValue: 'auto', safe: true },
    { id: 'acceptEdits', label: 'Edit automatically', description: 'Edits files without asking, still asks for risky operations', cliValue: 'acceptEdits' },
    { id: 'plan', label: 'Read-only', description: 'Native reads and Ordewell commands; lands nothing', cliValue: 'default', readOnly: true },
    { id: 'bypassPermissions', label: 'Bypass permissions', description: 'Skips all permission prompts: use for AI-driven autonomous runs', cliValue: 'bypassPermissions', autonomous: true },
  ],
};
